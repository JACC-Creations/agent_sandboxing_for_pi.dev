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

test('simultaneous starts allocate different slots exactly once', async () => {
  const broker = await makeBroker(2);
  try {
    const [left, right] = await Promise.all([start(broker.stateDir, 300), start(broker.stateDir, 300)]);
    assert.notEqual(left.taskId, right.taskId);
    assert.deepEqual(new Set([left.slot, right.slot]), new Set([1, 2]));
    const all = JSON.parse((await run(['status', '--state-dir', broker.stateDir])).stdout);
    assert.equal(all.tasks.length, 2);
    assert.equal(new Set(all.slots.map((slot) => slot.taskId)).size, 2);
  } finally {
    await cleanup(broker);
  }
});

test('capacity overflow fails and completed slots remain retained', async () => {
  const broker = await makeBroker();
  try {
    const started = await start(broker.stateDir, 100);
    await waitFor(broker.stateDir, started.taskId, (task) => task.state === 'completed');
    await assert.rejects(
      run(['start', '--state-dir', broker.stateDir, '--', process.execPath, fixture, '10']),
      /capacity exhausted/,
    );
    const all = JSON.parse((await run(['status', '--state-dir', broker.stateDir])).stdout);
    assert.equal(all.slots[0].taskId, started.taskId);
    assert.equal(all.tasks.length, 1);
  } finally {
    await cleanup(broker);
  }
});

test('cancel recovery requires an empty owned Job even after the launcher has exited', async () => {
  const broker = await makeProjfsBroker(1, ['--max-concurrent-heavy-builds', '1']);
  try {
    const holder = makeHolder(broker, 'exited-launcher');
    const result = await run([
      'start', '--state-dir', broker.stateDir, '--resource-class', 'heavy-build', '--',
      ...holder.command,
    ], { env: { AGENT_WORKSPACE_TEST_TERMINATE_FAILURE: '1' } });
    const started = JSON.parse(result.stdout);
    await waitFor(broker.stateDir, started.taskId, (task) => task.state === 'running');
    await run(['cancel', '--state-dir', broker.stateDir, started.taskId]);
    const failed = await waitFor(broker.stateDir, started.taskId, (task) => task.state === 'termination_failed', 10000);
    await holder.release();
    await waitForProcessExit(failed.pid, 10000);
    await run(['cancel', '--state-dir', broker.stateDir, started.taskId], {
      env: { AGENT_WORKSPACE_TEST_QUERY_JOB_NONEMPTY: '1' },
    });
    const quarantined = await waitFor(broker.stateDir, started.taskId, (task) => task.state === 'termination_failed', 10000);
    assert.equal(quarantined.permitState, 'quarantined');
    assert.equal(quarantined.buildCapacityReleasedAt, null);
    assert.equal(quarantined.monitorRecoveries, 1);
    await run(['cancel', '--state-dir', broker.stateDir, started.taskId]);
    const recovered = await waitFor(broker.stateDir, started.taskId, (task) => task.state === 'cancelled', 10000);
    assert.equal(recovered.permitState, 'released');
    assert.equal(recovered.attempt, failed.attempt);
    assert.equal(recovered.monitorRecoveries, 2);
  } finally {
    await cleanup(broker);
  }
});

test('explicit cancel retries a failed owned termination without replacing the task or permit', async () => {
  const broker = await makeProjfsBroker(1, ['--max-concurrent-heavy-builds', '1']);
  try {
    const holder = makeHolder(broker, 'retry-termination');
    const result = await run([
      'start', '--state-dir', broker.stateDir, '--resource-class', 'heavy-build', '--',
      ...holder.command,
    ], { env: { AGENT_WORKSPACE_TEST_TERMINATE_FAILURE: '1' } });
    const started = JSON.parse(result.stdout);
    await waitFor(broker.stateDir, started.taskId, (task) => task.state === 'running');
    await run(['cancel', '--state-dir', broker.stateDir, started.taskId]);
    const failed = await waitFor(broker.stateDir, started.taskId, (task) => task.state === 'termination_failed', 10000);
    assert.equal(failed.permitState, 'quarantined');
    assert.equal(failed.buildCapacityReleasedAt, null);
    await run(['cancel', '--state-dir', broker.stateDir, started.taskId]);
    const recovered = await waitFor(broker.stateDir, started.taskId, (task) => task.state === 'cancelled', 10000);
    assert.equal(recovered.attempt, failed.attempt);
    assert.deepEqual(recovered.processOwnership, failed.processOwnership);
    assert.equal(recovered.buildCapacityAcquiredAt, failed.buildCapacityAcquiredAt);
    assert.equal(recovered.permitState, 'released');
    assert.ok(recovered.buildCapacityReleasedAt);
    assert.equal(recovered.cancelRequestedAt, failed.cancelRequestedAt);
    assert.equal(recovered.monitorRecoveries, 1);
    assert.ok(recovered.terminationAttempts > failed.terminationAttempts);
    assert.equal(await queryOwnedJobEmpty({ adapter: 'projfs', testMode: true }, recovered.processOwnership), true);
  } finally {
    await cleanup(broker);
  }
});
