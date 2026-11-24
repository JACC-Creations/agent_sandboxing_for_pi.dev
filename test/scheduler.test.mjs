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

test('ProjFS termination failure quarantines an acquired permit until cleanup', async () => {
  const broker = await makeProjfsBroker(1, ['--max-concurrent-heavy-builds', '1']);
  try {
    const result = await run([
      'start', '--state-dir', broker.stateDir, '--resource-class', 'heavy-build', '--',
      process.execPath, fixture, '10000', '50', '0',
    ], { env: { AGENT_WORKSPACE_TEST_TERMINATE_FAILURE: '1' } });
    const started = JSON.parse(result.stdout);
    await waitFor(broker.stateDir, started.taskId, (task) => task.state === 'running');
    await run(['cancel', '--state-dir', broker.stateDir, started.taskId]);
    const failed = await waitFor(broker.stateDir, started.taskId, (task) => task.state === 'termination_failed', 10000);
    assert.equal(failed.permitState, 'quarantined');
    assert.equal(failed.buildCapacityReleasedAt, null);
    await run(['cleanup', '--state-dir', broker.stateDir], { timeout: 120000 });
  } finally {
    await cleanup(broker);
  }
});
