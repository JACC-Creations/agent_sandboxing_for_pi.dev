import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteJson, readJsonIfPresent, withLock } from './state.mjs';

export const ownerMarkerName = '.agent-workspace-owner.json';
export const ownershipVersion = 1;

export function newNonce() {
  return crypto.randomBytes(16).toString('hex');
}

export function externalCleanupPaths(stateDir) {
  return {
    journal: `${stateDir}.cleanup-journal.json`,
    receipt: `${stateDir}.cleanup-receipt.json`,
  };
}

export async function assertNoCleanupInProgress(stateDir) {
  const { journal } = externalCleanupPaths(stateDir);
  const value = await readJsonIfPresent(journal);
  if (value && value.state !== 'completed') {
    throw new Error(`cleanup is in progress for broker state '${stateDir}'`);
  }
}

export async function assertBrokerGeneration(stateDir, brokerUuid) {
  await assertNoCleanupInProgress(stateDir);
  const config = await readJsonIfPresent(path.join(stateDir, 'config.json'));
  if (!config || config.brokerUuid !== brokerUuid || path.resolve(config.stateDir) !== path.resolve(stateDir)) {
    throw new Error(`broker generation changed for state '${stateDir}'`);
  }
}

export async function canonicalizeForSafety(candidate) {
  const absolute = path.resolve(candidate);
  let cursor = absolute;
  const suffix = [];
  while (true) {
    try {
      const real = await fs.realpath(cursor);
      return normalizeCanonical(path.join(real, ...suffix.reverse()));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw error;
      suffix.push(path.basename(cursor));
      cursor = parent;
    }
  }
}

export async function rejectReparseAncestors(candidate) {
  let cursor = path.resolve(candidate);
  while (true) {
    const stats = await fs.lstat(cursor).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (stats?.isSymbolicLink()) {
      throw new Error(`unsafe symbolic-link/reparse ancestor: ${cursor}`);
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) return;
    cursor = parent;
  }
}

export function pathsOverlap(left, right) {
  const leftKey = normalizeCanonical(left);
  const rightKey = normalizeCanonical(right);
  if (leftKey === rightKey) return true;
  const separator = path.sep;
  return leftKey.startsWith(`${rightKey}${separator}`) || rightKey.startsWith(`${leftKey}${separator}`);
}

export async function validatePathIsolation(lower, stateDir, roots) {
  const entries = [
    { label: 'lower', value: lower },
    { label: 'state directory', value: stateDir },
    ...roots.map((value, index) => ({ label: `ProjFS root ${index + 1}`, value })),
  ];
  for (const entry of entries) await rejectReparseAncestors(entry.value);
  const canonical = await Promise.all(entries.map(async (entry) => ({ ...entry, canonical: await canonicalizeForSafety(entry.value) })));
  for (let left = 0; left < canonical.length; left += 1) {
    for (let right = left + 1; right < canonical.length; right += 1) {
      if (pathsOverlap(canonical[left].canonical, canonical[right].canonical)) {
        throw new Error(`${canonical[left].label} and ${canonical[right].label} must not overlap: ${canonical[left].value} and ${canonical[right].value}`);
      }
    }
  }
  return Object.fromEntries(canonical.map((entry) => [entry.label, entry.canonical]));
}

export async function createOwnedDirectory(directory, marker) {
  const parent = path.dirname(directory);
  await fs.mkdir(parent, { recursive: true });
  try {
    await fs.mkdir(directory);
  } catch (error) {
    if (error.code === 'EEXIST') {
      throw new Error(`refusing existing ProjFS root because exclusive broker ownership cannot be proven: ${directory}`);
    }
    throw error;
  }
  try {
    await atomicWriteJson(path.join(directory, ownerMarkerName), marker);
  } catch (error) {
    await fs.rmdir(directory).catch(() => {});
    throw error;
  }
}

export async function verifyOwnedDirectory(directory, brokerUuid, rootNonce) {
  const marker = await readJsonIfPresent(path.join(directory, ownerMarkerName)).catch(() => null);
  return Boolean(marker
    && marker.version === ownershipVersion
    && marker.type === 'projfs-root'
    && marker.brokerUuid === brokerUuid
    && marker.rootNonce === rootNonce
    && path.resolve(marker.path) === path.resolve(directory));
}

export async function appendOwnershipResource(stateDir, resource) {
  await appendOwnershipResources(stateDir, [resource]);
  return resource;
}

export async function appendOwnershipResources(stateDir, resources) {
  if (!Array.isArray(resources) || resources.length === 0) throw new Error('ownership resources must be a nonempty array');
  return withLock(stateDir, 'ownership', async () => {
    const manifestPath = path.join(stateDir, 'ownership.json');
    const manifest = await readJsonIfPresent(manifestPath);
    if (!manifest?.brokerUuid || manifest.type !== 'broker') throw new Error('ownership manifest is missing or invalid');
    const identities = resources.map(resourceIdentity);
    if (new Set(identities).size !== identities.length) throw new Error('ownership resources must have unique identities');
    for (const identity of identities) {
      if (manifest.resources.some((candidate) => isP4Resource(candidate) && resourceIdentity(candidate) === identity)) {
        throw new Error(`ownership resource already exists: ${identity}`);
      }
    }
    manifest.resources.push(...resources.map((resource) => structuredClone(resource)));
    await atomicWriteJson(manifestPath, manifest);
    return resources;
  });
}

export async function replaceOwnershipResource(stateDir, expected, replacement) {
  await replaceOwnershipResources(stateDir, [expected], [replacement]);
  return replacement;
}

export async function replaceOwnershipResources(stateDir, expected, replacements) {
  if (!Array.isArray(expected) || expected.length === 0 || expected.length !== replacements?.length) {
    throw new Error('ownership replacements require equal nonempty arrays');
  }
  return withLock(stateDir, 'ownership', async () => {
    const manifestPath = path.join(stateDir, 'ownership.json');
    const manifest = await readJsonIfPresent(manifestPath);
    if (!manifest?.brokerUuid || manifest.type !== 'broker') throw new Error('ownership manifest is missing or invalid');
    const updates = expected.map((resource, updateIndex) => {
      const identity = resourceIdentity(resource);
      if (resourceIdentity(replacements[updateIndex]) !== identity) throw new Error('ownership resource identity cannot change during replacement');
      const matches = manifest.resources.map((candidate, index) => ({ resource: candidate, index }))
        .filter(({ resource: candidate }) => isP4Resource(candidate) && resourceIdentity(candidate) === identity);
      if (matches.length !== 1) throw new Error(`exact ownership resource replacement failed: ${identity}`);
      return { ...matches[0], expected: resource, replacement: replacements[updateIndex], identity };
    });
    if (new Set(updates.map(({ index }) => index)).size !== updates.length) throw new Error('ownership replacement identities must be unique');
    const allCurrent = updates.every(({ resource, replacement }) => JSON.stringify(resource) === JSON.stringify(replacement));
    if (allCurrent) return replacements;
    for (const update of updates) {
      if (JSON.stringify(update.resource) !== JSON.stringify(update.expected)) {
        throw new Error(`exact ownership resource replacement failed: ${update.identity}`);
      }
    }
    for (const update of updates) manifest.resources[update.index] = structuredClone(update.replacement);
    await atomicWriteJson(manifestPath, manifest);
    return replacements;
  });
}

function isP4Resource(resource) {
  return Boolean(resource && ['p4-client', 'p4-change', 'p4-shelf'].includes(resource.type));
}

function resourceIdentity(resource) {
  if (!isP4Resource(resource)
    || typeof resource.brokerUuid !== 'string' || typeof resource.nonce !== 'string') {
    throw new Error('resource requires exact type, brokerUuid, and nonce identity');
  }
  return `${resource.type}:${resource.brokerUuid}:${resource.nonce}`;
}

export function makeOwnershipManifest(brokerUuid, stateDir, lower, roots, createdAt) {
  return {
    version: ownershipVersion,
    type: 'broker',
    brokerUuid,
    createdAt,
    stateDir: path.resolve(stateDir),
    lower: path.resolve(lower),
    resources: roots.map((root) => ({
      type: 'projfs-root',
      path: root.path,
      nonce: root.nonce,
      ownership: 'package',
      handedOff: false,
    })),
    objectTypes: {
      filesystem: ['projfs-root', 'private-runtime', 'temp', 'provider-log', 'task-log', 'task-state'],
      perforce: ['p4-client', 'p4-change', 'p4-shelf'],
    },
    handoffRule: 'handedOff=true transfers the object out of package ownership and excludes it from cleanup',
  };
}

function normalizeCanonical(candidate) {
  const normalized = path.normalize(candidate);
  const withoutTrailingSeparators = normalized === path.parse(normalized).root
    ? normalized
    : normalized.replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? withoutTrailingSeparators.toLowerCase() : withoutTrailingSeparators;
}
