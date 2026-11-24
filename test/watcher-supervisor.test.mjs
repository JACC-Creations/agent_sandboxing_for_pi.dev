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

test('ProjFS fake live watcher mutation evidence quarantines and blocks provider launch with safe recovery UX', async () => {
  const broker = await makeProjfsBroker(1);
  try {
    const controlPath = path.join(broker.workspace, '.fake-lower-guard.json');
    await fs.writeFile(controlPath, JSON.stringify({
      quarantine: true,
      reason: 'lower watcher reported a root identity change',
      paths: [{ path: path.join(broker.workspace, 'changed.txt') }],
    }));
    await new Promise((resolve) => setTimeout(resolve, 150));
    const baseStatus = JSON.parse((await run(['base-change', 'status', '--state-dir', broker.stateDir])).stdout);
    assert.equal(baseStatus.safety.quarantined, true);
    assert.equal(baseStatus.safety.quarantine.reason, 'lower watcher reported a root identity change');
    await assert.rejects(
      startRaw(broker.stateDir, [process.execPath, '-e', 'process.exit(0)'], ['--resource-class', 'light']),
      /lower watcher reported a root identity change/,
    );
    const slots = JSON.parse(await fs.readFile(path.join(broker.stateDir, 'slots.json'), 'utf8'));
    assert.equal(slots.slots[0].provider, null);
    const planned = JSON.parse((await run([
      'base-change', 'plan-new-generation', '--state-dir', broker.stateDir, '--acknowledge-safe-boundary',
    ])).stdout);
    assert.equal(planned.planning.safeToResume, false);
    assert.equal(planned.planning.rootsReusable, false);
  } finally {
    await cleanupProjfs(broker);
  }
});

test('ProjFS guard ignores outside-lower activity and is adopted across broker CLI restarts', async () => {
  const broker = await makeProjfsBroker(1);
  try {
    const firstOwner = JSON.parse(await fs.readFile(path.join(broker.stateDir, 'lower-guard-owner.json'), 'utf8'));
    const supervisorOwner = JSON.parse(await fs.readFile(path.join(broker.stateDir, 'generation-supervisor-owner.json'), 'utf8'));
    await fs.writeFile(path.join(broker.temporaryRoot, 'outside-lower.txt'), 'outside');
    const first = JSON.parse((await run(['status', '--state-dir', broker.stateDir])).stdout);
    const second = JSON.parse((await run(['status', '--state-dir', broker.stateDir])).stdout);
    assert.equal(first.safety.quarantined, false);
    assert.equal(second.safety.guard.pid, firstOwner.pid);
    assert.equal(second.safety.supervisor.pid, supervisorOwner.pid);
    assert.doesNotThrow(() => process.kill(firstOwner.pid, 0));
    assert.doesNotThrow(() => process.kill(supervisorOwner.pid, 0));
  } finally {
    await cleanupProjfs(broker);
  }
});

test('ProjFS guard startup failure fails initialization closed', async () => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'projfs-guard-startup-test-'));
  const workspace = path.join(temporaryRoot, 'lower');
  const stateDir = path.join(temporaryRoot, 'state');
  await fs.mkdir(workspace);
  try {
    await assert.rejects(run([
      'init', '--state-dir', stateDir, '--workspace', workspace, '--max-slots', '1', '--adapter', 'projfs', '--test-mode',
      '--provider-exe', fakeProjfsFixture, '--root-parent', path.join(temporaryRoot, 'roots'),
      '--lower-guard-ready-timeout-ms', '1000',
    ], { env: { AGENT_WORKSPACE_TEST_GUARD_STARTUP_FAILURE: '1' } }), /lower-freeze guard/);
    const quarantine = JSON.parse(await fs.readFile(path.join(stateDir, 'lower-quarantine.json'), 'utf8'));
    assert.match(quarantine.reason, /startup\/readiness failed/);
  } finally {
    const owner = await fs.readFile(path.join(stateDir, 'lower-guard-owner.json'), 'utf8').then(JSON.parse, () => null);
    await terminateFixtureProcess(owner?.pid, owner?.creationIdentity);
    await fs.rm(temporaryRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test('ProjFS guard death becomes durable quarantine', async () => {
  const broker = await makeProjfsBroker(1, ['--lower-guard-heartbeat-stale-ms', '1000']);
  try {
    const owner = JSON.parse(await fs.readFile(path.join(broker.stateDir, 'lower-guard-owner.json'), 'utf8'));
    await terminateFixtureProcess(owner.pid, owner.creationIdentity);
    await waitForProcessExit(owner.pid);
    const quarantinePath = path.join(broker.stateDir, 'lower-quarantine.json');
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !await fs.access(quarantinePath).then(() => true, () => false)) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(await fs.access(quarantinePath).then(() => true, () => false), true);
    const all = JSON.parse((await run(['status', '--state-dir', broker.stateDir])).stdout);
    assert.equal(all.safety.quarantined, true);
    assert.match(all.safety.quarantine.reason, /guard process died|died or its process identity became unverifiable|heartbeat\/checkpoint is stale/);
  } finally {
    await cleanupProjfs(broker);
  }
});

test('ProjFS fake overflow, watcher error, and identity failures each fail closed', async () => {
  for (const reason of [
    'directory notification buffer overflow',
    'directory watcher failed',
    'lower root identity or path changed',
  ]) {
    const broker = await makeProjfsBroker(1);
    try {
      await fs.writeFile(path.join(broker.workspace, '.fake-lower-guard.json'), JSON.stringify({ quarantine: true, reason }));
      await new Promise((resolve) => setTimeout(resolve, 150));
      const result = JSON.parse((await run(['base-change', 'status', '--state-dir', broker.stateDir])).stdout);
      assert.equal(result.safety.quarantined, true);
      assert.equal(result.safety.quarantine.reason, reason);
    } finally {
      await cleanupProjfs(broker);
    }
  }
});

test('ProjFS provider death fails a running task closed and does not replace the retained provider', async () => {
  const broker = await makeProjfsBroker(1);
  try {
    const started = await startRaw(broker.stateDir, [process.execPath, fixture, '10000', '50', '0'], ['--resource-class', 'light']);
    await waitFor(broker.stateDir, started.taskId, (task) => task.state === 'running' && task.launcherIdentity);
    const slots = JSON.parse(await fs.readFile(path.join(broker.stateDir, 'slots.json'), 'utf8'));
    const provider = slots.slots[0].provider;
    const providerPid = provider.pid;
    await terminateFixtureProcess(providerPid, provider.creationIdentity);
    const failed = await waitFor(broker.stateDir, started.taskId, (task) => task.state === 'failed', 15000);
    assert.match(failed.error, /provider died/);
    const retained = JSON.parse(await fs.readFile(path.join(broker.stateDir, 'slots.json'), 'utf8'));
    assert.equal(retained.slots[0].provider.pid, providerPid);
  } finally {
    await cleanupProjfs(broker);
  }
});

test('generation supervisor immediately stops an idle human provider on mutation', async () => {
  const broker = await makeProjfsBroker(1);
  try {
    await run(['human-slot', 'create', '--state-dir', broker.stateDir, '--name', 'idle-human']);
    await fs.writeFile(path.join(broker.workspace, '.fake-lower-guard.json'), JSON.stringify({
      quarantine: true,
      reason: 'sealed lower changed',
      action: 'modified',
      path: 'changed.txt',
    }));
    const slotsPath = path.join(broker.stateDir, 'slots.json');
    const deadline = Date.now() + 5000;
    let providerState;
    while (Date.now() < deadline) {
      providerState = JSON.parse(await fs.readFile(slotsPath, 'utf8')).slots[0].provider?.state;
      if (providerState === 'quarantined') break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(providerState, 'quarantined');
  } finally {
    await cleanupProjfs(broker);
  }
});

test('ProjFS quarantine cancels queued and immediate-prelaunch attempts', async () => {
  const queuedBroker = await makeProjfsBroker(2, ['--max-concurrent-heavy-builds', '1', '--build-wait-timeout-ms', '10000']);
  try {
    const first = await startRaw(queuedBroker.stateDir, [process.execPath, fixture, '5000', '50', '0'], ['--resource-class', 'heavy-build']);
    await waitFor(queuedBroker.stateDir, first.taskId, (task) => task.state === 'running');
    const second = await startRaw(queuedBroker.stateDir, [process.execPath, '-e', 'process.exit(0)'], ['--resource-class', 'heavy-build']);
    await waitFor(queuedBroker.stateDir, second.taskId, (task) => task.state === 'WAITING_FOR_BUILD_CAPACITY');
    await fs.writeFile(path.join(queuedBroker.workspace, '.fake-lower-guard.json'), JSON.stringify({
      quarantine: true,
      reason: 'sealed lower changed',
      paths: [{ path: path.join(queuedBroker.workspace, 'changed.cpp') }],
    }));
    const cancelled = await waitFor(queuedBroker.stateDir, second.taskId, (task) => task.state === 'cancelled');
    assert.equal(cancelled.pid, null);
    await waitFor(queuedBroker.stateDir, first.taskId, (task) => task.state === 'cancelled');
    const quarantinedSlots = JSON.parse(await fs.readFile(path.join(queuedBroker.stateDir, 'slots.json'), 'utf8'));
    assert.equal(quarantinedSlots.slots[0].provider.state, 'quarantined');
    assert.equal(quarantinedSlots.slots[1].provider.state, 'quarantined');
  } finally {
    await cleanupProjfs(queuedBroker);
  }

  const prelaunchBroker = await makeProjfsBroker(1);
  try {
    const result = await run([
      'start', '--state-dir', prelaunchBroker.stateDir, '--resource-class', 'light', '--',
      process.execPath, '-e', 'process.exit(0)',
    ], { env: { AGENT_WORKSPACE_TEST_PRELAUNCH_DELAY_MS: '500' } });
    const started = JSON.parse(result.stdout);
    await fs.writeFile(path.join(prelaunchBroker.stateDir, 'BASE_MODIFIED'), 'test quarantine');
    const cancelled = await waitFor(prelaunchBroker.stateDir, started.taskId, (task) => task.state === 'cancelled');
    assert.equal(cancelled.pid, null);
  } finally {
    await cleanupProjfs(prelaunchBroker);
  }
});
