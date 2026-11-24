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

test('CLI cleanup requires the exact broker UUID and rejects all other arguments before mutation', async () => {
  const broker = await makeProjfsBroker(1);
  try {
    const config = JSON.parse(await fs.readFile(path.join(broker.stateDir, 'config.json'), 'utf8'));
    const assertUnmutated = async () => {
      await assert.doesNotReject(fs.access(broker.stateDir));
      await assert.rejects(fs.access(`${broker.stateDir}.cleanup-journal.json`), { code: 'ENOENT' });
      await assert.rejects(fs.access(path.join(broker.stateDir, 'CLEANUP_IN_PROGRESS')), { code: 'ENOENT' });
    };

    await assert.rejects(
      run(['cleanup', '--state-dir', broker.stateDir], { pinCleanup: false }),
      /--broker-uuid is required/,
    );
    await assertUnmutated();

    await assert.rejects(run([
      'cleanup', '--state-dir', broker.stateDir,
      '--broker-uuid', '00000000-0000-4000-8000-000000000000',
    ]), /broker generation changed/);
    await assertUnmutated();

    await assert.rejects(run([
      'cleanup', '--state-dir', broker.stateDir, '--broker-uuid', config.brokerUuid, '--unsupported',
    ]), /cleanup does not support --unsupported/);
    await assertUnmutated();

    await assert.rejects(run([
      'cleanup', '--state-dir', broker.stateDir, '--broker-uuid', config.brokerUuid, 'unexpected',
    ]), /cleanup does not accept/);
    await assertUnmutated();

    const cleaned = JSON.parse((await run([
      'cleanup', '--state-dir', broker.stateDir, '--broker-uuid', config.brokerUuid,
    ])).stdout);
    assert.equal(cleaned.brokerUuid, config.brokerUuid);
    assert.equal(cleaned.state, 'completed');
    await assert.rejects(fs.access(broker.stateDir), { code: 'ENOENT' });
  } finally {
    await cleanup(broker);
  }
});

test('ProjFS cleanup lifecycle lock deterministically excludes new task and human-slot allocation', async () => {
  const broker = await makeProjfsBroker(2);
  try {
    const cleaning = run(['cleanup', '--state-dir', broker.stateDir], {
      env: { AGENT_WORKSPACE_TEST_CLEANUP_AFTER_GENERATION_DELAY_MS: '500' },
    });
    await waitForPath(`${broker.stateDir}.cleanup-journal.json`);
    const attempts = Promise.allSettled([
      run([
        'start', '--state-dir', broker.stateDir, '--resource-class', 'light', '--',
        process.execPath, '-e', 'process.exit(0)',
      ]),
      run(['human-slot', 'create', '--state-dir', broker.stateDir, '--name', 'racing-human']),
    ]);
    await cleaning;
    const [startAttempt, humanAttempt] = await attempts;
    assert.equal(startAttempt.status, 'rejected');
    assert.match(startAttempt.reason.message, /cleanup is in progress|broker is not initialized|generation changed/);
    assert.equal(humanAttempt.status, 'rejected');
    assert.match(humanAttempt.reason.message, /broker is not initialized|ENOENT|generation changed/);
  } finally {
    await cleanup(broker);
  }
});

test('ProjFS cleanup serializes with provider creation and final rerun launch', async () => {
  const providerBroker = await makeProjfsBroker(1, ['--provider-ready-timeout-ms', '2000']);
  try {
    const started = await run([
      'start', '--state-dir', providerBroker.stateDir, '--resource-class', 'light', '--',
      process.execPath, '-e', 'setTimeout(() => process.exit(0), 1000)',
    ], { env: { AGENT_WORKSPACE_TEST_PROVIDER_LIFECYCLE_DELAY_MS: '500' } });
    assert.ok(JSON.parse(started.stdout).taskId);
    await waitForProviderState(providerBroker.stateDir, 'starting');
    const cleaned = JSON.parse((await run(['cleanup', '--state-dir', providerBroker.stateDir], { timeout: 120000 })).stdout);
    assert.equal(cleaned.state, 'completed');
    await assert.rejects(fs.access(providerBroker.stateDir), { code: 'ENOENT' });
  } finally {
    await cleanup(providerBroker);
  }

  const taskBroker = await makeProjfsBroker(1, ['--provider-ready-timeout-ms', '2000']);
  try {
    const first = await startRaw(taskBroker.stateDir, [process.execPath, '-e', 'process.exit(0)'], ['--resource-class', 'light']);
    await waitFor(taskBroker.stateDir, first.taskId, (task) => task.state === 'completed');
    await run([
      'run', '--state-dir', taskBroker.stateDir, first.taskId, '--resource-class', 'light', '--',
      process.execPath, '-e', 'setTimeout(() => process.exit(0), 1000)',
    ], { env: { AGENT_WORKSPACE_TEST_TASK_LAUNCH_DELAY_MS: '500' } });
    await waitFor(taskBroker.stateDir, first.taskId, (task) => Boolean(task.launchAttemptedAt));
    const cleaned = JSON.parse((await run(['cleanup', '--state-dir', taskBroker.stateDir], { timeout: 120000 })).stdout);
    assert.equal(cleaned.state, 'completed');
  } finally {
    await cleanup(taskBroker);
  }
});

test('ProjFS cleanup fails closed when a live provider identity remains unqueryable', async () => {
  const broker = await makeProjfsBroker(1);
  try {
    await run(['human-slot', 'create', '--state-dir', broker.stateDir, '--name', 'unknown-provider']);
    const slots = JSON.parse(await fs.readFile(path.join(broker.stateDir, 'slots.json'), 'utf8'));
    const providerPid = slots.slots[0].provider.pid;
    await assert.rejects(run(['cleanup', '--state-dir', broker.stateDir], {
      env: { AGENT_WORKSPACE_TEST_IDENTITY_UNAVAILABLE_PID: String(providerPid) },
    }), /identity is unknown-live/);
    assert.doesNotReject(fs.access(broker.stateDir));
    await run(['cleanup', '--state-dir', broker.stateDir]);
  } finally {
    await cleanup(broker);
  }
});

test('ProjFS cleanup fails closed when guard identity remains unqueryable', async () => {
  const broker = await makeProjfsBroker(1);
  try {
    const guard = JSON.parse(await fs.readFile(path.join(broker.stateDir, 'lower-guard-owner.json'), 'utf8'));
    await assert.rejects(run(['cleanup', '--state-dir', broker.stateDir], {
      env: { AGENT_WORKSPACE_TEST_IDENTITY_UNAVAILABLE_PID: String(guard.pid) },
    }), /lower-freeze guard survived cleanup: guard process identity is unverifiable/);
    assert.doesNotReject(fs.access(broker.stateDir));
    await run(['cleanup', '--state-dir', broker.stateDir]);
  } finally {
    await cleanup(broker);
  }
});

test('ProjFS cleanup resumes a root deletion interrupted after its ownership marker was removed', async () => {
  const broker = await makeProjfsBroker(1);
  try {
    await assert.rejects(run(['cleanup', '--state-dir', broker.stateDir], {
      env: { AGENT_WORKSPACE_TEST_INTERRUPT_ROOT_DELETION: '1' },
    }), /simulated interruption after root deletion intent/);
    const journal = JSON.parse(await fs.readFile(`${broker.stateDir}.cleanup-journal.json`, 'utf8'));
    assert.equal(journal.rootDeletionIntents.length, 1);
    const rootPath = path.join(broker.rootParent, 'Workspace1');
    assert.equal(journal.rootDeletionIntents[0].path, rootPath);
    await assert.rejects(fs.access(path.join(rootPath, '.agent-workspace-owner.json')), { code: 'ENOENT' });
    await run(['cleanup', '--state-dir', broker.stateDir]);
    await assert.rejects(fs.access(rootPath), { code: 'ENOENT' });
  } finally {
    await cleanup(broker);
  }
});

test('ProjFS cleanup receipt cannot complete a reinitialized generation at the same path', async () => {
  const broker = await makeProjfsBroker(1);
  try {
    const firstConfig = JSON.parse(await fs.readFile(path.join(broker.stateDir, 'config.json'), 'utf8'));
    await run(['cleanup', '--state-dir', broker.stateDir]);
    await run([
      'init', '--state-dir', broker.stateDir, '--workspace', broker.workspace,
      '--max-slots', '1', '--adapter', 'projfs', '--test-mode', '--poll-ms', '25',
      '--provider-exe', fakeProjfsFixture, '--root-parent', broker.rootParent,
      '--provider-ready-timeout-ms', '300', '--build-wait-timeout-ms', '2000',
    ]);
    const secondConfig = JSON.parse(await fs.readFile(path.join(broker.stateDir, 'config.json'), 'utf8'));
    assert.notEqual(secondConfig.brokerUuid, firstConfig.brokerUuid);
    const cleaned = JSON.parse((await run(['cleanup', '--state-dir', broker.stateDir])).stdout);
    assert.equal(cleaned.brokerUuid, secondConfig.brokerUuid);
    await assert.rejects(fs.access(broker.stateDir), { code: 'ENOENT' });
  } finally {
    await cleanup(broker);
  }
});

test('ProjFS cleanup refuses tampered ownership and never touches lower', async () => {
  const broker = await makeProjfsBroker(1);
  const rootPath = path.join(broker.rootParent, 'Workspace1');
  const markerPath = path.join(rootPath, '.agent-workspace-owner.json');
  const lowerSentinel = path.join(broker.workspace, 'protected-lower.txt');
  try {
    await fs.writeFile(lowerSentinel, 'protected');
    const marker = JSON.parse(await fs.readFile(markerPath, 'utf8'));
    marker.brokerUuid = 'tampered-owner';
    await fs.writeFile(markerPath, `${JSON.stringify(marker, null, 2)}\n`);
    await assert.rejects(run(['cleanup', '--state-dir', broker.stateDir]), /ownership marker is missing or tampered/);
    assert.equal(await fs.readFile(lowerSentinel, 'utf8'), 'protected');
    assert.doesNotReject(fs.access(rootPath));
    assert.doesNotReject(fs.access(broker.stateDir));
  } finally {
    await cleanup(broker);
  }
});

test('ProjFS final owned-Job fence recovers stale completed stop phases', async () => {
  const broker = await makeProjfsBroker(1);
  try {
    await run(['human-slot', 'create', '--state-dir', broker.stateDir, '--name', 'stop-failure']);
    await assert.rejects(run(['cleanup', '--state-dir', broker.stateDir], {
      env: { AGENT_WORKSPACE_TEST_STOP_FAILURE: '1', AGENT_WORKSPACE_TEST_TERMINATE_FAILURE: '1' },
    }), /provider for slot 1 survived cleanup/);
    const slots = JSON.parse(await fs.readFile(path.join(broker.stateDir, 'slots.json'), 'utf8'));
    assert.equal(slots.slots[0].provider.state, 'termination_failed');
    assert.doesNotReject(fs.access(slots.slots[0].root));

    const journalPath = `${broker.stateDir}.cleanup-journal.json`;
    const journal = JSON.parse(await fs.readFile(journalPath, 'utf8'));
    journal.state = 'in_progress';
    journal.errors = [];
    const completedAt = new Date().toISOString();
    journal.phases.stop_providers = { completedAt };
    journal.phases.stop_generation_supervisor = { completedAt };
    journal.phases.stop_lower_guard = { completedAt };
    delete journal.phases.owned_jobs_stopped;
    await fs.writeFile(journalPath, `${JSON.stringify(journal, null, 2)}\n`);

    await run(['cleanup', '--state-dir', broker.stateDir]);
  } finally {
    await cleanup(broker);
  }
});

test('ProjFS human provisioning failures remain visible as quarantined owner state', async () => {
  const broker = await makeProjfsBroker(1);
  try {
    await fs.writeFile(path.join(broker.workspace, '.fake-provider-wrong-ready'), '1');
    await assert.rejects(run(['human-slot', 'create', '--state-dir', broker.stateDir, '--name', 'broken']), /exact PROJFS_READY/);
    const all = JSON.parse((await run(['status', '--state-dir', broker.stateDir])).stdout);
    assert.equal(all.slots[0].humanOwnerState, 'quarantined');
    assert.equal(all.humanOwnerCounts.quarantined, 1);
  } finally {
    await cleanupProjfs(broker);
  }
});

test('ProjFS starting provider ownership is adopted after monitor crash without duplicate launch', async () => {
  const broker = await makeProjfsBroker(1, ['--provider-ready-timeout-ms', '6000']);
  try {
    await fs.writeFile(path.join(broker.workspace, '.fake-provider-delay-ready'), '3000');
    const started = await startRaw(broker.stateDir, [process.execPath, '-e', 'process.exit(0)'], ['--resource-class', 'light']);
    const slotsPath = path.join(broker.stateDir, 'slots.json');
    let providerPid = null;
    let monitorPid = null;
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && !providerPid) {
      const [slots, task] = await Promise.all([
        fs.readFile(slotsPath, 'utf8').then(JSON.parse),
        fs.readFile(path.join(broker.stateDir, 'tasks', `${started.taskId}.json`), 'utf8').then(JSON.parse),
      ]);
      providerPid = slots.slots[0].provider?.pid ?? null;
      monitorPid = task.monitorPid;
      if (!providerPid) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(providerPid);
    await terminateFixtureMonitor(monitorPid);
    await waitForProcessExit(monitorPid);
    const configPath = path.join(broker.stateDir, 'config.json');
    const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
    config.monitorStaleMs = 200;
    await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await new Promise((resolve) => setTimeout(resolve, 250));
    await run(['status', '--state-dir', broker.stateDir, started.taskId]);
    const completed = await waitFor(broker.stateDir, started.taskId, (task) => task.state === 'completed', 10000);
    assert.equal(completed.exitCode, 0);
    const slots = JSON.parse(await fs.readFile(slotsPath, 'utf8'));
    assert.equal(slots.slots[0].provider.pid, providerPid);
    assert.equal(slots.slots[0].provider.state, 'ready');
  } finally {
    await cleanupProjfs(broker);
  }
});
