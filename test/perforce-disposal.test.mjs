import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createP4 } from '../src/perforce.mjs';
import { disposeAgentWorkspaceP4Handoff } from '../src/api.mjs';
import { disposeP4Review, disposeP4ReviewWithLegacyAdoption } from '../src/review-disposal.mjs';

const fakeP4 = fileURLToPath(new URL('./fixtures/fake-p4.mjs', import.meta.url));
const brokerUuid = '12345678-1234-4234-9234-123456789abc';
const taskId = '20261124112233-abcdef123456';
const transaction = '0123456789abcdef0123456789abcdef';

function description(extra) {
  return [
    'AgentWorkspace-Owned: true',
    `AgentWorkspace-Broker: ${brokerUuid}`,
    `AgentWorkspace-Nonce: ${transaction}`,
    `AgentWorkspace-Task: ${taskId}`,
    'AgentWorkspace-Client: review-client',
    extra,
  ].join('\n');
}

async function setup(overrides = {}) {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'review-disposal-'));
  const stateDir = path.join(temporaryRoot, 'state');
  const registryPath = path.join(temporaryRoot, 'p4.json');
  const root = path.join(temporaryRoot, 'former-projected-root');
  const resources = [
    {
      type: 'p4-client', client: 'review-client', taskId, user: 'agent', root, slot: `handoff:${taskId}`,
      brokerUuid, nonce: transaction, handedOff: true, handoffTransaction: transaction,
    },
    {
      type: 'p4-change', client: 'review-client', change: '1000', taskId, user: 'agent',
      brokerUuid, nonce: transaction, handedOff: true, handoffTransaction: transaction,
    },
    {
      type: 'p4-shelf', client: 'review-client', change: '1000', taskId, user: 'agent',
      brokerUuid, nonce: transaction, handedOff: true, handoffTransaction: transaction,
    },
  ];
  const identity = {
    serverAddress: 'fake:1666',
    serverRoot: '/fake/server/root',
    serverServices: 'standard',
    serverID: 'fake-server-id',
    caseHandling: 'sensitive',
    unicode: 'enabled',
  };
  const receipt = {
    version: 2,
    state: 'completed',
    brokerUuid,
    stateDir: path.resolve(stateDir),
    completedAt: '2026-11-24T12:00:00.000Z',
    removed: [{ type: 'broker-private-state', path: stateDir }],
    handoffExclusions: resources,
    nativeSupervisor: false,
    ownedJobs: [],
    p4Reconnect: {
      version: 1,
      executable: process.execPath,
      port: 'fake:1666',
      user: overrides.p4User ?? 'agent',
      serverFingerprint: crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex'),
      testMode: true,
      fakeScript: fakeP4,
      fakeRegistry: registryPath,
    },
  };
  const registry = {
    user: 'agent',
    clients: {
      'review-client': {
        Client: 'review-client', Root: root, Owner: 'agent',
        Description: description('AgentWorkspace-Resource: review-handoff'),
      },
    },
    have: { 'review-client': {} },
    opened: [],
    changes: {
      1000: {
        Change: '1000', Client: 'review-client', User: 'agent', Status: 'pending',
        Description: description('AgentWorkspace-Change: review-handoff'),
      },
    },
    shelves: {
      1000: [{ depotFile: '//Depot/Main/Review.cpp', action: 'edit', rev: '7', type: 'text' }],
    },
    nextChange: 1001,
    faults: {},
    log: [],
  };
  overrides.receipt?.(receipt);
  overrides.registry?.(registry);
  await fs.writeFile(`${stateDir}.cleanup-receipt.json`, overrides.rawReceipt ?? `${JSON.stringify(receipt, null, 2)}\n`);
  await fs.writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
  const p4 = createP4({
    testMode: true,
    fakeScript: fakeP4,
    env: { FAKE_P4_REGISTRY: registryPath, ...(overrides.env ?? {}) },
    P4PORT: 'fake:1666',
    P4USER: overrides.p4User ?? 'agent',
    preserveAmbientCredentials: overrides.preserveAmbientCredentials,
  });
  return {
    temporaryRoot, stateDir, registryPath, receipt, resources, p4,
    options: { stateDir, expectedBrokerUuid: brokerUuid, taskId },
  };
}

async function dispose(context) {
  await fs.rm(context.temporaryRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  await fs.rm(`${context.stateDir}.lifecycle`, { recursive: true, force: true });
}

async function registry(context) {
  return JSON.parse(await fs.readFile(context.registryPath, 'utf8'));
}

function destructiveCommands(value) {
  return value.log.filter((entry) => (entry.command === 'shelve' || entry.command === 'change' || entry.command === 'client') && entry.args[0] === '-d')
    .map((entry) => entry.command);
}

async function withAmbientP4Environment(values, callback) {
  const names = ['P4EXE', 'P4PORT', 'P4CHARSET', 'P4TICKETS', 'P4TRUST'];
  const prior = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  for (const name of names) delete process.env[name];
  Object.assign(process.env, { P4EXE: process.execPath, ...values });
  try {
    return await callback();
  } finally {
    for (const [name, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
}

test('strict receipt validation and absent broker state are checked before Perforce', async () => {
  const cases = [
    { receipt: (value) => { value.version = 3; } },
    { receipt: (value) => { value.stateDir = `${value.stateDir}-other`; } },
    { receipt: (value) => { value.handoffExclusions.push(structuredClone(value.handoffExclusions[0])); } },
    { receipt: (value) => { value.handoffExclusions[2].change = '2000'; } },
    { receipt: (value) => { value.handoffExclusions[0].nonce = 'f'.repeat(32); } },
  ];
  for (const mutations of cases) {
    const context = await setup(mutations);
    try {
      let calls = 0;
      await assert.rejects(disposeP4Review(context.options, { createBoundP4: () => ({ run: async () => { calls += 1; } }) }));
      assert.equal(calls, 0);
    } finally {
      await dispose(context);
    }
  }

  const context = await setup();
  try {
    await fs.mkdir(context.stateDir);
    let calls = 0;
    await assert.rejects(disposeP4Review(context.options, { createBoundP4: () => ({ run: async () => { calls += 1; } }) }), /broker_state_present/);
    assert.equal(calls, 0);
  } finally {
    await dispose(context);
  }
});

test('missing receipt with absent state directory fails without Perforce or recreating state', async () => {
  const context = await setup();
  try {
    await fs.unlink(`${context.stateDir}.cleanup-receipt.json`);
    let calls = 0;
    await assert.rejects(disposeP4Review(context.options, { createBoundP4: () => ({ run: async () => { calls += 1; } }) }), /invalid_receipt/);
    assert.equal(calls, 0);
    assert.equal(await fs.access(context.stateDir).then(() => true, () => false), false);
  } finally {
    await dispose(context);
  }
});

test('preflight rejects wrong identity, receipt tampering, empty shelf, opens, and unrelated pending changes', async () => {
  const cases = [
    { p4User: 'other' },
    { registry: (value) => { value.clients['review-client'].Root += '-wrong'; } },
    { registry: (value) => { value.clients['review-client'].Owner = 'other'; } },
    { registry: (value) => { value.changes[1000].Description = 'foreign'; } },
    { registry: (value) => { delete value.shelves[1000]; } },
    { registry: (value) => { value.opened.push({ client: 'review-client', depotFile: '//Depot/X', action: 'edit', change: '1000' }); } },
    { registry: (value) => { value.changes[1001] = { Change: '1001', Client: 'review-client', User: 'agent', Status: 'pending', Description: 'unrelated' }; } },
  ];
  for (const mutations of cases) {
    const context = await setup(mutations);
    try {
      await assert.rejects(disposeP4Review(context.options, { createBoundP4: () => context.p4 }), /live_verification_failed/);
      assert.deepEqual(destructiveCommands(await registry(context)), []);
    } finally {
      await dispose(context);
    }
  }
});

test('successful disposal writes intents and deletes shelf, change, then client', async () => {
  const context = await setup();
  try {
    const result = await disposeP4Review(context.options, { createBoundP4: () => context.p4 });
    assert.deepEqual(result, { state: 'completed', taskId, idempotent: false });
    const value = await registry(context);
    assert.deepEqual(destructiveCommands(value), ['shelve', 'change', 'client']);
    assert.deepEqual(value.clients, {});
    assert.deepEqual(value.changes, {});
    assert.deepEqual(value.shelves, {});
    const journal = JSON.parse(await fs.readFile(`${context.stateDir}.review-disposal-${transaction}.json`, 'utf8'));
    assert.equal(journal.state, 'completed');
    for (const phase of ['shelf', 'change', 'client']) {
      assert.equal(typeof journal.phases[phase].intentAt, 'string');
      assert.equal(typeof journal.phases[phase].completedAt, 'string');
    }
    assert.equal(await fs.access(context.stateDir).then(() => true, () => false), false);
  } finally {
    await dispose(context);
  }
});

test('every intent boundary is crash recoverable and completed disposal is idempotent', async () => {
  for (const faultPhase of ['shelf', 'change', 'client']) {
    const context = await setup();
    try {
      const thrown = new Set();
      await assert.rejects(disposeP4Review(context.options, {
        createBoundP4: () => context.p4,
        afterIntent(phase) {
          if (phase === faultPhase && !thrown.has(phase)) {
            thrown.add(phase);
            throw new Error('simulated crash');
          }
        },
      }), /internal_failure/);
      const recovered = await disposeP4Review(context.options, { createBoundP4: () => context.p4 });
      assert.equal(recovered.state, 'completed');
      const repeated = await disposeP4Review(context.options, { createBoundP4: () => ({ run: async () => { throw new Error('must not run'); } }) });
      assert.deepEqual(repeated, { state: 'completed', taskId, idempotent: true });
      assert.deepEqual(destructiveCommands(await registry(context)), ['shelve', 'change', 'client']);
    } finally {
      await dispose(context);
    }
  }
});

test('lost responses at every mutation boundary are reconciled only after durable intent', async () => {
  const context = await setup({
    registry: (value) => {
      for (const command of ['shelve', 'change', 'client']) {
        value.faults[command] = { times: 1, args0: '-d', afterMutation: true, error: 'private server output' };
      }
    },
  });
  try {
    const result = await disposeP4Review(context.options, { createBoundP4: () => context.p4 });
    assert.equal(result.state, 'completed');
    assert.deepEqual(destructiveCommands(await registry(context)), ['shelve', 'change', 'client']);
  } finally {
    await dispose(context);
  }
});

test('receipt byte tampering after an intent is rejected before further Perforce operations', async () => {
  const context = await setup();
  try {
    await assert.rejects(disposeP4Review(context.options, {
      createBoundP4: () => context.p4,
      afterIntent(phase) {
        if (phase === 'shelf') throw new Error('stop');
      },
    }), /internal_failure/);
    const before = (await registry(context)).log.length;
    await fs.appendFile(`${context.stateDir}.cleanup-receipt.json`, ' ');
    await assert.rejects(disposeP4Review(context.options, { createBoundP4: () => context.p4 }), /invalid_journal/);
    assert.equal((await registry(context)).log.length, before);
  } finally {
    await dispose(context);
  }
});

test('concurrent disposal is serialized by the lifecycle lock', async () => {
  const context = await setup();
  try {
    let released;
    const gate = new Promise((resolve) => { released = resolve; });
    let entered;
    const firstEntered = new Promise((resolve) => { entered = resolve; });
    const first = disposeP4Review(context.options, {
      createBoundP4: () => context.p4,
      async afterIntent(phase) {
        if (phase === 'shelf') {
          entered();
          await gate;
        }
      },
    });
    await firstEntered;
    const second = disposeP4Review(context.options, { createBoundP4: () => context.p4 });
    released();
    const results = await Promise.all([first, second]);
    assert.deepEqual(results.map((result) => result.idempotent), [false, true]);
    assert.deepEqual(destructiveCommands(await registry(context)), ['shelve', 'change', 'client']);
  } finally {
    await dispose(context);
  }
});

test('production factory rejects a changed server fingerprint and absent executable before mutation', async () => {
  for (const mutation of [
    { registry: (value) => { value.serverID = 'other-server'; } },
    { receipt: (value) => {
      value.p4Reconnect.testMode = undefined;
      value.p4Reconnect.fakeScript = undefined;
      value.p4Reconnect.fakeRegistry = undefined;
      value.p4Reconnect.executable = path.join(path.dirname(value.stateDir), 'missing-p4.exe');
    } },
  ]) {
    const context = await setup(mutation);
    try {
      await assert.rejects(disposeP4Review(context.options), /endpoint_verification_failed/);
      assert.deepEqual(destructiveCommands(await registry(context)), []);
      await assert.rejects(fs.access(`${context.stateDir}.review-disposal-${transaction}.json`), { code: 'ENOENT' });
    } finally {
      await dispose(context);
    }
  }
});

test('public disposal refuses an unbound legacy receipt without binding or Perforce calls', async () => {
  const context = await setup({ receipt: (value) => { value.version = 1; delete value.p4Reconnect; } });
  try {
    const before = (await registry(context)).log.length;
    await assert.rejects(disposeAgentWorkspaceP4Handoff({
      stateDir: context.stateDir,
      brokerUuid,
      taskId,
    }), /legacy_adoption_required/);
    assert.equal((await registry(context)).log.length, before);
    await assert.rejects(fs.access(`${context.stateDir}.review-disposal-${transaction}.binding.json`), { code: 'ENOENT' });
  } finally {
    await dispose(context);
  }
});

test('production legacy adoption resolves the imported ambient executable path before Perforce access', async () => {
  const context = await setup({ receipt: (value) => { value.version = 1; delete value.p4Reconnect; } });
  const prior = process.env.P4EXE;
  process.env.P4EXE = path.join(context.temporaryRoot, 'missing-production-p4.exe');
  try {
    await assert.rejects(disposeP4ReviewWithLegacyAdoption(context.options), /p4_executable_unavailable/);
    assert.deepEqual(destructiveCommands(await registry(context)), []);
    await assert.rejects(fs.access(`${context.stateDir}.review-disposal-${transaction}.binding.json`), { code: 'ENOENT' });
  } finally {
    if (prior === undefined) delete process.env.P4EXE; else process.env.P4EXE = prior;
    await dispose(context);
  }
});

test('legacy adoption verifies the controlled endpoint and exact resources before binding', async () => {
  const context = await setup({ receipt: (value) => { value.version = 1; delete value.p4Reconnect; } });
  const profile = {
    ...context.receipt.p4Reconnect,
    version: 1,
    executable: process.execPath,
    port: 'fake:1666',
    user: 'agent',
    serverFingerprint: crypto.createHash('sha256').update(JSON.stringify({
      serverAddress: 'fake:1666', serverRoot: '/fake/server/root', serverServices: 'standard',
      serverID: 'fake-server-id', caseHandling: 'sensitive', unicode: 'enabled',
    })).digest('hex'),
    testMode: true,
    fakeScript: fakeP4,
    fakeRegistry: context.registryPath,
  };
  try {
    await assert.rejects(disposeP4ReviewWithLegacyAdoption(context.options, {
      createAmbientP4: () => context.p4,
      legacyProfile: profile,
      createBoundP4: () => { throw new Error('controlled adapter unavailable'); },
    }), /internal_failure/);
    await assert.rejects(fs.access(`${context.stateDir}.review-disposal-${transaction}.binding.json`), { code: 'ENOENT' });
    assert.deepEqual(destructiveCommands(await registry(context)), []);
  } finally {
    await dispose(context);
  }
});

test('approved legacy adoption durably binds then retries only through the controlled profile', async () => {
  const context = await setup({ receipt: (value) => { value.version = 1; delete value.p4Reconnect; } });
  const profile = {
    version: 1,
    executable: process.execPath,
    port: 'fake:1666',
    user: 'agent',
    serverFingerprint: crypto.createHash('sha256').update(JSON.stringify({
      serverAddress: 'fake:1666', serverRoot: '/fake/server/root', serverServices: 'standard',
      serverID: 'fake-server-id', caseHandling: 'sensitive', unicode: 'enabled',
    })).digest('hex'),
    testMode: true,
    fakeScript: fakeP4,
    fakeRegistry: context.registryPath,
  };
  try {
    await assert.rejects(disposeP4ReviewWithLegacyAdoption(context.options, {
      createAmbientP4: () => context.p4,
      legacyProfile: profile,
      afterIntent(phase) { if (phase === 'shelf') throw new Error('simulated crash'); },
    }), /internal_failure/);
    const bindingPath = `${context.stateDir}.review-disposal-${transaction}.binding.json`;
    const adopted = JSON.parse(await fs.readFile(bindingPath, 'utf8'));
    assert.equal(adopted.transaction, transaction);
    assert.equal(adopted.profile.serverFingerprint, profile.serverFingerprint);
    const result = await disposeP4Review(context.options);
    assert.equal(result.state, 'completed');
    assert.deepEqual(destructiveCommands(await registry(context)), ['shelve', 'change', 'client']);
  } finally {
    await dispose(context);
  }
});

test('legacy adoption uses effective settings rather than the opaque info server address', async () => {
  const ticketFile = path.join(os.tmpdir(), 'effective-p4-tickets.txt');
  const trustFile = path.join(os.tmpdir(), 'effective-p4-trust.txt');
  const context = await setup({
    receipt: (value) => { value.version = 1; delete value.p4Reconnect; },
    registry: (value) => {
      value.serverAddress = 'perforce-node.internal.example:1666';
      value.settings = {
        P4PORT: 'perforce-edge.example.com:1666',
        P4CHARSET: 'utf8',
        P4TICKETS: ticketFile,
        P4TRUST: trustFile,
      };
    },
  });
  const controlledProfiles = [];
  try {
    await withAmbientP4Environment({ P4PORT: 'invalid\nport' }, async () => {
      const result = await disposeP4ReviewWithLegacyAdoption(context.options, {
        createAmbientP4: () => context.p4,
        createBoundP4: (profile) => {
          controlledProfiles.push(profile);
          return context.p4;
        },
      });
      assert.equal(result.state, 'completed');
    });
    assert.ok(controlledProfiles.length >= 2);
    for (const profile of controlledProfiles) {
      assert.equal(profile.port, 'perforce-edge.example.com:1666');
      assert.notEqual(profile.port, 'perforce-node.internal.example:1666');
      assert.equal(profile.charset, 'utf8');
      assert.equal(profile.ticketFile, ticketFile);
      assert.equal(profile.trustFile, trustFile);
    }
    const value = await registry(context);
    assert.deepEqual(value.log.filter((entry) => entry.command === 'set').map((entry) => entry.args), [
      ['-q', 'P4PORT'], ['-q', 'P4CHARSET'], ['-q', 'P4TICKETS'], ['-q', 'P4TRUST'],
    ]);
    assert.ok(value.log.filter((entry) => entry.command === 'info').length >= 3);
    assert.deepEqual(destructiveCommands(value), ['shelve', 'change', 'client']);
  } finally {
    await dispose(context);
  }
});

test('legacy adoption prefers valid explicit settings and does not query their values', async () => {
  const context = await setup({
    receipt: (value) => { value.version = 1; delete value.p4Reconnect; },
    registry: (value) => {
      value.settings = { P4PORT: 'configured:1666', P4CHARSET: 'utf8' };
    },
  });
  const profiles = [];
  try {
    await withAmbientP4Environment({ P4PORT: 'explicit:1666', P4CHARSET: 'utf16' }, async () => {
      await disposeP4ReviewWithLegacyAdoption(context.options, {
        createAmbientP4: () => context.p4,
        createBoundP4: (profile) => {
          profiles.push(profile);
          return context.p4;
        },
      });
    });
    assert.ok(profiles.length >= 2);
    assert.ok(profiles.every((profile) => profile.port === 'explicit:1666' && profile.charset === 'utf16'));
    assert.deepEqual((await registry(context)).log.filter((entry) => entry.command === 'set').map((entry) => entry.args), [
      ['-q', 'P4TICKETS'], ['-q', 'P4TRUST'],
    ]);
  } finally {
    await dispose(context);
  }
});

test('missing or malformed effective P4PORT fails before binding or mutation', async () => {
  const cases = [
    (value) => { value.settings = {}; },
    (value) => { value.settingRecords = { P4PORT: [{ P4PORT: 'configured:1666', unexpected: 'field' }] }; },
    (value) => { value.settings = { P4PORT: '' }; },
  ];
  for (const configure of cases) {
    const context = await setup({
      receipt: (value) => { value.version = 1; delete value.p4Reconnect; },
      registry: configure,
    });
    let controlledCalls = 0;
    try {
      await withAmbientP4Environment({}, async () => {
        await assert.rejects(disposeP4ReviewWithLegacyAdoption(context.options, {
          createAmbientP4: () => context.p4,
          createBoundP4: () => {
            controlledCalls += 1;
            return context.p4;
          },
        }), /endpoint_verification_failed/);
      });
      assert.equal(controlledCalls, 0);
      await assert.rejects(fs.access(`${context.stateDir}.review-disposal-${transaction}.binding.json`), { code: 'ENOENT' });
      assert.deepEqual(destructiveCommands(await registry(context)), []);
    } finally {
      await dispose(context);
    }
  }
});

test('bound production factory strips hostile ambient Perforce configuration', async () => {
  const context = await setup();
  const prior = { P4CONFIG: process.env.P4CONFIG, P4ENVIRO: process.env.P4ENVIRO, P4LOGINSSO: process.env.P4LOGINSSO };
  Object.assign(process.env, { P4CONFIG: 'hostile.cfg', P4ENVIRO: 'hostile.enviro', P4LOGINSSO: 'hostile-sso' });
  try {
    await disposeP4Review(context.options);
    const value = await registry(context);
    assert.ok(value.log.every((entry) => !entry.secretEnvKeys.some((key) => ['P4CONFIG', 'P4ENVIRO', 'P4LOGINSSO'].includes(key.toUpperCase()))));
  } finally {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await dispose(context);
  }
});
