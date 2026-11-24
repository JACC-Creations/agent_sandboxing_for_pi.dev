import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import {
  checkpointAgentWorkspaceP4,
  cleanupAgentWorkspace,
  disposeAgentWorkspaceP4Handoff,
  handoffAgentWorkspaceP4,
  inspectAgentWorkspace,
  openAgentWorkspaceP4,
  unshelveAgentWorkspaceP4,
} from '../src/api.mjs';
import {
  dispose,
  normalPath,
  readJson,
  run,
  setup,
  waitFor,
} from './helpers/perforce-integration-fixture.mjs';

const addedPath = '//Depot/Main/AddedByShelf.cpp';
const disposalBrokerUuid = '12345678-1234-4234-9234-123456789abc';
const disposalTaskId = '20261124112233-abcdef123456';
const disposalTransaction = '0123456789abcdef0123456789abcdef';

async function setupLegacyDisposalFixture() {
  const temporaryRoot = await fs.mkdtemp(path.join(process.cwd(), 'pi-disposal-refusal-'));
  const stateDir = path.join(temporaryRoot, 'state');
  const registryPath = path.join(temporaryRoot, 'fake-p4.json');
  const reviewRoot = path.join(temporaryRoot, 'former-review-root');
  const ownership = {
    client: 'review-client', taskId: disposalTaskId, user: 'agent', brokerUuid: disposalBrokerUuid,
    nonce: disposalTransaction, handedOff: true, handoffTransaction: disposalTransaction,
  };
  const resources = [
    { type: 'p4-client', ...ownership, root: reviewRoot, slot: `handoff:${disposalTaskId}` },
    { type: 'p4-change', ...ownership, change: '1000' },
    { type: 'p4-shelf', ...ownership, change: '1000' },
  ];
  const description = [
    'AgentWorkspace-Owned: true',
    `AgentWorkspace-Broker: ${disposalBrokerUuid}`,
    `AgentWorkspace-Nonce: ${disposalTransaction}`,
    `AgentWorkspace-Task: ${disposalTaskId}`,
    'AgentWorkspace-Client: review-client',
  ].join('\n');
  await fs.writeFile(`${stateDir}.cleanup-receipt.json`, `${JSON.stringify({
    version: 1,
    state: 'completed',
    brokerUuid: disposalBrokerUuid,
    stateDir: path.resolve(stateDir),
    completedAt: '2026-11-24T12:00:00.000Z',
    removed: [{ type: 'broker-private-state', path: stateDir }],
    handoffExclusions: resources,
    nativeSupervisor: false,
    ownedJobs: [],
  }, null, 2)}\n`);
  await fs.writeFile(registryPath, `${JSON.stringify({
    user: 'agent',
    clients: {
      'review-client': {
        Client: 'review-client', Root: reviewRoot, Owner: 'agent',
        Description: `${description}\nAgentWorkspace-Resource: review-handoff`,
      },
    },
    have: { 'review-client': {} },
    opened: [],
    changes: {
      1000: {
        Change: '1000', Client: 'review-client', User: 'agent', Status: 'pending',
        Description: `${description}\nAgentWorkspace-Change: review-handoff`,
      },
    },
    shelves: {
      1000: [{ depotFile: '//Depot/Main/Review.cpp', action: 'edit', rev: '7', type: 'text' }],
    },
    nextChange: 1001,
    faults: {},
    log: [],
  }, null, 2)}\n`);
  return {
    temporaryRoot,
    stateDir,
    registryPath,
    bindingPath: `${stateDir}.review-disposal-${disposalTransaction}.binding.json`,
    journalPath: `${stateDir}.review-disposal-${disposalTransaction}.json`,
  };
}

async function startRetainedTask(context) {
  const started = JSON.parse((await run([
    'start', '--state-dir', context.stateDir, '--resource-class', 'light', '--',
    process.execPath, '-e', 'process.exit(0)',
  ])).stdout);
  await waitFor(context.stateDir, started.taskId, (task) => task.state === 'completed', 12000);
  return started.taskId;
}

test('generation-pinned public API validates inputs and task binding before P4 mutations', async () => {
  const context = await setup(1);
  try {
    await run(context.initArgs, { timeout: 20000 });
    const taskId = await startRetainedTask(context);
    const status = await inspectAgentWorkspace(context.stateDir);
    const brokerUuid = status.brokerUuid;
    assert.equal(Object.isFrozen(status), true);
    assert.equal(status.stateDir, path.resolve(context.stateDir));
    assert.equal(status.p4Enabled, true);
    assert.deepEqual(status.revisionControl, {
      mode: 'p4',
      enabled: true,
      capabilities: {
        explicitOpen: true,
        artifactImport: true,
        automaticCheckpoints: true,
        reviewHandoff: true,
      },
    });
    assert.deepEqual(status.tasks.map((task) => task.taskId), [taskId]);
    assert.equal(JSON.stringify(status).includes('nonce'), false);
    assert.equal(JSON.stringify(status).includes('client'), false);

    const registryBeforeMismatch = await readJson(context.registry);
    await assert.rejects(openAgentWorkspaceP4({
      stateDir: context.stateDir,
      expectedBrokerUuid: crypto.randomUUID(),
      taskId,
      action: 'edit',
      depotPaths: [normalPath],
    }), /generation changed/);
    assert.equal((await readJson(context.registry)).log.length, registryBeforeMismatch.log.length);

    for (const invalid of [
      { ...baseOptions(context, brokerUuid, taskId), action: 'move', depotPaths: [normalPath] },
      { ...baseOptions(context, brokerUuid, taskId), action: 'edit', depotPaths: [] },
      { ...baseOptions(context, brokerUuid, taskId), action: 'edit', depotPaths: [normalPath, normalPath] },
      { ...baseOptions(context, brokerUuid, taskId), action: 'edit', depotPaths: ['Normal.cpp'] },
      { ...baseOptions(context, brokerUuid, taskId), action: 'edit', depotPaths: [normalPath], allowProtectedBase: true },
    ]) {
      await assert.rejects(openAgentWorkspaceP4(invalid), /action|at least one|unique|depot path|unsupported operation option/);
    }
    await assert.rejects(unshelveAgentWorkspaceP4({
      ...baseOptions(context, brokerUuid, taskId),
      sourceChange: 0,
    }), /positive integer/);

    const opened = await openAgentWorkspaceP4({
      ...baseOptions(context, brokerUuid, taskId),
      action: 'edit',
      depotPaths: [normalPath],
    });
    assert.deepEqual(opened.result, { action: 'edit', depotPaths: [normalPath] });
    const checkpointed = await checkpointAgentWorkspaceP4(baseOptions(context, brokerUuid, taskId));
    assert.equal(checkpointed.result.state, 'shelved');
    assert.equal(checkpointed.result.openedDepotPaths[0], normalPath);
    assert.equal(JSON.stringify(checkpointed).includes('nonce'), false);

    const registry = await readJson(context.registry);
    registry.shelves[9000] = [{ depotFile: addedPath, action: 'add', rev: '1' }];
    await fs.writeFile(context.registry, `${JSON.stringify(registry, null, 2)}\n`);
    const unshelved = await unshelveAgentWorkspaceP4({
      ...baseOptions(context, brokerUuid, taskId),
      sourceChange: 9000,
    });
    assert.deepEqual(unshelved.result.depotPaths, [addedPath]);

    const handedOff = await handoffAgentWorkspaceP4(baseOptions(context, brokerUuid, taskId));
    assert.equal(handedOff.result.state, 'committed');
    assert.equal(handedOff.result.user, 'agent');
    assert.equal(JSON.stringify(handedOff).includes('client'), false);
    assert.equal(JSON.stringify(handedOff).includes('nonce'), false);
    const handedOffStatus = await inspectAgentWorkspace(context.stateDir);
    assert.deepEqual(handedOffStatus.tasks[0].p4.handoff, {
      state: 'committed', change: handedOff.result.change, user: 'agent',
    });

    const slotsPath = path.join(context.stateDir, 'slots.json');
    const slots = await readJson(slotsPath);
    const originalTaskId = slots.slots[0].taskId;
    slots.slots[0].taskId = '20000101000000-000000000000';
    await fs.writeFile(slotsPath, `${JSON.stringify(slots, null, 2)}\n`);
    const logLengthBeforeBindingRefusal = (await readJson(context.registry)).log.length;
    await assert.rejects(checkpointAgentWorkspaceP4(baseOptions(context, brokerUuid, taskId)), /binding refused/);
    assert.equal((await readJson(context.registry)).log.length, logLengthBeforeBindingRefusal);
    slots.slots[0].taskId = originalTaskId;
    await fs.writeFile(slotsPath, `${JSON.stringify(slots, null, 2)}\n`);
  } finally {
    await dispose(context);
  }
});

test('cleanup public API refuses the wrong UUID and accepts the exact generation idempotently', async () => {
  const context = await setup(1);
  try {
    await run(context.initArgs, { timeout: 20000 });
    const brokerUuid = (await inspectAgentWorkspace(context.stateDir)).brokerUuid;
    await assert.rejects(cleanupAgentWorkspace({
      stateDir: context.stateDir,
      expectedBrokerUuid: crypto.randomUUID(),
    }), /generation changed/);
    await fs.access(context.stateDir);

    const cleaned = await cleanupAgentWorkspace({ stateDir: context.stateDir, expectedBrokerUuid: brokerUuid });
    assert.equal(cleaned.brokerUuid, brokerUuid);
    assert.equal(cleaned.state, 'completed');
    assert.equal(cleaned.idempotent, false);
    assert.equal(JSON.stringify(cleaned).includes('nonce'), false);
    await assert.rejects(fs.access(context.stateDir), { code: 'ENOENT' });

    const repeated = await cleanupAgentWorkspace({ stateDir: context.stateDir, expectedBrokerUuid: brokerUuid });
    assert.equal(repeated.idempotent, true);
    assert.equal(repeated.brokerUuid, brokerUuid);
    await assert.rejects(cleanupAgentWorkspace({
      stateDir: context.stateDir,
      expectedBrokerUuid: crypto.randomUUID(),
    }), /generation changed/);
  } finally {
    await dispose(context);
  }
});

test('disposal API accepts only retained identity and sanitizes failures', async () => {
  const temporaryRoot = await fs.mkdtemp(path.join(process.cwd(), 'pi-disposal-api-'));
  const stateDir = path.join(temporaryRoot, 'private-ticket-value');
  const brokerUuid = crypto.randomUUID();
  const taskId = '20261124112233-abcdef123456';
  try {
    await assert.rejects(disposeAgentWorkspaceP4Handoff({
      stateDir, brokerUuid, taskId, change: 1234,
    }), (error) => error.message === 'review disposal refused: invalid_input');
    await assert.rejects(disposeAgentWorkspaceP4Handoff({ stateDir, brokerUuid, taskId }), (error) => {
      assert.equal(error.message, 'review disposal refused: invalid_receipt');
      assert.equal(error.message.includes('private-ticket-value'), false);
      return true;
    });
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
    await fs.rm(`${stateDir}.lifecycle`, { recursive: true, force: true });
  }
});

test('Pi package manifest and extension expose only the seven narrow typed tools', async () => {
  const root = path.resolve(import.meta.dirname, '..');
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  assert.deepEqual(manifest.keywords, ['pi-package']);
  assert.deepEqual(manifest.pi.extensions, ['./extensions/agent-workspace/index.ts']);
  assert.deepEqual(manifest.pi.skills, ['./skills/agent-workspace']);
  assert.deepEqual(Object.keys(manifest.peerDependencies).sort(), ['@earendil-works/pi-coding-agent', 'typebox']);
  assert.equal(manifest.exports['.'], './src/api.mjs');
  assert.equal(manifest.exports['./internal-api'], undefined);

  const extension = await fs.readFile(path.join(root, 'extensions', 'agent-workspace', 'index.ts'), 'utf8');
  const names = [...extension.matchAll(/name: "(agent_workspace_[^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(names, [
    'agent_workspace_status',
    'agent_workspace_p4_open',
    'agent_workspace_p4_unshelve',
    'agent_workspace_p4_checkpoint',
    'agent_workspace_p4_handoff',
    'agent_workspace_p4_dispose_handoff',
    'agent_workspace_cleanup',
  ]);
  assert.equal((extension.match(/executionMode: "sequential"/g) ?? []).length, 6);
  assert.match(extension, /registerCommand\("revision-control"/);
  assert.match(extension, /getArgumentCompletions: revisionControlCompletions/);
  assert.match(extension, /runRevisionControlCommand\(args, ctx, CONFIG_DIR_NAME\)/);
  assert.match(extension, /ctx\.hasUI/);
  assert.match(extension, /ctx\.ui\.confirm/);
  assert.match(extension, /disposeAgentWorkspaceP4HandoffAfterApproval/);
  assert.match(extension, /from "\.\.\/\.\.\/src\/internal-api\.mjs"/);
  assert.doesNotMatch(extension, /disposeAgentWorkspaceP4Handoff,\s*$/m);
  assert.match(extension, /publicErrorMessage\(code\)/);
  assert.doesNotMatch(extension, /failed: \$\{diagnostic\}/);
  assert.doesNotMatch(extension, /error: \{ code, message: diagnostic \}/);
  for (const bypass of ['pi.exec', 'child_process', 'allowProtectedBase', 'resourceNonce', 'p4Flags', 'commandArgs']) {
    assert.equal(extension.includes(bypass), false, `extension must not expose or invoke ${bypass}`);
  }
  assert.match(extension, /additionalProperties: false/);
  assert.match(extension, /uniqueItems: true/);
  assert.match(extension, /pattern: "\^\/\/\.\+"/);
  assert.match(extension, /permanent deletion in shelf → change → client order/);
});

test('Pi disposal tool fails closed on decline/no UI and redacts broker failures', async (t) => {
  const tools = await loadExtensionTools(t);
  if (!tools) return;
  const fixture = await setupLegacyDisposalFixture();
  const redactionStateDir = path.join(process.cwd(), 'private-disposal-ticket');
  t.after(async () => {
    await fs.rm(fixture.temporaryRoot, { recursive: true, force: true });
    await fs.rm(`${fixture.stateDir}.cleanup-receipt.json`, { force: true });
    await fs.rm(`${fixture.stateDir}.lifecycle`, { recursive: true, force: true });
    await fs.rm(`${redactionStateDir}.lifecycle`, { recursive: true, force: true });
  });
  const tool = tools.find((candidate) => candidate.name === 'agent_workspace_p4_dispose_handoff');
  assert.ok(tool);
  assert.equal(tool.executionMode, 'sequential');
  assert.deepEqual(Object.keys(tool.parameters.properties).sort(), ['brokerUuid', 'stateDir', 'taskId']);
  assert.equal(tool.parameters.additionalProperties, false);

  const params = {
    stateDir: fixture.stateDir,
    brokerUuid: disposalBrokerUuid,
    taskId: disposalTaskId,
  };
  const originalP4Log = (await readJson(fixture.registryPath)).log;
  const assertRefusalHadNoSideEffects = async () => {
    await assert.rejects(fs.access(fixture.bindingPath), { code: 'ENOENT' });
    await assert.rejects(fs.access(fixture.journalPath), { code: 'ENOENT' });
    assert.deepEqual((await readJson(fixture.registryPath)).log, originalP4Log);
  };
  let confirmCalls = 0;
  const noUi = await tool.execute('call-no-ui', params, undefined, undefined, {
    hasUI: false,
    ui: { confirm: async () => { confirmCalls += 1; return true; } },
  });
  assert.equal(noUi.isError, true);
  assert.equal(noUi.details.error.code, 'approval_required');
  assert.equal(confirmCalls, 0);
  await assertRefusalHadNoSideEffects();

  const declined = await tool.execute('call-declined', params, undefined, undefined, {
    hasUI: true,
    ui: { confirm: async () => { confirmCalls += 1; return false; } },
  });
  assert.equal(declined.isError, true);
  assert.equal(declined.details.error.code, 'approval_required');
  assert.equal(confirmCalls, 1);
  await assertRefusalHadNoSideEffects();

  const failedParams = { ...params, stateDir: redactionStateDir };
  let confirmationText = '';
  const failed = await tool.execute('call-failed', failedParams, undefined, undefined, {
    hasUI: true,
    ui: { confirm: async (_title, text) => { confirmationText = text; return true; } },
  });
  assert.equal(failed.isError, true);
  assert.match(confirmationText, /permanent deletion in shelf → change → client order/);
  assert.match(confirmationText, /current project P4 endpoint will be durably adopted/);
  assert.equal(JSON.stringify(failed).includes('private-disposal-ticket'), false);
  assert.equal(JSON.stringify(failed).includes('review-client'), false);
  assert.deepEqual(Object.keys(failed.details.error).sort(), ['code', 'message']);
});

async function loadExtensionTools(t) {
  const installRoot = process.env.PI_MANAGED_INSTALL_ROOT;
  if (!installRoot) {
    t.skip('Pi managed install is unavailable');
    return null;
  }
  const version = (await fs.readFile(path.join(installRoot, 'current-version'), 'utf8')).trim();
  const moduleRoot = path.join(installRoot, 'releases', version, 'node_modules');
  const { createJiti } = await import(pathToFileURL(path.join(moduleRoot, 'jiti', 'lib', 'jiti.mjs')).href);
  const stubRoot = await fs.mkdtemp(path.join(process.cwd(), 'pi-extension-stubs-'));
  t.after(() => fs.rm(stubRoot, { recursive: true, force: true }));
  const hostStub = path.join(stubRoot, 'host.mjs');
  const typeboxStub = path.join(stubRoot, 'typebox.mjs');
  await fs.writeFile(hostStub, 'export const CONFIG_DIR_NAME = ".pi"; export const defineTool = (tool) => tool;\n');
  await fs.writeFile(typeboxStub, `
function schema(type, options = {}) { return { type, ...options }; }
export const Type = {
  String: (options) => schema('string', options),
  Integer: (options) => schema('integer', options),
  Boolean: (options) => schema('boolean', options),
  Unknown: () => ({}),
  Literal: (value) => ({ const: value }),
  Union: (values) => ({ anyOf: values }),
  Optional: (value) => value,
  Array: (items, options = {}) => ({ type: 'array', items, ...options }),
  Object: (properties, options = {}) => ({ type: 'object', properties, required: Object.keys(properties), ...options }),
};
`);
  const jiti = createJiti(import.meta.url, {
    alias: {
      '@earendil-works/pi-coding-agent': hostStub,
      typebox: typeboxStub,
    },
    moduleCache: false,
  });
  const extension = await jiti.import(path.resolve(import.meta.dirname, '..', 'extensions', 'agent-workspace', 'index.ts'), { default: true });
  const tools = [];
  extension({
    registerCommand() {},
    registerTool(tool) { tools.push(tool); },
  });
  return tools;
}

function baseOptions(context, expectedBrokerUuid, taskId) {
  return { stateDir: context.stateDir, expectedBrokerUuid, taskId };
}
