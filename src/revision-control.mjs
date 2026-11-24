import {
  bindTaskP4,
  checkpointTaskP4,
  cleanupP4Ledger,
  discoverP4Configuration,
  loadLiveBaseline,
  operateTaskP4,
  p4WorkerEnvironment,
  planTaskP4,
  provisionP4Slots,
  recoverAndValidateP4Handoffs,
} from './perforce-state.mjs';
import { validateRevisionControlMode } from './revision-control-preference.mjs';

const p4Capabilities = Object.freeze({
  explicitOpen: true,
  artifactImport: true,
  automaticCheckpoints: true,
  reviewHandoff: true,
});

const loreCapabilities = Object.freeze({
  explicitOpen: false,
  artifactImport: false,
  automaticCheckpoints: false,
  reviewHandoff: false,
});

const backends = Object.freeze({
  p4: Object.freeze({
    mode: 'p4',
    capabilities: p4Capabilities,
    async initialize(options, workspace) {
      return { p4: await discoverP4Configuration(options, workspace) };
    },
    isEnabled(config) {
      return config.p4?.enabled === true;
    },
    async provision(stateDir, config) {
      return provisionP4Slots(stateDir, config);
    },
    async planTask(stateDir, config, task, slot) {
      return planTaskP4(stateDir, config, task, slot);
    },
    async bindTask(stateDir, config, taskId) {
      return bindTaskP4(stateDir, config, taskId);
    },
    workerEnvironment(config, task, baseEnvironment) {
      return p4WorkerEnvironment(config, task, baseEnvironment);
    },
    async checkpointTask(stateDir, config, taskId) {
      return checkpointTaskP4(stateDir, config, taskId);
    },
    async loadLiveState(config) {
      return loadLiveBaseline(config);
    },
    async operateTask(stateDir, config, taskId, operation, options) {
      return operateTaskP4(stateDir, config, taskId, operation, options);
    },
    async recoverForCleanup(stateDir, config) {
      return recoverAndValidateP4Handoffs(stateDir, config);
    },
    async cleanupResources(config, resources) {
      return cleanupP4Ledger(config, resources);
    },
    isTaskSealed(task) {
      return Boolean(task.p4?.handoff);
    },
  }),
  lore: Object.freeze({
    mode: 'lore',
    capabilities: loreCapabilities,
    async initialize() {
      throw new Error('Lore revision-control backend is not implemented');
    },
    isEnabled() {
      return false;
    },
    async provision() {},
    async planTask(_stateDir, _config, task) {
      return task;
    },
    async bindTask() {
      throw new Error('Lore revision-control backend is not implemented');
    },
    workerEnvironment(_config, _task, baseEnvironment) {
      return baseEnvironment;
    },
    async checkpointTask() {
      throw new Error('Lore revision-control backend is not implemented');
    },
    async loadLiveState() {
      throw new Error('Lore revision-control backend is not implemented');
    },
    async operateTask() {
      throw new Error('Lore revision-control backend is not implemented');
    },
    async recoverForCleanup() {},
    async cleanupResources(_config, resources) {
      if (resources.length > 0) throw new Error('Lore revision-control backend cannot clean Perforce resources');
      return { cleaned: true, idempotent: true };
    },
    isTaskSealed() {
      return false;
    },
  }),
});

export function revisionControlSnapshot(mode) {
  return Object.freeze({ version: 1, mode: validateRevisionControlMode(mode) });
}

export function revisionControlMode(config) {
  if (config.revisionControl === undefined) {
    if (Number.isInteger(config.version) && config.version <= 9) return 'p4';
    throw new Error('current generation configuration has no immutable revisionControl selection');
  }
  const value = config.revisionControl;
  const keys = value && typeof value === 'object' && !Array.isArray(value)
    ? Object.keys(value).sort()
    : [];
  if (keys.length !== 2 || keys[0] !== 'mode' || keys[1] !== 'version' || value.version !== 1) {
    throw new Error('invalid immutable revisionControl generation configuration');
  }
  return validateRevisionControlMode(value.mode, 'revisionControl.mode');
}

export function revisionControlStatus(config) {
  const backend = revisionControlBackend(config);
  return Object.freeze({
    mode: backend.mode,
    enabled: backend.isEnabled(config),
    capabilities: backend.capabilities,
  });
}

export function revisionControlBackend(configOrMode) {
  const mode = typeof configOrMode === 'string'
    ? validateRevisionControlMode(configOrMode)
    : revisionControlMode(configOrMode);
  return backends[mode];
}

export function assertRevisionControlCanInitialize(mode) {
  const backend = revisionControlBackend(mode);
  if (backend.mode === 'lore') {
    throw new Error('Lore revision-control backend is not implemented');
  }
  return backend;
}
