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

test('ProjFS readiness gates tasks and retains one provider and projected cwd across attempts', async () => {
  const broker = await makeProjfsBroker(1);
  try {
    await assert.rejects(
      startRaw(broker.stateDir, [process.execPath, '-e', 'process.exit(0)']),
      /requires --resource-class light\|heavy-build/,
    );
    const cwdOutput = path.join(broker.temporaryRoot, 'cwd.json');
    const first = await startRaw(broker.stateDir, [
      process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(cwdOutput)}, JSON.stringify(process.cwd()))`,
    ], ['--resource-class', 'light']);
    await waitFor(broker.stateDir, first.taskId, (task) => task.state === 'completed');
    const slotsAfterFirst = JSON.parse(await fs.readFile(path.join(broker.stateDir, 'slots.json'), 'utf8'));
    const providerPid = slotsAfterFirst.slots[0].provider.pid;
    assert.equal(slotsAfterFirst.slots[0].provider.state, 'ready');
    assert.ok(slotsAfterFirst.slots[0].provider.creationIdentity);
    assert.equal(JSON.parse(await fs.readFile(cwdOutput, 'utf8')), slotsAfterFirst.slots[0].root);

    await runIteration(broker.stateDir, first.taskId, [process.execPath, '-e', 'process.exit(0)'], ['--resource-class', 'light']);
    await waitFor(broker.stateDir, first.taskId, (task) => task.attempt === 2 && task.state === 'completed');
    const slotsAfterSecond = JSON.parse(await fs.readFile(path.join(broker.stateDir, 'slots.json'), 'utf8'));
    assert.equal(slotsAfterSecond.slots[0].provider.pid, providerPid);
    assert.doesNotThrow(() => process.kill(providerPid, 0));
  } finally {
    await cleanupProjfs(broker);
  }
});

test('ProjFS missing or inexact readiness fails closed without launching a task', async () => {
  const broker = await makeProjfsBroker(1);
  try {
    await fs.writeFile(path.join(broker.workspace, '.fake-provider-wrong-ready'), '1');
    const started = await startRaw(broker.stateDir, [process.execPath, '-e', 'process.exit(0)'], ['--resource-class', 'light']);
    const failed = await waitFor(broker.stateDir, started.taskId, (task) => task.state === 'failed');
    assert.match(failed.error, /exact PROJFS_READY/);
    assert.equal(failed.pid, null);
  } finally {
    await cleanupProjfs(broker);
  }
});

test('ProjFS base-modified quarantine blocks automation with prominent human-slot guidance', async () => {
  const broker = await makeProjfsBroker(1);
  try {
    await fs.writeFile(path.join(broker.stateDir, 'BASE_MODIFIED'), 'deterministic test guard');
    await assert.rejects(
      startRaw(broker.stateDir, [process.execPath, '-e', 'process.exit(0)'], ['--resource-class', 'light']),
      /LOWER FREEZE QUARANTINE.*BASE_MODIFIED deterministic test hook/,
    );
    const all = JSON.parse((await run(['status', '--state-dir', broker.stateDir])).stdout);
    assert.equal(all.safety.state, 'base_modified_quarantine');
    assert.equal(all.safety.quarantine.source, 'deterministic_test_hook');
    assert.match(all.safety.message, /new generation/);
    assert.doesNotMatch(all.safety.message, /human-slot create/);
  } finally {
    await cleanupProjfs(broker);
  }
});

test('ProjFS human-slot create retains named ownership, root, and provider', async () => {
  const broker = await makeProjfsBroker(1);
  try {
    const created = JSON.parse((await run([
      'human-slot', 'create', '--state-dir', broker.stateDir, '--name', 'manual-investigation',
    ])).stdout);
    assert.equal(created.name, 'manual-investigation');
    assert.equal(created.slot, 1);
    assert.match(created.root, /Workspace1$/);
    assert.equal(created.provider.state, 'ready');
    const all = JSON.parse((await run(['status', '--state-dir', broker.stateDir])).stdout);
    assert.equal(all.slots[0].humanOwner, 'manual-investigation');
    assert.equal(all.slots[0].taskId, 'human:manual-investigation');
  } finally {
    await cleanupProjfs(broker);
  }
});

test('ProjFS stale starting provider is quarantined instead of duplicated', async () => {
  const broker = await makeProjfsBroker(1);
  try {
    const first = await startRaw(broker.stateDir, [process.execPath, '-e', 'process.exit(0)'], ['--resource-class', 'light']);
    await waitFor(broker.stateDir, first.taskId, (task) => task.state === 'completed');
    const slotsPath = path.join(broker.stateDir, 'slots.json');
    const slots = JSON.parse(await fs.readFile(slotsPath, 'utf8'));
    await terminateFixtureProcess(slots.slots[0].provider.pid, slots.slots[0].provider.creationIdentity);
    await waitForProcessExit(slots.slots[0].provider.pid);
    const config = JSON.parse(await fs.readFile(path.join(broker.stateDir, 'config.json'), 'utf8'));
    slots.slots[0].provider = {
      state: 'starting', ownerUuid: config.brokerUuid, nonce: 'a'.repeat(32), pid: null, creationIdentity: null,
      jobName: `Local\\AgentWorkspace-${config.brokerUuid}-${'a'.repeat(32)}`,
      launchManifestPath: path.join(broker.stateDir, 'launches', `provider-slot-1-${'a'.repeat(32)}.json`),
      startedAt: '2000-01-01T00:00:00.000Z', readyDeadline: '2000-01-01T00:00:00.001Z',
      stdoutLogPath: path.join(broker.stateDir, 'logs', 'stale-provider.stdout.log'),
      stderrLogPath: path.join(broker.stateDir, 'logs', 'stale-provider.stderr.log'),
    };
    await fs.writeFile(slotsPath, `${JSON.stringify(slots, null, 2)}\n`);
    await runIteration(broker.stateDir, first.taskId, [process.execPath, '-e', 'process.exit(0)'], ['--resource-class', 'light']);
    const failed = await waitFor(broker.stateDir, first.taskId, (task) => task.attempt === 2 && task.state === 'failed');
    assert.match(failed.error, /exact PROJFS_READY/);
    const repaired = JSON.parse(await fs.readFile(slotsPath, 'utf8'));
    assert.equal(repaired.slots[0].provider.state, 'quarantined');
    assert.equal(repaired.slots[0].provider.pid, null);
  } finally {
    await cleanupProjfs(broker);
  }
});

test('ProjFS cancellation during provider readiness prevents task launch', async () => {
  const broker = await makeProjfsBroker(1, ['--provider-ready-timeout-ms', '1000']);
  try {
    await fs.writeFile(path.join(broker.workspace, '.fake-provider-no-ready'), '1');
    const started = await startRaw(broker.stateDir, [process.execPath, '-e', 'process.exit(0)'], ['--resource-class', 'light']);
    await run(['cancel', '--state-dir', broker.stateDir, started.taskId]);
    const cancelled = await waitFor(broker.stateDir, started.taskId, (task) => task.state === 'cancelled');
    assert.equal(cancelled.pid, null);
  } finally {
    await cleanupProjfs(broker);
  }
});

test('ProjFS initialization rejects overlaps and existing unowned roots', async () => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'projfs-root-safety-test-'));
  const lower = path.join(temporaryRoot, 'lower');
  await fs.mkdir(lower);
  try {
    await assert.rejects(run([
      'init', '--state-dir', path.join(lower, 'state'), '--workspace', lower, '--max-slots', '1', '--adapter', 'projfs', '--test-mode',
      '--provider-exe', fakeProjfsFixture, '--root-parent', path.join(temporaryRoot, 'roots'),
    ]), /must not overlap/);
    const existing = path.join(temporaryRoot, 'existing-root');
    await fs.mkdir(existing);
    await fs.writeFile(path.join(existing, 'foreign.txt'), 'do not touch');
    await assert.rejects(run([
      'init', '--state-dir', path.join(temporaryRoot, 'state'), '--workspace', lower, '--max-slots', '1', '--adapter', 'projfs', '--test-mode',
      '--provider-exe', fakeProjfsFixture, '--roots', existing,
    ]), /exclusive broker ownership cannot be proven/);
    assert.equal(await fs.readFile(path.join(existing, 'foreign.txt'), 'utf8'), 'do not touch');
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('ProjFS cleanup removes all owned state and roots, protects lower, and is idempotent', async () => {
  const broker = await makeProjfsBroker(1);
  const lowerSentinel = path.join(broker.workspace, 'protected-lower.txt');
  await fs.writeFile(lowerSentinel, 'protected');
  const rootPath = path.join(broker.rootParent, 'Workspace1');
  try {
    const guard = JSON.parse(await fs.readFile(path.join(broker.stateDir, 'lower-guard-owner.json'), 'utf8'));
    const started = await startRaw(broker.stateDir, [process.execPath, '-e', "console.log('owned-log')"], ['--resource-class', 'light']);
    await waitFor(broker.stateDir, started.taskId, (task) => task.state === 'completed');
    await fs.mkdir(path.join(broker.stateDir, 'runtime', 'private'), { recursive: true });
    await fs.writeFile(path.join(broker.stateDir, 'runtime', 'private', 'edit.tmp'), 'owned');
    const first = JSON.parse((await run(['cleanup', '--state-dir', broker.stateDir])).stdout);
    assert.equal(first.state, 'completed');
    await assert.rejects(fs.access(rootPath), { code: 'ENOENT' });
    await assert.rejects(fs.access(broker.stateDir), { code: 'ENOENT' });
    await waitForProcessExit(guard.pid);
    assert.equal(await fs.readFile(lowerSentinel, 'utf8'), 'protected');
    const second = JSON.parse((await run(['cleanup', '--state-dir', broker.stateDir])).stdout);
    assert.equal(second.idempotent, true);
  } finally {
    await cleanup(broker);
  }
});
