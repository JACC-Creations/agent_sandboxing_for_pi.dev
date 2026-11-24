import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
import { createSecretRedactor } from '../../src/redact.mjs';
import { withLock } from '../../src/state.mjs';
import { buildLaunch, classifyLauncherIdentity, handleUnverifiableRecovery } from '../../src/worker.mjs';
import { getProcessIdentity, stopProcessGroup } from '../../src/projfs.mjs';
import {
  isOwnedProcessAlive,
  launchOwned,
  ownershipDescriptor,
  queryOwnedJobEmpty,
  terminateOwned,
} from '../../src/process-owner.mjs';

const execFileAsync = promisify(execFile);
process.env.AGENT_WORKSPACE_INTERNAL_TEST_MODE = '1';
const root = path.resolve(import.meta.dirname, '..', '..');
const cli = path.join(root, 'bin', 'agent-workspace.mjs');
const fixture = path.join(root, 'test', 'fixtures', 'task.mjs');
const holderFixture = path.join(root, 'test', 'fixtures', 'holder.mjs');
const argvFixture = path.join(root, 'test', 'fixtures', 'argv.mjs');
const environmentFixture = path.join(root, 'test', 'fixtures', 'environment.mjs');
const fakeOidcFixture = path.join(root, 'test', 'fixtures', 'fake-oidc.mjs');
const fakeProjfsFixture = path.join(root, 'test', 'fixtures', 'fake-projfs-provider.mjs');

async function run(args, options = {}) {
  let resolvedArgs = args;
  if (args[0] === 'cleanup' && !args.includes('--broker-uuid') && options.pinCleanup !== false) {
    const stateDirIndex = args.indexOf('--state-dir');
    assert.notEqual(stateDirIndex, -1, 'test cleanup commands must specify --state-dir');
    const brokerUuid = await cleanupBrokerUuid(args[stateDirIndex + 1]);
    resolvedArgs = [...args, '--broker-uuid', brokerUuid];
  }
  return execFileAsync(process.execPath, [cli, ...resolvedArgs], {
    cwd: root,
    windowsHide: true,
    timeout: options.timeout ?? 15000,
    env: { ...process.env, ...options.env },
  });
}

async function makeBroker(maxSlots = 1, extra = []) {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-workspace-test-'));
  const workspace = path.join(temporaryRoot, 'workspace');
  const stateDir = path.join(temporaryRoot, 'state');
  await fs.mkdir(workspace);
  await run([
    'init', '--state-dir', stateDir, '--workspace', workspace,
    '--max-slots', String(maxSlots), '--adapter', 'test', '--poll-ms', '50', ...extra,
  ]);
  return { temporaryRoot, workspace, stateDir };
}

async function start(stateDir, durationMs, extra = [], childPidPath = null) {
  const command = [process.execPath, fixture, String(durationMs), '50', '0'];
  if (childPidPath) {
    command.push(childPidPath);
  }
  const result = await run(['start', '--state-dir', stateDir, ...extra, '--', ...command]);
  return JSON.parse(result.stdout);
}

async function startRaw(stateDir, command, extra = []) {
  const result = await run(['start', '--state-dir', stateDir, ...extra, '--', ...command]);
  return JSON.parse(result.stdout);
}

async function makeProjfsBroker(maxSlots = 2, extra = []) {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'projfs-broker-test-'));
  const workspace = path.join(temporaryRoot, 'lower');
  const rootParent = path.join(temporaryRoot, 'roots');
  const stateDir = path.join(temporaryRoot, 'state');
  await fs.mkdir(workspace);
  await run([
    'init', '--state-dir', stateDir, '--workspace', workspace,
    '--max-slots', String(maxSlots), '--adapter', 'projfs', '--test-mode', '--poll-ms', '25',
    '--provider-exe', fakeProjfsFixture, '--root-parent', rootParent,
    '--provider-ready-timeout-ms', '1000', '--build-wait-timeout-ms', '2000',
    ...extra,
  ]);
  return { temporaryRoot, workspace, rootParent, stateDir };
}

async function cleanupProjfs(broker) {
  await cleanup(broker);
}

async function cleanupBrokerUuid(stateDir) {
  const externalCandidates = [
    path.join(stateDir, 'config.json'),
    `${stateDir}.cleanup-journal.json`,
    `${stateDir}.cleanup-receipt.json`,
  ];
  for (const candidate of externalCandidates) {
    const record = await fs.readFile(candidate, 'utf8').then(JSON.parse, () => null);
    if (record?.brokerUuid) return record.brokerUuid;
  }
  assert.fail(`cleanup generation UUID is unavailable for ${stateDir}`);
}

async function runIteration(stateDir, taskId, command, extra = [], options = {}) {
  const result = await run(['run', '--state-dir', stateDir, taskId, ...extra, '--', ...command], options);
  return JSON.parse(result.stdout);
}

async function status(stateDir, taskId) {
  return fs.readFile(path.join(stateDir, 'tasks', `${taskId}.json`), 'utf8').then(JSON.parse);
}

async function waitFor(stateDir, taskId, predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let task;
  while (Date.now() < deadline) {
    task = await status(stateDir, taskId);
    if (predicate(task)) {
      return task;
    }
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  assert.fail(`task ${taskId} did not reach expected state; last snapshot: ${JSON.stringify(task)}`);
}

async function waitForProviderState(stateDir, expectedState, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const slots = await fs.readFile(path.join(stateDir, 'slots.json'), 'utf8').then(JSON.parse);
    if (slots.slots[0].provider?.state === expectedState) return slots.slots[0].provider;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`provider did not reach ${expectedState}`);
}

async function waitForPath(filePath, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fs.access(filePath).then(() => true, () => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`path did not appear: ${filePath}`);
}

async function terminateFixtureProcess(pid, recordedIdentity = null) {
  if (!pid) return;
  const currentIdentity = await getProcessIdentity(pid);
  if (!currentIdentity) return;
  if (recordedIdentity) assert.equal(currentIdentity, recordedIdentity, `fixture PID ${pid} identity changed`);
  assert.equal(await stopProcessGroup(pid, currentIdentity, 3000), true, `fixture PID ${pid} did not terminate`);
}

async function terminateFixtureMonitor(pid) {
  const identity = await getProcessIdentity(pid);
  assert.ok(identity, `fixture monitor PID ${pid} has no identity`);
  await execFileAsync('taskkill.exe', ['/pid', String(pid), '/f'], { windowsHide: true }).catch(() => {});
  await waitForProcessExit(pid, 3000);
  assert.notEqual(await getProcessIdentity(pid), identity, `fixture monitor PID ${pid} survived termination`);
}

async function waitForProcessExit(pid, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === 'ESRCH') {
        return;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`process ${pid} remained alive`);
}

async function cleanup(broker) {
  const config = await fs.readFile(path.join(broker.stateDir, 'config.json'), 'utf8').then(JSON.parse, () => null);
  const slots = await fs.readFile(path.join(broker.stateDir, 'slots.json'), 'utf8').then(JSON.parse, () => ({ slots: [] }));
  const taskDirectory = path.join(broker.stateDir, 'tasks');
  const taskNames = await fs.readdir(taskDirectory).catch(() => []);
  const tasks = await Promise.all(taskNames.map((name) => fs.readFile(path.join(taskDirectory, name), 'utf8').then(JSON.parse, () => null)));
  const owners = await Promise.all([
    fs.readFile(path.join(broker.stateDir, 'lower-guard-owner.json'), 'utf8').then(JSON.parse, () => null),
    fs.readFile(path.join(broker.stateDir, 'generation-supervisor-owner.json'), 'utf8').then(JSON.parse, () => null),
  ]);
  owners.push(...slots.slots.map((slot) => slot.provider).filter(Boolean));

  if (config) {
    const descriptors = [
      ...owners.filter((owner) => owner?.launchManifestPath),
      ...tasks.map((task) => task?.processOwnership).filter(Boolean),
    ];
    for (const descriptor of descriptors) {
      await terminateOwned(config, descriptor, 3000).catch(() => false);
    }
  }

  const expected = owners.filter((owner) => owner?.pid && owner?.creationIdentity)
    .map((owner) => ({ pid: owner.pid, identity: owner.creationIdentity }));
  for (const task of tasks.filter(Boolean)) {
    if (task.monitorPid) {
      const identity = await getProcessIdentity(task.monitorPid);
      if (identity) expected.push({ pid: task.monitorPid, identity });
    }
    if (task.pid && task.launcherIdentity) expected.push({ pid: task.pid, identity: task.launcherIdentity });
  }
  for (const processValue of expected) {
    await stopProcessGroup(processValue.pid, processValue.identity, 3000).catch(() => false);
  }
  const leaked = [];
  for (const processValue of expected) {
    if (await getProcessIdentity(processValue.pid) === processValue.identity) leaked.push(processValue.pid);
  }
  assert.deepEqual(leaked, [], `owned fixture processes survived cleanup: ${leaked.join(', ')}`);
  await fs.rm(broker.temporaryRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
export {
  assert, fs, os, path, spawn, test,
  argvFixture, cleanup, cleanupProjfs, createSecretRedactor, environmentFixture,
  fakeOidcFixture, fakeProjfsFixture, fixture, holderFixture, getProcessIdentity,
  handleUnverifiableRecovery, isOwnedProcessAlive, launchOwned, makeBroker,
  makeProjfsBroker, ownershipDescriptor, queryOwnedJobEmpty, root, run,
  runIteration, start, startRaw, status, stopProcessGroup, terminateFixtureMonitor,
  terminateFixtureProcess, terminateOwned, waitFor, waitForPath,
  waitForProcessExit, waitForProviderState, withLock, buildLaunch,
  classifyLauncherIdentity,
};
