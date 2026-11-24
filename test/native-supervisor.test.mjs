import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
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
import { waitForOwnedExit } from '../src/worker.mjs';

const execFileAsync = promisify(execFile);

test('bundled native durable replace atomically installs a same-directory file and rejects invalid paths', async () => {
  const supervisorExe = path.join(root, 'native', 'projfs-provider', 'bin', 'win32-x64', 'launch-supervisor.exe');
  assert.equal(process.platform, 'win32');
  await fs.access(supervisorExe);
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'native-durable-replace-test-'));
  const otherRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'native-durable-replace-other-'));
  const source = path.join(temporaryRoot, 'state.tmp');
  const target = path.join(temporaryRoot, 'state.json');
  try {
    const handle = await fs.open(source, 'wx');
    await handle.writeFile('new-state\n');
    await handle.sync();
    await handle.close();
    await fs.writeFile(target, 'old-state\n');
    await execFileAsync(supervisorExe, ['durable-replace', '--source', source, '--target', target]);
    assert.equal(await fs.readFile(target, 'utf8'), 'new-state\n');
    await assert.rejects(fs.access(source), { code: 'ENOENT' });

    const crossDirectorySource = path.join(otherRoot, 'state.tmp');
    await fs.writeFile(crossDirectorySource, 'must-not-move\n');
    await assert.rejects(execFileAsync(supervisorExe, [
      'durable-replace', '--source', crossDirectorySource, '--target', target,
    ]));
    assert.equal(await fs.readFile(target, 'utf8'), 'new-state\n');
    assert.equal(await fs.readFile(crossDirectorySource, 'utf8'), 'must-not-move\n');
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
    await fs.rm(otherRoot, { recursive: true, force: true });
  }
});

test('native identity reports a stable Windows process creation identity', async (context) => {
  const supervisorExe = path.join(root, 'native', 'projfs-provider', 'build', 'Release', 'launch-supervisor.exe');
  if (process.platform !== 'win32' || !await fs.access(supervisorExe).then(() => true, () => false)) {
    context.skip('native Release supervisor is not built');
    return;
  }
  const first = await execFileAsync(supervisorExe, ['identity', '--pid', String(process.pid)]);
  const second = await execFileAsync(supervisorExe, ['identity', '--pid', String(process.pid)]);
  assert.match(first.stdout, /^win:\d+$/);
  assert.equal(second.stdout, first.stdout);
});

test('native terminate waits until the owned job is empty', async (context) => {
  const supervisorExe = path.join(root, 'native', 'projfs-provider', 'build', 'Release', 'launch-supervisor.exe');
  const providerExe = path.join(root, 'native', 'projfs-provider', 'build', 'Release', 'projfs-provider.exe');
  if (process.platform !== 'win32' || !await fs.access(supervisorExe).then(() => true, () => false)) {
    context.skip('native Release supervisor is not built');
    return;
  }
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'native-supervisor-terminate-test-'));
  const sentinel = path.join(temporaryRoot, 'child-ran.txt');
  const config = {
    adapter: 'projfs',
    brokerUuid: '22222222-2222-4222-8222-222222222222',
    providerExe,
    launchSupervisorExe: supervisorExe,
  };
  const descriptor = ownershipDescriptor(temporaryRoot, config, 'terminate-test', 'abcdef0123456789abcdef0123456789');
  try {
    const owned = await launchOwned(config, descriptor, process.execPath, [
      '-e', `require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'ran'); setTimeout(() => {}, 10000)`,
    ], {
      cwd: temporaryRoot,
      stdoutPath: path.join(temporaryRoot, 'stdout.log'),
      stderrPath: path.join(temporaryRoot, 'stderr.log'),
      launchTimeoutMs: 2000,
      env: process.env,
    });
    await waitForPath(sentinel);
    const consoleHosts = await execFileAsync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `[Console]::Write(@(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'conhost.exe' -and $_.ParentProcessId -eq ${owned.pid} }).Count)`,
    ]);
    assert.equal(consoleHosts.stdout, '0');
    assert.equal(await terminateOwned(config, descriptor, 3000), true);
    assert.equal(await queryOwnedJobEmpty(config, descriptor), true);
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});

test('worker waits for the owned Job after the launcher exits', async (context) => {
  const supervisorExe = path.join(root, 'native', 'projfs-provider', 'build', 'Release', 'launch-supervisor.exe');
  const providerExe = path.join(root, 'native', 'projfs-provider', 'build', 'Release', 'projfs-provider.exe');
  if (process.platform !== 'win32' || !await fs.access(supervisorExe).then(() => true, () => false)) {
    context.skip('native Release supervisor is not built');
    return;
  }
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'native-supervisor-descendant-test-'));
  const config = {
    adapter: 'projfs',
    brokerUuid: '33333333-3333-4333-8333-333333333333',
    providerExe,
    launchSupervisorExe: supervisorExe,
  };
  const descriptor = ownershipDescriptor(temporaryRoot, config, 'descendant-test', '123456789abcdef0123456789abcdef0');
  const childPidPath = path.join(temporaryRoot, 'child.pid');
  try {
    const owned = await launchOwned(config, descriptor, process.execPath, [fixture, '100', '50', '0', childPidPath], {
      cwd: temporaryRoot,
      stdoutPath: path.join(temporaryRoot, 'stdout.log'),
      stderrPath: path.join(temporaryRoot, 'stderr.log'),
      launchTimeoutMs: 2000,
      env: process.env,
    });
    await waitForPath(childPidPath);
    const childPid = Number(await fs.readFile(childPidPath, 'utf8'));
    const childIdentity = await getProcessIdentity(childPid);
    const terminateChild = new Promise((resolve, reject) => {
      setTimeout(() => terminateFixtureProcess(childPid, childIdentity).then(resolve, reject), 3000);
    });
    const startedAt = Date.now();
    const result = await waitForOwnedExit(config, descriptor, owned.creationIdentity, 50);
    await terminateChild;
    assert.ok(Date.now() - startedAt >= 2500);
    assert.equal(result.exitCode, 0);
    assert.equal(result.exitCodeUnknown, false);
    assert.equal(await queryOwnedJobEmpty(config, descriptor), true);
  } finally {
    await terminateOwned(config, descriptor, 3000).catch(() => false);
    await fs.rm(temporaryRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});

test('native supervisor publication timeout cannot leave a resumable orphan', async (context) => {
  const supervisorExe = path.join(root, 'native', 'projfs-provider', 'build', 'Release', 'launch-supervisor.exe');
  const providerExe = path.join(root, 'native', 'projfs-provider', 'build', 'Release', 'projfs-provider.exe');
  if (process.platform !== 'win32' || !await fs.access(supervisorExe).then(() => true, () => false)) {
    context.skip('native Release supervisor is not built');
    return;
  }
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'native-supervisor-timeout-test-'));
  const sentinel = path.join(temporaryRoot, 'child-ran.txt');
  const config = {
    adapter: 'projfs',
    brokerUuid: '11111111-1111-4111-8111-111111111111',
    providerExe,
    launchSupervisorExe: supervisorExe,
  };
  const descriptor = ownershipDescriptor(temporaryRoot, config, 'timeout-test', '0123456789abcdef0123456789abcdef');
  try {
    await assert.rejects(launchOwned(config, descriptor, process.execPath, [
      '-e', `require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'ran')`,
    ], {
      cwd: temporaryRoot,
      stdoutPath: path.join(temporaryRoot, 'stdout.log'),
      stderrPath: path.join(temporaryRoot, 'stderr.log'),
      launchTimeoutMs: 100,
      env: { ...process.env, AGENT_WORKSPACE_TEST_NATIVE_PUBLICATION_DELAY_MS: '500' },
    }), /supervisor did not publish durable|owned job could not be proven empty/);
    await new Promise((resolve) => setTimeout(resolve, 600));
    await assert.rejects(fs.access(sentinel), { code: 'ENOENT' });
    assert.equal(await queryOwnedJobEmpty(config, {
      ...descriptor,
      verificationPath: `${descriptor.launchManifestPath}.intent`,
    }), true);
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('native no-commit deadline and broker recovery never resume a prepared child', async (context) => {
  const supervisorExe = path.join(root, 'native', 'projfs-provider', 'build', 'Release', 'launch-supervisor.exe');
  const providerExe = path.join(root, 'native', 'projfs-provider', 'build', 'Release', 'projfs-provider.exe');
  if (process.platform !== 'win32' || !await fs.access(supervisorExe).then(() => true, () => false)) {
    context.skip('native Release supervisor is not built');
    return;
  }
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'native-supervisor-no-commit-test-'));
  const config = {
    adapter: 'projfs',
    brokerUuid: '33333333-3333-4333-8333-333333333333',
    providerExe,
    launchSupervisorExe: supervisorExe,
  };
  const runPrepared = async (label, commitTimeoutMs, recover) => {
    const descriptor = ownershipDescriptor(
      temporaryRoot,
      config,
      `${label}-test`,
      label === 'deadline' ? '11111111111111111111111111111111' : '22222222222222222222222222222222',
    );
    const sentinel = path.join(temporaryRoot, `${label}-child-ran.txt`);
    const stdoutPath = path.join(temporaryRoot, `${label}.stdout.log`);
    const stderrPath = path.join(temporaryRoot, `${label}.stderr.log`);
    const commitPath = `${descriptor.launchManifestPath}.commit`;
    await fs.mkdir(path.dirname(descriptor.launchManifestPath), { recursive: true });
    const child = spawn(supervisorExe, [
      'launch', '--manifest', descriptor.launchManifestPath,
      '--owner', descriptor.ownerUuid, '--nonce', descriptor.nonce,
      '--kind', descriptor.kind, '--job-name', descriptor.jobName,
      '--commit', commitPath, '--commit-timeout-ms', String(commitTimeoutMs),
      '--cwd', temporaryRoot, '--stdout', stdoutPath, '--stderr', stderrPath,
      '--', process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'ran')`,
    ], { windowsHide: true, stdio: 'ignore' });
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    const closed = new Promise((resolve) => child.once('close', resolve));
    await waitForPath(descriptor.launchManifestPath);
    const prepared = JSON.parse(await fs.readFile(descriptor.launchManifestPath, 'utf8'));
    assert.equal(prepared.state, 'prepared');
    assert.equal(await isOwnedProcessAlive(descriptor), false);
    if (recover) {
      const taskId = '20000101000000-123456789abc';
      const token = 'recovery-monitor-token';
      const now = new Date().toISOString();
      const taskPath = path.join(temporaryRoot, 'tasks', `${taskId}.json`);
      await fs.mkdir(path.dirname(taskPath), { recursive: true });
      await fs.writeFile(taskPath, `${JSON.stringify({
        id: taskId,
        state: 'starting',
        createdAt: now,
        attemptCreatedAt: now,
        heartbeatAt: now,
        monitorToken: token,
        pid: null,
        launcherIdentity: null,
        processOwnership: descriptor,
        buildCapacityAcquiredAt: null,
        buildCapacityReleasedAt: null,
        permitState: null,
        logPath: path.join(temporaryRoot, 'recovery-task.log'),
        errors: [],
      }, null, 2)}\n`);
      await handleUnverifiableRecovery(temporaryRoot, taskId, { ...config, terminationWaitMs: 2000 }, token);
      const recovered = JSON.parse(await fs.readFile(taskPath, 'utf8'));
      assert.equal(recovered.state, 'failed');
      assert.match(recovered.error, /prepared but uncommitted.*terminated without resuming/);
      assert.notEqual(recovered.state, 'running');
    }
    const exitCode = await closed;
    assert.notEqual(exitCode, 0);
    const aborted = JSON.parse(await fs.readFile(descriptor.launchManifestPath, 'utf8'));
    assert.equal(aborted.state, 'aborted');
    assert.equal(await queryOwnedJobEmpty(config, descriptor), true);
    await assert.rejects(fs.access(sentinel), { code: 'ENOENT' });
  };
  try {
    await runPrepared('deadline', 250, false);
    await runPrepared('recovery', 1000, true);
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
});
