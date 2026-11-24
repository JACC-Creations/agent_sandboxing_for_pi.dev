import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  atomicWriteJson,
  ensureStateDirectories,
  listTasks,
  readJson,
  readTask,
  statePaths,
  taskPath,
  updateLogStats,
  isProcessAlive,
  validateTaskId,
  withLifecycleLock,
  withLock,
  writeTask,
} from './state.mjs';
import {
  authLifetimeMarginMs,
  defaultAuthMinValidMs,
  readAndValidateTokenFile,
  withoutHordeSecrets,
} from './auth.mjs';
import { ensureGenerationSupervisor, ensureLowerGuard, quarantineLower, requireProjfsSafe } from './projfs.mjs';
import {
  assertRevisionControlCanInitialize,
  revisionControlBackend,
  revisionControlMode,
  revisionControlSnapshot,
} from './revision-control.mjs';
import { configureProcessIdentity } from './process-identity.mjs';
import {
  assertBrokerGeneration,
  assertNoCleanupInProgress,
  createOwnedDirectory,
  makeOwnershipManifest,
  newNonce,
  ownershipVersion,
  validatePathIsolation,
  verifyOwnedDirectory,
} from './ownership.mjs';

const workerEntry = fileURLToPath(new URL('../bin/agent-workspace.mjs', import.meta.url));
const terminalStates = new Set(['completed', 'artifact_failed', 'failed', 'timed_out', 'cancelled', 'termination_failed', 'handed_off']);
const monitorHandshakeMs = 1500;

export async function isWindowsX64Pe(filePath) {
  let file;
  try {
    file = await fs.open(filePath, 'r');
    const dosHeader = Buffer.alloc(64);
    if ((await file.read(dosHeader, 0, dosHeader.length, 0)).bytesRead !== dosHeader.length
      || dosHeader.readUInt16LE(0) !== 0x5a4d) return false;
    const peOffset = dosHeader.readUInt32LE(0x3c);
    if (peOffset < 64 || peOffset > 64 * 1024 * 1024) return false;
    const peHeader = Buffer.alloc(6);
    if ((await file.read(peHeader, 0, peHeader.length, peOffset)).bytesRead !== peHeader.length) return false;
    return peHeader.readUInt32LE(0) === 0x00004550 && peHeader.readUInt16LE(4) === 0x8664;
  } catch {
    return false;
  } finally {
    if (file) await file.close().catch(() => {});
  }
}

export async function initialize(stateDir, options) {
  const mode = options.revisionControl ?? 'p4';
  assertRevisionControlCanInitialize(mode);
  return withLifecycleLock(stateDir, () => initializeExclusive(stateDir, { ...options, revisionControl: mode }));
}

async function initializeExclusive(stateDir, options) {
  await assertNoCleanupInProgress(stateDir);
  if (!options.workspace) {
    throw new Error('init requires --workspace');
  }
  const maxSlots = options.maxSlots ?? 10;
  if (!Number.isInteger(maxSlots) || maxSlots < 1) {
    throw new Error('init requires --max-slots with a positive integer');
  }
  if (!['projfs', 'test'].includes(options.adapter)) {
    throw new Error("--adapter must be 'projfs' or the explicit testing-only 'test' adapter");
  }
  if (!Number.isInteger(options.pollMs) || options.pollMs < 10 || options.pollMs > 60000) {
    throw new Error('--poll-ms must be an integer between 10 and 60000');
  }

  const workspace = path.resolve(options.workspace);
  const workspaceStats = await fs.stat(workspace).catch(() => null);
  if (!workspaceStats?.isDirectory()) {
    throw new Error(`workspace is not a directory: ${workspace}`);
  }

  const paths = statePaths(stateDir);
  if (await fs.access(paths.config).then(() => true, () => false)) {
    throw new Error(`state is already initialized at ${stateDir}`);
  }

  const slotNames = Array.from({ length: maxSlots }, (_, index) => `Workspace${index + 1}`);
  const revisionBackend = revisionControlBackend(options.revisionControl);
  const revisionConfiguration = await revisionBackend.initialize(options, workspace);

  let roots = null;
  let rootOwnership = null;
  let launchSupervisorExe = null;
  let lowerGuardExe = null;
  let generationSupervisorExe = null;
  if (options.adapter === 'projfs') {
    if (!options.providerExe) {
      throw new Error('adapter=projfs requires --provider-exe');
    }
    if (!await fs.stat(path.resolve(options.providerExe)).then((stats) => stats.isFile(), () => false)) {
      throw new Error(`ProjFS provider executable is not a file: ${path.resolve(options.providerExe)}`);
    }
    if (options.roots?.length) {
      if (options.roots.length !== maxSlots) {
        throw new Error('--roots must contain exactly --max-slots paths');
      }
      roots = options.roots.map((root) => path.resolve(root));
    } else if (options.rootParent) {
      roots = slotNames.map((slotName) => path.resolve(options.rootParent, slotName));
    } else {
      throw new Error('adapter=projfs requires --root-parent or --roots');
    }
    await validatePathIsolation(workspace, stateDir, roots);
    launchSupervisorExe = options.launchSupervisorExe
      ? path.resolve(options.launchSupervisorExe)
      : path.join(path.dirname(path.resolve(options.providerExe)), 'launch-supervisor.exe');
    const explicitTestMode = options.testMode === true;
    if (!explicitTestMode && (process.platform !== 'win32' || !await isWindowsX64Pe(path.resolve(options.providerExe)))) {
      throw new Error('production ProjFS requires a Windows x64 PE provider; use --test-mode explicitly for script fixtures');
    }
    lowerGuardExe = options.lowerGuardExe
      ? path.resolve(options.lowerGuardExe)
      : explicitTestMode
        ? path.resolve(path.dirname(options.providerExe), 'fake-lower-freeze-guard.mjs')
        : path.join(path.dirname(path.resolve(options.providerExe)), 'lower-freeze-guard.exe');
    generationSupervisorExe = options.generationSupervisorExe
      ? path.resolve(options.generationSupervisorExe)
      : path.join(path.dirname(path.resolve(options.providerExe)), 'generation-supervisor.exe');
    if (!await fs.stat(lowerGuardExe).then((stats) => stats.isFile(), () => false)) {
      throw new Error(`lower watcher executable is not a file: ${lowerGuardExe}`);
    }
    if (!explicitTestMode) {
      if (!await isWindowsX64Pe(lowerGuardExe)) {
        throw new Error('production ProjFS requires a Windows x64 PE lower watcher; script guards require --test-mode');
      }
      if (!await isWindowsX64Pe(launchSupervisorExe)) {
        throw new Error(`production ProjFS requires the Windows x64 PE launch supervisor: ${launchSupervisorExe}`);
      }
      if (!await isWindowsX64Pe(generationSupervisorExe)) {
        throw new Error(`production ProjFS requires the Windows x64 PE generation supervisor: ${generationSupervisorExe}`);
      }
    }
    rootOwnership = roots.map((root) => ({ path: root, nonce: newNonce() }));
    if (!Number.isInteger(options.lowerGuardReadyTimeoutMs) || options.lowerGuardReadyTimeoutMs < 1 || options.lowerGuardReadyTimeoutMs > 600000) {
      throw new Error('--lower-guard-ready-timeout-ms must be between 1 and 600000');
    }
    if (!Number.isInteger(options.lowerGuardHeartbeatStaleMs) || options.lowerGuardHeartbeatStaleMs < 1000 || options.lowerGuardHeartbeatStaleMs > 600000) {
      throw new Error('--lower-guard-heartbeat-stale-ms must be between 1000 and 600000');
    }
    if (!Number.isInteger(options.providerReadyTimeoutMs) || options.providerReadyTimeoutMs < 1 || options.providerReadyTimeoutMs > 60000) {
      throw new Error('--provider-ready-timeout-ms must be between 1 and 60000');
    }
    if (!Number.isInteger(options.providerStopTimeoutMs) || options.providerStopTimeoutMs < 1 || options.providerStopTimeoutMs > 60000) {
      throw new Error('--provider-stop-timeout-ms must be between 1 and 60000');
    }
    if (!Number.isInteger(options.maxConcurrentHeavyBuilds) || options.maxConcurrentHeavyBuilds < 1) {
      throw new Error('--max-concurrent-heavy-builds must be positive');
    }
    if (!['wait', 'reject'].includes(options.buildCapacityPolicy)) {
      throw new Error("--build-capacity-policy must be 'wait' or 'reject'");
    }
    if (!Number.isInteger(options.buildWaitTimeoutMs) || options.buildWaitTimeoutMs < 1 || options.buildWaitTimeoutMs > 86400000) {
      throw new Error('--build-wait-timeout-ms must be between 1 and 86400000');
    }
  }

  const now = new Date().toISOString();
  const brokerUuid = crypto.randomUUID();
  if (options.adapter === 'projfs') {
    if (await fs.access(stateDir).then(() => true, () => false)) {
      throw new Error(`refusing existing ProjFS state directory because exclusive broker ownership cannot be proven: ${stateDir}`);
    }
    await fs.mkdir(stateDir);
    try {
      const results = await Promise.allSettled(rootOwnership.map((root) => createOwnedDirectory(root.path, {
        version: ownershipVersion,
        type: 'projfs-root',
        brokerUuid,
        rootNonce: root.nonce,
        path: root.path,
        createdAt: now,
      })));
      const failure = results.find((result) => result.status === 'rejected');
      if (failure) throw failure.reason;
    } catch (error) {
      for (const root of rootOwnership) {
        const marker = await fs.readFile(path.join(root.path, '.agent-workspace-owner.json'), 'utf8').then(JSON.parse, () => null);
        if (marker?.brokerUuid === brokerUuid && marker?.rootNonce === root.nonce) {
          await fs.rm(root.path, { recursive: true, force: true }).catch(() => {});
        }
      }
      await fs.rmdir(stateDir).catch(() => {});
      throw error;
    }
  }
  await ensureStateDirectories(stateDir);
  const config = {
    version: 10,
    brokerUuid,
    createdAt: now,
    stateDir,
    workspace,
    maxSlots,
    maxAgentWorkspaces: maxSlots,
    slotNames,
    roots,
    rootParent: options.adapter === 'projfs' && options.rootParent ? path.resolve(options.rootParent) : null,
    adapter: options.adapter,
    testMode: options.testMode === true,
    lower: options.adapter === 'projfs' ? workspace : null,
    providerExe: options.adapter === 'projfs' ? path.resolve(options.providerExe) : null,
    launchSupervisorExe: options.adapter === 'projfs' ? launchSupervisorExe : null,
    lowerGuardExe: options.adapter === 'projfs' ? lowerGuardExe : null,
    generationSupervisorExe: options.adapter === 'projfs' ? generationSupervisorExe : null,
    lowerGuardReadyTimeoutMs: options.lowerGuardReadyTimeoutMs ?? 60000,
    lowerGuardHeartbeatStaleMs: options.lowerGuardHeartbeatStaleMs ?? 10000,
    providerReadyTimeoutMs: options.providerReadyTimeoutMs ?? 10000,
    providerStopTimeoutMs: options.providerStopTimeoutMs ?? 5000,
    maxConcurrentHeavyBuilds: options.maxConcurrentHeavyBuilds ?? 5,
    buildCapacityPolicy: options.buildCapacityPolicy ?? 'wait',
    buildWaitTimeoutMs: options.buildWaitTimeoutMs ?? 3600000,
    pollMs: options.pollMs,
    monitorStaleMs: Math.max(10000, options.pollMs * 10),
    terminationAttempts: 3,
    terminationWaitMs: 1000,
    revisionControl: revisionControlSnapshot(options.revisionControl),
    ...revisionConfiguration,
  };
  const slots = {
    version: 4,
    brokerUuid,
    updatedAt: now,
    buildQueue: [],
    slots: slotNames.map((slotName, index) => ({
      index: index + 1,
      slotName,
      root: roots?.[index] ?? null,
      rootNonce: rootOwnership?.[index]?.nonce ?? null,
      taskId: null,
      humanOwner: null,
      humanOwnerState: null,
      allocatedAt: null,
      provider: null,
      p4: null,
    })),
  };
  if (options.adapter === 'projfs') {
    await atomicWriteJson(path.join(stateDir, 'ownership.json'), makeOwnershipManifest(brokerUuid, stateDir, workspace, rootOwnership, now));
  }
  await atomicWriteJson(paths.config, config);
  await atomicWriteJson(paths.slots, slots);
  configureProcessIdentity(config);
  if (options.adapter === 'projfs') {
    await ensureLowerGuard(stateDir, config);
    try {
      await revisionBackend.provision(stateDir, config);
    } catch (error) {
      if (revisionBackend.isEnabled(config)) await quarantineLower(stateDir, config, `Perforce provisioning failed: ${error.message}`, { source: 'p4_provisioning' });
      throw error;
    }
    await ensureGenerationSupervisor(stateDir, config);
  }
  return config;
}

export async function loadConfig(stateDir) {
  let config;
  try {
    config = await readJson(statePaths(stateDir).config);
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(`broker is not initialized at ${stateDir}`);
    }
    throw error;
  }
  if (!Number.isInteger(config.pollMs) || config.pollMs < 10 || config.pollMs > 60000) {
    throw new Error(`invalid pollMs in broker configuration: ${config.pollMs}`);
  }
  revisionControlMode(config);
  configureProcessIdentity(config);
  config.maxAgentWorkspaces ??= config.maxSlots;
  if (config.adapter === 'projfs') {
    if (!config.brokerUuid) {
      throw new Error('ProjFS broker configuration has no immutable broker UUID; reinitialize safely');
    }
    const ownership = await readJson(path.join(stateDir, 'ownership.json')).catch(() => null);
    if (ownership?.brokerUuid !== config.brokerUuid || ownership?.type !== 'broker') {
      throw new Error('ProjFS broker ownership manifest is missing or does not match the immutable broker UUID');
    }
    const ownedSlots = await readJson(statePaths(stateDir).slots);
    for (const slot of ownedSlots.slots) {
      const resource = ownership.resources?.find((candidate) => candidate.type === 'projfs-root'
        && path.resolve(candidate.path) === path.resolve(slot.root)
        && candidate.nonce === slot.rootNonce
        && candidate.ownership === 'package'
        && candidate.handedOff === false);
      if (!resource || !await verifyOwnedDirectory(slot.root, config.brokerUuid, slot.rootNonce)) {
        throw new Error(`ProjFS root positive ownership manifest is missing or tampered for slot ${slot.index}: ${slot.root}`);
      }
    }
  }
  config.maxConcurrentHeavyBuilds ??= 5;
  config.buildCapacityPolicy ??= 'wait';
  config.buildWaitTimeoutMs ??= 3600000;
  if (!['projfs', 'test'].includes(config.adapter)) {
    throw new Error(`unsupported legacy adapter '${config.adapter}'; initialize a new ProjFS generation`);
  }
  return config;
}

function createExecution(task, command, timeoutMs, auth, resourceClass, attempt, now, logPath, virtualLogPath) {
  return {
    version: 7,
    id: task.id,
    state: 'queued',
    createdAt: task.createdAt,
    updatedAt: now,
    attempt,
    attemptCreatedAt: now,
    attempts: task.attempts ?? [],
    startedAt: null,
    finishedAt: null,
    heartbeatAt: now,
    monitorPid: null,
    monitorToken: null,
    monitorRecoveries: 0,
    pid: null,
    launcherIdentity: null,
    launchAttemptedAt: null,
    pids: [],
    command,
    commandLine: command.join(' '),
    resourceClass,
    attemptNonce: newNonce(),
    processOwnership: null,
    queueEnteredAt: null,
    queuePosition: null,
    buildCapacityAcquiredAt: null,
    buildCapacityReleasedAt: null,
    permitState: null,
    workspace: task.workspace,
    adapter: task.adapter,
    slotName: task.slotName,
    slot: task.slot,
    logPath,
    virtualLogPath,
    logBytes: 0,
    logMtime: null,
    elapsedMs: 0,
    exitCode: null,
    exitCodeUnknown: false,
    signal: null,
    timeoutMs: timeoutMs ?? null,
    authEnabled: auth !== null,
    auth,
    timedOut: false,
    cancelRequestedAt: null,
    cancelledAt: null,
    terminationAttempts: 0,
    error: null,
    errors: [],
    p4: task.p4 ?? null,
  };
}

async function admitTaskAuth(config, options) {
  if (!config.auth?.enabled || options.authEnabled === false) {
    return null;
  }
  if (!Number.isSafeInteger(options.timeoutMs)) {
    throw new Error('authenticated tasks require --timeout-ms for token lifetime admission');
  }
  const minValidMs = config.auth.minValidMs ?? defaultAuthMinValidMs;
  const requiredLifetime = Math.max(minValidMs, options.timeoutMs + authLifetimeMarginMs);
  await readAndValidateTokenFile(config.auth.tokenFile, requiredLifetime);
  return {
    hordeUrl: config.auth.hordeUrl,
    tokenFile: config.auth.tokenFile,
    minValidMs,
  };
}

function archiveExecution(task) {
  const archived = structuredClone(task);
  delete archived.attempts;
  archived.attempt ??= 1;
  archived.attemptCreatedAt ??= archived.createdAt;
  return archived;
}

function ensureAttemptMetadata(task) {
  task.attempt ??= 1;
  task.attemptCreatedAt ??= task.createdAt;
  task.attempts ??= [];
  return task;
}

export async function startTask(stateDir, command, options = {}) {
  if (!command.length) {
    throw new Error('start requires a command after --');
  }
  await assertNoCleanupInProgress(stateDir);
  const config = await loadConfig(stateDir);
  validateResourceClass(config, options.resourceClass);
  await requireProjfsSafe(stateDir, config);
  const auth = await admitTaskAuth(config, options);
  await recoverTasks(stateDir, config);
  const task = await withLifecycleLock(stateDir, async () => {
    await assertBrokerGeneration(stateDir, config.brokerUuid);
    return withLock(stateDir, 'state', async () => {
    const paths = statePaths(stateDir);
    const slots = await readJson(paths.slots);
    const persistedTasks = await listTasks(stateDir);
    let repairedSlots = false;
    for (const persistedTask of persistedTasks) {
      const persistedSlot = slots.slots.find((candidate) => candidate.index === persistedTask.slot);
      if (!persistedSlot) {
        throw new Error(`state corruption: task '${persistedTask.id}' references missing slot ${persistedTask.slot}`);
      }
      if (persistedSlot.taskId && persistedSlot.taskId !== persistedTask.id) {
        throw new Error(`state corruption: slot ${persistedSlot.index} has conflicting task assignments`);
      }
      if (!persistedSlot.taskId) {
        persistedSlot.taskId = persistedTask.id;
        persistedSlot.allocatedAt = persistedTask.createdAt;
        repairedSlots = true;
      }
    }
    for (const slot of slots.slots) {
      if (slot.taskId && !slot.humanOwner && !persistedTasks.some((taskValue) => taskValue.id === slot.taskId)) {
        throw new Error(`state corruption: slot ${slot.index} references missing task '${slot.taskId}'`);
      }
    }
    if (repairedSlots) {
      slots.updatedAt = new Date().toISOString();
      await atomicWriteJson(paths.slots, slots);
    }

    const slot = slots.slots.find((candidate) => candidate.taskId === null && !candidate.humanOwner);
    if (!slot) {
      throw new Error(`capacity exhausted: all ${config.maxSlots} slots are retained by tasks`);
    }

    const now = new Date().toISOString();
    const id = createTaskId();
    const virtualLogPath = path.join(paths.logs, `${id}.attempt-1.log`);
    const logPath = virtualLogPath;
    const value = createExecution({
      id,
      createdAt: now,
      attempts: [],
      workspace: config.adapter === 'projfs' ? slot.root : config.workspace,
      adapter: config.adapter,
      slotName: slot.slotName,
      slot: slot.index,
    }, command, options.timeoutMs, auth, options.resourceClass ?? null, 1, now, logPath, virtualLogPath);
    await revisionControlBackend(config).planTask(stateDir, config, value, slot);

    await fs.mkdir(path.dirname(value.logPath), { recursive: true });
    await fs.writeFile(value.logPath, '', { flag: 'wx' });
    await atomicWriteJson(taskPath(stateDir, id), value);
    slot.taskId = id;
    slot.allocatedAt = now;
    slots.updatedAt = now;
    await atomicWriteJson(paths.slots, slots);
    return value;
    });
  });

  try {
    await launchMonitor(stateDir, task.id, false);
  } catch (error) {
    await markMonitorLaunchFailure(stateDir, task.id, error.message);
    throw new Error(`task '${task.id}' monitor failed to start: ${error.message}`);
  }
  return readTask(stateDir, task.id);
}

export async function rerunTask(stateDir, taskId, command, options = {}) {
  validateTaskId(taskId);
  if (!command.length) {
    throw new Error('run requires a command after --');
  }
  try {
    return await withLock(
      stateDir,
      `rerun-${taskId}`,
      () => rerunTaskExclusive(stateDir, taskId, command, options),
      { timeoutMs: 0 },
    );
  } catch (error) {
    if (error.message === `timed out waiting for state lock 'rerun-${taskId}'`) {
      throw new Error(`task '${taskId}' rerun is already in progress`);
    }
    throw error;
  }
}

async function rerunTaskExclusive(stateDir, taskId, command, options) {
  await assertNoCleanupInProgress(stateDir);
  const config = await loadConfig(stateDir);
  validateResourceClass(config, options.resourceClass);
  await requireProjfsSafe(stateDir, config);
  const auth = await admitTaskAuth(config, options);
  await recoverTasks(stateDir, config, taskId);
  const task = await withLifecycleLock(stateDir, async () => {
    await assertBrokerGeneration(stateDir, config.brokerUuid);
    return withLock(stateDir, `task-${taskId}`, async () => {
    const previous = ensureAttemptMetadata(await readTask(stateDir, taskId));
    if (!terminalStates.has(previous.state)) {
      throw new Error(`task '${taskId}' is not terminal (state: ${previous.state})`);
    }
    if (revisionControlBackend(config).isTaskSealed(previous)) {
      throw new Error(`task '${taskId}' is sealed by its revision-control handoff intent`);
    }

    await updateLogStats(previous);
    const attempt = previous.attempt + 1;
    const now = new Date().toISOString();
    const virtualLogPath = path.join(statePaths(stateDir).logs, `${taskId}.attempt-${attempt}.log`);
    const logPath = virtualLogPath;
    await fs.mkdir(path.dirname(logPath), { recursive: true });
    await fs.writeFile(logPath, '', { flag: 'wx' });

    const attempts = [...previous.attempts, archiveExecution(previous)];
    const next = createExecution(
      { ...previous, attempts },
      command,
      options.timeoutMs,
      auth,
      options.resourceClass ?? null,
      attempt,
      now,
      logPath,
      virtualLogPath,
    );
    await writeTask(stateDir, next);
    return next;
    });
  });

  try {
    await launchMonitor(stateDir, task.id, false);
  } catch (error) {
    await markMonitorLaunchFailure(stateDir, task.id, error.message);
    throw new Error(`task '${task.id}' monitor failed to start: ${error.message}`);
  }
  return readTask(stateDir, task.id);
}

export async function launchMonitor(stateDir, taskId, recovery = false) {
  validateTaskId(taskId);
  const child = spawn(process.execPath, [workerEntry, '_worker', '--state-dir', stateDir, '--task-id', taskId], {
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    windowsHide: true,
    env: { ...withoutHordeSecrets(process.env), AGENT_WORKSPACE_RECOVERY: recovery ? '1' : '0' },
  });

  try {
    await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        child.off('error', onError);
        child.off('exit', onExit);
        child.off('message', onMessage);
        if (error) reject(error); else resolve();
      };
      const onError = (error) => finish(error);
      const onExit = (code, signal) => finish(new Error(`monitor exited before acknowledgement (${code ?? signal})`));
      const onMessage = (message) => {
        if (message?.type === 'monitor-ready') {
          child.send({ type: 'monitor-accepted' }, (error) => finish(error ?? null));
        } else if (message?.type === 'monitor-rejected') {
          finish(recovery ? null : new Error(message.reason ?? 'monitor rejected task claim'));
        }
      };
      const timer = setTimeout(() => finish(new Error(`monitor acknowledgement timed out after ${monitorHandshakeMs}ms`)), monitorHandshakeMs);
      timer.unref();
      child.once('error', onError);
      child.once('exit', onExit);
      child.on('message', onMessage);
    });
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await Promise.race([
        new Promise((resolve) => child.once('exit', resolve)),
        new Promise((resolve) => setTimeout(resolve, 500)),
      ]);
    }
    throw error;
  } finally {
    child.disconnect?.();
    child.unref();
  }
}

async function markMonitorLaunchFailure(stateDir, taskId, message) {
  await withLock(stateDir, `task-${taskId}`, async () => {
    const task = await readTask(stateDir, taskId);
    if (terminalStates.has(task.state)) {
      return;
    }
    const now = new Date().toISOString();
    task.state = 'failed';
    task.finishedAt = now;
    task.heartbeatAt = now;
    task.error = `monitor launch failed: ${message}`;
    task.errors.push(task.error);
    await writeTask(stateDir, task);
  });
}

export async function recoverTasks(stateDir, providedConfig = null, onlyTaskId = null) {
  const config = providedConfig ?? await loadConfig(stateDir);
  const tasks = onlyTaskId ? [await readTask(stateDir, onlyTaskId)] : await listTasks(stateDir);
  const now = Date.now();
  for (const task of tasks) {
    if (terminalStates.has(task.state) || task.state === 'queued') {
      continue;
    }
    const heartbeat = Date.parse(task.heartbeatAt ?? task.updatedAt);
    const heartbeatAge = Number.isFinite(heartbeat) ? now - heartbeat : Number.POSITIVE_INFINITY;
    const monitorAlive = isProcessAlive(task.monitorPid);
    const staleThreshold = monitorAlive ? Math.max(config.monitorStaleMs, 120000) : config.monitorStaleMs;
    if (heartbeatAge <= staleThreshold) {
      continue;
    }
    await withLifecycleLock(stateDir, async () => {
      await assertNoCleanupInProgress(stateDir);
      await assertBrokerGeneration(stateDir, config.brokerUuid);
      const current = await readTask(stateDir, task.id);
      if (terminalStates.has(current.state) || current.state === 'queued') return;
      const currentHeartbeat = Date.parse(current.heartbeatAt ?? current.updatedAt);
      const currentAge = Number.isFinite(currentHeartbeat) ? Date.now() - currentHeartbeat : Number.POSITIVE_INFINITY;
      const currentMonitorAlive = isProcessAlive(current.monitorPid);
      const currentThreshold = currentMonitorAlive ? Math.max(config.monitorStaleMs, 120000) : config.monitorStaleMs;
      if (currentAge <= currentThreshold) return;
      await launchMonitor(stateDir, task.id, true);
    }).catch(async (error) => {
      await appendRecoveryError(stateDir, task.id, `monitor recovery failed: ${error.message}`).catch(() => {});
    });
  }
}

async function appendRecoveryError(stateDir, taskId, message) {
  await withLock(stateDir, `task-${taskId}`, async () => {
    const task = await readTask(stateDir, taskId);
    task.errors.push(message);
    task.error = message;
    await writeTask(stateDir, task);
  });
}

export async function getTask(stateDir, taskId) {
  validateTaskId(taskId);
  await recoverTasks(stateDir, null, taskId);
  const task = ensureAttemptMetadata(await readTask(stateDir, taskId));
  await updateLogStats(task);
  return task;
}

export async function getTasks(stateDir) {
  await recoverTasks(stateDir);
  const tasks = (await listTasks(stateDir)).map(ensureAttemptMetadata);
  await Promise.all(tasks.map((task) => updateLogStats(task)));
  return tasks;
}

export async function cancelTask(stateDir, taskId) {
  validateTaskId(taskId);
  await recoverTasks(stateDir, null, taskId);
  return withLock(stateDir, `task-${taskId}`, async () => {
    const task = await readTask(stateDir, taskId);
    if (terminalStates.has(task.state)) {
      return task;
    }
    const now = new Date().toISOString();
    task.state = 'cancel_requested';
    task.cancelRequestedAt ??= now;
    await updateLogStats(task);
    await writeTask(stateDir, task);
    return task;
  });
}

export async function readSlots(stateDir) {
  await loadConfig(stateDir);
  return readJson(statePaths(stateDir).slots);
}

export function isTerminal(state) {
  return terminalStates.has(state);
}

function validateResourceClass(config, resourceClass) {
  if (config.adapter !== 'projfs') {
    return;
  }
  if (!['light', 'heavy-build'].includes(resourceClass)) {
    throw new Error("ProjFS start/run requires --resource-class light|heavy-build");
  }
}

function createTaskId() {
  const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  return `${timestamp}-${crypto.randomBytes(6).toString('hex')}`;
}
