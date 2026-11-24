import {
  assert, fs, os, path, spawn, test,
  argvFixture, cleanup, cleanupProjfs, createSecretRedactor, environmentFixture,
  fakeOidcFixture, fakeProjfsFixture, fixture, holderFixture, getProcessIdentity,
  handleUnverifiableRecovery, isOwnedProcessAlive, launchOwned, makeBroker,
  makeProjfsBroker, ownershipDescriptor, queryOwnedJobEmpty, root, run,
  runIteration, start, startRaw, status, stopProcessGroup, terminateFixtureMonitor,
  terminateFixtureProcess, terminateOwned, waitFor, waitForPath,
  waitForProcessExit, waitForProviderState, withLock, buildLaunch,
  classifyLauncherIdentity,
} from './helpers/broker-fixture.mjs';

function makeHolder(broker, label, orderPath = '') {
  const readyPath = path.join(broker.temporaryRoot, `${label}.ready`);
  const releasePath = path.join(broker.temporaryRoot, `${label}.release`);
  return {
    command: [process.execPath, holderFixture, readyPath, releasePath, orderPath, label],
    readyPath,
    release: () => fs.writeFile(releasePath, 'release'),
  };
}

test('ProjFS heavy-build cap admits retained tasks in durable FIFO order', async () => {
  const broker = await makeProjfsBroker(3, ['--max-concurrent-heavy-builds', '1', '--build-wait-timeout-ms', '60000']);
  try {
    const orderPath = path.join(broker.temporaryRoot, 'order.txt');
    const one = makeHolder(broker, 'one', orderPath);
    const two = makeHolder(broker, 'two', orderPath);
    const three = makeHolder(broker, 'three', orderPath);
    const first = await startRaw(broker.stateDir, one.command, ['--resource-class', 'heavy-build']);
    await waitFor(broker.stateDir, first.taskId, (task) => task.state === 'running');
    await waitForPath(one.readyPath, 30000);
    const second = await startRaw(broker.stateDir, two.command, ['--resource-class', 'heavy-build']);
    const third = await startRaw(broker.stateDir, three.command, ['--resource-class', 'heavy-build']);
    const secondWaiting = await waitFor(broker.stateDir, second.taskId, (task) => task.state === 'WAITING_FOR_BUILD_CAPACITY');
    const thirdWaiting = await waitFor(broker.stateDir, third.taskId, (task) => task.state === 'WAITING_FOR_BUILD_CAPACITY');
    assert.equal(secondWaiting.queuePosition, 1);
    assert.ok(thirdWaiting.queuePosition >= 1);
    await one.release();
    await waitForPath(two.readyPath, 30000);
    await two.release();
    await waitForPath(three.readyPath, 30000);
    await three.release();
    await Promise.all([
      waitFor(broker.stateDir, first.taskId, (task) => task.state === 'completed'),
      waitFor(broker.stateDir, second.taskId, (task) => task.state === 'completed'),
      waitFor(broker.stateDir, third.taskId, (task) => task.state === 'completed'),
    ]);
    assert.deepEqual((await fs.readFile(orderPath, 'utf8')).trim().split('\n'), [
      'one-start', 'one-end', 'two-start', 'two-end', 'three-start', 'three-end',
    ]);
  } finally {
    await cleanupProjfs(broker);
  }
});

test('ProjFS heavy-build reject, wait timeout, and waiting cancellation are deterministic', async () => {
  const rejectBroker = await makeProjfsBroker(2, ['--max-concurrent-heavy-builds', '1', '--build-capacity-policy', 'reject']);
  try {
    const holder = makeHolder(rejectBroker, 'reject-holder');
    const first = await startRaw(rejectBroker.stateDir, holder.command, ['--resource-class', 'heavy-build']);
    await waitFor(rejectBroker.stateDir, first.taskId, (task) => task.state === 'running');
    await waitForPath(holder.readyPath);
    const rejected = await startRaw(rejectBroker.stateDir, [process.execPath, fixture, '10'], ['--resource-class', 'heavy-build']);
    const failed = await waitFor(rejectBroker.stateDir, rejected.taskId, (task) => task.state === 'failed');
    assert.match(failed.error, /capacity rejected/);
    await holder.release();
    await waitFor(rejectBroker.stateDir, first.taskId, (task) => task.state === 'completed');
  } finally {
    await cleanupProjfs(rejectBroker);
  }

  const waitBroker = await makeProjfsBroker(3, ['--max-concurrent-heavy-builds', '1', '--build-wait-timeout-ms', '250']);
  try {
    const holder = makeHolder(waitBroker, 'timeout-holder');
    const first = await startRaw(waitBroker.stateDir, holder.command, ['--resource-class', 'heavy-build']);
    await waitFor(waitBroker.stateDir, first.taskId, (task) => task.state === 'running');
    await waitForPath(holder.readyPath);
    const timed = await startRaw(waitBroker.stateDir, [process.execPath, fixture, '10'], ['--resource-class', 'heavy-build']);
    const timedFailure = await waitFor(waitBroker.stateDir, timed.taskId, (task) => task.state === 'failed');
    assert.match(timedFailure.error, /timed out waiting 250ms/);
    await holder.release();
    await waitFor(waitBroker.stateDir, first.taskId, (task) => task.state === 'completed');
  } finally {
    await cleanupProjfs(waitBroker);
  }

  const cancelBroker = await makeProjfsBroker(2, ['--max-concurrent-heavy-builds', '1', '--build-wait-timeout-ms', '10000']);
  try {
    const holder = makeHolder(cancelBroker, 'cancel-holder');
    const first = await startRaw(cancelBroker.stateDir, holder.command, ['--resource-class', 'heavy-build']);
    await waitFor(cancelBroker.stateDir, first.taskId, (task) => task.state === 'running');
    await waitForPath(holder.readyPath);
    const cancelled = await startRaw(cancelBroker.stateDir, [process.execPath, fixture, '10'], ['--resource-class', 'heavy-build']);
    await waitFor(cancelBroker.stateDir, cancelled.taskId, (task) => task.state === 'WAITING_FOR_BUILD_CAPACITY');
    await run(['cancel', '--state-dir', cancelBroker.stateDir, cancelled.taskId]);
    const cancelledTask = await waitFor(cancelBroker.stateDir, cancelled.taskId, (task) => task.state === 'cancelled');
    assert.equal(cancelledTask.pid, null);
    await holder.release();
    await waitFor(cancelBroker.stateDir, first.taskId, (task) => task.state === 'completed');
  } finally {
    await cleanupProjfs(cancelBroker);
  }
});

test('ProjFS stale queue entries are atomically pruned and permits are structured', async () => {
  const broker = await makeProjfsBroker(2, ['--max-concurrent-heavy-builds', '1', '--build-wait-timeout-ms', '10000']);
  try {
    const slotsPath = path.join(broker.stateDir, 'slots.json');
    const slots = JSON.parse(await fs.readFile(slotsPath, 'utf8'));
    slots.buildQueue = ['legacy-id', { taskId: 'missing', attempt: 99, nonce: 'stale', enteredAt: '2000-01-01T00:00:00Z' }];
    await fs.writeFile(slotsPath, `${JSON.stringify(slots, null, 2)}\n`);
    const holder = makeHolder(broker, 'queue-holder');
    const first = await startRaw(broker.stateDir, holder.command, ['--resource-class', 'heavy-build']);
    await waitFor(broker.stateDir, first.taskId, (task) => task.state === 'running');
    await waitForPath(holder.readyPath);
    const second = await startRaw(broker.stateDir, [process.execPath, '-e', 'process.exit(0)'], ['--resource-class', 'heavy-build']);
    await waitFor(broker.stateDir, second.taskId, (task) => task.state === 'WAITING_FOR_BUILD_CAPACITY');
    const waitingSlots = JSON.parse(await fs.readFile(slotsPath, 'utf8'));
    assert.deepEqual(Object.keys(waitingSlots.buildQueue[0]).sort(), ['attempt', 'enteredAt', 'nonce', 'taskId']);
    await holder.release();
    await waitFor(broker.stateDir, first.taskId, (task) => task.state === 'completed');
    const completed = await waitFor(broker.stateDir, second.taskId, (task) => task.state === 'completed');
    assert.equal(completed.permitState, 'released');
    assert.deepEqual(JSON.parse(await fs.readFile(slotsPath, 'utf8')).buildQueue, []);
  } finally {
    await cleanupProjfs(broker);
  }
});
