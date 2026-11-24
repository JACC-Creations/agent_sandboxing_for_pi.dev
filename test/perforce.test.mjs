import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, test as nodeTest } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  buildSanitizedWorkerEnv,
  checkpoint,
  cleanupResources,
  createP4,
  ensureStableTaskChange,
  findPlannedTaskChange,
  importShelf,
  openPaths,
  parseTaggedOutput,
  planP4ChangeResource,
  planP4ClientResource,
  provisionSlotClient,
  seedExactPaths,
  validateDiscoverBase,
  verifySlotClient,
} from '../src/perforce.mjs';
import { p4WorkerEnvironment, resolveP4Executable } from '../src/perforce-state.mjs';

const fakeScript = fileURLToPath(new URL('./fixtures/fake-p4.mjs', import.meta.url));
const test = (name, callback) => nodeTest(name, { concurrency: true }, callback);
const clientOwnership = Object.freeze({ brokerUuid: 'broker-1234', nonce: 'client-nonce' });
const changeOwnership = Object.freeze({ brokerUuid: 'broker-1234', nonce: 'change-nonce' });
const protectedPaths = Array.from({ length: 5 }, (_, index) => `//Depot/Main/Inherited${index + 1}.cpp`);

async function writeState(registry, state) {
  await fs.writeFile(registry, `${JSON.stringify(state, null, 2)}\n`);
}

async function readState(registry) {
  return JSON.parse(await fs.readFile(registry, 'utf8'));
}

async function setup() {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'fake-p4-test-'));
  const lower = path.join(temporaryRoot, 'lower');
  const projected = path.join(temporaryRoot, 'projected');
  const registry = path.join(temporaryRoot, 'registry.json');
  await fs.mkdir(lower);
  await fs.mkdir(projected);
  await Promise.all(protectedPaths.map((depotFile, index) => fs.writeFile(path.join(lower, path.basename(depotFile)), `protected-${index}\n`)));
  const generated = Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`//Depot/Main/Batch${String(index).padStart(2, '0')}.cpp`, String(index + 100)]));
  const baseHave = {
    ...Object.fromEntries(protectedPaths.map((depotFile, index) => [depotFile, String(index + 10)])),
    '//Depot/Main/Normal.cpp': '42', '//Depot/Main/Other.cpp': '7', '//Depot/Main/Delete.cpp': '8', '//Depot/Main/Integrate.cpp': '9',
    '//Depot/Main/name;$(unsafe).cpp': '11', ...generated,
  };
  await writeState(registry, {
    clients: {
      base: {
        Client: 'base', Root: lower, Stream: '//Depot/Main', Options: 'noallwrite noclobber nocompress unlocked nomodtime rmdir',
        SubmitOptions: 'revertunchanged', Host: 'BUILDHOST', ServerID: 'edge-1', Type: 'writeable', LineEnd: 'local', Description: 'human base',
      },
    },
    have: { base: baseHave },
    opened: protectedPaths.map((depotFile) => ({ client: 'base', depotFile, action: 'edit', change: '8123' })),
    changes: {},
    shelves: {
      900: [
        { depotFile: '//Depot/Main/Other.cpp', action: 'edit', rev: '8' },
        { depotFile: '//Depot/Main/New.cpp', action: 'add', rev: '1' },
        { depotFile: '//Depot/Main/Delete.cpp', action: 'delete', rev: '8' },
        { depotFile: '//Depot/Main/Integrate.cpp', action: 'integrate', rev: '9' },
      ],
    },
    nextChange: 1000, faults: {}, log: [],
  });
  const p4 = createP4({
    testMode: true, fakeScript,
    env: { FAKE_P4_REGISTRY: registry, p4passwd: 'must-not-reach-child', P4Trust: 'also-secret' },
    P4PORT: 'ssl:perforce.example:1666', P4USER: 'agent', timeoutMs: 5_000,
  });
  return { temporaryRoot, lower, projected, registry, p4 };
}

async function dispose(context) {
  await fs.rm(context.temporaryRoot, { recursive: true, force: true });
}

async function discover(context) {
  return validateDiscoverBase(context.p4, { baseClient: 'base', expectedLowerRoot: context.lower });
}

async function provision(context, baseline) {
  baseline ??= await discover(context);
  const plannedResource = planP4ClientResource({ client: 'worker-1', projectedRoot: context.projected, slot: 1, ownership: clientOwnership });
  const clientResource = await provisionSlotClient(context.p4, {
    baseline, client: 'worker-1', projectedRoot: context.projected, slot: 1, plannedResource,
  });
  return { baseline, clientResource };
}

async function stableChange(context) {
  const plannedResource = planP4ChangeResource({ client: 'worker-1', taskId: 'task-1', user: 'agent', ownership: changeOwnership });
  const changeResource = await ensureStableTaskChange(context.p4, {
    client: 'worker-1', taskId: 'task-1', user: 'agent', plannedResource,
  });
  return { plannedResource, changeResource };
}

describe('Perforce core', { concurrency: true }, () => {
test('tagged parsing supports normal repeated records', () => {
  assert.deepEqual(parseTaggedOutput('... depotFile //A\n... haveRev 1\n... depotFile //B\n... haveRev 2\n'), [
    { depotFile: '//A', haveRev: '1' }, { depotFile: '//B', haveRev: '2' },
  ]);
});

test('tagged parsing preserves untagged multiline form continuations', () => {
  assert.deepEqual(parseTaggedOutput('... Client worker\n... Description AgentWorkspace-Owned: true\nAgentWorkspace-Broker: broker-id\nAgentWorkspace-Nonce: nonce\n\n'), [{
    Client: 'worker',
    Description: 'AgentWorkspace-Owned: true\nAgentWorkspace-Broker: broker-id\nAgentWorkspace-Nonce: nonce',
  }]);
});

test('creation requires exact caller-predeclared resources before any server mutation', async () => {
  const context = await setup();
  try {
    const baseline = await discover(context);
    await assert.rejects(provisionSlotClient(context.p4, {
      baseline, client: 'worker-1', projectedRoot: context.projected, slot: 1,
    }), /durably predeclared p4-client/);
    let state = await readState(context.registry);
    assert.equal(state.log.some((entry) => entry.command === 'client' && entry.args[0] === '-i'), false);
    state.faults.client = { times: 1, afterCreate: true, error: 'connection dropped after create' };
    await writeState(context.registry, state);
    await provision(context, baseline);
    await assert.rejects(ensureStableTaskChange(context.p4, {
      client: 'worker-1', taskId: 'task-1', user: 'agent',
    }), /durably predeclared p4-change/);
    state = await readState(context.registry);
    assert.equal(state.log.some((entry) => entry.command === 'change' && entry.args[0] === '-i'), false);
  } finally {
    await dispose(context);
  }
});

test('client existence uses exact clients -e, clones SubmitOptions, and verifies ownership', async () => {
  const context = await setup();
  try {
    const { clientResource } = await provision(context);
    const state = await readState(context.registry);
    assert.equal(state.clients['worker-1'].SubmitOptions, 'revertunchanged');
    assert.match(state.clients['worker-1'].Description, /AgentWorkspace-Nonce: client-nonce/);
    assert.ok(state.log.some((entry) => entry.command === 'clients' && entry.args.join(' ') === '-e worker-1'));
    assert.equal(clientResource.nonce, 'client-nonce');
    await verifySlotClient(context.p4, { client: 'worker-1', projectedRoot: context.projected, slot: 1, ownership: clientResource });
  } finally {
    await dispose(context);
  }
});

test('Perforce executable resolution persists an absolute existing file and no-P4 environments add no undefined entries', async () => {
  assert.equal(await resolveP4Executable(process.execPath), process.execPath);
  assert.equal(await resolveP4Executable(path.basename(process.execPath), {
    PATH: path.dirname(process.execPath), PATHEXT: process.env.PATHEXT,
  }), process.execPath);
  await assert.rejects(resolveP4Executable(path.join('missing-tools', 'p4.exe')), /not a file/);
  const base = { PATH: 'safe' };
  assert.deepEqual(p4WorkerEnvironment({ p4: null }, { p4: null }, base), base);
  assert.deepEqual(Object.entries(p4WorkerEnvironment({ p4: null }, { p4: null }, base)).filter(([, value]) => value === undefined), []);
});

test('createP4 and worker environments strip credential names case-insensitively', async () => {
  const context = await setup();
  try {
    await discover(context);
    const state = await readState(context.registry);
    assert.deepEqual(state.log[0].secretEnvKeys, []);
    const env = buildSanitizedWorkerEnv(
      { PATH: 'safe', P4PASSWD: 'secret', p4tickets: 'ticket', P4Config: '.p4config', p4EDITOR: 'evil' },
      { P4CLIENT: 'worker-1', P4PORT: 'ssl:server:1666', P4USER: 'agent', P4CHARSET: 'utf8' },
    );
    assert.deepEqual(env, { PATH: 'safe', P4CLIENT: 'worker-1', P4PORT: 'ssl:server:1666', P4USER: 'agent', P4CHARSET: 'utf8', P4EDITOR: '' });
  } finally {
    await dispose(context);
  }
});

test('validated baseline is mandatory for open, import, seed, and checkpoint APIs', async () => {
  const context = await setup();
  try {
    await assert.rejects(seedExactPaths(context.p4, { workerClient: 'worker-1', depotPaths: [] }), /validated protected baseline/);
    await assert.rejects(openPaths(context.p4, { action: 'add', workerClient: 'worker-1', depotPaths: [] }), /validated protected baseline/);
    await assert.rejects(importShelf(context.p4, { workerClient: 'worker-1', shelf: 900, change: 1 }), /validated protected baseline/);
    await assert.rejects(checkpoint(context.p4, { client: 'worker-1', change: 1 }), /validated protected baseline/);
  } finally {
    await dispose(context);
  }
});

test('lazy seeding batches explicit paths, uses one have query per batch, and exactly verifies every revision', async () => {
  const context = await setup();
  try {
    const { baseline } = await provision(context);
    const paths = Array.from({ length: 40 }, (_, index) => `//Depot/Main/Batch${String(index).padStart(2, '0')}.cpp`);
    const revisions = await seedExactPaths(context.p4, { baseline, workerClient: 'worker-1', depotPaths: paths, maxBatchArgumentBytes: 300 });
    assert.equal(revisions.length, 40);
    let state = await readState(context.registry);
    const baseQueries = state.log.filter((entry) => entry.command === 'have' && entry.selectedClient === 'base'
      && entry.args.some((value) => value.startsWith('//Depot/Main/Batch')));
    const workerQueries = state.log.filter((entry) => entry.command === 'have' && entry.selectedClient === 'worker-1'
      && entry.args.some((value) => value.startsWith('//Depot/Main/Batch')));
    assert.ok(baseQueries.length > 1 && baseQueries.length < paths.length);
    assert.equal(workerQueries.length, baseQueries.length);
    assert.ok(state.log.filter((entry) => entry.command === 'sync').length > 1);
    assert.deepEqual(Object.keys(state.have['worker-1']).sort(), paths);
    state.faults.wrongSyncPath = paths.at(-1);
    await writeState(context.registry, state);
    await assert.rejects(seedExactPaths(context.p4, { baseline, workerClient: 'worker-1', depotPaths: [paths.at(-1)] }), /worker have verification failed/);
  } finally {
    await dispose(context);
  }
});

test('argv-only execution preserves hostile depot syntax as one argument', async () => {
  const context = await setup();
  try {
    const { baseline } = await provision(context);
    const hostile = '//Depot/Main/name;$(unsafe).cpp';
    await seedExactPaths(context.p4, { baseline, workerClient: 'worker-1', depotPaths: [hostile] });
    const state = await readState(context.registry);
    const sync = state.log.find((entry) => entry.command === 'sync');
    assert.equal(sync.argv.filter((argument) => argument.includes('unsafe')).length, 1);
    assert.ok(sync.argv.includes(`${hostile}#11`));
  } finally {
    await dispose(context);
  }
});

test('real indexed shelf fields seed only actions requiring base have and protect every action', async () => {
  const context = await setup();
  try {
    const { baseline } = await provision(context);
    const { changeResource } = await stableChange(context);
    const imported = await importShelf(context.p4, { baseline, workerClient: 'worker-1', shelf: 900, change: changeResource.change });
    assert.equal(imported.files.length, 4);
    const state = await readState(context.registry);
    assert.equal(state.have['worker-1']['//Depot/Main/New.cpp'], undefined);
    assert.equal(state.have['worker-1']['//Depot/Main/Other.cpp'], '7');
    assert.equal(state.have['worker-1']['//Depot/Main/Delete.cpp'], '8');
    assert.equal(state.have['worker-1']['//Depot/Main/Integrate.cpp'], '9');
    assert.ok(state.log.find((entry) => entry.command === 'describe').args.includes('-S'));

    state.shelves[901] = [{ depotFile: protectedPaths[0], action: 'add' }];
    await writeState(context.registry, state);
    await assert.rejects(importShelf(context.p4, { baseline, workerClient: 'worker-1', shelf: 901, change: changeResource.change }), /unshelve rejects inherited protected/);
  } finally {
    await dispose(context);
  }
});

test('fake unshelve rejects destination conflicts without replacing the existing open', async () => {
  const context = await setup();
  try {
    const { baseline } = await provision(context);
    const { changeResource } = await stableChange(context);
    let state = await readState(context.registry);
    state.opened.push({ client: 'worker-1', depotFile: '//Depot/Main/Other.cpp', action: 'edit', change: changeResource.change });
    await writeState(context.registry, state);
    await assert.rejects(importShelf(context.p4, { baseline, workerClient: 'worker-1', shelf: 900, change: changeResource.change }), /already opened/);
    state = await readState(context.registry);
    assert.equal(state.opened.filter((entry) => entry.client === 'worker-1' && entry.depotFile === '//Depot/Main/Other.cpp').length, 1);
  } finally {
    await dispose(context);
  }
});

test('unknown create outcome is reconciled by exact planned nonce without duplicates', async () => {
  const context = await setup();
  try {
    const { clientResource } = await provision(context);
    let state = await readState(context.registry);
    state.faults.change = { times: 1, afterCreate: true, error: 'connection dropped after create' };
    await writeState(context.registry, state);
    const plannedResource = planP4ChangeResource({ client: 'worker-1', taskId: 'task-1', user: 'agent', ownership: changeOwnership });
    const first = await ensureStableTaskChange(context.p4, { client: 'worker-1', taskId: 'task-1', user: 'agent', plannedResource });
    const found = await findPlannedTaskChange(context.p4, { plannedResource });
    const second = await ensureStableTaskChange(context.p4, { client: 'worker-1', taskId: 'task-1', user: 'agent', plannedResource });
    assert.equal(first.change, found.change);
    assert.equal(second.change, first.change);
    state = await readState(context.registry);
    assert.equal(Object.keys(state.changes).length, 1);
    assert.equal(state.log.filter((entry) => entry.command === 'change' && entry.args[0] === '-i').length, 1);
    await cleanupResources(context.p4, { resources: [clientResource, plannedResource], workersStopped: true });
    state = await readState(context.registry);
    assert.equal(Object.keys(state.changes).length, 0);
  } finally {
    await dispose(context);
  }
});

test('stable change recovery verifies client, user, pending status, and exact markers', async () => {
  const context = await setup();
  try {
    await provision(context);
    const { plannedResource, changeResource } = await stableChange(context);
    const state = await readState(context.registry);
    state.changes[changeResource.change].User = 'attacker';
    await writeState(context.registry, state);
    await assert.rejects(findPlannedTaskChange(context.p4, { plannedResource }), /client, user, or pending status mismatch/);
  } finally {
    await dispose(context);
  }
});

test('checkpoint handles no changes, first shelf, and replacement while returning exact shelf ownership', async () => {
  const context = await setup();
  try {
    const { baseline } = await provision(context);
    const { changeResource } = await stableChange(context);
    const empty = await checkpoint(context.p4, { baseline, client: 'worker-1', change: changeResource.change, changeResource });
    assert.deepEqual(empty, { state: 'no_changes', change: changeResource.change, opened: [] });
    let state = await readState(context.registry);
    assert.equal(state.log.some((entry) => entry.command === 'shelve'), false);

    await openPaths(context.p4, { baseline, action: 'edit', workerClient: 'worker-1', depotPaths: ['//Depot/Main/Normal.cpp'], change: changeResource.change });
    const first = await checkpoint(context.p4, { baseline, client: 'worker-1', change: changeResource.change, changeResource });
    assert.equal(first.state, 'shelved');
    assert.equal(first.replaced, false);
    assert.equal(first.shelfResource.nonce, changeOwnership.nonce);
    assert.equal(first.shelfResource.change, changeResource.change);
    const replacement = await checkpoint(context.p4, { baseline, client: 'worker-1', change: changeResource.change, changeResource });
    assert.equal(replacement.replaced, true);
    state = await readState(context.registry);
    state.opened = state.opened.filter((entry) => entry.client !== 'worker-1');
    await writeState(context.registry, state);
    const retained = await checkpoint(context.p4, { baseline, client: 'worker-1', change: changeResource.change, changeResource });
    assert.equal(retained.state, 'shelf_retained');
    assert.equal(retained.shelfResource.change, changeResource.change);
    state = await readState(context.registry);
    const shelves = state.log.filter((entry) => entry.command === 'shelve');
    assert.equal(shelves[0].args.includes('-r'), false);
    assert.equal(shelves[1].args.includes('-r'), true);
  } finally {
    await dispose(context);
  }
});

test('protected baseline is rejected for add, edit, delete, import, and checkpoint by default', async () => {
  const context = await setup();
  try {
    const { baseline } = await provision(context);
    const { changeResource } = await stableChange(context);
    for (const action of ['add', 'edit', 'delete']) {
      await assert.rejects(openPaths(context.p4, { baseline, action, workerClient: 'worker-1', depotPaths: [protectedPaths[0]] }), /open rejects inherited protected/);
    }
    const state = await readState(context.registry);
    state.opened.push({ client: 'worker-1', depotFile: protectedPaths[0], action: 'edit', change: changeResource.change });
    await writeState(context.registry, state);
    await assert.rejects(checkpoint(context.p4, { baseline, client: 'worker-1', change: changeResource.change, changeResource }), /checkpoint rejects inherited protected/);
  } finally {
    await dispose(context);
  }
});

test('cleanup requires a fence, verifies resource-specific ownership and shelf ledger, uses exact client scope, and is idempotent', async () => {
  const context = await setup();
  try {
    const { baseline, clientResource } = await provision(context);
    const { changeResource } = await stableChange(context);
    await openPaths(context.p4, { baseline, action: 'edit', workerClient: 'worker-1', depotPaths: ['//Depot/Main/Normal.cpp'], change: changeResource.change });
    const artifact = await checkpoint(context.p4, { baseline, client: 'worker-1', change: changeResource.change, changeResource });
    const resources = [clientResource, changeResource, artifact.shelfResource];
    await assert.rejects(cleanupResources(context.p4, { resources }), /workersStopped/);
    await assert.rejects(cleanupResources(context.p4, { resources: [clientResource, changeResource], workersStopped: true }), /p4-shelf ledger/);
    const first = await cleanupResources(context.p4, { resources, workersStopped: true });
    assert.deepEqual(first, { cleaned: true, idempotent: false });
    let state = await readState(context.registry);
    const revert = state.log.find((entry) => entry.command === 'revert');
    assert.equal(revert.args.at(-1), '//worker-1/...');
    assert.equal(revert.args.some((argument) => argument === '-f'), false);
    const destructive = state.log.filter((entry) => ['revert', 'shelve', 'change', 'client'].includes(entry.command));
    assert.equal(destructive.some((entry) => entry.args.includes('-f')), false);
    assert.equal(state.clients['worker-1'], undefined);
    assert.equal(state.changes[changeResource.change], undefined);
    const second = await cleanupResources(context.p4, { resources, workersStopped: true });
    assert.deepEqual(second, { cleaned: true, idempotent: true });
  } finally {
    await dispose(context);
  }
});

test('cleanup rejects per-resource ownership tampering and unrecorded opens', async () => {
  const context = await setup();
  try {
    const { clientResource } = await provision(context);
    const { changeResource } = await stableChange(context);
    let state = await readState(context.registry);
    state.clients['worker-1'].Description = state.clients['worker-1'].Description.replace('client-nonce', 'foreign');
    await writeState(context.registry, state);
    await assert.rejects(cleanupResources(context.p4, { resources: [clientResource, changeResource], workersStopped: true }), /ownership verification failed/);

    state = await readState(context.registry);
    state.clients['worker-1'].Description = state.clients['worker-1'].Description.replace('foreign', 'client-nonce');
    state.opened.push({ client: 'worker-1', depotFile: '//Depot/Main/Normal.cpp', action: 'edit', change: 'default' });
    await writeState(context.registry, state);
    await assert.rejects(cleanupResources(context.p4, { resources: [clientResource, changeResource], workersStopped: true }), /unrecorded opens/);
  } finally {
    await dispose(context);
  }
});
});
