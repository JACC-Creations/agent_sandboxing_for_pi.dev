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
import { atomicWriteJson, syncContainingDirectory } from '../src/state.mjs';

test('atomic directory sync tolerates only documented unsupported errors and fails closed otherwise', async () => {
  const fakeFileSystem = (code, closed) => ({
    async open() {
      return {
        async sync() { throw Object.assign(new Error(code), { code }); },
        async close() { closed.value = true; },
      };
    },
  });
  for (const code of ['EINVAL', 'ENOTSUP', 'EISDIR']) {
    const closed = { value: false };
    await syncContainingDirectory('ignored', fakeFileSystem(code, closed));
    assert.equal(closed.value, true);
  }
  for (const code of ['EIO', 'EPERM', 'EACCES']) {
    const closed = { value: false };
    await assert.rejects(syncContainingDirectory('ignored', fakeFileSystem(code, closed), 'win32'), { code });
    assert.equal(closed.value, true);
  }
});

test('Windows atomic JSON fails closed when durable replacement fails', async () => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'atomic-json-fault-'));
  const target = path.join(temporaryRoot, 'state.json');
  await fs.writeFile(target, '{"generation":"old"}\n');
  try {
    await assert.rejects(atomicWriteJson(target, { generation: 'new' }, {
      platform: 'win32',
      durableReplace: async () => { throw Object.assign(new Error('replace denied'), { code: 'EACCES' }); },
    }), { code: 'EACCES' });
    assert.deepEqual(JSON.parse(await fs.readFile(target, 'utf8')), { generation: 'old' });
    assert.deepEqual(await fs.readdir(temporaryRoot), ['state.json']);
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('filesystem lock will not steal from a live owner and reclaims a dead stale owner', async () => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-workspace-lock-test-'));
  try {
    await withLock(temporaryRoot, 'live', async () => {
      await assert.rejects(
        withLock(temporaryRoot, 'live', async () => {}, { timeoutMs: 160, staleMs: 60, heartbeatMs: 20 }),
        /timed out waiting for state lock/,
      );
    }, { staleMs: 60, heartbeatMs: 20 });

    const lockPath = path.join(temporaryRoot, 'locks', 'stale.lock');
    await fs.mkdir(lockPath, { recursive: true });
    await fs.writeFile(path.join(lockPath, 'owner.json'), JSON.stringify({
      token: 'former-owner',
      pid: 2147483647,
      acquiredAt: '2000-01-01T00:00:00.000Z',
      heartbeatAt: '2000-01-01T00:00:00.000Z',
    }));
    let entered = false;
    await withLock(temporaryRoot, 'stale', async () => { entered = true; }, { timeoutMs: 1000, staleMs: 10 });
    assert.equal(entered, true);
    await assert.rejects(fs.access(lockPath), { code: 'ENOENT' });
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('recovery treats unavailable identity for a live PID as unknown, not exited', () => {
  assert.equal(classifyLauncherIdentity(null, 'win:expected', true), 'unknown-live');
  assert.equal(classifyLauncherIdentity('win:expected', 'win:expected', true), 'matching');
  assert.equal(classifyLauncherIdentity(null, 'win:expected', false), 'exited-or-reused');
  assert.equal(classifyLauncherIdentity('win:other', 'win:expected', true), 'exited-or-reused');
});

test('arguments round-trip through the CLI without shell interpolation', async () => {
  const broker = await makeBroker();
  const outputPath = path.join(broker.workspace, 'argv.json');
  const expected = ['space value', 'quote"value', '', 'ends-with-backslash\\', '\\server\\path with space\\'];
  try {
    const started = await startRaw(broker.stateDir, [process.execPath, argvFixture, outputPath, ...expected]);
    await waitFor(broker.stateDir, started.taskId, (task) => task.state === 'completed');
    assert.deepEqual(JSON.parse(await fs.readFile(outputPath, 'utf8')), expected);

    const production = buildLaunch(
      { adapter: 'projfs' },
      { virtualLogPath: 'D:\\broker\\logs\\task.log', command: ['program.exe', ...expected] },
    );
    assert.equal(production.executable, process.execPath);
    assert.match(production.args[0], /task-runner\.mjs$/);
    assert.deepEqual(production.args.slice(1), ['--', 'D:\\broker\\logs\\task.log', 'program.exe', ...expected]);

    const authenticated = buildLaunch(
      {
        adapter: 'projfs',
        auth: { enabled: true, tokenFile: 'C:\\token.json', hordeUrl: 'https://horde.example.test', minValidMs: 300000 },
      },
      {
        virtualLogPath: 'D:\\broker\\logs\\task.log',
        command: ['program.exe'],
        authEnabled: true,
        timeoutMs: 720000,
      },
    );
    const minimumIndex = authenticated.args.indexOf('--horde-min-valid-ms');
    assert.equal(authenticated.args[minimumIndex + 1], '780000');
  } finally {
    await cleanup(broker);
  }
});

test('secret redaction covers every chunk boundary and repeated occurrences', () => {
  const secret = 'token-value';
  const input = `before:${secret}:middle:${secret}:after`;
  for (let split = 0; split <= input.length; split += 1) {
    const redactor = createSecretRedactor(secret);
    const output = redactor.push(Buffer.from(input.slice(0, split)))
      + redactor.push(Buffer.from(input.slice(split)))
      + redactor.finish();
    assert.equal(output, 'before:[REDACTED]:middle:[REDACTED]:after');
  }

  const redactor = createSecretRedactor(secret);
  const output = [...Buffer.from(input)].map((byte) => redactor.push(Buffer.from([byte]))).join('') + redactor.finish();
  assert.equal(output, 'before:[REDACTED]:middle:[REDACTED]:after');
});

test('invalid task IDs and poll intervals are rejected before path use', async () => {
  const broker = await makeBroker();
  try {
    await assert.rejects(run(['status', '--state-dir', broker.stateDir, '..']), /invalid task ID/);
  } finally {
    await cleanup(broker);
  }

  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-workspace-poll-test-'));
  const workspace = path.join(temporaryRoot, 'workspace');
  await fs.mkdir(workspace);
  try {
    await assert.rejects(
      run(['init', '--state-dir', path.join(temporaryRoot, 'state'), '--workspace', workspace, '--max-slots', '1', '--adapter', 'test', '--poll-ms', '0']),
      /poll-ms must be an integer between 10 and 60000/,
    );
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('auth prepare is unattended, stores only metadata, and status and doctor never reveal the token', async () => {
  const broker = await makeBroker();
  const argsPath = path.join(broker.temporaryRoot, 'oidc-args.json');
  const token = 'unit-test-secret-token-prepare';
  const hordeUrl = 'https://horde.example.test';
  try {
    const prepared = await run([
      'auth', 'prepare', '--state-dir', broker.stateDir,
      '--horde-url', hordeUrl, '--oidc-token-exe', fakeOidcFixture, '--min-valid-ms', '60000',
    ], { env: { FAKE_OIDC_ARGS_PATH: argsPath, FAKE_OIDC_TOKEN: token } });
    const preparedStatus = JSON.parse(prepared.stdout);
    assert.equal(preparedStatus.hordeUrl, hordeUrl);
    assert.ok(preparedStatus.remainingMs >= 60000);
    assert.doesNotMatch(prepared.stdout, new RegExp(token));

    const oidcArgs = JSON.parse(await fs.readFile(argsPath, 'utf8'));
    assert.deepEqual(oidcArgs.slice(0, 8), [
      '--Service', 'Horde', '--HordeUrl', hordeUrl, '--Mode', 'GetToken', '--Unattended', 'true',
    ]);
    assert.equal(oidcArgs[8], '--OutFile');
    assert.ok(oidcArgs[9].includes(`${path.sep}secrets${path.sep}.oidc.`));
    assert.ok(!oidcArgs.some((argument) => /result.?to.?console/i.test(argument)));

    const configText = await fs.readFile(path.join(broker.stateDir, 'config.json'), 'utf8');
    const config = JSON.parse(configText);
    assert.doesNotMatch(configText, new RegExp(token));
    assert.equal(config.auth.hordeUrl, hordeUrl);
    assert.ok(config.auth.tokenFile.startsWith(path.join(broker.stateDir, 'secrets')));
    assert.equal(JSON.parse(await fs.readFile(config.auth.tokenFile, 'utf8')).Token, token);

    const statusResult = await run(['auth', 'status', '--state-dir', broker.stateDir]);
    assert.doesNotMatch(statusResult.stdout, new RegExp(token));
    assert.equal(JSON.parse(statusResult.stdout).tokenFile, config.auth.tokenFile);
    const doctorResult = await run(['doctor', '--state-dir', broker.stateDir]);
    assert.doesNotMatch(doctorResult.stdout, new RegExp(token));
    assert.equal(JSON.parse(doctorResult.stdout).checks.auth.ok, true);
  } finally {
    await cleanup(broker);
  }
});

test('failed auth refresh preserves prior metadata and successful refresh retains referenceable generations', async () => {
  const broker = await makeBroker();
  const priorToken = 'unit-test-prior-token';
  const rejectedToken = 'unit-test-rejected-token';
  try {
    await run([
      'auth', 'prepare', '--state-dir', broker.stateDir, '--horde-url', 'https://horde.example.test',
      '--oidc-token-exe', fakeOidcFixture, '--min-valid-ms', '60000',
    ], { env: { FAKE_OIDC_TOKEN: priorToken } });
    const configPath = path.join(broker.stateDir, 'config.json');
    const before = JSON.parse(await fs.readFile(configPath, 'utf8'));

    await assert.rejects(
      run([
        'auth', 'prepare', '--state-dir', broker.stateDir, '--horde-url', 'https://other-horde.example.test',
        '--oidc-token-exe', fakeOidcFixture, '--min-valid-ms', '60000',
      ], { env: {
        FAKE_OIDC_TOKEN: rejectedToken,
        FAKE_OIDC_EXPIRES_AT: new Date(Date.now() + 30000).toISOString(),
      } }),
      /below required minimum/,
    );

    const after = JSON.parse(await fs.readFile(configPath, 'utf8'));
    assert.deepEqual(after.auth, before.auth);
    assert.equal(JSON.parse(await fs.readFile(after.auth.tokenFile, 'utf8')).Token, priorToken);
    assert.equal((await fs.readdir(path.join(broker.stateDir, 'secrets'))).length, 1);

    await run([
      'auth', 'prepare', '--state-dir', broker.stateDir, '--horde-url', 'https://other-horde.example.test',
      '--oidc-token-exe', fakeOidcFixture, '--min-valid-ms', '60000',
    ], { env: { FAKE_OIDC_TOKEN: rejectedToken } });
    const refreshed = JSON.parse(await fs.readFile(configPath, 'utf8'));
    assert.notEqual(refreshed.auth.tokenFile, before.auth.tokenFile);
    assert.equal(JSON.parse(await fs.readFile(before.auth.tokenFile, 'utf8')).Token, priorToken);
    assert.equal((await fs.readdir(path.join(broker.stateDir, 'secrets'))).length, 2);
  } finally {
    await cleanup(broker);
  }
});

test('runner injects Horde auth only into the child without task, history, command-line, or log leakage', async () => {
  const broker = await makeBroker();
  const token = 'unit-test-runner-secret';
  const hordeUrl = 'https://horde.example.test';
  const outputPath = path.join(broker.workspace, 'environment.json');
  try {
    await run([
      'auth', 'prepare', '--state-dir', broker.stateDir, '--horde-url', hordeUrl,
      '--oidc-token-exe', fakeOidcFixture, '--min-valid-ms', '60000',
    ], { env: { FAKE_OIDC_TOKEN: token } });
    await assert.rejects(
      startRaw(broker.stateDir, [process.execPath, environmentFixture, outputPath]),
      /authenticated tasks require --timeout-ms/,
    );
    const started = await startRaw(
      broker.stateDir,
      [process.execPath, environmentFixture, outputPath, 'print-token'],
      ['--timeout-ms', '10000'],
    );
    const completed = await waitFor(broker.stateDir, started.taskId, (task) => task.state === 'completed', 30000);
    assert.deepEqual(JSON.parse(await fs.readFile(outputPath, 'utf8')), { hordeUrl, hordeToken: token });

    const taskText = await fs.readFile(path.join(broker.stateDir, 'tasks', `${started.taskId}.json`), 'utf8');
    assert.doesNotMatch(taskText, new RegExp(token));
    assert.equal(completed.command.includes(token), false);
    const log = (await run(['logs', '--state-dir', broker.stateDir, started.taskId])).stdout;
    assert.doesNotMatch(log, new RegExp(token));
    assert.match(log, /\[REDACTED\]/);

    await runIteration(
      broker.stateDir,
      started.taskId,
      [process.execPath, '-e', "console.log('rerun-ok')"],
      ['--timeout-ms', '10000'],
    );
    const rerun = await waitFor(
      broker.stateDir,
      started.taskId,
      (task) => task.attempt === 2 && task.state === 'completed',
      30000,
    );
    assert.doesNotMatch(JSON.stringify(rerun.attempts), new RegExp(token));
  } finally {
    await cleanup(broker);
  }
});

test('runner rejects an expired token before launch and --no-auth strips inherited Horde variables', async () => {
  const broker = await makeBroker(2);
  const expiredOutput = path.join(broker.workspace, 'expired-environment.json');
  const noAuthOutput = path.join(broker.workspace, 'no-auth-environment.json');
  const token = 'unit-test-expired-secret';
  try {
    await run([
      'auth', 'prepare', '--state-dir', broker.stateDir, '--horde-url', 'https://horde.example.test',
      '--oidc-token-exe', fakeOidcFixture, '--min-valid-ms', '0',
    ], { env: { FAKE_OIDC_TOKEN: token } });
    const config = JSON.parse(await fs.readFile(path.join(broker.stateDir, 'config.json'), 'utf8'));
    await fs.writeFile(config.auth.tokenFile, JSON.stringify({
      Token: token,
      ExpiresAtUtc: new Date(Date.now() - 1000).toISOString(),
    }));

    await assert.rejects(
      startRaw(
        broker.stateDir,
        [process.execPath, environmentFixture, expiredOutput],
        ['--timeout-ms', '10000'],
      ),
      /Horde token is expired/,
    );
    await assert.rejects(fs.access(expiredOutput), { code: 'ENOENT' });

    const noAuth = JSON.parse((await run([
      'start', '--state-dir', broker.stateDir, '--no-auth', '--',
      process.execPath, environmentFixture, noAuthOutput,
    ], { env: { UE_HORDE_TOKEN: 'ambient-secret', UE_HORDE_URL: 'https://ambient.invalid' } })).stdout);
    const completed = await waitFor(broker.stateDir, noAuth.taskId, (task) => task.state === 'completed');
    assert.equal(completed.authEnabled, false);
    assert.deepEqual(JSON.parse(await fs.readFile(noAuthOutput, 'utf8')), { hordeUrl: null, hordeToken: null });
  } finally {
    await cleanup(broker);
  }
});

test('production ProjFS rejects script provider and watcher fakes without explicit test mode', async () => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'projfs-production-fake-rejection-'));
  const workspace = path.join(temporaryRoot, 'lower');
  await fs.mkdir(workspace);
  try {
    await assert.rejects(run([
      'init', '--state-dir', path.join(temporaryRoot, 'state'), '--workspace', workspace,
      '--max-slots', '1', '--adapter', 'projfs', '--provider-exe', fakeProjfsFixture,
      '--root-parent', path.join(temporaryRoot, 'roots'),
    ]), /Windows x64 PE provider/);
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('null process identity can never authorize PID termination', async () => {
  assert.equal(await stopProcessGroup(process.pid, null, 10), false);
  assert.doesNotThrow(() => process.kill(process.pid, 0));
});
