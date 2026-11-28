import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './broker.mjs';
import { authLifetimeMarginMs, defaultAuthMinValidMs, withoutHordeSecrets } from './auth.mjs';
import { atomicWriteJson, delay, isProcessAlive, listTasks, readJson, readTask, statePaths, updateLogStats, withLifecycleLock, withLock, writeTask } from './state.mjs';
import { ensureProvider, inspectProjfsSafety, requireProjfsSafe, verifyProviderAlive } from './projfs.mjs';
import { getProcessIdentity } from './process-identity.mjs';
import { isOwnedProcessAlive, launchOwned, ownershipDescriptor, queryOwnedJobEmpty, readOwnedProcess, terminateOwned, terminatePreparedOwned } from './process-owner.mjs';
import { assertBrokerGeneration, newNonce } from './ownership.mjs';
import { revisionControlBackend } from './revision-control.mjs';

const execFileAsync = promisify(execFile);
const runnerEntry = fileURLToPath(new URL('./task-runner.mjs', import.meta.url));

export async function runWorker(stateDir, taskId) {
  const config = await loadConfig(stateDir);
  if (config.adapter === 'test' && process.env.AGENT_WORKSPACE_TEST_MONITOR_STARTUP_FAILURE === '1') {
    throw new Error('simulated monitor startup failure');
  }
  const token = crypto.randomBytes(16).toString('hex');
  const claim = await claimTask(stateDir, taskId, config, token);
  if (!claim) {
    await acknowledge({ type: 'monitor-rejected', reason: 'task has a current monitor or is terminal' });
    return;
  }
  const accepted = await acknowledge({ type: 'monitor-ready', recovery: claim.recovery }, true);
  if (!accepted) {
    return;
  }

  if (claim.task.state === 'cancel_requested' && !claim.task.pid) {
    await finishWithoutProcess(stateDir, taskId, token, 'cancelled', { cancelledAt: new Date().toISOString() });
    return;
  }
  if (claim.recovery) {
    if (!claim.task.pid || !claim.task.launcherIdentity) {
      await handleUnverifiableRecovery(stateDir, taskId, config, token);
    } else {
      await monitorRecoveredProcess(stateDir, taskId, config, token);
    }
    return;
  }
  await launchAndMonitor(stateDir, taskId, config, token, claim.task);
}

function acknowledge(message, waitForAcceptance = false) {
  if (!process.send) {
    return Promise.resolve(!waitForAcceptance);
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (accepted) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      process.off('message', onMessage);
      process.off('disconnect', onDisconnect);
      process.disconnect?.();
      resolve(accepted);
    };
    const onMessage = (response) => {
      if (response?.type === 'monitor-accepted') {
        finish(true);
      }
    };
    const onDisconnect = () => finish(false);
    const timer = setTimeout(() => finish(false), 2000);
    timer.unref();
    if (waitForAcceptance) {
      process.on('message', onMessage);
      process.once('disconnect', onDisconnect);
    }
    process.send(message, (error) => {
      if (error) {
        finish(false);
      } else if (!waitForAcceptance) {
        finish(true);
      }
    });
  });
}

async function claimTask(stateDir, taskId, config, token) {
  return withLock(stateDir, `task-${taskId}`, async () => {
    const task = await readTask(stateDir, taskId);
    const nowMs = Date.now();
    const heartbeat = Date.parse(task.heartbeatAt ?? task.updatedAt);
    const active = ['starting', 'running', 'cancel_requested', 'WAITING_FOR_BUILD_CAPACITY'].includes(task.state);
    const stale = !Number.isFinite(heartbeat) || nowMs - heartbeat > config.monitorStaleMs;
    if (!['queued', 'cancel_requested'].includes(task.state) && (!active || !stale)) {
      return null;
    }
    if (active && !stale && task.monitorToken) {
      return null;
    }

    const recovery = active && Boolean(task.pid || task.launchAttemptedAt);
    const now = new Date(nowMs).toISOString();
    task.state = task.cancelRequestedAt ? 'cancel_requested'
      : recovery && task.pid && task.launcherIdentity ? 'running' : 'starting';
    task.monitorPid = process.pid;
    task.monitorToken = token;
    task.monitorRecoveries = (task.monitorRecoveries ?? 0) + (recovery ? 1 : 0);
    task.pids = [...new Set([...(task.pids ?? []), process.pid])];
    task.heartbeatAt = now;
    await writeTask(stateDir, task);
    return { task, recovery };
  });
}

async function launchAndMonitor(stateDir, taskId, config, token, claimed) {
  if (config.adapter === 'projfs') {
    try {
      await ensureProvider(stateDir, config, taskId);
      const admitted = await acquireBuildCapacity(stateDir, taskId, config, token);
      if (!admitted) {
        return;
      }
    } catch (error) {
      const cancelled = error.message.includes('LOWER FREEZE QUARANTINE') || error.message.includes('cancelled while');
      await finishWithoutProcess(stateDir, taskId, token, cancelled ? 'cancelled' : 'failed', {
        error: error.message,
        errors: [error.message],
        ...(cancelled ? { cancelledAt: new Date().toISOString() } : {}),
      });
      return;
    }
  }
  const prelaunchDelayMs = Number(process.env.AGENT_WORKSPACE_TEST_PRELAUNCH_DELAY_MS ?? 0);
  if (config.adapter === 'projfs' && Number.isSafeInteger(prelaunchDelayMs) && prelaunchDelayMs > 0) {
    await delay(prelaunchDelayMs);
  }
  let current = await readTask(stateDir, taskId);
  if (current.cancelRequestedAt) {
    await finishWithoutProcess(stateDir, taskId, token, 'cancelled', { cancelledAt: new Date().toISOString() });
    return;
  }
  try {
    await requireProjfsSafe(stateDir, config);
  } catch (error) {
    await finishWithoutProcess(stateDir, taskId, token, 'cancelled', { cancelledAt: new Date().toISOString(), error: error.message, errors: [error.message] });
    return;
  }
  if (config.adapter === 'projfs' && !await verifyProviderAlive(stateDir, config, current)) {
    const message = 'retained ProjFS provider died before task launch; failing closed';
    await finishWithoutProcess(stateDir, taskId, token, 'failed', { error: message, errors: [message] });
    return;
  }
  const revisionBackend = revisionControlBackend(config);
  if (revisionBackend.isEnabled(config)) {
    try {
      await revisionBackend.bindTask(stateDir, config, taskId);
      current = await readTask(stateDir, taskId);
    } catch (error) {
      await finishWithoutProcess(stateDir, taskId, token, 'failed', { error: error.message, errors: [error.message] });
      return;
    }
  }
  const launch = buildLaunch(config, current);
  const descriptor = ownershipDescriptor(stateDir, config, `task-${taskId}-attempt-${current.attempt}`, newNonce());
  const ownsLaunch = await mutateOwnedTask(stateDir, taskId, token, async (task) => {
    task.launchAttemptedAt = new Date().toISOString();
    task.processOwnership = descriptor;
  });
  if (!ownsLaunch) return;

  const environment = revisionBackend.workerEnvironment(config, current, {
    ...withoutHordeSecrets(process.env),
    AGENT_WORKSPACE_STATE_DIR: stateDir,
    AGENT_WORKSPACE_TASK_ID: taskId,
    TASK_ID: taskId,
    AGENT_WORKSPACE_SLOT: String(claimed.slot),
  });
  let owned;
  try {
    owned = await withLifecycleLock(stateDir, async () => {
      const lifecycleDelayMs = Number(process.env.AGENT_WORKSPACE_TEST_TASK_LAUNCH_DELAY_MS ?? 0);
      if (Number.isSafeInteger(lifecycleDelayMs) && lifecycleDelayMs > 0) await delay(lifecycleDelayMs);
      await assertBrokerGeneration(stateDir, config.brokerUuid);
      await requireProjfsSafe(stateDir, config);
      const launchTask = await readTask(stateDir, taskId);
      if (launchTask.monitorToken !== token || launchTask.cancelRequestedAt) {
        throw new Error('task launch was cancelled or monitor ownership changed before native launch');
      }
      if (config.adapter === 'projfs' && !await verifyProviderAlive(stateDir, config, launchTask)) {
        throw new Error('retained ProjFS provider died immediately before task native launch');
      }
      return launchOwned(config, descriptor, launch.executable, launch.args, {
        cwd: current.workspace,
        stdoutPath: `${current.logPath}.launcher.stdout.log`,
        stderrPath: `${current.logPath}.launcher.stderr.log`,
        launchTimeoutMs: Math.max(config.providerReadyTimeoutMs ?? 10000, 10000),
        env: environment,
      });
    });
  } catch (error) {
    const cancelled = error.message.includes('LOWER FREEZE QUARANTINE') || error.message.includes('launch was cancelled');
    await finishWithoutProcess(stateDir, taskId, token, cancelled ? 'cancelled' : 'failed', {
      error: error.message,
      errors: [error.message],
      ...(cancelled ? { cancelledAt: new Date().toISOString() } : {}),
    });
    return;
  }
  if (!owned.creationIdentity) {
    await finishWithoutProcess(stateDir, taskId, token, 'termination_failed', {
      error: 'owned task launch returned a null process identity; execution cannot be monitored safely',
      errors: ['owned task launch returned a null process identity; execution cannot be monitored safely'],
    });
    return;
  }
  const ownsTask = await mutateOwnedTask(stateDir, taskId, token, async (task) => {
    const now = new Date().toISOString();
    task.state = task.cancelRequestedAt ? 'cancel_requested' : 'running';
    task.startedAt = now;
    task.heartbeatAt = now;
    task.pid = owned.pid;
    task.launcherIdentity = owned.creationIdentity;
    task.pids = [...new Set([...(task.pids ?? []), owned.pid])];
    await updateLogStats(task);
  });
  if (!ownsTask) {
    await terminateOwned(config, descriptor, config.terminationWaitMs).catch(() => false);
    return;
  }

  const closed = owned.child
    ? owned.child.exitCode !== null
      ? Promise.resolve({ exitCode: owned.child.exitCode, signal: owned.child.signalCode })
      : new Promise((resolve) => owned.child.once('close', (exitCode, signal) => resolve({ exitCode, signal })))
    : waitForOwnedExit(config, descriptor, owned.creationIdentity, config.pollMs);
  let stoppingFor = null;
  while (true) {
    const result = await Promise.race([closed, delay(config.pollMs).then(() => null)]);
    if (result) {
      await finishProcess(stateDir, taskId, config, token, result, stoppingFor);
      return;
    }

    const decision = await heartbeat(stateDir, taskId, config, token);
    if (!decision.owned) {
      return;
    }
    stoppingFor ??= decision.cancelRequested ? 'cancelled' : decision.timedOut ? 'timed_out' : null;
    if (!stoppingFor && config.adapter === 'projfs'
      && (await inspectProjfsSafety(stateDir, config)).quarantined) {
      stoppingFor = 'quarantined';
    }
    if (!stoppingFor && config.adapter === 'projfs' && !await verifyProviderAlive(stateDir, config, decision)) {
      stoppingFor = 'provider_died';
    }
    if (!stoppingFor) {
      continue;
    }

    const confirmed = await terminateTask(stateDir, taskId, config, token);
    if (!confirmed) {
      await finishTerminationFailure(stateDir, taskId, token, stoppingFor);
      return;
    }
  }
}

async function acquireBuildCapacity(stateDir, taskId, config, token) {
  const task = await readTask(stateDir, taskId);
  if (task.resourceClass !== 'heavy-build') {
    return true;
  }

  const enteredAt = task.queueEnteredAt ?? new Date().toISOString();
  const queueEntry = { taskId, attempt: task.attempt, nonce: task.attemptNonce, enteredAt };
  while (true) {
    let decision = { admitted: false, cancelled: false, rejected: false, timedOut: false, lostOwnership: false };
    const safety = await inspectProjfsSafety(stateDir, config);
    if (safety.quarantined) {
      await withLock(stateDir, 'state', async () => {
        const paths = statePaths(stateDir);
        const slots = await readJson(paths.slots);
        slots.buildQueue = (slots.buildQueue ?? []).filter((entry) => !(entry?.taskId === taskId
          && entry.attempt === task.attempt && entry.nonce === task.attemptNonce));
        slots.updatedAt = new Date().toISOString();
        await atomicWriteJson(paths.slots, slots);
      });
      await finishWithoutProcess(stateDir, taskId, token, 'cancelled', {
        cancelledAt: new Date().toISOString(), error: safety.message, errors: [safety.message],
      });
      return false;
    }
    await withLock(stateDir, 'state', async () => {
      const paths = statePaths(stateDir);
      const slots = await readJson(paths.slots);
      slots.buildQueue ??= [];
      const tasks = await listTasks(stateDir);
      const byId = new Map(tasks.map((candidate) => [candidate.id, candidate]));
      const seen = new Set();
      slots.buildQueue = slots.buildQueue.filter((entry) => {
        if (!entry || typeof entry !== 'object') return false;
        const candidate = byId.get(entry.taskId);
        const key = `${entry.taskId}:${entry.attempt}:${entry.nonce}`;
        if (seen.has(key) || !candidate) return false;
        seen.add(key);
        return candidate.attempt === entry.attempt
          && candidate.attemptNonce === entry.nonce
          && !['completed', 'artifact_failed', 'failed', 'timed_out', 'cancelled', 'termination_failed'].includes(candidate.state)
          && candidate.permitState !== 'acquired'
          && candidate.permitState !== 'quarantined';
      });
      const current = tasks.find((candidate) => candidate.id === taskId);
      if (!current || current.monitorToken !== token) {
        decision.lostOwnership = true;
        return;
      }
      const matchesCurrent = (entry) => entry.taskId === taskId && entry.attempt === task.attempt && entry.nonce === task.attemptNonce;
      if (current.cancelRequestedAt) {
        slots.buildQueue = slots.buildQueue.filter((entry) => !matchesCurrent(entry));
        decision.cancelled = true;
        await atomicWriteJson(paths.slots, slots);
        return;
      }
      const active = tasks.filter((candidate) => candidate.id !== taskId
        && candidate.resourceClass === 'heavy-build'
        && ['acquired', 'quarantined'].includes(candidate.permitState)).length;
      const alreadyQueued = slots.buildQueue.some(matchesCurrent);
      if (config.buildCapacityPolicy === 'reject' && (active >= config.maxConcurrentHeavyBuilds || slots.buildQueue.length > 0)) {
        decision.rejected = true;
      } else if (!alreadyQueued) {
        slots.buildQueue.push(queueEntry);
      }
      const position = slots.buildQueue.findIndex(matchesCurrent) + 1;
      if (!decision.rejected && position === 1 && active < config.maxConcurrentHeavyBuilds) {
        slots.buildQueue = slots.buildQueue.filter((entry) => !matchesCurrent(entry));
        decision.admitted = true;
      } else if (!decision.rejected && Date.now() - Date.parse(enteredAt) >= config.buildWaitTimeoutMs) {
        slots.buildQueue = slots.buildQueue.filter((entry) => !matchesCurrent(entry));
        decision.timedOut = true;
      }
      slots.updatedAt = new Date().toISOString();
      await atomicWriteJson(paths.slots, slots);
      await mutateOwnedTask(stateDir, taskId, token, async (owned) => {
        owned.heartbeatAt = new Date().toISOString();
        owned.queueEnteredAt = enteredAt;
        owned.queuePosition = decision.admitted ? null : position;
        if (decision.admitted) {
          owned.buildCapacityAcquiredAt = new Date().toISOString();
          owned.permitState = 'acquired';
          owned.state = 'starting';
        } else if (!decision.cancelled && !decision.rejected && !decision.timedOut) {
          owned.state = 'WAITING_FOR_BUILD_CAPACITY';
        }
      });
    });

    if (decision.lostOwnership) {
      return false;
    }
    if (decision.admitted) {
      return true;
    }
    if (decision.cancelled) {
      await finishWithoutProcess(stateDir, taskId, token, 'cancelled', { cancelledAt: new Date().toISOString() });
      return false;
    }
    if (decision.rejected) {
      const message = `heavy-build capacity rejected: maximum ${config.maxConcurrentHeavyBuilds} concurrent build(s)`;
      await finishWithoutProcess(stateDir, taskId, token, 'failed', { error: message, errors: [message] });
      return false;
    }
    if (decision.timedOut) {
      const message = `timed out waiting ${config.buildWaitTimeoutMs}ms for heavy-build capacity`;
      await finishWithoutProcess(stateDir, taskId, token, 'failed', { error: message, errors: [message] });
      return false;
    }
    await delay(config.pollMs);
  }
}

async function monitorRecoveredProcess(stateDir, taskId, config, token) {
  let stoppingFor = null;
  while (true) {
    const decision = await heartbeat(stateDir, taskId, config, token);
    if (!decision.owned) {
      return;
    }

    stoppingFor ??= decision.cancelRequested ? 'cancelled' : decision.timedOut ? 'timed_out' : null;
    if (!stoppingFor && config.adapter === 'projfs'
      && (await inspectProjfsSafety(stateDir, config)).quarantined) {
      stoppingFor = 'quarantined';
    }
    if (!stoppingFor && config.adapter === 'projfs' && !await verifyProviderAlive(stateDir, config, decision)) {
      stoppingFor = 'provider_died';
    }
    if (stoppingFor) {
      const confirmed = await terminateTask(stateDir, taskId, config, token);
      if (confirmed) {
        await finishRecoveredStopped(stateDir, taskId, config, token, stoppingFor);
      } else {
        await finishTerminationFailure(stateDir, taskId, token, stoppingFor);
      }
      return;
    }
    const identity = await getProcessIdentity(decision.pid);
    const launcherState = classifyLauncherIdentity(identity, decision.launcherIdentity, isProcessAlive(decision.pid));
    if (launcherState !== 'matching') {
      if (launcherState === 'unknown-live') {
        await delay(config.pollMs);
        continue;
      }
      if (decision.launcherIdentity) {
        await finishInterrupted(stateDir, taskId, config, token);
      } else {
        await finishUnverifiableRecovery(stateDir, taskId, token);
      }
      return;
    }

    await delay(config.pollMs);
  }
}

export async function waitForOwnedExit(config, descriptor, expectedIdentity, pollMs) {
  let publicationDeadline = null;
  while (true) {
    const manifest = await readOwnedProcess(descriptor);
    if (manifest?.state === 'exited') {
      return { exitCode: Number.isInteger(manifest.exitCode) ? manifest.exitCode : null, exitCodeUnknown: !Number.isInteger(manifest.exitCode), signal: null };
    }
    const identity = manifest ? await getProcessIdentity(manifest.pid) : null;
    if (manifest && identity !== expectedIdentity) {
      let jobIsEmpty = false;
      try {
        jobIsEmpty = await queryOwnedJobEmpty(config, descriptor, Math.max(1000, pollMs * 10));
      } catch {
        publicationDeadline = null;
        await delay(pollMs);
        continue;
      }
      if (jobIsEmpty) {
        publicationDeadline ??= Date.now() + Math.max(2000, pollMs * 20);
        if (Date.now() >= publicationDeadline) {
          return { exitCode: null, exitCodeUnknown: true, signal: null };
        }
      } else {
        publicationDeadline = null;
      }
    } else {
      publicationDeadline = null;
    }
    await delay(pollMs);
  }
}

export function buildLaunch(config, task) {
  const auth = task.auth ?? (config.auth?.enabled && task.authEnabled !== false ? config.auth : null);
  const configuredMinimum = auth?.minValidMs ?? defaultAuthMinValidMs;
  const requiredLifetime = Math.max(configuredMinimum, (task.timeoutMs ?? 0) + authLifetimeMarginMs);
  const authArgs = auth
    ? [
        '--horde-token-file', auth.tokenFile,
        '--horde-url', auth.hordeUrl,
        '--horde-min-valid-ms', String(requiredLifetime),
      ]
    : [];
  const runnerArgs = [runnerEntry, ...authArgs, '--', task.virtualLogPath, ...task.command];
  return { executable: process.execPath, args: runnerArgs };
}

async function heartbeat(stateDir, taskId, config, token) {
  let result = { owned: false };
  await mutateOwnedTask(stateDir, taskId, token, async (task) => {
    const now = Date.now();
    const timedOut = task.timeoutMs !== null
      && task.startedAt !== null
      && now - Date.parse(task.startedAt) >= task.timeoutMs;
    task.heartbeatAt = new Date(now).toISOString();
    if (timedOut) {
      task.timedOut = true;
    }
    await updateLogStats(task);
    result = {
      owned: true,
      cancelRequested: task.cancelRequestedAt !== null,
      timedOut,
      pid: task.pid,
      slot: task.slot,
      launcherIdentity: task.launcherIdentity,
    };
  });
  return result;
}

async function mutateOwnedTask(stateDir, taskId, token, mutate) {
  return withLock(stateDir, `task-${taskId}`, async () => {
    const task = await readTask(stateDir, taskId);
    if (task.monitorToken !== token) {
      return false;
    }
    await mutate(task);
    await writeTask(stateDir, task);
    return true;
  });
}

async function automaticCheckpointError(stateDir, taskId, config) {
  const revisionBackend = revisionControlBackend(config);
  if (!revisionBackend.isEnabled(config)) return null;
  try {
    await revisionBackend.checkpointTask(stateDir, config, taskId);
    return null;
  } catch (error) {
    return `required automatic Perforce checkpoint failed: ${error.message}`;
  }
}

function appendArtifactFailure(task, artifactError) {
  if (!artifactError) return;
  task.errors.push(artifactError);
  task.error = artifactError;
  if (task.state === 'completed') task.state = 'artifact_failed';
}

async function finishProcess(stateDir, taskId, config, token, result, stoppingFor) {
  const artifactError = await automaticCheckpointError(stateDir, taskId, config);
  await mutateOwnedTask(stateDir, taskId, token, async (task) => {
    const now = new Date().toISOString();
    const finalReason = stoppingFor ?? (task.cancelRequestedAt ? 'cancelled' : task.timedOut ? 'timed_out' : null);
    task.state = finalReason === 'provider_died' ? 'failed'
      : finalReason === 'quarantined' ? 'cancelled'
        : finalReason ?? (result.exitCode === 0 ? 'completed' : 'failed');
    task.finishedAt = now;
    task.heartbeatAt = now;
    if (task.buildCapacityAcquiredAt) {
      task.buildCapacityReleasedAt = now;
      task.permitState = 'released';
    }
    task.exitCode = result.exitCode;
    task.exitCodeUnknown = result.exitCodeUnknown === true;
    task.signal = result.signal;
    if (task.state === 'cancelled') {
      task.cancelledAt = now;
      if (finalReason === 'quarantined') {
        task.error = 'task cancelled because the ProjFS pool entered quarantine';
        task.errors.push(task.error);
      }
    }
    if (task.state === 'timed_out') {
      task.timedOut = true;
    }
    if (finalReason === 'provider_died') {
      task.error = 'retained ProjFS provider died while the task process was running; task terminated fail-closed';
      task.errors.push(task.error);
    } else if (task.state === 'failed' && !task.error) {
      task.error = result.exitCodeUnknown
        ? 'command exited before its native supervisor published a final exit code'
        : `command exited with code ${result.exitCode}${result.signal ? ` (${result.signal})` : ''}`;
      task.errors.push(task.error);
    }
    appendArtifactFailure(task, artifactError);
    await updateLogStats(task);
  });
}

async function finishWithoutProcess(stateDir, taskId, token, state, details) {
  await mutateOwnedTask(stateDir, taskId, token, async (task) => {
    const now = new Date().toISOString();
    task.state = state;
    task.finishedAt = now;
    task.heartbeatAt = now;
    if (task.buildCapacityAcquiredAt && !task.pid) {
      task.buildCapacityReleasedAt = now;
      task.permitState = 'released';
    }
    Object.assign(task, details);
    await updateLogStats(task);
  });
}

async function finishInterrupted(stateDir, taskId, config, token) {
  const artifactError = await automaticCheckpointError(stateDir, taskId, config);
  await mutateOwnedTask(stateDir, taskId, token, async (task) => {
    const now = new Date().toISOString();
    task.state = 'failed';
    task.finishedAt = now;
    task.heartbeatAt = now;
    if (task.buildCapacityAcquiredAt) {
      task.buildCapacityReleasedAt = now;
      task.permitState = 'released';
    }
    task.exitCode = null;
    task.exitCodeUnknown = true;
    task.error = 'monitor was interrupted; verified launcher exit but its exit code is unknown';
    task.errors.push(task.error);
    appendArtifactFailure(task, artifactError);
    await updateLogStats(task);
  });
}

export async function handleUnverifiableRecovery(stateDir, taskId, config, token) {
  const pending = await readTask(stateDir, taskId);
  if (pending.processOwnership) {
    const manifest = await readOwnedProcess(pending.processOwnership);
    if (manifest?.state === 'prepared') {
      const terminated = await terminatePreparedOwned(config, pending.processOwnership, config.terminationWaitMs).catch(() => false);
      const message = terminated
        ? 'monitor recovery found a prepared but uncommitted suspended launch; its owned job was terminated without resuming the child'
        : 'monitor recovery found a prepared but uncommitted suspended launch and could not confirm owned-job termination';
      await finishWithoutProcess(stateDir, taskId, token, terminated ? 'failed' : 'termination_failed', {
        error: message,
        errors: [message],
        exitCodeUnknown: true,
        ...(terminated ? {} : {
          permitState: pending.buildCapacityAcquiredAt ? 'quarantined' : pending.permitState,
          buildCapacityReleasedAt: null,
        }),
      });
      return;
    }
    if (manifest?.state === 'aborted') {
      const message = 'native launch supervisor aborted the prepared launch before commit; the suspended child was never resumed';
      await finishWithoutProcess(stateDir, taskId, token, 'failed', {
        error: message,
        errors: [message],
        exitCode: Number.isInteger(manifest.exitCode) ? manifest.exitCode : null,
      });
      return;
    }
    if (manifest?.creationIdentity && ['running', 'exited'].includes(manifest.state)) {
      await mutateOwnedTask(stateDir, taskId, token, async (task) => {
        task.pid = manifest.pid;
        task.launcherIdentity = manifest.creationIdentity;
        task.startedAt ??= task.launchAttemptedAt;
        task.state = task.cancelRequestedAt ? 'cancel_requested' : manifest.state === 'running' ? 'running' : 'starting';
        task.pids = [...new Set([...(task.pids ?? []), manifest.pid])];
      });
      if (manifest.state === 'exited') {
        const reason = pending.cancelRequestedAt ? 'cancelled' : pending.timedOut ? 'timed_out' : null;
        await finishProcess(stateDir, taskId, config, token, {
          exitCode: Number.isInteger(manifest.exitCode) ? manifest.exitCode : null,
          signal: null,
        }, reason);
        return;
      }
      if (await isOwnedProcessAlive(pending.processOwnership)) {
        await monitorRecoveredProcess(stateDir, taskId, config, token);
      } else {
        await finishInterrupted(stateDir, taskId, config, token);
      }
      return;
    }
  }
  await finishUnverifiableRecovery(stateDir, taskId, token);
}

async function finishUnverifiableRecovery(stateDir, taskId, token) {
  await mutateOwnedTask(stateDir, taskId, token, async (task) => {
    const now = new Date().toISOString();
    task.state = 'termination_failed';
    task.finishedAt = now;
    task.heartbeatAt = now;
    task.exitCodeUnknown = true;
    task.error = 'monitor recovery could not verify the original launcher identity; no PID was killed';
    task.errors.push(task.error);
    if (task.buildCapacityAcquiredAt) {
      task.permitState = 'quarantined';
      task.buildCapacityReleasedAt = null;
    }
    await updateLogStats(task);
  });
}

async function finishRecoveredStopped(stateDir, taskId, config, token, reason) {
  const artifactError = await automaticCheckpointError(stateDir, taskId, config);
  await mutateOwnedTask(stateDir, taskId, token, async (task) => {
    const now = new Date().toISOString();
    task.state = reason === 'provider_died' ? 'failed' : reason === 'quarantined' ? 'cancelled' : reason;
    task.finishedAt = now;
    task.heartbeatAt = now;
    if (task.buildCapacityAcquiredAt) {
      task.buildCapacityReleasedAt = now;
      task.permitState = 'released';
    }
    task.exitCode = null;
    task.exitCodeUnknown = true;
    if (reason === 'cancelled' || reason === 'quarantined') {
      task.cancelledAt = now;
      if (reason === 'quarantined') {
        task.error = 'task cancelled because the ProjFS pool entered quarantine';
        task.errors.push(task.error);
      }
    } else if (reason === 'timed_out') {
      task.timedOut = true;
    } else {
      task.error = 'retained ProjFS provider died while the recovered task process was running; task terminated fail-closed';
      task.errors.push(task.error);
    }
    appendArtifactFailure(task, artifactError);
    await updateLogStats(task);
  });
}

async function finishTerminationFailure(stateDir, taskId, token, reason) {
  await mutateOwnedTask(stateDir, taskId, token, async (task) => {
    const now = new Date().toISOString();
    task.state = 'termination_failed';
    task.finishedAt = now;
    task.heartbeatAt = now;
    const operation = reason === 'cancelled' ? 'cancellation'
      : reason === 'provider_died' ? 'provider-death'
        : reason === 'quarantined' ? 'quarantine cancellation' : 'timeout';
    task.error = `unable to confirm ${operation} termination after bounded retries`;
    task.errors.push(task.error);
    if (task.buildCapacityAcquiredAt) {
      task.permitState = 'quarantined';
      task.buildCapacityReleasedAt = null;
    }
    await updateLogStats(task);
  });
}

async function terminateTask(stateDir, taskId, config, token) {
  const task = await readTask(stateDir, taskId);
  if (config.adapter === 'projfs'
    && (!task.processOwnership || !await readOwnedProcess(task.processOwnership))) return false;
  for (let attempt = 1; attempt <= config.terminationAttempts; attempt += 1) {
    let errorMessage = null;
    try {
      if (config.adapter === 'projfs') {
        await terminateOwned(config, task.processOwnership, config.terminationWaitMs);
      } else if (task.launcherIdentity) {
        const identity = await getProcessIdentity(task.pid);
        if (identity === task.launcherIdentity) await terminateTree(task.pid);
      }
    } catch (error) {
      errorMessage = error.message;
    }

    await mutateOwnedTask(stateDir, taskId, token, async (current) => {
      current.terminationAttempts = (current.terminationAttempts ?? 0) + 1;
      if (errorMessage) {
        current.errors.push(`termination attempt ${attempt} failed: ${errorMessage}`);
      }
    });

    const deadline = Date.now() + config.terminationWaitMs;
    while (Date.now() < deadline) {
      if (config.adapter === 'projfs') {
        if (await queryOwnedJobEmpty(config, task.processOwnership, config.terminationWaitMs)) return true;
      } else {
        const identity = await getProcessIdentity(task.pid);
        if (task.launcherIdentity && identity !== task.launcherIdentity) return true;
      }
      await delay(50);
    }
  }
  return false;
}

export function classifyLauncherIdentity(identity, expectedIdentity, pidAlive) {
  if (identity !== null && identity === expectedIdentity) {
    return 'matching';
  }
  if (identity === null && pidAlive) {
    return 'unknown-live';
  }
  return 'exited-or-reused';
}

async function terminateTree(pid) {
  if (process.platform === 'win32') {
    await execFileAsync('taskkill.exe', ['/pid', String(pid), '/t', '/f'], { windowsHide: true });
    return;
  }

  try {
    process.kill(-pid, 'SIGTERM');
  } catch (error) {
    if (error.code === 'ESRCH') {
      return;
    }
    throw error;
  }
  await delay(300);
  try {
    process.kill(-pid, 'SIGKILL');
  } catch (error) {
    if (error.code !== 'ESRCH') {
      throw error;
    }
  }
}
