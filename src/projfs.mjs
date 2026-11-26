import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { atomicWriteJson, delay, isProcessAlive, readJson, statePaths, withLifecycleLock, withLock } from './state.mjs';
import { classifyProcessIdentity, getProcessIdentity } from './process-identity.mjs';
import {
  isOwnedProcessAlive,
  launchOwned,
  ownershipDescriptor,
  queryOwnedJobEmpty,
  readOwnedProcess,
  terminateOwned,
} from './process-owner.mjs';
import { assertBrokerGeneration, newNonce } from './ownership.mjs';

export const quarantineMarkerName = 'BASE_MODIFIED';
const lowerGuardOwnerName = 'lower-guard-owner.json';
const lowerQuarantineName = 'lower-quarantine.json';
const execFileAsync = promisify(execFile);
const generationSupervisorEntry = fileURLToPath(new URL('../bin/agent-workspace.mjs', import.meta.url));

export function humanSlotGuidance() {
  return 'Choices: accept a new generation with base-change plan-new-generation, then clean up and initialize new roots; or remain quarantined. Mixed roots are never reused.';
}

function lowerGuardPaths(stateDir) {
  const directory = path.join(stateDir, 'lower-guard');
  return {
    directory,
    owner: path.join(stateDir, lowerGuardOwnerName),
    state: path.join(directory, 'state.json'),
    stdout: path.join(directory, 'stdout.log'),
    stderr: path.join(directory, 'stderr.log'),
    quarantine: path.join(stateDir, lowerQuarantineName),
  };
}

async function readGuardState(statePath) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const state = await readJson(statePath).catch(() => null);
    if (state) return state;
    if (attempt < 2) await delay(20);
  }
  return null;
}

function lowerGuardDescriptor(owner) {
  return {
    ownerUuid: owner.ownerUuid,
    nonce: owner.nonce,
    kind: owner.kind ?? 'lower-freeze-guard',
    launchManifestPath: owner.launchManifestPath,
    jobName: owner.jobName,
  };
}

function generationSupervisorPaths(stateDir) {
  return {
    owner: path.join(stateDir, 'generation-supervisor-owner.json'),
    state: path.join(stateDir, 'generation-supervisor-state.json'),
    stdout: path.join(stateDir, 'generation-supervisor-stdout.log'),
    stderr: path.join(stateDir, 'generation-supervisor-stderr.log'),
  };
}

function generationSupervisorDescriptor(owner) {
  return {
    ownerUuid: owner.ownerUuid,
    nonce: owner.nonce,
    kind: owner.kind ?? 'generation-supervisor',
    launchManifestPath: owner.launchManifestPath,
    jobName: owner.jobName,
  };
}

export async function quarantineLower(stateDir, config, reason, details = {}) {
  if (config.adapter !== 'projfs') return null;
  const paths = lowerGuardPaths(stateDir);
  return withLock(stateDir, 'quarantine', async () => {
    const existing = await readJson(paths.quarantine).catch(() => null);
    if (existing?.brokerUuid === config.brokerUuid) return existing;
    const evidence = {
      version: 1,
      brokerUuid: config.brokerUuid,
      state: 'quarantined',
      detectedAt: new Date().toISOString(),
      reason,
      source: details.source ?? 'broker_guard_validation',
      paths: details.paths ?? [],
      ...details,
    };
    await atomicWriteJson(paths.quarantine, evidence);
    return evidence;
  });
}

async function enforceQuarantinedProviders(stateDir, config, reason) {
  const slots = await readJson(statePaths(stateDir).slots).catch(() => null);
  if (!slots) return;
  for (const slot of slots.slots) {
    if (!slot.provider || ['quarantined', 'termination_failed', 'stopped'].includes(slot.provider.state)) continue;
    const descriptor = providerDescriptor(slot.provider);
    const manifest = await readOwnedProcess(descriptor);
    if (manifest?.creationIdentity) {
      await terminateOwned(config, descriptor, config.providerStopTimeoutMs).catch(() => false);
    }
    await quarantineProvider(stateDir, slot.index, `lower-freeze quarantine stopped provider: ${reason}`).catch(() => {});
  }
}

export async function inspectProjfsSafety(stateDir, config, options = {}) {
  if (config.adapter !== 'projfs') return { state: 'not_applicable', quarantined: false };
  const paths = lowerGuardPaths(stateDir);
  const markerPath = path.join(stateDir, quarantineMarkerName);
  if (await fs.access(markerPath).then(() => true, () => false)) {
    await quarantineLower(stateDir, config, 'BASE_MODIFIED deterministic test hook requested quarantine', {
      source: 'deterministic_test_hook',
      markerPath,
    });
  }
  let quarantine = await readJson(paths.quarantine).catch(() => null);
  const owner = await readJson(paths.owner).catch(() => null);
  const guardState = await readGuardState(paths.state);
  const supervisorPaths = generationSupervisorPaths(stateDir);
  const supervisorOwner = await readJson(supervisorPaths.owner).catch(() => null);
  const supervisorState = await readGuardState(supervisorPaths.state);
  if (!quarantine && (!owner || owner.ownerUuid !== config.brokerUuid)) {
    quarantine = await quarantineLower(stateDir, config, 'lower-freeze guard ownership is missing or belongs to another generation');
  }
  if (!quarantine && guardState?.phase === 'quarantined') {
    quarantine = await quarantineLower(stateDir, config, guardState.reason || 'lower-freeze guard reported quarantine', {
      source: 'native_guard_state',
    });
  }
  if (!quarantine && owner?.state === 'ready' && !isProcessAlive(owner.pid)) {
    quarantine = await quarantineLower(stateDir, config, 'lower-freeze guard process died', {
      source: 'guard_process_liveness',
    });
  }
  const guardIdentityStatus = !quarantine && options.verifyGuardIdentity && owner?.state === 'ready'
    ? await providerIdentityStatus(owner)
    : null;
  if (!quarantine && guardIdentityStatus?.state !== undefined && guardIdentityStatus.state !== 'matching') {
    quarantine = await quarantineLower(stateDir, config, 'lower-freeze guard died or its process identity became unverifiable', {
      source: 'guard_process_identity',
    });
  }
  if (!quarantine && owner?.state !== 'ready') {
    quarantine = await quarantineLower(stateDir, config, 'lower watcher is not durably ready', {
      source: 'guard_readiness',
    });
  }
  if (!quarantine && !options.skipSupervisorValidation) {
    const supervisorHeartbeat = Date.parse(supervisorState?.heartbeatAt ?? '');
    const supervisorIsLive = supervisorOwner?.state === 'ready' && isProcessAlive(supervisorOwner.pid);
    if (supervisorOwner?.ownerUuid !== config.brokerUuid || !supervisorIsLive
      || supervisorState?.brokerUuid !== config.brokerUuid || !Number.isFinite(supervisorHeartbeat)
      || Date.now() - supervisorHeartbeat > config.lowerGuardHeartbeatStaleMs) {
      quarantine = await quarantineLower(stateDir, config, 'generation supervisor died or its continuity became unverifiable', {
        source: 'generation_supervisor_validation',
      });
    }
  }
  if (!quarantine) {
    const heartbeat = Date.parse(guardState?.heartbeatAt ?? '');
    if (guardState?.brokerUuid !== config.brokerUuid || guardState?.phase !== 'ready'
      || !Number.isFinite(heartbeat) || Date.now() - heartbeat > config.lowerGuardHeartbeatStaleMs) {
      quarantine = await quarantineLower(stateDir, config, 'lower-freeze guard heartbeat/checkpoint is stale or invalid', {
        source: 'guard_checkpoint',
      });
    }
  }
  if (quarantine) {
    await enforceQuarantinedProviders(stateDir, config, quarantine.reason);
  }
  return {
    state: quarantine ? 'base_modified_quarantine' : 'lower_frozen_guarded',
    quarantined: Boolean(quarantine),
    markerPath,
    quarantinePath: paths.quarantine,
    protection: 'continuous subtree directory watcher; continuity loss quarantines this retained generation',
    guard: owner ? {
      state: owner.state,
      pid: owner.pid,
      creationIdentity: owner.creationIdentity,
      heartbeatAt: guardState?.heartbeatAt ?? null,
      identityState: guardIdentityStatus?.state ?? null,
    } : null,
    supervisor: supervisorOwner ? {
      state: supervisorOwner.state,
      pid: supervisorOwner.pid,
      creationIdentity: supervisorOwner.creationIdentity,
      heartbeatAt: supervisorState?.heartbeatAt ?? null,
    } : null,
    quarantine,
    message: quarantine
      ? `LOWER FREEZE QUARANTINE: projected work is blocked and queued/active attempts are cancelled. ${quarantine.reason}. ${humanSlotGuidance()}`
      : `The continuous lower watcher is healthy. ${humanSlotGuidance()}`,
  };
}

export async function requireProjfsSafe(stateDir, config) {
  const safety = await inspectProjfsSafety(stateDir, config, { verifyGuardIdentity: true });
  if (safety.quarantined) throw new Error(safety.message);
  return safety;
}

export async function ensureLowerGuard(stateDir, config) {
  if (config.adapter !== 'projfs') return null;
  const paths = lowerGuardPaths(stateDir);
  await assertBrokerGeneration(stateDir, config.brokerUuid);
  const reservation = await withLock(stateDir, 'guard', async () => {
    const existing = await readJson(paths.owner).catch(() => null);
    if (existing) return { mode: 'adopt', owner: existing };
    const nonce = newNonce();
    const descriptor = ownershipDescriptor(stateDir, config, 'lower-freeze-guard', nonce);
    const owner = {
      version: 1,
      state: 'starting',
      ownerUuid: config.brokerUuid,
      nonce,
      kind: descriptor.kind,
      pid: null,
      creationIdentity: null,
      jobName: descriptor.jobName,
      launchManifestPath: descriptor.launchManifestPath,
      startedAt: new Date().toISOString(),
      readyAt: null,
    };
    await atomicWriteJson(paths.owner, owner);
    return { mode: 'launch', owner };
  });
  if (reservation.mode === 'adopt') {
    if (reservation.owner.state === 'ready' && (await providerIdentityStatus(reservation.owner)).state === 'matching') {
      await requireProjfsSafe(stateDir, config);
      return reservation.owner;
    }
    const reason = 'existing lower-freeze guard could not be safely adopted';
    await quarantineLower(stateDir, config, reason, { source: 'guard_adoption' });
    throw new Error(reason);
  }
  const owner = reservation.owner;
  const descriptor = lowerGuardDescriptor(owner);
  const guardArgs = [
    '--lower', config.lower,
    '--state', paths.state,
    '--quarantine', paths.quarantine,
    '--broker-uuid', config.brokerUuid,
  ];
  const executable = config.testMode ? process.execPath : config.lowerGuardExe;
  const args = config.testMode ? [config.lowerGuardExe, ...guardArgs] : guardArgs;
  try {
    const owned = await launchOwned(config, descriptor, executable, args, {
      cwd: stateDir,
      stdoutPath: paths.stdout,
      stderrPath: paths.stderr,
      launchTimeoutMs: config.lowerGuardReadyTimeoutMs,
      env: process.env,
    });
    await withLock(stateDir, 'guard', async () => {
      const current = await readJson(paths.owner);
      if (current.nonce !== owner.nonce) throw new Error('lower-freeze guard reservation was superseded');
      current.pid = owned.pid;
      current.creationIdentity = owned.creationIdentity;
      await atomicWriteJson(paths.owner, current);
    });
    owned.child?.unref();
    const deadline = Date.now() + config.lowerGuardReadyTimeoutMs;
    while (Date.now() < deadline) {
      const [output, state, live] = await Promise.all([
        fs.readFile(paths.stdout, 'utf8').catch(() => ''),
        readJson(paths.state).catch(() => null),
        isOwnedProcessAlive(descriptor),
      ]);
      if (live && output.split(/\r?\n/).includes('LOWER_FREEZE_READY')
        && state?.phase === 'ready' && state?.brokerUuid === config.brokerUuid) {
        const readyAt = new Date().toISOString();
        await withLock(stateDir, 'guard', async () => {
          const current = await readJson(paths.owner);
          current.state = 'ready';
          current.readyAt = readyAt;
          await atomicWriteJson(paths.owner, current);
        });
        return { ...owner, pid: owned.pid, creationIdentity: owned.creationIdentity, state: 'ready', readyAt };
      }
      if (!live) break;
      await delay(Math.min(config.pollMs, 50));
    }
    throw new Error(`lower-freeze guard did not emit exact LOWER_FREEZE_READY with a durable seal within ${config.lowerGuardReadyTimeoutMs}ms`);
  } catch (error) {
    await terminateOwned(config, descriptor, config.providerStopTimeoutMs).catch(() => false);
    await quarantineLower(stateDir, config, `lower-freeze guard startup/readiness failed: ${error.message}`, { source: 'guard_startup' });
    await withLock(stateDir, 'guard', async () => {
      const current = await readJson(paths.owner).catch(() => owner);
      current.state = 'quarantined';
      current.error = error.message;
      await atomicWriteJson(paths.owner, current);
    });
    throw error;
  }
}

export async function stopOwnedLowerGuard(stateDir, config) {
  if (config.adapter !== 'projfs') return { stopped: true };
  const paths = lowerGuardPaths(stateDir);
  const owner = await readJson(paths.owner).catch(() => null);
  if (!owner) return { stopped: true };
  const descriptor = lowerGuardDescriptor(owner);
  const manifest = await readOwnedProcess(descriptor);
  if (!manifest) return { stopped: false, error: 'guard owned-job manifest is missing' };
  const status = owner.pid && owner.creationIdentity ? await providerIdentityStatus(owner) : { state: 'unverifiable' };
  if (['unknown-live', 'unverifiable'].includes(status.state)) {
    return { stopped: false, error: 'guard process identity is unverifiable' };
  }
  if (status.state === 'matching') {
    await stopProcessGroup(owner.pid, owner.creationIdentity, config.providerStopTimeoutMs).catch(() => false);
  }
  if (!await ensureOwnedJobEmpty(config, descriptor, config.providerStopTimeoutMs)) {
    return { stopped: false, error: 'guard survived owned-job termination' };
  }
  owner.state = 'stopped';
  owner.stoppedAt = new Date().toISOString();
  await atomicWriteJson(paths.owner, owner);
  return { stopped: true };
}

export async function ensureGenerationSupervisor(stateDir, config) {
  if (config.adapter !== 'projfs') return null;
  const paths = generationSupervisorPaths(stateDir);
  const reservation = await withLock(stateDir, 'generation-supervisor', async () => {
    const existing = await readJson(paths.owner).catch(() => null);
    if (existing) return { mode: 'adopt', owner: existing };
    const nonce = newNonce();
    const descriptor = ownershipDescriptor(stateDir, config, 'generation-supervisor', nonce);
    const owner = {
      version: 1,
      state: 'starting',
      ownerUuid: config.brokerUuid,
      nonce,
      kind: descriptor.kind,
      pid: null,
      creationIdentity: null,
      jobName: descriptor.jobName,
      launchManifestPath: descriptor.launchManifestPath,
      startedAt: new Date().toISOString(),
    };
    await atomicWriteJson(paths.owner, owner);
    return { mode: 'launch', owner };
  });
  if (reservation.mode === 'adopt') {
    const state = await readJson(paths.state).catch(() => null);
    if (reservation.owner.state === 'ready' && (await providerIdentityStatus(reservation.owner)).state === 'matching'
      && state?.brokerUuid === config.brokerUuid) return reservation.owner;
    await quarantineLower(stateDir, config, 'generation supervisor continuity was lost', { source: 'generation_supervisor_adoption' });
    throw new Error('existing generation supervisor could not be safely adopted');
  }

  const owner = reservation.owner;
  const descriptor = generationSupervisorDescriptor(owner);
  const executable = config.testMode ? process.execPath : config.generationSupervisorExe;
  const args = config.testMode
    ? [generationSupervisorEntry, '_generation-supervisor', '--state-dir', stateDir]
    : [process.execPath, generationSupervisorEntry, '_generation-supervisor', '--state-dir', stateDir];
  try {
    const owned = await launchOwned(config, descriptor, executable, args, {
      cwd: stateDir,
      stdoutPath: paths.stdout,
      stderrPath: paths.stderr,
      launchTimeoutMs: config.lowerGuardReadyTimeoutMs,
      env: process.env,
    });
    const deadline = Date.now() + config.lowerGuardReadyTimeoutMs;
    while (Date.now() < deadline) {
      const [output, state, live] = await Promise.all([
        fs.readFile(paths.stdout, 'utf8').catch(() => ''),
        readJson(paths.state).catch(() => null),
        isOwnedProcessAlive(descriptor),
      ]);
      if (live && output.split(/\r?\n/).includes('GENERATION_SUPERVISOR_READY')
        && state?.brokerUuid === config.brokerUuid) {
        const ready = { ...owner, pid: owned.pid, creationIdentity: owned.creationIdentity, state: 'ready', readyAt: new Date().toISOString() };
        await atomicWriteJson(paths.owner, ready);
        owned.child?.unref();
        return ready;
      }
      if (!live) break;
      await delay(Math.min(config.pollMs, 50));
    }
    throw new Error('generation supervisor did not become durably ready');
  } catch (error) {
    await terminateOwned(config, descriptor, config.providerStopTimeoutMs).catch(() => false);
    await quarantineLower(stateDir, config, `generation supervisor startup failed: ${error.message}`, { source: 'generation_supervisor_startup' });
    throw error;
  }
}

export async function stopOwnedGenerationSupervisor(stateDir, config) {
  if (config.adapter !== 'projfs') return { stopped: true };
  const paths = generationSupervisorPaths(stateDir);
  const owner = await readJson(paths.owner).catch(() => null);
  if (!owner) return { stopped: true };
  const descriptor = generationSupervisorDescriptor(owner);
  const manifest = await readOwnedProcess(descriptor);
  if (!manifest) return { stopped: false, error: 'generation supervisor owned-job manifest is missing' };
  const status = owner.pid && owner.creationIdentity ? await providerIdentityStatus(owner) : { state: 'starting-with-owned-job' };
  if (status.state === 'unknown-live' || status.state === 'unverifiable') {
    return { stopped: false, error: 'generation supervisor identity is unverifiable' };
  }
  if (!await ensureOwnedJobEmpty(config, descriptor, config.providerStopTimeoutMs)) {
    return { stopped: false, error: 'generation supervisor survived owned-job termination' };
  }
  owner.state = 'stopped';
  owner.stoppedAt = new Date().toISOString();
  await atomicWriteJson(paths.owner, owner);
  return { stopped: true };
}

export async function ensureProvider(stateDir, config, taskId) {
  if (config.adapter !== 'projfs') return null;
  await requireProjfsSafe(stateDir, config);
  const reservation = await withLifecycleLock(stateDir, () => reserveAndLaunchProvider(stateDir, config, taskId));
  return finishProviderStartup(stateDir, config, taskId, reservation);
}

async function reserveAndLaunchProvider(stateDir, config, taskId) {
  await assertBrokerGeneration(stateDir, config.brokerUuid);
  const value = await withLock(stateDir, 'state', async () => {
    const paths = statePaths(stateDir);
    const slots = await readJson(paths.slots);
    const slot = slots.slots.find((candidate) => candidate.taskId === taskId);
    if (!slot) throw new Error(`task '${taskId}' has no retained ProjFS slot`);
    if (slot.provider?.state === 'ready') return { mode: 'ready', slot: structuredClone(slot) };
    if (slot.provider?.state === 'starting') return { mode: 'recover', slot: structuredClone(slot) };
    if (['quarantined', 'termination_failed'].includes(slot.provider?.state)) {
      throw new Error(slot.provider.error ?? `ProjFS provider for slot ${slot.index} is ${slot.provider.state}`);
    }
    const now = new Date();
    const nonce = newNonce();
    const descriptor = ownershipDescriptor(stateDir, config, `provider-slot-${slot.index}`, nonce);
    slot.provider = {
      state: 'starting',
      ownerUuid: config.brokerUuid,
      nonce,
      pid: null,
      creationIdentity: null,
      jobName: descriptor.jobName,
      launchManifestPath: descriptor.launchManifestPath,
      startedAt: now.toISOString(),
      readyDeadline: new Date(now.getTime() + config.providerReadyTimeoutMs).toISOString(),
      readyAt: null,
      diedAt: null,
      stdoutLogPath: path.join(paths.logs, `projfs-slot-${slot.index}.stdout.log`),
      stderrLogPath: path.join(paths.logs, `projfs-slot-${slot.index}.stderr.log`),
    };
    slots.updatedAt = slot.provider.startedAt;
    await atomicWriteJson(paths.slots, slots);
    return { mode: 'launch', slot: structuredClone(slot) };
  });
  if (value.mode === 'launch') {
    const lifecycleGate = process.env.AGENT_WORKSPACE_TEST_PROVIDER_LIFECYCLE_GATE;
    if (lifecycleGate) {
      while (!await fs.access(lifecycleGate).then(() => true, () => false)) await delay(20);
    }
    const lifecycleDelayMs = Number(process.env.AGENT_WORKSPACE_TEST_PROVIDER_LIFECYCLE_DELAY_MS ?? 0);
    if (Number.isSafeInteger(lifecycleDelayMs) && lifecycleDelayMs > 0) await delay(lifecycleDelayMs);
    await assertBrokerGeneration(stateDir, config.brokerUuid);
    await launchReservedProvider(stateDir, config, value.slot);
  }
  return value;
}

async function finishProviderStartup(stateDir, config, taskId, reservation) {
  if (reservation.mode === 'ready') {
    if (await providerIdentityMatches(reservation.slot.provider)) return reservation.slot.provider;
    await quarantineProvider(stateDir, reservation.slot.index, 'retained ProjFS provider identity is no longer live');
    throw new Error(`retained ProjFS provider died for slot ${reservation.slot.index}; failing closed`);
  }
  return waitForProvider(stateDir, config, reservation.slot.index, taskId);
}

async function launchReservedProvider(stateDir, config, slot) {
  await requireProjfsSafe(stateDir, config);
  const providerArgs = ['--lower', config.lower, '--root', slot.root];
  const executable = config.testMode ? process.execPath : config.providerExe;
  const args = config.testMode ? [config.providerExe, ...providerArgs] : providerArgs;
  const descriptor = providerDescriptor(slot.provider);
  try {
    const owned = await launchOwned(config, descriptor, executable, args, {
      cwd: slot.root,
      stdoutPath: slot.provider.stdoutLogPath,
      stderrPath: slot.provider.stderrLogPath,
      launchTimeoutMs: config.providerReadyTimeoutMs,
      env: process.env,
    });
    if (!owned.creationIdentity) throw new Error('provider launch returned a null process identity');
    await updateProvider(stateDir, slot.index, (provider) => {
      if (provider.nonce !== descriptor.nonce) throw new Error('provider reservation was superseded');
      provider.pid = owned.pid;
      provider.creationIdentity = owned.creationIdentity;
    });
    owned.child?.unref();
  } catch (error) {
    await quarantineProvider(stateDir, slot.index, `ProjFS provider launch failed: ${error.message}`);
    throw error;
  }
}

async function waitForProvider(stateDir, config, slotIndex, taskId) {
  while (true) {
    const safety = await inspectProjfsSafety(stateDir, config);
    if (safety.quarantined) {
      const snapshot = await readJson(statePaths(stateDir).slots);
      const provider = snapshot.slots.find((slot) => slot.index === slotIndex)?.provider;
      if (provider) {
        const descriptor = providerDescriptor(provider);
        if (await readOwnedProcess(descriptor)) await terminateOwned(config, descriptor, config.providerStopTimeoutMs).catch(() => false);
        await quarantineProvider(stateDir, slotIndex, safety.message);
      }
      throw new Error(safety.message);
    }
    const [slots, task] = await Promise.all([
      readJson(statePaths(stateDir).slots),
      taskId.startsWith('human:') ? Promise.resolve(null) : readJson(path.join(statePaths(stateDir).tasks, `${taskId}.json`)).catch(() => null),
    ]);
    const provider = slots.slots.find((slot) => slot.index === slotIndex)?.provider;
    if (task?.cancelRequestedAt) {
      if (provider) {
        const descriptor = providerDescriptor(provider);
        if (await readOwnedProcess(descriptor)) await terminateOwned(config, descriptor, config.providerStopTimeoutMs).catch(() => false);
        await quarantineProvider(stateDir, slotIndex, 'provider readiness cancelled with its owning task');
      }
      throw new Error('task cancelled while waiting for ProjFS readiness');
    }
    if (!provider) throw new Error(`missing ProjFS provider state for slot ${slotIndex}`);
    if (provider.state === 'ready' && await providerIdentityMatches(provider)) return provider;
    if (['quarantined', 'termination_failed', 'dead'].includes(provider.state)) {
      throw new Error(provider.error ?? `ProjFS provider is ${provider.state} for slot ${slotIndex}`);
    }
    const descriptor = providerDescriptor(provider);
    const manifest = await readOwnedProcess(descriptor);
    if (manifest?.state === 'prepared') {
      await terminateOwned(config, descriptor, config.providerStopTimeoutMs).catch(() => false);
      const reason = 'ProjFS provider recovery found a prepared but uncommitted suspended launch; it was terminated without being labeled ready';
      await quarantineProvider(stateDir, slotIndex, reason);
      throw new Error(reason);
    }
    if (manifest?.state === 'aborted') {
      const reason = 'ProjFS provider launch was aborted before commit and was never resumed';
      await quarantineProvider(stateDir, slotIndex, reason);
      throw new Error(reason);
    }
    if (manifest && !provider.pid) {
      await updateProvider(stateDir, slotIndex, (current) => {
        current.pid = manifest.pid;
        current.creationIdentity = manifest.creationIdentity;
      });
    }
    if (manifest?.state === 'running' && await isOwnedProcessAlive(descriptor)) {
      const output = await fs.readFile(provider.stdoutLogPath, 'utf8').catch(() => '');
      if (output.split(/\r?\n/).includes('PROJFS_READY')) {
        const readyAt = new Date().toISOString();
        await updateProvider(stateDir, slotIndex, (current) => {
          current.state = 'ready';
          current.readyAt = readyAt;
        });
        return { ...provider, ...manifest, state: 'ready', readyAt };
      }
    } else if (manifest) {
      await quarantineProvider(stateDir, slotIndex, 'ProjFS provider exited before exact PROJFS_READY');
      throw new Error('ProjFS provider exited before exact PROJFS_READY');
    }
    if (Date.now() >= Date.parse(provider.readyDeadline)) {
      if (manifest) await terminateOwned(config, descriptor, config.providerStopTimeoutMs).catch(() => false);
      const reason = `ProjFS provider did not emit exact PROJFS_READY within ${config.providerReadyTimeoutMs}ms`;
      await quarantineProvider(stateDir, slotIndex, reason);
      throw new Error(reason);
    }
    await delay(Math.min(config.pollMs, 50));
  }
}

function providerDescriptor(provider) {
  return {
    ownerUuid: provider.ownerUuid,
    nonce: provider.nonce,
    kind: provider.kind ?? providerKindFromManifest(provider.launchManifestPath),
    launchManifestPath: provider.launchManifestPath,
    jobName: provider.jobName,
  };
}

function providerKindFromManifest(manifestPath) {
  return path.basename(manifestPath).replace(/-[0-9a-f]{32}\.json$/i, '');
}

async function providerIdentityStatus(provider) {
  if (!provider.creationIdentity || !provider.pid) return { state: 'unverifiable', identity: null };
  return classifyProcessIdentity(provider.pid, provider.creationIdentity);
}

async function providerIdentityMatches(provider) {
  return (await providerIdentityStatus(provider)).state === 'matching';
}

async function updateProvider(stateDir, slotIndex, mutate) {
  await withLock(stateDir, 'state', async () => {
    const paths = statePaths(stateDir);
    const slots = await readJson(paths.slots);
    const slot = slots.slots.find((candidate) => candidate.index === slotIndex);
    if (!slot?.provider) throw new Error(`missing ProjFS provider state for slot ${slotIndex}`);
    mutate(slot.provider);
    slots.updatedAt = new Date().toISOString();
    await atomicWriteJson(paths.slots, slots);
  });
}

async function quarantineProvider(stateDir, slotIndex, reason, state = 'quarantined') {
  await updateProvider(stateDir, slotIndex, (provider) => {
    provider.state = state;
    provider.diedAt = new Date().toISOString();
    provider.error = reason;
  });
}

export async function stopOwnedProvider(stateDir, config, slot) {
  const provider = slot.provider;
  if (!provider) return { stopped: true };
  if (!provider.creationIdentity) {
    const manifest = provider.launchManifestPath ? await readOwnedProcess(providerDescriptor(provider)) : null;
    if (manifest?.creationIdentity) {
      provider.pid = manifest.pid;
      provider.creationIdentity = manifest.creationIdentity;
      await updateProvider(stateDir, slot.index, (current) => {
        current.pid = manifest.pid;
        current.creationIdentity = manifest.creationIdentity;
      });
    } else if (!provider.pid) {
      return { stopped: true };
    } else {
      const identity = await classifyProcessIdentity(provider.pid, '__missing_expected_identity__');
      if (identity.state === 'dead') return { stopped: true };
      await quarantineProvider(stateDir, slot.index, 'provider has a live PID but no creation identity; termination refused', 'termination_failed');
      return { stopped: false, error: 'provider identity is unknown-live' };
    }
  }
  const descriptor = providerDescriptor(provider);
  const manifest = await readOwnedProcess(descriptor);
  if (!manifest) {
    await quarantineProvider(stateDir, slot.index, 'provider owned-job manifest is missing', 'termination_failed');
    return { stopped: false, error: 'provider owned-job manifest is missing' };
  }
  const identityStatus = await providerIdentityStatus(provider);
  if (identityStatus.state === 'unknown-live' || identityStatus.state === 'unverifiable') {
    await quarantineProvider(stateDir, slot.index, 'provider PID is live but its creation identity cannot be verified after bounded retries', 'termination_failed');
    return { stopped: false, error: 'provider identity is unknown-live' };
  }
  if (identityStatus.state === 'matching') {
    await stopProcessGroup(provider.pid, provider.creationIdentity, config.providerStopTimeoutMs).catch(() => false);
  }
  if (!await ensureOwnedJobEmpty(config, descriptor, config.providerStopTimeoutMs)) {
    await quarantineProvider(stateDir, slot.index, 'provider graceful stop and owned-job termination could not be confirmed', 'termination_failed');
    return { stopped: false, error: 'provider termination could not be confirmed' };
  }
  await updateProvider(stateDir, slot.index, (current) => {
    current.state = 'stopped';
    current.stoppedAt = new Date().toISOString();
  });
  return { stopped: true };
}

export async function createHumanSlot(stateDir, config, name) {
  if (config.adapter !== 'projfs') throw new Error('human-slot requires an adapter=projfs broker');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) {
    throw new Error('--name must contain only letters, digits, dot, underscore, or hyphen');
  }
  await requireProjfsSafe(stateDir, config);
  const ownerId = `human:${name}`;
  return withLifecycleLock(stateDir, async () => {
    await assertBrokerGeneration(stateDir, config.brokerUuid);
    const slot = await withLock(stateDir, 'state', async () => {
      const paths = statePaths(stateDir);
      const slots = await readJson(paths.slots);
      if (slots.slots.some((candidate) => candidate.humanOwner === name)) throw new Error(`human slot '${name}' is already retained`);
      const selected = slots.slots.find((candidate) => !candidate.taskId && !candidate.humanOwner);
      if (!selected) throw new Error(`capacity exhausted: all ${config.maxAgentWorkspaces} projected slots are retained`);
      selected.taskId = ownerId;
      selected.humanOwner = name;
      selected.humanOwnerState = 'provisioning';
      selected.allocatedAt = new Date().toISOString();
      slots.updatedAt = selected.allocatedAt;
      await atomicWriteJson(paths.slots, slots);
      return structuredClone(selected);
    });
    try {
      const reservation = await reserveAndLaunchProvider(stateDir, config, ownerId);
      const provider = await finishProviderStartup(stateDir, config, ownerId, reservation);
      await setHumanOwnerState(stateDir, config.brokerUuid, slot.index, name, 'ready');
      return { name, slot: slot.index, root: slot.root, humanOwnerState: 'ready', provider };
    } catch (error) {
      await setHumanOwnerState(stateDir, config.brokerUuid, slot.index, name, 'quarantined', error.message);
      throw error;
    }
  });
}

async function setHumanOwnerState(stateDir, brokerUuid, slotIndex, humanOwner, state, error = null) {
  await assertBrokerGeneration(stateDir, brokerUuid);
  await withLock(stateDir, 'state', async () => {
    const paths = statePaths(stateDir);
    const slots = await readJson(paths.slots);
    if (slots.brokerUuid !== brokerUuid) throw new Error('human slot generation changed before finalization');
    const slot = slots.slots.find((candidate) => candidate.index === slotIndex);
    if (!slot || slot.humanOwner !== humanOwner) throw new Error('human slot reservation changed before finalization');
    slot.humanOwnerState = state;
    slot.humanOwnerError = error;
    slots.updatedAt = new Date().toISOString();
    await atomicWriteJson(paths.slots, slots);
  });
}

export async function refreshProviderStates(stateDir, config) {
  if (config.adapter !== 'projfs') return;
  const slots = await readJson(statePaths(stateDir).slots);
  for (const slot of slots.slots) {
    if (slot.provider?.state !== 'ready') continue;
    if (!await providerIdentityMatches(slot.provider)) {
      await quarantineProvider(stateDir, slot.index, 'retained ProjFS provider identity is no longer live');
    }
  }
}

export async function verifyProviderAlive(stateDir, config, task) {
  if (config.adapter !== 'projfs') return true;
  const slots = await readJson(statePaths(stateDir).slots);
  const slot = slots.slots.find((candidate) => candidate.index === task.slot);
  return Boolean(slot?.provider?.state === 'ready' && isProcessAlive(slot.provider.pid));
}

async function ensureOwnedJobEmpty(config, descriptor, timeoutMs) {
  if (await queryOwnedJobEmpty(config, descriptor, timeoutMs)) return true;
  if (!await terminateOwned(config, descriptor, timeoutMs).catch(() => false)) return false;
  return queryOwnedJobEmpty(config, descriptor, timeoutMs);
}

export async function stopProcessGroup(pid, creationIdentity, timeoutMs = 5000) {
  if (!creationIdentity || await getProcessIdentity(pid) !== creationIdentity) return false;
  if (process.env.AGENT_WORKSPACE_TEST_STOP_FAILURE === '1') return false;
  if (process.platform === 'win32') {
    await execFileAsync('taskkill.exe', ['/pid', String(pid), '/t', '/f'], {
      windowsHide: true,
      timeout: Math.max(timeoutMs, 1000),
    }).catch(() => {});
  } else {
    try {
      process.kill(-pid, 'SIGTERM');
    } catch (error) {
      if (error.code === 'ESRCH') return true;
      throw error;
    }
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await classifyProcessIdentity(pid, creationIdentity);
    if (status.state === 'dead' || status.state === 'reused') return true;
    await delay(50);
  }
  return false;
}

export { getProcessIdentity } from './process-identity.mjs';
