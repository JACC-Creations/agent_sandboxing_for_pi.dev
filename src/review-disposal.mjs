import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createP4, deleteReviewDisposalResource, inspectReviewDisposal, readP4ServerBinding } from './perforce.mjs';
import {
  createControlledP4,
  discoverControlledP4Profile,
  resolveP4Executable,
  validateReconnectProfile as validateSharedReconnectProfile,
  verifyControlledEndpoint,
} from './perforce-reconnect.mjs';
import { atomicWriteJson, readJsonIfPresent, validateTaskId, withLifecycleLock } from './state.mjs';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const noncePattern = /^[0-9a-f]{32}$/;
const phases = ['shelf', 'change', 'client'];

export class ReviewDisposalError extends Error {
  constructor(code) {
    super(`review disposal refused: ${code}`);
    this.name = 'ReviewDisposalError';
    this.code = code;
  }
}

function refuse(code) {
  throw new ReviewDisposalError(code);
}

function requireText(value) {
  return typeof value === 'string' && value.length > 0 && !/[\0\r\n]/.test(value);
}

async function readReceipt(receiptPath) {
  let bytes;
  try {
    bytes = await fs.readFile(receiptPath);
  } catch {
    refuse('invalid_receipt');
  }
  try {
    return { bytes, receipt: JSON.parse(bytes.toString('utf8')) };
  } catch {
    refuse('invalid_receipt');
  }
}

function validateTransaction(resources, brokerUuid) {
  if (resources.length !== 3) refuse('invalid_receipt');
  const transaction = resources[0]?.handoffTransaction;
  const types = resources.map((resource) => resource?.type);
  if (!noncePattern.test(transaction ?? '') || new Set(types).size !== 3
    || !types.every((type) => ['p4-client', 'p4-change', 'p4-shelf'].includes(type))) refuse('invalid_receipt');
  const byType = new Map(resources.map((resource) => [resource.type, resource]));
  const client = byType.get('p4-client');
  const change = byType.get('p4-change');
  const shelf = byType.get('p4-shelf');
  for (const resource of resources) {
    if (resource.handedOff !== true || resource.handoffTransaction !== transaction || resource.nonce !== transaction
      || resource.brokerUuid !== brokerUuid || !requireText(resource.taskId)
      || !requireText(resource.client) || !requireText(resource.user)) refuse('invalid_receipt');
  }
  if (client.taskId !== change.taskId || client.taskId !== shelf.taskId
    || client.client !== change.client || client.client !== shelf.client
    || client.user !== change.user || client.user !== shelf.user
    || client.slot !== `handoff:${client.taskId}` || !path.isAbsolute(client.root)
    || !/^\d+$/.test(String(change.change ?? '')) || String(change.change) !== String(shelf.change)) refuse('invalid_receipt');
  return { transaction, taskId: client.taskId, resources: [client, change, shelf] };
}

function validateResourceSet(receipt, taskId, brokerUuid) {
  if (!Array.isArray(receipt.handoffExclusions)) refuse('invalid_receipt');
  const groups = new Map();
  for (const resource of receipt.handoffExclusions) {
    const transaction = resource?.handoffTransaction;
    if (!requireText(transaction)) refuse('invalid_receipt');
    const group = groups.get(transaction) ?? [];
    group.push(resource);
    groups.set(transaction, group);
  }
  const transactions = [...groups.values()].map((resources) => validateTransaction(resources, brokerUuid));
  const matches = transactions.filter((transaction) => transaction.taskId === taskId);
  if (matches.length !== 1) refuse('ambiguous_transaction');
  return { transaction: matches[0].transaction, resources: matches[0].resources };
}

function validateRemovedResources(receipt) {
  if (!Array.isArray(receipt.removed)) refuse('invalid_receipt');
  for (const resource of receipt.removed) {
    if (['p4-client', 'p4-change', 'p4-shelf'].includes(resource?.type)) {
      if (!requireText(resource.client) || !requireText(resource.brokerUuid) || !requireText(resource.nonce)) refuse('invalid_receipt');
      continue;
    }
    if (!['projfs-root', 'broker-private-state'].includes(resource?.type) || !path.isAbsolute(resource.path ?? '')) refuse('invalid_receipt');
  }
}

function validateReconnectProfile(profile, errorCode = 'invalid_receipt') {
  try {
    return validateSharedReconnectProfile(profile);
  } catch {
    refuse(errorCode);
  }
}

function validateReceipt(receipt, stateDir, expectedBrokerUuid, taskId) {
  if (!receipt || Array.isArray(receipt) || ![1, 2].includes(receipt.version) || receipt.state !== 'completed'
    || !requireText(receipt.completedAt) || !Number.isFinite(Date.parse(receipt.completedAt))
    || !uuidPattern.test(receipt.brokerUuid ?? '') || receipt.brokerUuid !== expectedBrokerUuid
    || receipt.stateDir !== stateDir || receipt.nativeSupervisor !== undefined && typeof receipt.nativeSupervisor !== 'boolean'
    || receipt.ownedJobs !== undefined && !Array.isArray(receipt.ownedJobs)) refuse('invalid_receipt');
  validateRemovedResources(receipt);
  const resources = validateResourceSet(receipt, taskId, expectedBrokerUuid);
  if (receipt.version === 2) return { ...resources, profile: validateReconnectProfile(receipt.p4Reconnect), legacy: false };
  if (receipt.p4Reconnect !== undefined) refuse('invalid_receipt');
  return { ...resources, profile: null, legacy: true };
}

function validateJournal(journal, binding) {
  if (!journal || journal.version !== 1 || journal.state !== 'in_progress' && journal.state !== 'completed'
    || journal.receiptSha256 !== binding.receiptSha256 || journal.transaction !== binding.transaction
    || journal.brokerUuid !== binding.brokerUuid || journal.taskId !== binding.taskId
    || !journal.phases || typeof journal.phases !== 'object') refuse('invalid_journal');
  let sawIncomplete = false;
  for (const phase of phases) {
    const value = journal.phases[phase];
    if (value === undefined) {
      sawIncomplete = true;
      continue;
    }
    if (!value || !requireText(value.intentAt) || value.completedAt !== null && !requireText(value.completedAt)) refuse('invalid_journal');
    if (value.completedAt === null) sawIncomplete = true;
    else if (sawIncomplete) refuse('invalid_journal');
  }
  if (journal.state === 'completed' && (sawIncomplete || !requireText(journal.completedAt))) refuse('invalid_journal');
}

function validateAdoption(adoption, binding) {
  if (!adoption || adoption.version !== 1 || adoption.receiptSha256 !== binding.receiptSha256
    || adoption.transaction !== binding.transaction || adoption.brokerUuid !== binding.brokerUuid
    || adoption.taskId !== binding.taskId || !requireText(adoption.adoptedAt)) refuse('invalid_adoption');
  return validateReconnectProfile(adoption.profile, 'invalid_adoption');
}

async function inspect(p4, resources) {
  try {
    return await inspectReviewDisposal(p4, { resources });
  } catch {
    refuse('live_verification_failed');
  }
}

async function verifyEndpoint(p4, profile) {
  try {
    await verifyControlledEndpoint(p4, profile);
  } catch {
    refuse('endpoint_verification_failed');
  }
}

function createProfileP4(profile, internals) {
  if (internals.createBoundP4) return internals.createBoundP4(structuredClone(profile));
  return createControlledP4(profile);
}

async function adoptLegacy(binding, adoptionPath, internals) {
  let executable = null;
  if (!internals.createAmbientP4 || !internals.legacyProfile) {
    try {
      executable = await resolveP4Executable(process.env.P4EXE ?? (process.platform === 'win32' ? 'p4.exe' : 'p4'));
    } catch {
      refuse('p4_executable_unavailable');
    }
  }
  const ambientP4 = internals.createAmbientP4
    ? internals.createAmbientP4()
    : createP4({ executable, preserveAmbientCredentials: true });
  const live = await inspect(ambientP4, binding.resources);
  if (!live.client || !live.change || !live.shelf) refuse('live_verification_failed');
  let endpoint;
  try {
    endpoint = await readP4ServerBinding(ambientP4);
  } catch {
    refuse('endpoint_verification_failed');
  }
  if (endpoint.user !== binding.resources[0].user) refuse('endpoint_verification_failed');
  let profile;
  if (internals.legacyProfile) {
    profile = validateReconnectProfile(internals.legacyProfile, 'endpoint_verification_failed');
    if (profile.user !== endpoint.user || profile.serverFingerprint !== endpoint.fingerprint) refuse('endpoint_verification_failed');
  } else {
    try {
      const discovered = await discoverControlledP4Profile({
        executable,
        ambientP4,
        knownBinding: endpoint,
        expectedUser: endpoint.user,
        expectedFingerprint: endpoint.fingerprint,
        allowInvalidEnvironmentFallback: true,
        controlledP4Factory: internals.createBoundP4,
      });
      profile = discovered.profile;
    } catch {
      refuse('endpoint_verification_failed');
    }
  }

  const controlledP4 = createProfileP4(profile, internals);
  await verifyEndpoint(controlledP4, profile);
  const controlledLive = await inspect(controlledP4, binding.resources);
  if (!controlledLive.client || !controlledLive.change || !controlledLive.shelf) refuse('live_verification_failed');

  await atomicWriteJson(adoptionPath, {
    version: 1,
    receiptSha256: binding.receiptSha256,
    transaction: binding.transaction,
    brokerUuid: binding.brokerUuid,
    taskId: binding.taskId,
    adoptedAt: new Date().toISOString(),
    profile,
  });
  return profile;
}

function assertPhaseEvidence(phase, live, hasIntent) {
  if (phase === 'shelf') {
    if (!live.client || !live.change || (!hasIntent && !live.shelf)) refuse('live_verification_failed');
    return;
  }
  if (phase === 'change') {
    if (!live.client || live.shelf || (!hasIntent && !live.change)) refuse('live_verification_failed');
    return;
  }
  if (live.change || live.shelf || (!hasIntent && !live.client)) refuse('live_verification_failed');
}

function phaseIsAbsent(phase, live) {
  return live[phase] === false;
}

async function persistJournal(journalPath, journal) {
  journal.updatedAt = new Date().toISOString();
  await atomicWriteJson(journalPath, journal);
}

async function runPhase(p4, binding, journal, journalPath, phase, internals) {
  const prior = journal.phases[phase];
  if (prior?.completedAt) return;
  let live = await inspect(p4, binding.resources);
  assertPhaseEvidence(phase, live, Boolean(prior));
  if (!prior) {
    journal.phases[phase] = { intentAt: new Date().toISOString(), completedAt: null };
    await persistJournal(journalPath, journal);
    await internals.afterIntent?.(phase);
  } else if (phaseIsAbsent(phase, live)) {
    journal.phases[phase].completedAt = new Date().toISOString();
    await persistJournal(journalPath, journal);
    return;
  }
  live = await inspect(p4, binding.resources);
  assertPhaseEvidence(phase, live, true);
  if (!phaseIsAbsent(phase, live)) {
    try {
      await deleteReviewDisposalResource(p4, { resources: binding.resources, phase });
    } catch {
      const recovered = await inspect(p4, binding.resources);
      assertPhaseEvidence(phase, recovered, true);
      if (!phaseIsAbsent(phase, recovered)) refuse('mutation_failed');
    }
    await internals.afterMutation?.(phase);
  }
  live = await inspect(p4, binding.resources);
  assertPhaseEvidence(phase, live, true);
  if (!phaseIsAbsent(phase, live)) refuse('mutation_failed');
  journal.phases[phase].completedAt = new Date().toISOString();
  await persistJournal(journalPath, journal);
}

async function disposeExclusive(options, internals, allowLegacyAdoption) {
  const stateDir = path.resolve(options.stateDir);
  if (await fs.lstat(stateDir).then(() => true, (error) => error.code === 'ENOENT' ? false : Promise.reject(error))) refuse('broker_state_present');
  const receiptPath = `${stateDir}.cleanup-receipt.json`;
  const { bytes, receipt } = await readReceipt(receiptPath);
  const validated = validateReceipt(receipt, stateDir, options.expectedBrokerUuid, options.taskId);
  const receiptSha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  const binding = { ...validated, receiptSha256, brokerUuid: options.expectedBrokerUuid, taskId: options.taskId };
  const journalPath = `${stateDir}.review-disposal-${validated.transaction}.json`;
  const adoptionPath = `${stateDir}.review-disposal-${validated.transaction}.binding.json`;
  let journal = await readJsonIfPresent(journalPath).catch(() => refuse('invalid_journal'));
  if (journal) validateJournal(journal, binding);

  let profile = binding.profile;
  if (binding.legacy) {
    const adoption = await readJsonIfPresent(adoptionPath).catch(() => refuse('invalid_adoption'));
    if (!adoption && !allowLegacyAdoption) refuse('legacy_adoption_required');
    profile = adoption ? validateAdoption(adoption, binding) : await adoptLegacy(binding, adoptionPath, internals);
  }
  if (journal?.state === 'completed') return { state: 'completed', taskId: options.taskId, idempotent: true };

  const p4 = createProfileP4(profile, internals);
  await verifyEndpoint(p4, profile);
  const preflight = await inspect(p4, binding.resources);
  if (!journal && (!preflight.client || !preflight.change || !preflight.shelf)) refuse('live_verification_failed');
  if (!journal) {
    journal = {
      version: 1,
      state: 'in_progress',
      brokerUuid: binding.brokerUuid,
      taskId: binding.taskId,
      transaction: binding.transaction,
      receiptSha256,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      completedAt: null,
      phases: {},
    };
    await persistJournal(journalPath, journal);
  }
  for (const phase of phases) await runPhase(p4, binding, journal, journalPath, phase, internals);
  journal.state = 'completed';
  journal.completedAt = new Date().toISOString();
  await persistJournal(journalPath, journal);
  return { state: 'completed', taskId: options.taskId, idempotent: false };
}

async function dispose(options, internals, allowLegacyAdoption) {
  if (!options || Object.keys(options).some((key) => !['stateDir', 'expectedBrokerUuid', 'taskId'].includes(key))
    || !requireText(options.stateDir) || !uuidPattern.test(options.expectedBrokerUuid ?? '')) refuse('invalid_input');
  try {
    validateTaskId(options.taskId);
  } catch {
    refuse('invalid_input');
  }
  try {
    return await withLifecycleLock(
      options.stateDir,
      () => disposeExclusive(options, internals, allowLegacyAdoption),
      { timeoutMs: 120000 },
    );
  } catch (error) {
    if (error instanceof ReviewDisposalError) throw error;
    refuse('internal_failure');
  }
}

export async function disposeP4Review(options, internals = {}) {
  return dispose(options, internals, false);
}

export async function disposeP4ReviewWithLegacyAdoption(options, internals = {}) {
  return dispose(options, internals, true);
}

export const disposeReviewP4 = disposeP4Review;
