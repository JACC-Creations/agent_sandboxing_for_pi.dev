import fs from 'node:fs/promises';
import path from 'node:path';
import { classifyProcessIdentity } from './process-identity.mjs';
import { queryOwnedJobEmpty, readOwnedProcess, terminateOwned } from './process-owner.mjs';
import { stopOwnedGenerationSupervisor, stopOwnedLowerGuard, stopOwnedProvider } from './projfs.mjs';
import { atomicWriteJson, delay, isProcessAlive, listTasks, readJson, readJsonIfPresent, statePaths, withLifecycleLock, writeTask } from './state.mjs';
import { revisionControlBackend } from './revision-control.mjs';
import { canonicalizeForSafety, externalCleanupPaths, pathsOverlap, verifyOwnedDirectory } from './ownership.mjs';

export async function cleanupBroker(stateDir, options = {}) {
  return withLifecycleLock(stateDir, () => cleanupBrokerExclusive(stateDir, options), { timeoutMs: 120000 });
}

async function cleanupBrokerExclusive(stateDir, options) {
  const expectedBrokerUuid = options.expectedBrokerUuid;
  if (expectedBrokerUuid !== undefined && (typeof expectedBrokerUuid !== 'string' || expectedBrokerUuid.length === 0)) {
    throw new Error('expectedBrokerUuid must be non-empty text');
  }
  const external = externalCleanupPaths(stateDir);
  const [receipt, currentConfig, persistedJournal] = await Promise.all([
    readJsonIfPresent(external.receipt),
    readJsonIfPresent(statePaths(stateDir).config),
    readJsonIfPresent(external.journal),
  ]);
  const actualBrokerUuid = currentConfig?.brokerUuid ?? persistedJournal?.brokerUuid ?? receipt?.brokerUuid;
  if (expectedBrokerUuid !== undefined && actualBrokerUuid !== expectedBrokerUuid) {
    throw new Error(`cleanup refused: broker generation changed for state '${stateDir}'`);
  }
  if (currentConfig) revisionControlBackend(currentConfig);
  if (persistedJournal?.config) revisionControlBackend(persistedJournal.config);
  if (receipt?.state === 'completed' && await validateCompletedReceipt(stateDir, receipt, currentConfig)) {
    return { ...receipt, idempotent: true };
  }

  let journal = persistedJournal;
  if (journal?.state === 'completed' && currentConfig?.brokerUuid !== journal.brokerUuid) journal = null;
  if (!journal) {
    const config = currentConfig ?? await readJson(statePaths(stateDir).config);
    journal = {
      version: 2,
      state: 'in_progress',
      brokerUuid: config.brokerUuid,
      stateDir: path.resolve(stateDir),
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      phases: { generation_established: { completedAt: new Date().toISOString() } },
      errors: [],
      removed: [],
      ownedJobs: [],
      rootDeletionIntents: [],
    };
    await atomicWriteJson(external.journal, journal);
    if (process.env.AGENT_WORKSPACE_TEST_CLEANUP_AFTER_GENERATION_DELAY_MS) {
      await new Promise((resolve) => setTimeout(resolve, Number(process.env.AGENT_WORKSPACE_TEST_CLEANUP_AFTER_GENERATION_DELAY_MS)));
    }
  }
  if (!journal.config) {
    const config = currentConfig ?? await readJson(statePaths(stateDir).config);
    if (config.brokerUuid !== journal.brokerUuid) throw new Error('cleanup generation changed before ownership snapshot');
    revisionControlBackend(config);
    if (config.adapter !== 'projfs') throw new Error('aggressive cleanup currently requires an owned ProjFS broker');
    const [ownership, slots, lowerGuard, generationSupervisor] = await Promise.all([
      readJson(path.join(stateDir, 'ownership.json')),
      readJson(statePaths(stateDir).slots),
      readJsonIfPresent(path.join(stateDir, 'lower-guard-owner.json')),
      readJsonIfPresent(path.join(stateDir, 'generation-supervisor-owner.json')),
    ]);
    if (!config.brokerUuid || ownership.type !== 'broker'
      || ownership.brokerUuid !== config.brokerUuid || slots.brokerUuid !== config.brokerUuid
      || path.resolve(config.stateDir) !== path.resolve(stateDir)
      || path.resolve(ownership.stateDir) !== path.resolve(stateDir)) {
      throw new Error('cleanup refused: broker ownership UUID/path is missing or inconsistent');
    }
    for (const slot of slots.slots) {
      const resource = ownership.resources?.find((candidate) => candidate.type === 'projfs-root'
        && path.resolve(candidate.path) === path.resolve(slot.root)
        && candidate.nonce === slot.rootNonce
        && candidate.ownership === 'package'
        && candidate.handedOff === false);
      if (!resource) throw new Error(`cleanup refused: slot ${slot.index} has no package-owned root manifest`);
    }
    Object.assign(journal, {
      config,
      ownership,
      slots,
      lowerGuard,
      generationSupervisor,
      handoffExclusions: ownership.resources.filter((resource) => resource.handedOff === true),
      ownedJobs: [
        ...(lowerGuard ? [providerJobDescriptor(lowerGuard)] : []),
        ...(generationSupervisor ? [providerJobDescriptor(generationSupervisor)] : []),
        ...slots.slots.flatMap((slot) => slot.provider ? [providerJobDescriptor(slot.provider)] : []),
      ],
    });
    await atomicWriteJson(external.journal, journal);
  }
  if (journal.state === 'completed') return journal;
  if (journal.state === 'failed') {
    journal.state = 'in_progress';
    journal.errors = [];
    for (const phase of ['cancel_tasks', 'workers_stopped', 'recover_p4_handoffs', 'remove_queue_and_permits', 'cleanup_owned_integrations', 'stop_generation_supervisor', 'stop_lower_guard', 'stop_providers', 'owned_jobs_stopped', 'delete_owned_roots', 'delete_private_state']) {
      delete journal.phases[phase];
    }
  }
  if (journal.brokerUuid !== journal.config?.brokerUuid || path.resolve(stateDir) !== path.resolve(journal.stateDir)) {
    throw new Error('cleanup refused: external journal ownership does not match this broker');
  }

  const errors = [];
  await runPhase(journal, external.journal, 'block_new_work', async () => {
    await fs.writeFile(path.join(stateDir, 'CLEANUP_IN_PROGRESS'), `${journal.brokerUuid}\n`).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  });

  await runPhase(journal, external.journal, 'cancel_tasks', async () => {
    const tasks = await listTasks(stateDir).catch((error) => error.code === 'ENOENT' ? [] : Promise.reject(error));
    for (const task of tasks) {
      if (!['completed', 'artifact_failed', 'failed', 'timed_out', 'cancelled', 'termination_failed', 'handed_off'].includes(task.state)) {
        const now = new Date().toISOString();
        task.cancelRequestedAt ??= now;
        task.state = 'cancel_requested';
        await writeTask(stateDir, task);
      }
      const ownedManifest = task.processOwnership ? await readOwnedProcess(task.processOwnership) : null;
      if (task.processOwnership) {
        journal.ownedJobs.push(task.processOwnership);
        if (!ownedManifest) {
          if (!isProcessAlive(task.monitorPid)
            && !await queryOwnedJobEmpty(journal.config, task.processOwnership, 1000)) {
            errors.push(`task ${task.id} has no positive owned-job manifest and its exact Job is not empty; termination refused`);
          }
          continue;
        }
        if (!await queryOwnedJobEmpty(journal.config, task.processOwnership, 1000)) {
          const stopped = await terminateOwned(journal.config, task.processOwnership, journal.config.terminationWaitMs).catch(() => false);
          if (!stopped) errors.push(`owned task job survived cleanup: ${task.id}`);
        }
        continue;
      }
      const pid = task.pid ?? null;
      const expectedIdentity = task.launcherIdentity ?? null;
      if (!pid) continue;
      if (!expectedIdentity) {
        const identity = await classifyProcessIdentity(pid, '__missing_expected_identity__');
        if (identity.state === 'dead') continue;
        errors.push(`task ${task.id} has live PID ${pid} but no expected process identity; termination refused`);
        continue;
      }
      const identity = await classifyProcessIdentity(pid, expectedIdentity);
      if (identity.state === 'unknown-live') {
        errors.push(`task ${task.id} has live PID ${pid} whose identity remained unqueryable after bounded retries`);
        continue;
      }
      if (identity.state === 'matching') {
        errors.push(`task ${task.id} has a live identity-matched PID but no owned Job; numeric PID termination refused`);
      }
    }
  });

  await runPhase(journal, external.journal, 'workers_stopped', async () => {
    const deadline = Date.now() + Math.max(30000, journal.config.terminationWaitMs ?? 0);
    let tasks = [];
    while (Date.now() < deadline) {
      tasks = await listTasks(stateDir).catch((error) => error.code === 'ENOENT' ? [] : Promise.reject(error));
      const jobsEmpty = await Promise.all(tasks.map((task) => task.processOwnership
        ? queryOwnedJobEmpty(journal.config, task.processOwnership, 1000)
        : true));
      if (tasks.every((task) => !isProcessAlive(task.monitorPid) && !isProcessAlive(task.pid)) && jobsEmpty.every(Boolean)) break;
      await delay(50);
    }
    for (const task of tasks) {
      if (isProcessAlive(task.monitorPid)) errors.push(`task ${task.id} monitor PID ${task.monitorPid} survived the workersStopped fence`);
      if (isProcessAlive(task.pid)) errors.push(`task ${task.id} owned job PID ${task.pid} survived the workersStopped fence`);
      if (task.processOwnership) {
        const ownedManifest = await readOwnedProcess(task.processOwnership);
        const jobEmpty = await queryOwnedJobEmpty(journal.config, task.processOwnership, 1000);
        if (!ownedManifest && !jobEmpty) {
          errors.push(`task ${task.id} has no positive owned-job manifest and its exact Job is not empty at the workersStopped fence`);
        } else if (!jobEmpty) {
          errors.push(`task ${task.id} owned Job is not empty at the workersStopped fence`);
        }
      }
    }
    if (process.env.AGENT_WORKSPACE_TEST_CLEANUP_WORKERS_STOPPED_DELAY_MS) {
      await delay(Number(process.env.AGENT_WORKSPACE_TEST_CLEANUP_WORKERS_STOPPED_DELAY_MS));
    }
  });

  if (errors.length === 0) {
    await runPhase(journal, external.journal, 'recover_p4_handoffs', async () => {
      const revisionBackend = revisionControlBackend(journal.config);
      if (revisionBackend.isEnabled(journal.config)) {
        await revisionBackend.recoverForCleanup(stateDir, journal.config);
        journal.ownership = await readJson(path.join(stateDir, 'ownership.json'));
        journal.handoffExclusions = journal.ownership.resources.filter((resource) => resource.handedOff === true);
        return;
      }
      if (journal.ownership.resources.some((resource) => resource.handedOff === true)) {
        throw new Error('cleanup refused: handoff exclusions exist without enabled revision control');
      }
    });
  }

  await runPhase(journal, external.journal, 'remove_queue_and_permits', async () => {
    const slotsPath = statePaths(stateDir).slots;
    const slots = await readJson(slotsPath).catch(() => null);
    if (!slots) return;
    slots.buildQueue = [];
    for (const slot of slots.slots) slot.cleanupState = 'releasing';
    slots.updatedAt = new Date().toISOString();
    await atomicWriteJson(slotsPath, slots);
  });

  await runPhase(journal, external.journal, 'cleanup_owned_integrations', async () => {
    if (errors.length > 0) return;
    const resources = journal.ownership.resources.filter((resource) => resource.handedOff !== true
      && ['p4-client', 'p4-change', 'p4-shelf'].includes(resource.type));
    if (resources.length === 0) return;
    try {
      await revisionControlBackend(journal.config).cleanupResources(journal.config, resources);
      journal.removed.push(...resources.map((resource) => ({
        type: resource.type, client: resource.client, change: resource.change ?? null,
        brokerUuid: resource.brokerUuid, nonce: resource.nonce,
      })));
    } catch (error) {
      errors.push(`Perforce cleanup failed closed: ${error.message}`);
    }
  });

  await runPhase(journal, external.journal, 'stop_providers', async () => {
    if (errors.length > 0) return;
    const slots = await readJson(statePaths(stateDir).slots).catch(() => journal.slots);
    for (const slot of slots.slots) {
      if (!slot.provider) continue;
      const result = await stopOwnedProvider(stateDir, journal.config, slot).catch((error) => ({ stopped: false, error: error.message }));
      if (!result.stopped) errors.push(`provider for slot ${slot.index} survived cleanup: ${result.error}`);
    }
  });

  await runPhase(journal, external.journal, 'stop_generation_supervisor', async () => {
    if (errors.length > 0) return;
    const result = await stopOwnedGenerationSupervisor(stateDir, journal.config).catch((error) => ({ stopped: false, error: error.message }));
    if (!result.stopped) errors.push(`generation supervisor survived cleanup: ${result.error}`);
  });

  await runPhase(journal, external.journal, 'stop_lower_guard', async () => {
    if (errors.length > 0) return;
    const result = await stopOwnedLowerGuard(stateDir, journal.config).catch((error) => ({ stopped: false, error: error.message }));
    if (!result.stopped) errors.push(`lower-freeze guard survived cleanup: ${result.error}`);
  });

  if (errors.length === 0) {
    await runPhase(journal, external.journal, 'owned_jobs_stopped', async () => {
      for (const descriptor of uniqueJobDescriptors(journal.ownedJobs)) {
        if (await queryOwnedJobEmpty(journal.config, descriptor, 2000)) continue;
        const stopped = await terminateOwned(journal.config, descriptor, journal.config.providerStopTimeoutMs).catch(() => false);
        if (!stopped || !await queryOwnedJobEmpty(journal.config, descriptor, 2000)) {
          errors.push(`owned Job survived final cleanup fence: ${descriptor.jobName}`);
        }
      }
    });
  }

  if (errors.length === 0) {
    await runPhase(journal, external.journal, 'delete_owned_roots', async () => {
      const lowerCanonical = await canonicalizeForSafety(journal.config.lower);
      journal.rootDeletionIntents ??= [];
      for (const slot of journal.slots.slots) {
        if (!await fs.access(slot.root).then(() => true, () => false)) {
          journal.removed.push({ type: 'projfs-root', path: slot.root });
          continue;
        }
        const rootCanonical = await canonicalizeForSafety(slot.root);
        if (pathsOverlap(lowerCanonical, rootCanonical)) {
          errors.push(`root overlaps protected lower and was not deleted: ${slot.root}`);
          continue;
        }
        const intent = journal.rootDeletionIntents.find((candidate) => path.resolve(candidate.path) === path.resolve(slot.root));
        if (intent) {
          if (intent.brokerUuid !== journal.brokerUuid || intent.rootNonce !== slot.rootNonce) {
            errors.push(`root deletion intent is inconsistent; deletion refused: ${slot.root}`);
            continue;
          }
        } else {
          if (!await verifyOwnedDirectory(slot.root, journal.brokerUuid, slot.rootNonce)) {
            errors.push(`root ownership marker is missing or tampered; deletion refused: ${slot.root}`);
            continue;
          }
          journal.rootDeletionIntents.push({
            type: 'projfs-root-deletion',
            path: slot.root,
            brokerUuid: journal.brokerUuid,
            rootNonce: slot.rootNonce,
            recordedAt: new Date().toISOString(),
          });
          journal.updatedAt = new Date().toISOString();
          await atomicWriteJson(external.journal, journal);
        }
        if (process.env.AGENT_WORKSPACE_TEST_INTERRUPT_ROOT_DELETION === '1') {
          await fs.unlink(path.join(slot.root, '.agent-workspace-owner.json'));
          throw new Error('simulated interruption after root deletion intent');
        }
        await fs.rm(slot.root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
        if (await fs.access(slot.root).then(() => true, () => false)) {
          errors.push(`owned root survived deletion: ${slot.root}`);
        } else {
          journal.removed.push({ type: 'projfs-root', path: slot.root });
        }
      }
    });
  }

  if (errors.length === 0) {
    await runPhase(journal, external.journal, 'delete_private_state', async () => {
      await fs.rm(stateDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
      if (await fs.access(stateDir).then(() => true, () => false)) throw new Error(`owned broker state survived deletion: ${stateDir}`);
      journal.removed.push({ type: 'broker-private-state', path: stateDir });
    });
  }

  journal.errors = [...new Set([...journal.errors, ...errors])];
  journal.updatedAt = new Date().toISOString();
  if (journal.errors.length > 0) {
    journal.state = 'failed';
    await atomicWriteJson(external.journal, journal);
    throw new Error(`cleanup incomplete: ${journal.errors.join('; ')}`);
  }

  journal.state = 'completed';
  journal.completedAt = new Date().toISOString();
  journal.phases.reset_pool_state = { completedAt: journal.completedAt };
  const completed = {
    version: 2,
    state: 'completed',
    brokerUuid: journal.brokerUuid,
    stateDir: journal.stateDir,
    completedAt: journal.completedAt,
    removed: journal.removed,
    handoffExclusions: journal.handoffExclusions,
    launchSupervisorExe: journal.config.launchSupervisorExe,
    nativeSupervisor: process.platform === 'win32' && path.extname(journal.config.providerExe).toLowerCase() !== '.mjs',
    ownedJobs: uniqueJobDescriptors(journal.ownedJobs),
    ...(journal.config.p4?.enabled ? { p4Reconnect: journal.config.p4.reconnect } : {}),
  };
  await atomicWriteJson(external.receipt, completed);
  await atomicWriteJson(external.journal, { ...completed, phases: journal.phases });
  return completed;
}

async function validateCompletedReceipt(stateDir, receipt, currentConfig) {
  if (![1, 2].includes(receipt.version)) return false;
  if (receipt.version === 2 && receipt.handoffExclusions?.length > 0 && !receipt.p4Reconnect) return false;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(receipt.brokerUuid ?? '')) return false;
  if (path.resolve(receipt.stateDir ?? '') !== path.resolve(stateDir)) return false;
  if (currentConfig) return false;
  for (const resource of receipt.removed ?? []) {
    if (['p4-client', 'p4-change', 'p4-shelf'].includes(resource.type)) {
      if (typeof resource.client !== 'string' || typeof resource.brokerUuid !== 'string' || typeof resource.nonce !== 'string') return false;
      continue;
    }
    if (!['projfs-root', 'broker-private-state'].includes(resource.type) || !path.isAbsolute(resource.path)) return false;
    if (await fs.access(resource.path).then(() => true, () => false)) return false;
  }
  const exclusions = receipt.handoffExclusions ?? [];
  if (exclusions.some((resource) => !['p4-client', 'p4-change', 'p4-shelf'].includes(resource.type)
    || resource.handedOff !== true || resource.handoffTransaction !== resource.nonce)) return false;
  for (const transaction of new Set(exclusions.map((resource) => resource.handoffTransaction))) {
    const group = exclusions.filter((resource) => resource.handoffTransaction === transaction);
    if (group.length !== 3 || new Set(group.map((resource) => resource.type)).size !== 3) return false;
  }
  if (!receipt.nativeSupervisor) return true;
  for (const descriptor of receipt.ownedJobs ?? []) {
    const config = { adapter: 'projfs', providerExe: 'native.exe', launchSupervisorExe: receipt.launchSupervisorExe };
    if (!config.launchSupervisorExe) return false;
    if (!await queryOwnedJobEmpty(config, { ...descriptor, verificationPath: `${stateDir}.cleanup-receipt.json` }, 2000)) return false;
  }
  return true;
}

function providerJobDescriptor(provider) {
  return {
    ownerUuid: provider.ownerUuid,
    nonce: provider.nonce,
    kind: provider.kind ?? path.basename(provider.launchManifestPath).replace(/-[0-9a-f]{32}\.json$/i, ''),
    launchManifestPath: provider.launchManifestPath,
    jobName: provider.jobName,
  };
}

function uniqueJobDescriptors(descriptors = []) {
  return [...new Map(descriptors.filter(Boolean).map((descriptor) => [descriptor.jobName, descriptor])).values()];
}

async function runPhase(journal, journalPath, name, callback) {
  if (journal.phases[name]?.completedAt) return;
  await callback();
  journal.phases[name] = { completedAt: new Date().toISOString() };
  journal.updatedAt = new Date().toISOString();
  await atomicWriteJson(journalPath, journal);
}
