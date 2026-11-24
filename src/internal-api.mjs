import { disposeP4ReviewWithLegacyAdoption } from './review-disposal.mjs';

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

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
