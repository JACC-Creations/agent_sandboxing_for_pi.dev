import path from 'node:path';
import { cleanupBroker } from './cleanup.mjs';
import { externalCleanupPaths } from './ownership.mjs';
import { disposeP4ReviewWithLegacyAdoption } from './review-disposal.mjs';
import { readJsonIfPresent, statePaths, withLifecycleLock } from './state.mjs';

const brokerUuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function disposeAgentWorkspaceP4HandoffAfterApproval(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)
    || Object.keys(options).length !== 3
    || !Object.hasOwn(options, 'stateDir') || !Object.hasOwn(options, 'brokerUuid') || !Object.hasOwn(options, 'taskId')) {
    throw new Error('review disposal refused: invalid_input');
  }
  const result = await disposeP4ReviewWithLegacyAdoption({
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

export async function inspectAgentWorkspaceCleanupRequirement(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)
    || Object.keys(options).length !== 2 || !Object.hasOwn(options, 'stateDir') || !Object.hasOwn(options, 'brokerUuid')
    || typeof options.stateDir !== 'string' || !options.stateDir || /[\0\r\n]/.test(options.stateDir)
    || !brokerUuidPattern.test(options.brokerUuid ?? '')) {
    throw new Error('cleanup inspection refused: invalid internal input');
  }
  const stateDir = path.resolve(options.stateDir);
  const result = await withLifecycleLock(stateDir, async () => {
    const external = externalCleanupPaths(stateDir);
    const [config, journal, receipt] = await Promise.all([
      readJsonIfPresent(statePaths(stateDir).config),
      readJsonIfPresent(external.journal),
      readJsonIfPresent(external.receipt),
    ]);
    const brokerUuid = config?.brokerUuid ?? journal?.brokerUuid ?? receipt?.brokerUuid ?? null;
    const completed = !config && brokerUuid === options.brokerUuid
      && (receipt?.state === 'completed' || journal?.state === 'completed');
    let slots = null;
    if (!completed && config?.brokerUuid === brokerUuid) {
      slots = await readJsonIfPresent(statePaths(stateDir).slots);
    } else if (!completed && journal?.brokerUuid === brokerUuid) {
      slots = journal.slots ?? null;
    }
    if (slots && slots.brokerUuid !== brokerUuid) {
      throw new Error('cleanup inspection refused: slot generation mismatch');
    }
    return {
      brokerUuidMatches: brokerUuid === options.brokerUuid,
      completed,
      hasHumanSlots: slots?.slots?.some((slot) => Boolean(slot.humanOwner || slot.humanOwnerState)) === true,
    };
  });
  return deepFreeze(result);
}

export async function cleanupAgentWorkspaceAfterApproval(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)
    || Object.keys(options).some((key) => !['stateDir', 'brokerUuid', 'allowHumanSlots'].includes(key))
    || typeof options.stateDir !== 'string' || !options.stateDir || /[\0\r\n]/.test(options.stateDir)
    || !brokerUuidPattern.test(options.brokerUuid ?? '') || typeof options.allowHumanSlots !== 'boolean') {
    throw new Error('cleanup refused: invalid internal approval input');
  }
  const result = await cleanupBroker(path.resolve(options.stateDir), {
    expectedBrokerUuid: options.brokerUuid,
    allowEndpointRecovery: true,
    allowHumanSlots: options.allowHumanSlots,
  });
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

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
