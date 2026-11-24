import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { cleanup as cleanupFixture, run, waitFor } from './broker-fixture.mjs';

export const fakeP4 = fileURLToPath(new URL('../fixtures/fake-p4.mjs', import.meta.url));
export const fakeProvider = fileURLToPath(new URL('../fixtures/fake-projfs-provider.mjs', import.meta.url));
export const environmentFixture = fileURLToPath(new URL('../fixtures/p4-environment.mjs', import.meta.url));
export const protectedPath = '//Depot/Main/Protected.cpp';
export const normalPath = '//Depot/Main/Normal.cpp';

export async function setup(slotCount = 2, faults = {}) {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'p4-integration-'));
  const lower = path.join(temporaryRoot, 'lower');
  const rootParent = path.join(temporaryRoot, 'roots');
  const stateDir = path.join(temporaryRoot, 'state');
  const registry = path.join(temporaryRoot, 'p4.json');
  await fs.mkdir(lower);
  await fs.writeFile(path.join(lower, path.basename(protectedPath)), 'protected baseline bytes\n');
  await fs.writeFile(registry, `${JSON.stringify({
    user: 'agent',
    clients: { base: { Client: 'base', Root: lower, Stream: '//Depot/Main', Options: 'noallwrite noclobber nocompress unlocked nomodtime rmdir', SubmitOptions: 'revertunchanged', LineEnd: 'local', Description: 'base' } },
    have: { base: { [protectedPath]: '10', [normalPath]: '42' } },
    opened: [{ client: 'base', depotFile: protectedPath, action: 'edit', change: '8123' }],
    changes: {}, shelves: {}, nextChange: 1000, faults, log: [],
  }, null, 2)}\n`);
  const initArgs = [
    'init', '--state-dir', stateDir, '--workspace', lower, '--max-slots', String(slotCount),
    '--adapter', 'projfs', '--test-mode', '--poll-ms', '25', '--provider-exe', fakeProvider,
    '--root-parent', rootParent, '--provider-ready-timeout-ms', '500',
    '--p4-exe', fakeP4, '--p4-base-client', 'base', '--p4-port', 'fake:1666', '--p4-user', 'agent',
    '--p4-charset', 'utf8', '--p4-fake-registry', registry,
  ];
  return { temporaryRoot, lower, rootParent, stateDir, registry, initArgs };
}

export async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

export async function dispose(context) {
  if (await fs.access(context.stateDir).then(() => true, () => false)) await cleanupFixture(context).catch(() => {});
  await fs.rm(context.temporaryRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  await fs.rm(`${context.stateDir}.cleanup-journal.json`, { force: true });
  await fs.rm(`${context.stateDir}.cleanup-receipt.json`, { force: true });
}


export { assert, fs, path, run, test, waitFor };
