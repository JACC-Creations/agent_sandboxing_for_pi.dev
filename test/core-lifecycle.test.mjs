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

test('start acknowledges its detached monitor and reports durable progress', async () => {
  const broker = await makeBroker();
  try {
    const before = Date.now();
    const started = await start(broker.stateDir, 1500);
    const returnTimeMs = Date.now() - before;
    assert.ok(returnTimeMs < 5000, `start took ${returnTimeMs}ms`);
    assert.match(started.taskId, /^\d{14}-[0-9a-f]{12}$/);
    assert.ok(started.monitorPid > 0);
    assert.equal(Object.hasOwn(started, 'monitorToken'), false);

    const running = await waitFor(
      broker.stateDir,
      started.taskId,
      (task) => task.state === 'running' && task.logBytes > 0,
    );
    assert.equal(running.slotName, 'Workspace1');
    assert.equal(running.slot, 1);
    assert.equal(running.virtualLogPath, running.logPath);
    assert.ok(running.pid > 0);
    assert.ok(running.launcherIdentity);
    assert.ok(running.pids.includes(running.monitorPid));
    assert.ok(running.pids.includes(running.pid));

    const log = await run(['logs', '--state-dir', broker.stateDir, started.taskId]);
    assert.match(log.stdout, /task-started/);

    const completed = await waitFor(
      broker.stateDir,
      started.taskId,
      (task) => task.state === 'completed',
      15000,
    );
    assert.equal(completed.exitCode, 0);
    assert.ok(completed.finishedAt);
  } finally {
    await cleanup(broker);
  }
});

test('timeout terminates a spawned child process tree', async () => {
  const broker = await makeBroker();
  const childPidPath = path.join(broker.temporaryRoot, 'timeout-child.pid');
  try {
    const started = await start(broker.stateDir, 10000, ['--timeout-ms', '300'], childPidPath);
    const task = await waitFor(
      broker.stateDir,
      started.taskId,
      (candidate) => candidate.state === 'timed_out',
      10000,
    );
    const childPid = Number(await fs.readFile(childPidPath, 'utf8'));
    assert.equal(task.timedOut, true);
    assert.ok(task.terminationAttempts >= 1);
    await waitForProcessExit(childPid);
  } finally {
    await cleanup(broker);
  }
});

test('cancel terminates a spawned child process tree', async () => {
  const broker = await makeBroker();
  const childPidPath = path.join(broker.temporaryRoot, 'cancel-child.pid');
  try {
    const started = await start(broker.stateDir, 10000, [], childPidPath);
    await waitFor(broker.stateDir, started.taskId, (task) => task.state === 'running');
    await waitForPath(childPidPath);
    const childPid = Number(await fs.readFile(childPidPath, 'utf8'));
    const cancelled = await run(['cancel', '--state-dir', broker.stateDir, started.taskId]);
    assert.equal(JSON.parse(cancelled.stdout).state, 'cancel_requested');
    const task = await waitFor(
      broker.stateDir,
      started.taskId,
      (candidate) => candidate.state === 'cancelled',
      10000,
    );
    assert.ok(task.cancelRequestedAt);
    assert.ok(task.cancelledAt);
    await waitForProcessExit(childPid);
  } finally {
    await cleanup(broker);
  }
});

test('stale monitor is adopted and timeout enforcement survives monitor death', async () => {
  const broker = await makeBroker();
  const childPidPath = path.join(broker.temporaryRoot, 'recovery-child.pid');
  try {
    const started = await start(broker.stateDir, 15000, ['--timeout-ms', '500'], childPidPath);
    const running = await waitFor(broker.stateDir, started.taskId, (task) => task.state === 'running');
    const configPath = path.join(broker.stateDir, 'config.json');
    const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
    config.monitorStaleMs = 500;
    await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await terminateFixtureMonitor(running.monitorPid);
    await new Promise((resolve) => setTimeout(resolve, 550));
    await run(['status', '--state-dir', broker.stateDir, started.taskId]);
    const recovered = await waitFor(
      broker.stateDir,
      started.taskId,
      (task) => task.state === 'timed_out' && task.monitorRecoveries >= 1,
      10000,
    );
    assert.equal(recovered.exitCodeUnknown, true);
    const childPid = Number(await fs.readFile(childPidPath, 'utf8'));
    await waitForProcessExit(childPid);
  } finally {
    await cleanup(broker);
  }
});

test('recovery does not kill a PID whose creation identity no longer matches', async () => {
  const broker = await makeBroker();
  try {
    const started = await start(broker.stateDir, 15000);
    const running = await waitFor(broker.stateDir, started.taskId, (task) => task.state === 'running');
    await terminateFixtureMonitor(running.monitorPid);
    await waitForProcessExit(running.monitorPid);

    const configPath = path.join(broker.stateDir, 'config.json');
    const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
    config.monitorStaleMs = 1000;
    await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

    const taskPath = path.join(broker.stateDir, 'tasks', `${started.taskId}.json`);
    const task = JSON.parse(await fs.readFile(taskPath, 'utf8'));
    task.launcherIdentity = 'reused-pid-sentinel';
    task.heartbeatAt = '2000-01-01T00:00:00.000Z';
    await fs.writeFile(taskPath, `${JSON.stringify(task, null, 2)}\n`);

    await run(['status', '--state-dir', broker.stateDir, started.taskId]);
    const recovered = await waitFor(broker.stateDir, started.taskId, (candidate) => candidate.state === 'failed', 30000);
    assert.equal(recovered.exitCodeUnknown, true);
    assert.doesNotThrow(() => process.kill(running.pid, 0));
    await terminateFixtureProcess(running.pid, running.launcherIdentity);
    await waitForProcessExit(running.pid, 5000);
  } finally {
    await cleanup(broker);
  }
});

test('runner combines stdout and stderr and returns the requested child exit code', async () => {
  const broker = await makeBroker();
  try {
    const script = "process.stdout.write('stdout-line\\n'); process.stderr.write('stderr-line\\n'); process.exitCode = 23";
    const started = await startRaw(broker.stateDir, [process.execPath, '-e', script]);
    const failed = await waitFor(broker.stateDir, started.taskId, (task) => task.state === 'failed');
    assert.equal(failed.exitCode, 23);
    const log = (await run(['logs', '--state-dir', broker.stateDir, started.taskId])).stdout;
    assert.match(log, /stdout-line/);
    assert.match(log, /stderr-line/);
  } finally {
    await cleanup(broker);
  }
});

test('retained task iterations preserve identity, history, lifecycle data, and logs', async () => {
  const broker = await makeBroker();
  try {
    const first = await startRaw(broker.stateDir, [
      process.execPath, '-e', "console.log('attempt-one'); process.exitCode = 23",
    ]);
    const failed = await waitFor(broker.stateDir, first.taskId, (task) => task.state === 'failed');
    assert.equal(failed.attempt, 1);
    assert.deepEqual(failed.attempts, []);

    const second = await runIteration(broker.stateDir, first.taskId, [
      process.execPath, '-e', "console.log('attempt-two')",
    ]);
    assert.equal(Object.hasOwn(second, 'monitorToken'), false);
    assert.equal(second.taskId, first.taskId);
    assert.equal(second.attempt, 2);
    const completed = await waitFor(
      broker.stateDir,
      first.taskId,
      (task) => task.attempt === 2 && task.state === 'completed',
    );
    assert.equal(completed.slot, failed.slot);
    assert.equal(completed.slotName, failed.slotName);
    assert.equal(completed.attempts.length, 1);
    const archivedFailure = completed.attempts[0];
    assert.equal(archivedFailure.attempt, 1);
    assert.equal(archivedFailure.state, 'failed');
    assert.equal(archivedFailure.exitCode, 23);
    assert.ok(archivedFailure.startedAt);
    assert.ok(archivedFailure.finishedAt);
    assert.ok(archivedFailure.pid > 0);
    assert.ok(Object.hasOwn(archivedFailure, 'launcherIdentity'));
    assert.ok(archivedFailure.pids.length >= 2);
    assert.ok(archivedFailure.logBytes > 0);
    assert.ok(archivedFailure.logMtime);
    assert.notEqual(archivedFailure.logPath, completed.logPath);
    assert.notEqual(archivedFailure.virtualLogPath, completed.virtualLogPath);
    assert.deepEqual(archivedFailure.command.slice(0, 2), [process.execPath, '-e']);
    assert.equal(archivedFailure.timedOut, false);
    assert.equal(archivedFailure.cancelRequestedAt, null);
    assert.equal(archivedFailure.terminationAttempts, 0);

    const oldLog = await run(['logs', '--state-dir', broker.stateDir, first.taskId, '--attempt', '1']);
    const currentLog = await run(['logs', '--state-dir', broker.stateDir, first.taskId]);
    assert.match(oldLog.stdout, /attempt-one/);
    assert.match(currentLog.stdout, /attempt-two/);

    await runIteration(
      broker.stateDir,
      first.taskId,
      [process.execPath, fixture, '10000', '50', '0'],
      ['--timeout-ms', '150'],
    );
    await waitFor(broker.stateDir, first.taskId, (task) => task.attempt === 3 && task.state === 'timed_out');

    await runIteration(broker.stateDir, first.taskId, [process.execPath, fixture, '10000', '50', '0']);
    await waitFor(broker.stateDir, first.taskId, (task) => task.attempt === 4 && task.state === 'running');
    await run(['cancel', '--state-dir', broker.stateDir, first.taskId]);
    await waitFor(broker.stateDir, first.taskId, (task) => task.attempt === 4 && task.state === 'cancelled');

    await runIteration(broker.stateDir, first.taskId, [process.execPath, '-e', "console.log('attempt-five')"]);
    const final = await waitFor(
      broker.stateDir,
      first.taskId,
      (task) => task.attempt === 5 && task.state === 'completed',
    );
    assert.deepEqual(final.attempts.map((attempt) => attempt.state), ['failed', 'completed', 'timed_out', 'cancelled']);
    assert.equal(final.attempts[2].timedOut, true);
    assert.ok(final.attempts[2].terminationAttempts >= 1);
    assert.ok(final.attempts[3].cancelRequestedAt);
    assert.ok(final.attempts[3].cancelledAt);
    assert.ok(final.attempts[3].terminationAttempts >= 1);

    const all = JSON.parse((await run(['status', '--state-dir', broker.stateDir])).stdout);
    assert.equal(all.tasks.length, 1);
    assert.equal(all.slots[0].taskId, first.taskId);
  } finally {
    await cleanup(broker);
  }
});

test('concurrent retained-task reruns admit exactly one iteration', async () => {
  const broker = await makeBroker();
  try {
    const first = await start(broker.stateDir, 50);
    await waitFor(broker.stateDir, first.taskId, (task) => task.state === 'completed');
    const command = [process.execPath, fixture, '250', '50', '0'];
    const results = await Promise.allSettled([
      runIteration(broker.stateDir, first.taskId, command),
      runIteration(broker.stateDir, first.taskId, command),
    ]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
    assert.match(results.find((result) => result.status === 'rejected').reason.message, /is not terminal|rerun is already in progress/);

    const completed = await waitFor(
      broker.stateDir,
      first.taskId,
      (task) => task.attempt === 2 && task.state === 'completed',
    );
    assert.equal(completed.attempts.length, 1);
    assert.equal(completed.attempts[0].attempt, 1);
  } finally {
    await cleanup(broker);
  }
});

test('rerun monitor startup failure is persisted on the new attempt', async () => {
  const broker = await makeBroker();
  try {
    const first = await start(broker.stateDir, 50);
    await waitFor(broker.stateDir, first.taskId, (task) => task.state === 'completed');
    await assert.rejects(
      runIteration(
        broker.stateDir,
        first.taskId,
        [process.execPath, '-e', "console.log('must-not-run')"],
        [],
        { env: { AGENT_WORKSPACE_TEST_MONITOR_STARTUP_FAILURE: '1' } },
      ),
      /monitor failed to start/,
    );
    const task = await status(broker.stateDir, first.taskId);
    assert.equal(task.attempt, 2);
    assert.equal(task.state, 'failed');
    assert.match(task.error, /monitor launch failed/);
    assert.equal(task.attempts.length, 1);
    assert.equal(task.attempts[0].state, 'completed');
    assert.equal(task.pid, null);
  } finally {
    await cleanup(broker);
  }
});
