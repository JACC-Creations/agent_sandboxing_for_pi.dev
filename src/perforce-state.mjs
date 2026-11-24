import fs from 'node:fs/promises';
import path from 'node:path';
import {
  buildSanitizedWorkerEnv,
  canonicalShelf,
  checkpoint,
  cleanupResources,
  createP4,
  ensureReviewChange,
  ensureReviewClient,
  ensureStableTaskChange,
  importShelf,
  openPaths,
  planP4ChangeResource,
  planP4ClientResource,
  planP4HandoffResources,
  provisionSlotClient,
  reshelveHandoff,
  readP4ServerBinding,
  validateDiscoverBase,
  verifyHandoffShelf,
  verifySlotClient,
} from './perforce.mjs';
import {
  appendOwnershipResource,
  appendOwnershipResources,
  newNonce,
  replaceOwnershipResource,
  replaceOwnershipResources,
} from './ownership.mjs';
import { atomicWriteJson, listTasks, readJson, readTask, statePaths, withLock, writeTask } from './state.mjs';

const terminalTaskStates = new Set(['completed', 'artifact_failed', 'failed', 'timed_out', 'cancelled', 'termination_failed', 'handed_off']);

export function makeConfiguredP4(config) {
  if (!config.p4?.enabled) return null;
  return createP4({
    executable: config.p4.executable,
    testMode: config.testMode,
    fakeScript: config.testMode ? config.p4.executable : undefined,
    env: config.testMode && config.p4.fakeRegistry ? { FAKE_P4_REGISTRY: config.p4.fakeRegistry } : undefined,
    P4PORT: config.p4.port,
    P4USER: config.p4.user,
    P4CHARSET: config.p4.charset,
    ticketFile: config.p4.ticketFile,
    trustFile: config.p4.trustFile,
  });
}

export async function resolveP4Executable(executable, environment = process.env) {
  const candidate = String(executable ?? '');
  if (!candidate) throw new Error('Perforce executable is required');
  if (path.isAbsolute(candidate) || /[\\/]/.test(candidate)) {
    const resolved = path.resolve(candidate);
    if (!await fs.stat(resolved).then((stats) => stats.isFile(), () => false)) throw new Error(`Perforce executable is not a file: ${resolved}`);
    return resolved;
  }
  const extensions = process.platform === 'win32'
    ? (environment.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : [''];
  for (const directory of String(environment.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const resolved = path.resolve(directory, process.platform === 'win32' && path.extname(candidate) ? candidate : `${candidate}${extension}`);
      if (await fs.stat(resolved).then((stats) => stats.isFile(), () => false)) return resolved;
    }
  }
  throw new Error(`Perforce executable could not be resolved: ${candidate}`);
}

export async function discoverP4Configuration(options, workspace) {
  if (!options.p4Exe && !options.p4BaseClient && !options.p4Port && !options.p4User && !options.p4Charset
    && !options.p4Tickets && !options.p4Trust && !options.p4FakeRegistry) return null;
  if (options.adapter !== 'projfs') throw new Error('Perforce can only be enabled for ProjFS');
  if (!options.p4Exe || !options.p4BaseClient) throw new Error('Perforce requires --p4-exe and --p4-base-client');
  if (!options.testMode && (options.p4FakeRegistry || /\.(?:mjs|cjs|js|cmd|bat|ps1)$/i.test(options.p4Exe))) {
    throw new Error('script Perforce executables and fake registries require --test-mode');
  }
  const value = {
    enabled: true,
    executable: await resolveP4Executable(options.p4Exe),
    baseClient: options.p4BaseClient,
    port: options.p4Port,
    user: options.p4User ?? process.env.P4USER,
    charset: options.p4Charset,
    ticketFile: options.p4Tickets ? path.resolve(options.p4Tickets) : undefined,
    trustFile: options.p4Trust ? path.resolve(options.p4Trust) : undefined,
    ...(options.testMode ? { fakeRegistry: options.p4FakeRegistry } : {}),
  };
  const config = { testMode: options.testMode === true, p4: value };
  const p4 = makeConfiguredP4(config);
  const binding = await readP4ServerBinding(p4);
  if (!value.user) value.user = binding.user;
  if (value.user !== binding.user) throw new Error('configured Perforce user does not match the live user');
  value.port ??= (await p4.run(['info'])).records.find((record) => record.userName === binding.user)?.serverAddress;
  if (!value.port) throw new Error('Perforce port could not be discovered; pass --p4-port');
  config.p4.user = value.user;
  config.p4.port = value.port;
  value.reconnect = {
    version: 1,
    executable: value.executable,
    port: value.port,
    user: value.user,
    ...(value.charset ? { charset: value.charset } : {}),
    ...(value.ticketFile ? { ticketFile: value.ticketFile } : {}),
    ...(value.trustFile ? { trustFile: value.trustFile } : {}),
    ...(options.testMode ? { testMode: true, fakeScript: value.executable, fakeRegistry: value.fakeRegistry } : {}),
    serverFingerprint: binding.fingerprint,
  };
  const baseline = await validateDiscoverBase(p4, { baseClient: value.baseClient, expectedLowerRoot: workspace });
  value.baseline = baselineSummary(baseline);
  return value;
}

export function baselineSummary(baseline) {
  return {
    baseClient: baseline.baseClient,
    root: baseline.root,
    fields: { ...baseline.fields },
    opened: baseline.opened.map(({ depotFile, haveRev, action, change, client, relativeLowerPath, sha256 }) => (
      { depotFile, haveRev, action, change, client, relativeLowerPath, sha256 }
    )).sort((left, right) => left.depotFile.localeCompare(right.depotFile)),
    protectedDepotPaths: [...baseline.protectedDepotPaths].sort(),
  };
}

export async function loadLiveBaseline(config) {
  const p4 = makeConfiguredP4(config);
  if (!p4) throw new Error('Perforce is not enabled');
  const baseline = await validateDiscoverBase(p4, { baseClient: config.p4.baseClient, expectedLowerRoot: config.lower });
  if (JSON.stringify(baselineSummary(baseline)) !== JSON.stringify(config.p4.baseline)) {
    throw new Error('Perforce protected baseline no longer exactly matches the validated persisted baseline');
  }
  return { p4, baseline };
}

export async function provisionP4Slots(stateDir, config) {
  if (!config.p4?.enabled) return;
  const { p4, baseline } = await loadLiveBaseline(config);
  for (const slot of (await readJson(statePaths(stateDir).slots)).slots) {
    if (slot.p4?.resource) continue;
    const client = deterministicClient(config.brokerUuid, slot.index);
    const resource = planP4ClientResource({
      client,
      projectedRoot: slot.root,
      slot: slot.index,
      ownership: { brokerUuid: config.brokerUuid, nonce: newNonce() },
    });
    await appendOwnershipResource(stateDir, resource);
    await withLock(stateDir, 'state', async () => {
      const slots = await readJson(statePaths(stateDir).slots);
      const current = slots.slots.find((candidate) => candidate.index === slot.index);
      current.p4 = { state: 'planned', client, nonce: resource.nonce, resource };
      slots.updatedAt = new Date().toISOString();
      await atomicWriteJson(statePaths(stateDir).slots, slots);
    });
    try {
      await provisionSlotClient(p4, { baseline, client, projectedRoot: slot.root, slot: slot.index, plannedResource: resource });
      await withLock(stateDir, 'state', async () => {
        const slots = await readJson(statePaths(stateDir).slots);
        slots.slots.find((candidate) => candidate.index === slot.index).p4.state = 'ready';
        slots.updatedAt = new Date().toISOString();
        await atomicWriteJson(statePaths(stateDir).slots, slots);
      });
    } catch (error) {
      await withLock(stateDir, 'state', async () => {
        const slots = await readJson(statePaths(stateDir).slots);
        const current = slots.slots.find((candidate) => candidate.index === slot.index);
        current.p4.state = 'quarantined';
        current.p4.error = error.message;
        await atomicWriteJson(statePaths(stateDir).slots, slots);
      });
      throw error;
    }
  }
  await loadLiveBaseline(config);
}

export async function planTaskP4(stateDir, config, task, slot) {
  if (!config.p4?.enabled) return task;
  if (task.p4?.plannedChangeResource && task.p4?.plannedShelfResource) return task;
  if (slot.p4?.state !== 'ready') throw new Error(`slot ${slot.index} Perforce client is not ready`);
  const nonce = newNonce();
  const ownership = { brokerUuid: config.brokerUuid, nonce };
  const change = planP4ChangeResource({ client: slot.p4.client, taskId: task.id, user: config.p4.user, ownership });
  const shelf = { type: 'p4-shelf', client: slot.p4.client, change: null, taskId: task.id, ...ownership, handedOff: false };
  await appendOwnershipResource(stateDir, change);
  await appendOwnershipResource(stateDir, shelf);
  task.p4 = {
    client: slot.p4.client,
    nonce,
    plannedChangeResource: change,
    plannedShelfResource: shelf,
    changeResource: null,
    shelfResource: null,
    artifactState: 'pending',
    artifactError: null,
  };
  return task;
}

async function injectBindFaultOnce(stateDir, name, message) {
  if (process.env[name] !== '1') return;
  const marker = path.join(stateDir, `${name}.consumed`);
  let file;
  try {
    file = await fs.open(marker, 'wx');
    throw new Error(message);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  } finally {
    await file?.close();
  }
}

export async function assertTaskP4Binding(stateDir, config, taskId) {
  const [task, slots] = await Promise.all([
    readTask(stateDir, taskId),
    readJson(statePaths(stateDir).slots),
  ]);
  if (slots.brokerUuid !== config.brokerUuid) {
    throw new Error('Perforce binding refused: slot generation does not match the broker generation');
  }
  const slotMatches = slots.slots.filter((candidate) => candidate.index === task.slot);
  const taskMatches = slots.slots.filter((candidate) => candidate.taskId === taskId);
  if (slotMatches.length !== 1 || taskMatches.length !== 1 || slotMatches[0] !== taskMatches[0]) {
    throw new Error(`Perforce binding refused: task '${taskId}' is not uniquely assigned to its recorded slot`);
  }
  const slot = slotMatches[0];
  if (slot.taskId !== task.id || slot.slotName !== task.slotName || path.resolve(slot.root) !== path.resolve(task.workspace)) {
    throw new Error(`Perforce binding refused: task '${taskId}' slot identity is inconsistent`);
  }
  if (slot.p4?.state !== 'ready' || !slot.p4.resource || task.p4?.client !== slot.p4.client) {
    throw new Error(`Perforce binding refused: task '${taskId}' is not attached to the ready slot client`);
  }
  if (slot.p4.resource.type !== 'p4-client' || slot.p4.resource.client !== slot.p4.client
    || slot.p4.resource.brokerUuid !== config.brokerUuid || slot.p4.resource.nonce !== slot.p4.nonce) {
    throw new Error(`Perforce binding refused: slot ${slot.index} client ownership is inconsistent`);
  }
  const taskResources = [task.p4.plannedChangeResource, task.p4.plannedShelfResource];
  if (taskResources.some((resource) => !resource || resource.client !== task.p4.client
    || resource.taskId !== taskId || resource.brokerUuid !== config.brokerUuid
    || resource.nonce !== task.p4.nonce || resource.handedOff !== false)) {
    throw new Error(`Perforce binding refused: task '${taskId}' planned ownership is inconsistent`);
  }
  if (task.p4.plannedChangeResource.type !== 'p4-change' || task.p4.plannedChangeResource.change !== null
    || task.p4.plannedShelfResource.type !== 'p4-shelf' || task.p4.plannedShelfResource.change !== null) {
    throw new Error(`Perforce binding refused: task '${taskId}' planned resource types are inconsistent`);
  }
  for (const [name, resource, type] of [
    ['change', task.p4.changeResource, 'p4-change'],
    ['shelf', task.p4.shelfResource, 'p4-shelf'],
  ]) {
    if (!resource) continue;
    if (resource.type !== type || resource.client !== task.p4.client || resource.taskId !== taskId
      || resource.brokerUuid !== config.brokerUuid || resource.nonce !== task.p4.nonce
      || resource.handedOff !== false || !/^\d+$/.test(String(resource.change ?? ''))) {
      throw new Error(`Perforce binding refused: task '${taskId}' ${name} ownership is inconsistent`);
    }
  }
  if (Boolean(task.p4.changeResource) !== Boolean(task.p4.shelfResource)
    || task.p4.changeResource && String(task.p4.changeResource.change) !== String(task.p4.shelfResource.change)) {
    throw new Error(`Perforce binding refused: task '${taskId}' stable change and shelf are inconsistent`);
  }
  return { task, slot };
}

export async function bindTaskP4(stateDir, config, taskId) {
  if (!config.p4?.enabled) return null;
  const binding = await assertTaskP4Binding(stateDir, config, taskId);
  const { p4, baseline } = await loadLiveBaseline(config);
  let { task } = binding;
  const { slot } = binding;
  await verifySlotClient(p4, { client: task.p4.client, projectedRoot: slot.root, slot: slot.index, ownership: slot.p4.resource });
  if (!task.p4.changeResource) {
    const actual = await ensureStableTaskChange(p4, {
      client: task.p4.client, taskId, user: config.p4.user, plannedResource: task.p4.plannedChangeResource,
    });
    const shelf = { ...task.p4.plannedShelfResource, change: actual.change };
    await replaceOwnershipResource(stateDir, task.p4.plannedChangeResource, actual);
    await injectBindFaultOnce(stateDir, 'AGENT_WORKSPACE_TEST_FAIL_AFTER_CHANGE_LEDGER_REPLACEMENT', 'simulated crash after change-ledger replacement');
    await replaceOwnershipResource(stateDir, task.p4.plannedShelfResource, shelf);
    await injectBindFaultOnce(stateDir, 'AGENT_WORKSPACE_TEST_FAIL_AFTER_SHELF_LEDGER_REPLACEMENT', 'simulated crash after shelf-ledger replacement');
    await withLock(stateDir, `task-${taskId}`, async () => {
      task = await readTask(stateDir, taskId);
      task.p4.changeResource = actual;
      task.p4.shelfResource = shelf;
      await writeTask(stateDir, task);
    });
  }
  return { p4, baseline, task };
}

export function p4WorkerEnvironment(config, task, baseEnv) {
  if (!config.p4?.enabled) return baseEnv;
  const change = task.p4.changeResource?.change;
  return buildSanitizedWorkerEnv(baseEnv, {
    P4CLIENT: task.p4.client,
    P4PORT: config.p4.port,
    P4USER: config.p4.user,
    P4CHARSET: config.p4.charset,
    ...(change === undefined || change === null ? {} : { P4_CHANGE: String(change), AGENT_WORKSPACE_P4_CHANGE: String(change) }),
  });
}

export async function checkpointTaskP4(stateDir, config, taskId) {
  try {
    const bound = await bindTaskP4(stateDir, config, taskId);
    if (!bound) return null;
    return await withLock(stateDir, `task-${taskId}`, async () => {
      const task = await readTask(stateDir, taskId);
      const artifact = await checkpoint(bound.p4, {
        baseline: bound.baseline,
        client: task.p4.client,
        change: task.p4.changeResource.change,
        changeResource: task.p4.changeResource,
        allowedProtectedPaths: task.p4.allowedProtectedPaths ?? [],
      });
      task.p4.artifactState = artifact.state;
      task.p4.artifactError = null;
      await writeTask(stateDir, task);
      return artifact;
    });
  } catch (error) {
    await withLock(stateDir, `task-${taskId}`, async () => {
      const task = await readTask(stateDir, taskId);
      if (task.p4) {
        task.p4.artifactState = 'checkpoint_failed';
        task.p4.artifactError = error.message;
      }
      await writeTask(stateDir, task);
    });
    throw error;
  }
}

export async function operateTaskP4(stateDir, config, taskId, operation, options = {}) {
  if (operation === 'handoff') return handoffTaskP4(stateDir, config, taskId);
  if (operation === 'status') {
    const { task, slot } = await assertTaskP4Binding(stateDir, config, taskId);
    const { p4 } = await loadLiveBaseline(config);
    await verifySlotClient(p4, {
      client: task.p4.client,
      projectedRoot: slot.root,
      slot: slot.index,
      ownership: slot.p4.resource,
    });
    return task.p4;
  }
  const bound = await bindTaskP4(stateDir, config, taskId);
  if (bound.task.p4.handoff) throw new Error(`task '${taskId}' is sealed by its Perforce handoff intent`);
  if (operation === 'checkpoint') return checkpointTaskP4(stateDir, config, taskId);
  if (operation === 'open') return withLock(stateDir, `task-${taskId}`, async () => {
    const task = await readTask(stateDir, taskId);
    const result = await openPaths(bound.p4, {
      baseline: bound.baseline, action: options.action, workerClient: task.p4.client,
      depotPaths: options.depotPaths, change: task.p4.changeResource.change, allowProtectedBase: options.allowProtectedBase,
    });
    if (options.allowProtectedBase) {
      const protectedPaths = new Set(bound.baseline.protectedDepotPaths);
      task.p4.allowedProtectedPaths = [...new Set([...(task.p4.allowedProtectedPaths ?? []), ...result.paths.filter((value) => protectedPaths.has(value))])].sort();
      await writeTask(stateDir, task);
    }
    return result;
  });
  if (operation === 'unshelve') return withLock(stateDir, `task-${taskId}`, async () => {
    const task = await readTask(stateDir, taskId);
    const result = await importShelf(bound.p4, {
      baseline: bound.baseline, workerClient: task.p4.client, shelf: options.sourceChange,
      change: task.p4.changeResource.change, allowProtectedBase: options.allowProtectedBase,
    });
    if (options.allowProtectedBase) {
      const protectedPaths = new Set(bound.baseline.protectedDepotPaths);
      task.p4.allowedProtectedPaths = [...new Set([...(task.p4.allowedProtectedPaths ?? []), ...result.paths.filter((value) => protectedPaths.has(value))])].sort();
      await writeTask(stateDir, task);
    }
    return result;
  });
  throw new Error(`unsupported Perforce operation '${operation}'`);
}

function deterministicReviewClient(brokerUuid, taskId) {
  return `agent-workspace-${brokerUuid.replaceAll('-', '')}-review-${taskId}`;
}

async function injectHandoffFaultOnce(stateDir, name, message) {
  const configured = process.env[name];
  if (configured !== '1' && (!configured || path.resolve(configured) !== path.resolve(stateDir))) return;
  const marker = path.join(stateDir, `${name}.consumed`);
  let file;
  try {
    file = await fs.open(marker, 'wx');
    throw new Error(message);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  } finally {
    await file?.close();
  }
}

function exactHandoffResources(resources, intent, handedOff) {
  return intent.plannedResources.map((planned) => resources.filter((candidate) => candidate.type === planned.type
    && candidate.brokerUuid === planned.brokerUuid && candidate.nonce === planned.nonce
    && candidate.handedOff === handedOff));
}

function committedHandoffResources(intent) {
  if (!intent.destinationChange) throw new Error('committed handoff resources have no durable destination change');
  const transaction = { handoffTransaction: intent.nonce };
  return intent.plannedResources.map((planned) => ({
    ...planned,
    ...(['p4-change', 'p4-shelf'].includes(planned.type) ? { change: intent.destinationChange } : {}),
    ...transaction,
    handedOff: true,
  }));
}

function assertExactCommittedHandoffResources(resources, intent) {
  const matches = exactHandoffResources(resources, intent, true);
  const expected = committedHandoffResources(intent);
  if (matches.some((entries) => entries.length !== 1)) throw new Error('handoff ownership commit is partial or duplicated');
  for (let index = 0; index < matches.length; index += 1) {
    if (JSON.stringify(matches[index][0]) !== JSON.stringify(expected[index])) {
      throw new Error('handoff ownership commit does not exactly match its durable transaction');
    }
  }
  return matches;
}

async function ensureHandoffLedger(stateDir, intent) {
  const ownershipPath = path.join(stateDir, 'ownership.json');
  const ownership = await readJson(ownershipPath);
  const matches = intent.plannedResources.map((planned) => ownership.resources.filter((candidate) => candidate.type === planned.type
    && candidate.brokerUuid === planned.brokerUuid && candidate.nonce === planned.nonce));
  if (matches.every((entries) => entries.length === 0)) {
    await appendOwnershipResources(stateDir, intent.plannedResources);
    return;
  }
  if (matches.some((entries) => entries.length !== 1)) throw new Error('handoff ownership predeclaration is missing, duplicated, or partial');
  for (let index = 0; index < matches.length; index += 1) {
    const actual = matches[index][0];
    const planned = intent.plannedResources[index];
    if (actual.handedOff === true) continue;
    if (JSON.stringify(actual) !== JSON.stringify(planned)) throw new Error('handoff ownership predeclaration does not exactly match its durable intent');
  }
}

async function beginHandoffIntent(stateDir, config, taskId) {
  return withLock(stateDir, `task-${taskId}`, async () => {
    const task = await readTask(stateDir, taskId);
    if (!terminalTaskStates.has(task.state)) throw new Error(`task '${taskId}' must be terminal before handoff`);
    if (task.p4.handoff) return { task, intent: task.p4.handoff };
    if (!['shelved', 'shelf_retained'].includes(task.p4.artifactState)) throw new Error('handoff requires a nonempty stable shelf checkpoint');
    if (!task.p4.changeResource || !task.p4.shelfResource) throw new Error('handoff requires exact source change and shelf resources');
    const nonce = newNonce();
    const client = deterministicReviewClient(config.brokerUuid, taskId);
    const plannedResources = planP4HandoffResources({
      client,
      taskId,
      user: config.p4.user,
      root: task.workspace,
      ownership: { brokerUuid: config.brokerUuid, nonce },
    });
    const intent = {
      version: 1,
      state: 'intent_recorded',
      taskId,
      user: config.p4.user,
      nonce,
      sourceChange: String(task.p4.changeResource.change),
      sourceClient: task.p4.client,
      reviewClient: client,
      destinationChange: null,
      sourceFingerprint: null,
      promotionState: null,
      fileCount: null,
      plannedResources,
      createdAt: new Date().toISOString(),
      completedAt: null,
    };
    task.p4.handoff = intent;
    await writeTask(stateDir, task);
    return { task, intent };
  });
}

function validateIntent(config, task, intent) {
  const expectedClient = deterministicReviewClient(config.brokerUuid, task.id);
  let expectedResources;
  try {
    expectedResources = planP4HandoffResources({
      client: expectedClient,
      taskId: task.id,
      user: config.p4.user,
      root: task.workspace,
      ownership: { brokerUuid: config.brokerUuid, nonce: intent?.nonce },
    });
  } catch {
    throw new Error('handoff retry does not exactly match the durable handoff intent');
  }
  if (intent.version !== 1 || !['intent_recorded', 'committed'].includes(intent.state)
    || intent.taskId !== task.id || intent.user !== config.p4.user
    || intent.sourceClient !== task.p4.client || intent.sourceChange !== String(task.p4.changeResource.change)
    || intent.reviewClient !== expectedClient
    || JSON.stringify(intent.plannedResources) !== JSON.stringify(expectedResources)) {
    throw new Error('handoff retry does not exactly match the durable handoff intent');
  }
  if (intent.destinationChange !== null && !/^\d+$/.test(intent.destinationChange)
    || intent.sourceFingerprint !== null && !/^[0-9a-f]{64}$/.test(intent.sourceFingerprint)
    || intent.promotionState !== null && !['promoted', 'not_required'].includes(intent.promotionState)
    || intent.fileCount !== null && (!Number.isSafeInteger(intent.fileCount) || intent.fileCount < 1)) {
    throw new Error('handoff durable result metadata is malformed');
  }
  if (intent.sourceFingerprint !== null && intent.destinationChange === null
    || intent.promotionState !== null && intent.sourceFingerprint === null
    || intent.fileCount !== null && intent.promotionState === null) {
    throw new Error('handoff durable result metadata is incomplete or out of order');
  }
  if (intent.state === 'committed' && (intent.fileCount === null || typeof intent.completedAt !== 'string' || intent.completedAt.length === 0)) {
    throw new Error('committed handoff intent has incomplete durable result metadata');
  }
  if (intent.state !== 'committed' && intent.completedAt !== null) throw new Error('uncommitted handoff intent has a completion time');
}

function handoffResult(intent) {
  return {
    state: intent.state,
    user: intent.user,
    change: intent.destinationChange,
    fileCount: intent.fileCount,
    promotionState: intent.promotionState,
    completedAt: intent.completedAt,
  };
}

async function finalizeCommittedHandoff(stateDir, config, taskId) {
  const task = await readTask(stateDir, taskId);
  const intent = task.p4.handoff;
  validateIntent(config, task, intent);
  if (intent.fileCount === null || intent.destinationChange === null || intent.sourceFingerprint === null || intent.promotionState === null) {
    throw new Error('handoff ownership commit has incomplete durable intent metadata');
  }
  if (intent.state !== 'committed') {
    intent.state = 'committed';
    intent.completedAt = new Date().toISOString();
    task.p4.artifactState = 'handed_off';
    task.state = 'handed_off';
    task.updatedAt = intent.completedAt;
    await writeTask(stateDir, task);
  }
  return handoffResult(intent);
}

export async function handoffTaskP4(stateDir, config, taskId) {
  let task = await readTask(stateDir, taskId);
  let intent = task.p4?.handoff ?? null;
  if (intent) {
    validateIntent(config, task, intent);
    const ownership = await readJson(path.join(stateDir, 'ownership.json'));
    const committedMatches = exactHandoffResources(ownership.resources, intent, true);
    if (intent.state === 'committed' || committedMatches.every((entries) => entries.length === 1)) {
      assertExactCommittedHandoffResources(ownership.resources, intent);
      return finalizeCommittedHandoff(stateDir, config, taskId);
    }
    if (committedMatches.some((entries) => entries.length !== 0)) throw new Error('handoff ownership commit is partial or duplicated');
  }

  const binding = await bindTaskP4(stateDir, config, taskId);
  ({ task, intent } = await beginHandoffIntent(stateDir, config, taskId));
  validateIntent(config, task, intent);
  await injectHandoffFaultOnce(stateDir, 'AGENT_WORKSPACE_TEST_FAIL_AFTER_HANDOFF_INTENT', 'simulated crash after handoff intent');
  await injectHandoffFaultOnce(stateDir, 'AGENT_WORKSPACE_TEST_FAIL_AFTER_HANDOFF_INTENT_TAMPER', 'simulated crash after handoff intent');
  await ensureHandoffLedger(stateDir, intent);
  await injectHandoffFaultOnce(stateDir, 'AGENT_WORKSPACE_TEST_FAIL_AFTER_HANDOFF_PREDECLARE', 'simulated crash after handoff ownership predeclaration');
  await injectHandoffFaultOnce(stateDir, 'AGENT_WORKSPACE_TEST_FAIL_AFTER_HANDOFF_PREDECLARE_ORDERING', 'simulated crash after handoff ownership predeclaration');

  const [plannedClient, plannedChange] = intent.plannedResources;
  await ensureReviewClient(binding.p4, {
    baseline: binding.baseline, resource: plannedClient, client: intent.reviewClient, root: task.workspace, taskId,
  });
  await injectHandoffFaultOnce(stateDir, 'AGENT_WORKSPACE_TEST_FAIL_AFTER_HANDOFF_CLIENT', 'simulated crash after review client creation');
  const destinationChange = await ensureReviewChange(binding.p4, {
    resource: plannedChange, client: intent.reviewClient, taskId, user: config.p4.user,
  });
  if (intent.destinationChange && intent.destinationChange !== String(destinationChange.change)) {
    throw new Error('recovered review change does not match the durable destination change');
  }
  intent.destinationChange = String(destinationChange.change);
  const source = await verifyHandoffSource(binding.p4, intent);
  intent.sourceFingerprint ??= source.fingerprint;
  if (intent.sourceFingerprint !== source.fingerprint) throw new Error('source shelf changed after handoff intent was recorded');
  await persistHandoffIntent(stateDir, taskId, intent);
  await injectHandoffFaultOnce(stateDir, 'AGENT_WORKSPACE_TEST_FAIL_AFTER_HANDOFF_CHANGE', 'simulated crash after review change creation');
  const promotion = await reshelveHandoff(binding.p4, {
    sourceChange: intent.sourceChange,
    destinationChange: intent.destinationChange,
    destinationClient: intent.reviewClient,
  });
  intent.promotionState ??= promotion.state;
  if (intent.promotionState !== promotion.state) throw new Error('Perforce topology changed during handoff recovery');
  await persistHandoffIntent(stateDir, taskId, intent);
  await injectHandoffFaultOnce(stateDir, 'AGENT_WORKSPACE_TEST_FAIL_AFTER_HANDOFF_RESHELVE', 'simulated crash after reshelve');
  await injectHandoffFaultOnce(stateDir, 'AGENT_WORKSPACE_TEST_FAIL_AFTER_HANDOFF_RESHELVE_AMBIGUITY', 'simulated crash after reshelve');
  const verification = await verifyHandoffShelf(binding.p4, {
    sourceClient: intent.sourceClient,
    sourceChange: intent.sourceChange,
    destinationChangeResource: destinationChange,
  });
  if (verification.source.fingerprint !== intent.sourceFingerprint) throw new Error('source shelf fingerprint changed during handoff');
  intent.fileCount = verification.fileCount;
  await persistHandoffIntent(stateDir, taskId, intent);
  await injectHandoffFaultOnce(stateDir, 'AGENT_WORKSPACE_TEST_FAIL_AFTER_HANDOFF_VERIFICATION', 'simulated crash after handoff verification persistence');
  await replaceOwnershipResources(stateDir, intent.plannedResources, committedHandoffResources(intent));
  await injectHandoffFaultOnce(stateDir, 'AGENT_WORKSPACE_TEST_FAIL_AFTER_HANDOFF_LEDGER', 'simulated crash after handoff ownership commit');
  await injectHandoffFaultOnce(stateDir, 'AGENT_WORKSPACE_TEST_FAIL_AFTER_HANDOFF_LEDGER_REVIEWER', 'simulated crash after handoff ownership commit');
  return finalizeCommittedHandoff(stateDir, config, taskId);
}

async function verifyHandoffSource(p4, intent) {
  return canonicalShelf(p4, { client: intent.sourceClient, change: intent.sourceChange });
}

async function persistHandoffIntent(stateDir, taskId, intent) {
  await withLock(stateDir, `task-${taskId}`, async () => {
    const task = await readTask(stateDir, taskId);
    validateIntent({ brokerUuid: intent.plannedResources[0].brokerUuid, p4: { user: intent.user } }, task, intent);
    task.p4.handoff = intent;
    await writeTask(stateDir, task);
  });
}

export async function recoverAndValidateP4Handoffs(stateDir, config) {
  for (const task of await listTasks(stateDir)) {
    if (task.p4?.handoff && task.p4.handoff.state !== 'committed') await handoffTaskP4(stateDir, config, task.id);
  }
  const tasks = await listTasks(stateDir);
  const ownership = await readJson(path.join(stateDir, 'ownership.json'));
  const exclusions = ownership.resources.filter((resource) => resource.handedOff === true);
  const committed = new Map(tasks.filter((task) => task.p4?.handoff?.state === 'committed')
    .map((task) => [task.p4.handoff.nonce, task.p4.handoff]));
  for (const resource of exclusions) {
    const intent = committed.get(resource.handoffTransaction);
    if (!intent || resource.handoffTransaction !== resource.nonce
      || !intent.plannedResources.some((planned) => planned.type === resource.type
        && planned.brokerUuid === resource.brokerUuid && planned.nonce === resource.nonce)) {
      throw new Error('handoff exclusion does not belong to an exact committed transaction');
    }
  }
  for (const intent of committed.values()) assertExactCommittedHandoffResources(exclusions, intent);
  return exclusions;
}

export async function cleanupP4Ledger(config, resources) {
  if (!config.p4?.enabled) {
    if (resources.length > 0) throw new Error('Perforce cleanup refused: owned resources exist without enabled Perforce configuration');
    return { cleaned: true, idempotent: true };
  }
  return cleanupResources(makeConfiguredP4(config), { resources, workersStopped: true });
}

function deterministicClient(brokerUuid, slot) {
  return `agent-workspace-${brokerUuid.replaceAll('-', '')}-slot-${slot}`;
}
