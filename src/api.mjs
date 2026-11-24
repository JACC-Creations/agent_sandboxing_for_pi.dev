import path from 'node:path';
import { loadConfig } from './broker.mjs';
import { cleanupBroker } from './cleanup.mjs';
import { assertBrokerGeneration } from './ownership.mjs';
import { revisionControlBackend, revisionControlStatus } from './revision-control.mjs';
import { requireProjfsSafe } from './projfs.mjs';
import { disposeP4Review } from './review-disposal.mjs';
import { listTasks, readJson, readJsonIfPresent, statePaths, validateTaskId, withLifecycleLock } from './state.mjs';

const brokerUuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function inspectAgentWorkspace(stateDir) {
  const resolvedStateDir = resolveStateDir(stateDir);
  const summary = await withLifecycleLock(resolvedStateDir, async () => {
    const config = await loadConfig(resolvedStateDir);
    await assertBrokerGeneration(resolvedStateDir, config.brokerUuid);
    const [slots, tasks, safety] = await Promise.all([
      readJson(statePaths(resolvedStateDir).slots),
      listTasks(resolvedStateDir),
      readRecordedSafety(resolvedStateDir, config),
    ]);
    if (slots.brokerUuid !== config.brokerUuid) {
      throw new Error('status refused: slot generation does not match the broker generation');
    }
    const slotCounts = slots.slots.reduce((counts, slot) => {
      if (slot.taskId) counts.task += 1;
      else if (slot.humanOwner) counts.human += 1;
      else counts.available += 1;
      return counts;
    }, { available: 0, task: 0, human: 0 });
    const revisionControl = revisionControlStatus(config);
    return {
      brokerUuid: config.brokerUuid,
      stateDir: resolvedStateDir,
      adapter: config.adapter,
      revisionControl,
      p4Enabled: revisionControl.mode === 'p4' && revisionControl.enabled,
      safety: {
        state: safety.state,
        quarantined: safety.quarantined === true,
      },
      capacity: {
        total: slots.slots.length,
        ...slotCounts,
        queuedHeavyBuilds: slots.buildQueue?.length ?? 0,
      },
      tasks: tasks.map((task) => ({
        taskId: task.id,
        state: task.state,
        slot: task.slot,
        slotName: task.slotName,
        attempt: task.attempt ?? 1,
        p4: task.p4 ? {
          enabled: true,
          artifactState: task.p4.artifactState ?? null,
          change: task.p4.changeResource?.change ? String(task.p4.changeResource.change) : null,
          handoff: task.p4.handoff ? {
            state: task.p4.handoff.state,
            change: task.p4.handoff.destinationChange,
            user: task.p4.handoff.user,
          } : null,
        } : { enabled: false, artifactState: null, change: null, handoff: null },
      })),
    };
  });
  return deepFreeze(summary);
}

export async function openAgentWorkspaceP4(options) {
  assertExactOptions(options, ['stateDir', 'expectedBrokerUuid', 'taskId', 'action', 'depotPaths']);
  const depotPaths = validateDepotPaths(options.depotPaths);
  const action = options?.action;
  if (!['edit', 'add', 'delete'].includes(action)) {
    throw new Error("action must be 'edit', 'add', or 'delete'");
  }
  return runPinnedP4(options, 'open', { action, depotPaths, allowProtectedBase: false }, (result) => ({
    action: result.action,
    depotPaths: [...result.paths],
  }));
}

export async function unshelveAgentWorkspaceP4(options) {
  assertExactOptions(options, ['stateDir', 'expectedBrokerUuid', 'taskId', 'sourceChange']);
  const sourceChange = options.sourceChange;
  if (!Number.isSafeInteger(sourceChange) || sourceChange < 1) {
    throw new Error('sourceChange must be a positive integer');
  }
  return runPinnedP4(options, 'unshelve', { sourceChange, allowProtectedBase: false }, (result) => ({
    sourceChange,
    depotPaths: [...result.paths],
    files: result.files.map(({ depotFile, action, rev }) => ({ depotFile, action, rev: rev ?? null })),
  }));
}

export async function checkpointAgentWorkspaceP4(options) {
  assertExactOptions(options, ['stateDir', 'expectedBrokerUuid', 'taskId']);
  return runPinnedP4(options, 'checkpoint', { allowProtectedBase: false }, (result) => ({
    state: result.state,
    change: String(result.change),
    openedDepotPaths: [...result.opened],
    replaced: result.replaced === true,
  }));
}

export async function handoffAgentWorkspaceP4(options) {
  assertExactOptions(options, ['stateDir', 'expectedBrokerUuid', 'taskId']);
  return runPinnedP4(options, 'handoff', {}, (result) => ({
    state: result.state,
    user: result.user,
    change: String(result.change),
    fileCount: result.fileCount,
    promotionState: result.promotionState,
    completedAt: result.completedAt,
  }));
}

export async function disposeAgentWorkspaceP4Handoff(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)
    || Object.keys(options).length !== 3
    || !Object.hasOwn(options, 'stateDir') || !Object.hasOwn(options, 'brokerUuid') || !Object.hasOwn(options, 'taskId')) {
    throw new Error('review disposal refused: invalid_input');
  }
  const result = await disposeP4Review({
    stateDir: options.stateDir,
    expectedBrokerUuid: options.brokerUuid,
    taskId: options.taskId,
  });
  return deepFreeze({
    brokerUuid: options.brokerUuid,
    taskId: options.taskId,
    operation: 'p4_dispose_handoff',
    result: {
      state: result.state,
      idempotent: result.idempotent === true,
    },
  });
}

export async function cleanupAgentWorkspace(options) {
  assertExactOptions(options, ['stateDir', 'expectedBrokerUuid']);
  const stateDir = resolveStateDir(options.stateDir);
  const expectedBrokerUuid = validateBrokerUuid(options.expectedBrokerUuid);
  const result = await cleanupBroker(stateDir, { expectedBrokerUuid });
  const removedByType = {};
  for (const resource of result.removed ?? []) {
    removedByType[resource.type] = (removedByType[resource.type] ?? 0) + 1;
  }
  return deepFreeze({
    brokerUuid: result.brokerUuid,
    state: result.state,
    completedAt: result.completedAt,
    idempotent: result.idempotent === true,
    removedByType,
  });
}

async function runPinnedP4(options, operation, operationOptions, sanitize) {
  const stateDir = resolveStateDir(options?.stateDir);
  const expectedBrokerUuid = validateBrokerUuid(options?.expectedBrokerUuid);
  const taskId = validateTaskId(options?.taskId);
  const result = await withLifecycleLock(stateDir, async () => {
    const config = await loadConfig(stateDir);
    await assertBrokerGeneration(stateDir, expectedBrokerUuid);
    if (config.brokerUuid !== expectedBrokerUuid) {
      throw new Error(`broker generation changed for state '${stateDir}'`);
    }
    const revisionBackend = revisionControlBackend(config);
    if (revisionBackend.mode !== 'p4') {
      throw new Error(`Perforce compatibility operation requires revision-control mode 'p4'; active mode is '${revisionBackend.mode}'`);
    }
    if (!revisionBackend.isEnabled(config)) {
      throw new Error('Perforce is not enabled for this broker generation');
    }
    await requireProjfsSafe(stateDir, config);
    return revisionBackend.operateTask(stateDir, config, taskId, operation, operationOptions);
  });
  return deepFreeze({
    brokerUuid: expectedBrokerUuid,
    taskId,
    operation,
    result: sanitize(result),
  });
}

async function readRecordedSafety(stateDir, config) {
  if (config.adapter !== 'projfs') return { state: 'not_applicable', quarantined: false };
  const [quarantine, guard, supervisor] = await Promise.all([
    readJsonIfPresent(path.join(stateDir, 'lower-quarantine.json')),
    readJsonIfPresent(path.join(stateDir, 'lower-guard-owner.json')),
    readJsonIfPresent(path.join(stateDir, 'generation-supervisor-owner.json')),
  ]);
  if (quarantine) return { state: 'base_modified_quarantine', quarantined: true };
  if (guard?.ownerUuid === config.brokerUuid && guard.state === 'ready'
    && supervisor?.ownerUuid === config.brokerUuid && supervisor.state === 'ready') {
    return { state: 'guarded_recorded_ready', quarantined: false };
  }
  return { state: 'guard_recorded_degraded', quarantined: false };
}

function assertExactOptions(options, allowedKeys) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new Error('operation options must be an object');
  }
  const unexpected = Object.keys(options).filter((key) => !allowedKeys.includes(key));
  if (unexpected.length > 0) {
    throw new Error(`unsupported operation option(s): ${unexpected.join(', ')}`);
  }
}

function resolveStateDir(value) {
  if (typeof value !== 'string' || value.length === 0 || /[\r\n\0]/.test(value)) {
    throw new Error('stateDir must be non-empty text without control newlines');
  }
  return path.resolve(value);
}

function validateBrokerUuid(value) {
  if (typeof value !== 'string' || !brokerUuidPattern.test(value)) {
    throw new Error('expectedBrokerUuid must be an exact broker UUID');
  }
  return value;
}

function validateDepotPaths(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('depotPaths must contain at least one depot path');
  }
  if (value.some((depotPath) => typeof depotPath !== 'string' || !/^\/\/.+/.test(depotPath) || /[\r\n\0]/.test(depotPath))) {
    throw new Error("each depot path must be nonempty, start with '//', and contain no control newlines");
  }
  if (new Set(value).size !== value.length) {
    throw new Error('depotPaths must be unique');
  }
  return [...value];
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
