import crypto from 'node:crypto';
import { describe } from 'node:test';
import {
  checkpointAgentWorkspaceP4,
  handoffAgentWorkspaceP4,
  inspectAgentWorkspace,
  openAgentWorkspaceP4,
  unshelveAgentWorkspaceP4,
} from '../src/api.mjs';
import {
  assert,
  dispose,
  fs,
  normalPath,
  path,
  readJson,
  run,
  setup,
  test,
  waitFor,
} from './helpers/perforce-integration-fixture.mjs';

async function prepareShelf(context) {
  const started = JSON.parse((await run([
    'start', '--state-dir', context.stateDir, '--resource-class', 'light', '--',
    process.execPath, '-e', 'process.exit(0)',
  ])).stdout);
  await waitFor(context.stateDir, started.taskId, (task) => task.state === 'completed', 60000);
  const brokerUuid = (await inspectAgentWorkspace(context.stateDir)).brokerUuid;
  await openAgentWorkspaceP4({
    stateDir: context.stateDir,
    expectedBrokerUuid: brokerUuid,
    taskId: started.taskId,
    action: 'edit',
    depotPaths: [normalPath],
  });
  await checkpointAgentWorkspaceP4({ stateDir: context.stateDir, expectedBrokerUuid: brokerUuid, taskId: started.taskId });
  return { taskId: started.taskId, brokerUuid };
}

function handoffOptions(context, prepared) {
  return {
    stateDir: context.stateDir,
    expectedBrokerUuid: prepared.brokerUuid,
    taskId: prepared.taskId,
  };
}

describe('Perforce handoff recovery', { concurrency: 5 }, () => {
test('standard-server handoff copies exactly, seals the task, and cleanup preserves only review resources', async () => {
  const context = await setup(1);
  try {
    const initial = await readJson(context.registry);
    initial.fstatShape = 'shelved';
    await fs.writeFile(context.registry, `${JSON.stringify(initial, null, 2)}\n`);
    await run(context.initArgs, { timeout: 120000 });
    const prepared = await prepareShelf(context);
    const taskBefore = await readJson(path.join(context.stateDir, 'tasks', `${prepared.taskId}.json`));
    const registryBefore = await readJson(context.registry);
    const baseBefore = structuredClone({
      client: registryBefore.clients.base,
      have: registryBefore.have.base,
      opened: registryBefore.opened.filter((entry) => entry.client === 'base'),
    });
    const workerBefore = structuredClone({
      client: registryBefore.clients[taskBefore.p4.client],
      have: registryBefore.have[taskBefore.p4.client],
      opened: registryBefore.opened.filter((entry) => entry.client === taskBefore.p4.client),
    });

    const result = await handoffAgentWorkspaceP4(handoffOptions(context, prepared));
    assert.equal(result.result.state, 'committed');
    assert.equal(result.result.user, 'agent');
    assert.equal(result.result.fileCount, 1);
    assert.equal(result.result.promotionState, 'not_required');
    assert.match(result.result.change, /^\d+$/);
    assert.equal(JSON.stringify(result).includes('nonce'), false);
    assert.equal(JSON.stringify(result).includes('client'), false);

    const task = await readJson(path.join(context.stateDir, 'tasks', `${prepared.taskId}.json`));
    assert.equal(task.state, 'handed_off');
    assert.equal(task.p4.artifactState, 'handed_off');
    const ownership = await readJson(path.join(context.stateDir, 'ownership.json'));
    const sourceResources = ownership.resources.filter((resource) => resource.nonce === taskBefore.p4.nonce);
    assert.ok(sourceResources.length >= 2);
    assert.ok(sourceResources.every((resource) => resource.handedOff === false));
    const exclusions = ownership.resources.filter((resource) => resource.handedOff === true);
    assert.deepEqual(exclusions.map((resource) => resource.type).sort(), ['p4-change', 'p4-client', 'p4-shelf']);
    assert.ok(exclusions.every((resource) => resource.handoffTransaction === resource.nonce));

    const registry = await readJson(context.registry);
    const reshelve = registry.log.filter((entry) => entry.command === 'reshelve');
    assert.equal(reshelve.length, 1);
    assert.equal(reshelve[0].args.includes('-p'), false);
    assert.equal(registry.log.some((entry) => entry.command === 'unshelve'), false);
    assert.deepEqual(registry.shelves[result.result.change], registry.shelves[taskBefore.p4.changeResource.change]);
    assert.deepEqual({
      client: registry.clients.base,
      have: registry.have.base,
      opened: registry.opened.filter((entry) => entry.client === 'base'),
    }, baseBefore);
    assert.deepEqual({
      client: registry.clients[taskBefore.p4.client],
      have: registry.have[taskBefore.p4.client],
      opened: registry.opened.filter((entry) => entry.client === taskBefore.p4.client),
    }, workerBefore);

    const status = await inspectAgentWorkspace(context.stateDir);
    assert.deepEqual(status.tasks[0].p4.handoff, { state: 'committed', change: result.result.change, user: 'agent' });
    assert.equal(JSON.stringify(status).includes('nonce'), false);
    assert.equal(JSON.stringify(status).includes(task.p4.handoff.reviewClient), false);
    const reviewerEditedRegistry = await readJson(context.registry);
    reviewerEditedRegistry.shelves[result.result.change][0].digest = 'reviewer-edited-after-commit';
    await fs.writeFile(context.registry, `${JSON.stringify(reviewerEditedRegistry, null, 2)}\n`);
    const repeated = await handoffAgentWorkspaceP4(handoffOptions(context, prepared));
    assert.deepEqual(repeated.result, result.result);
    await assert.rejects(openAgentWorkspaceP4({
      ...handoffOptions(context, prepared), action: 'edit', depotPaths: [normalPath],
    }), /sealed/);
    await assert.rejects(unshelveAgentWorkspaceP4({
      ...handoffOptions(context, prepared), sourceChange: 1,
    }), /sealed/);
    await assert.rejects(checkpointAgentWorkspaceP4(handoffOptions(context, prepared)), /sealed/);
    await assert.rejects(run([
      'run', '--state-dir', context.stateDir, prepared.taskId, '--resource-class', 'light', '--',
      process.execPath, '-e', 'process.exit(0)',
    ]), /sealed/);
    await assert.rejects(handoffAgentWorkspaceP4({ ...handoffOptions(context, prepared), user: 'other' }), /unsupported operation option/);

    await run(['cleanup', '--state-dir', context.stateDir], { timeout: 120000 });
    const cleaned = await readJson(context.registry);
    const reviewClient = exclusions.find((resource) => resource.type === 'p4-client').client;
    assert.deepEqual(Object.keys(cleaned.clients).sort(), ['base', reviewClient].sort());
    assert.deepEqual(Object.keys(cleaned.changes), [result.result.change]);
    assert.ok(cleaned.shelves[result.result.change]);
    assert.equal(cleaned.shelves[taskBefore.p4.changeResource.change], undefined);
    const receipt = await readJson(`${context.stateDir}.cleanup-receipt.json`);
    assert.equal(receipt.handoffExclusions.length, 3);
  } finally {
    await dispose(context);
  }
});

test('handoff uses binary print fallback for shelves whose fstat content metadata is wholly absent', async () => {
  const context = await setup(1);
  try {
    const initial = await readJson(context.registry);
    initial.fstatShape = 'absent';
    await fs.writeFile(context.registry, `${JSON.stringify(initial, null, 2)}\n`);
    await run(context.initArgs, { timeout: 120000 });
    const prepared = await prepareShelf(context);
    const task = await readJson(path.join(context.stateDir, 'tasks', `${prepared.taskId}.json`));
    const sourceChange = task.p4.changeResource.change;
    const binaryContent = Buffer.from([0x00, 0xff, 0x80, 0x41, 0xc3, 0x28]);
    const before = await readJson(context.registry);
    before.shelves[sourceChange][0].contentBase64 = binaryContent.toString('base64');
    await fs.writeFile(context.registry, `${JSON.stringify(before, null, 2)}\n`);

    process.env.AGENT_WORKSPACE_TEST_FAIL_AFTER_HANDOFF_VERIFICATION = context.stateDir;
    try {
      await assert.rejects(handoffAgentWorkspaceP4(handoffOptions(context, prepared)), /simulated crash/);
    } finally {
      delete process.env.AGENT_WORKSPACE_TEST_FAIL_AFTER_HANDOFF_VERIFICATION;
    }
    const result = await handoffAgentWorkspaceP4(handoffOptions(context, prepared));
    assert.equal(result.result.state, 'committed');
    assert.equal(result.result.fileCount, 1);

    const registry = await readJson(context.registry);
    assert.equal(registry.shelves[result.result.change][0].contentBase64, binaryContent.toString('base64'));
    assert.ok(registry.log.filter((entry) => entry.command === 'print').length >= 4);
    assert.equal(registry.log.some((entry) => entry.command === 'unshelve'), false);
    assert.equal(registry.reshelves.length, 1);
  } finally {
    delete process.env.AGENT_WORKSPACE_TEST_FAIL_AFTER_HANDOFF_VERIFICATION;
    await dispose(context);
  }
});

async function runEdgeFaultMatrix(faultNames) {
  const context = await setup(faultNames.length);
  try {
    const initial = await readJson(context.registry);
    initial.serverServices = 'edge-server';
    await fs.writeFile(context.registry, `${JSON.stringify(initial, null, 2)}\n`);
    await run(context.initArgs, { timeout: 30000 });
    for (const faultName of faultNames) {
      const prepared = await prepareShelf(context);
      process.env[faultName] = context.stateDir;
      try {
        await assert.rejects(handoffAgentWorkspaceP4(handoffOptions(context, prepared)), /simulated crash/);
      } finally {
        delete process.env[faultName];
      }
      const result = await handoffAgentWorkspaceP4(handoffOptions(context, prepared));
      assert.equal(result.result.state, 'committed');
      assert.equal(result.result.promotionState, 'promoted');
    }
    const registry = await readJson(context.registry);
    assert.equal(registry.reshelves.length, faultNames.length);
    assert.ok(registry.log.filter((entry) => entry.command === 'reshelve').every((entry) => entry.args.includes('-p')));
    assert.equal(registry.log.some((entry) => entry.command === 'unshelve'), false);
  } finally {
    for (const faultName of faultNames) delete process.env[faultName];
    await dispose(context);
  }
}

test('edge handoff retries durable intent and predeclaration boundaries', async () => {
  await runEdgeFaultMatrix([
    'AGENT_WORKSPACE_TEST_FAIL_AFTER_HANDOFF_INTENT',
    'AGENT_WORKSPACE_TEST_FAIL_AFTER_HANDOFF_PREDECLARE',
  ]);
});

test('edge handoff retries review client and change creation boundaries', async () => {
  await runEdgeFaultMatrix([
    'AGENT_WORKSPACE_TEST_FAIL_AFTER_HANDOFF_CLIENT',
    'AGENT_WORKSPACE_TEST_FAIL_AFTER_HANDOFF_CHANGE',
  ]);
});

test('edge handoff retries verification, reshelve, and ownership-ledger boundaries', async () => {
  await runEdgeFaultMatrix([
    'AGENT_WORKSPACE_TEST_FAIL_AFTER_HANDOFF_RESHELVE',
    'AGENT_WORKSPACE_TEST_FAIL_AFTER_HANDOFF_VERIFICATION',
    'AGENT_WORKSPACE_TEST_FAIL_AFTER_HANDOFF_LEDGER',
  ]);
});

test('handoff reconciles lost client, change, and successful reshelve responses', async () => {
  const context = await setup(3);
  try {
    await run(context.initArgs, { timeout: 30000 });
    for (const [command, error] of [
      ['client', 'connection dropped after client create'],
      ['change', 'connection dropped after change create'],
      ['reshelve', 'connection dropped after exact reshelve'],
    ]) {
      const prepared = await prepareShelf(context);
      const registry = await readJson(context.registry);
      registry.faults[command] = { times: 1, afterCreate: true, error };
      await fs.writeFile(context.registry, `${JSON.stringify(registry, null, 2)}\n`);
      const result = await handoffAgentWorkspaceP4(handoffOptions(context, prepared));
      assert.equal(result.result.state, 'committed');
    }
    const registry = await readJson(context.registry);
    assert.equal(registry.reshelves.length, 3);
    assert.equal(new Set(registry.reshelves.map((entry) => entry.destination)).size, 3);
  } finally {
    await dispose(context);
  }
});

test('ledger ownership commit finalizes without querying reviewer-mutated resources and cleanup preserves them', async () => {
  const context = await setup(1);
  try {
    await run(context.initArgs, { timeout: 120000 });
    const prepared = await prepareShelf(context);
    process.env.AGENT_WORKSPACE_TEST_FAIL_AFTER_HANDOFF_LEDGER_REVIEWER = context.stateDir;
    try {
      await assert.rejects(handoffAgentWorkspaceP4(handoffOptions(context, prepared)), /simulated crash/);
    } finally {
      delete process.env.AGENT_WORKSPACE_TEST_FAIL_AFTER_HANDOFF_LEDGER_REVIEWER;
    }
    const task = await readJson(path.join(context.stateDir, 'tasks', `${prepared.taskId}.json`));
    assert.equal(task.p4.handoff.state, 'intent_recorded');
    const ownership = await readJson(path.join(context.stateDir, 'ownership.json'));
    const exclusions = ownership.resources.filter((resource) => resource.handedOff === true);
    assert.equal(exclusions.length, 3);
    const reviewClient = exclusions.find((resource) => resource.type === 'p4-client').client;
    const reviewChange = task.p4.handoff.destinationChange;
    const registry = await readJson(context.registry);
    registry.clients[reviewClient].Root = 'C:/reviewer/changed-root';
    registry.clients[reviewClient].Description = 'reviewer changed client';
    registry.changes[reviewChange].Description = 'reviewer changed change';
    registry.shelves[reviewChange][0].digest = 'reviewer-changed-shelf';
    registry.opened.push({ client: reviewClient, depotFile: '//Depot/Main/Reviewer.cpp', action: 'edit', change: reviewChange });
    const logLength = registry.log.length;
    await fs.writeFile(context.registry, `${JSON.stringify(registry, null, 2)}\n`);

    const result = await handoffAgentWorkspaceP4(handoffOptions(context, prepared));
    assert.equal(result.result.state, 'committed');
    assert.equal((await readJson(context.registry)).log.length, logLength);

    await run(['cleanup', '--state-dir', context.stateDir], { timeout: 120000 });
    const cleaned = await readJson(context.registry);
    assert.equal(cleaned.clients[reviewClient].Root, 'C:/reviewer/changed-root');
    assert.equal(cleaned.changes[reviewChange].Description, 'reviewer changed change');
    assert.equal(cleaned.shelves[reviewChange][0].digest, 'reviewer-changed-shelf');
    assert.ok(cleaned.opened.some((entry) => entry.client === reviewClient));
  } finally {
    delete process.env.AGENT_WORKSPACE_TEST_FAIL_AFTER_HANDOFF_LEDGER_REVIEWER;
    await dispose(context);
  }
});

test('handoff rejects tampered durable planned-resource structure and identity before P4 access', async () => {
  const context = await setup(1);
  try {
    await run(context.initArgs, { timeout: 120000 });
    const prepared = await prepareShelf(context);
    process.env.AGENT_WORKSPACE_TEST_FAIL_AFTER_HANDOFF_INTENT_TAMPER = context.stateDir;
    try {
      await assert.rejects(handoffAgentWorkspaceP4(handoffOptions(context, prepared)), /simulated crash/);
    } finally {
      delete process.env.AGENT_WORKSPACE_TEST_FAIL_AFTER_HANDOFF_INTENT_TAMPER;
    }
    const taskPath = path.join(context.stateDir, 'tasks', `${prepared.taskId}.json`);
    const exact = await readJson(taskPath);
    const tampers = [
      (intent) => intent.plannedResources.reverse(),
      (intent) => { intent.plannedResources[0].handedOff = true; },
      (intent) => { intent.plannedResources[1].change = '123'; },
      (intent) => { intent.plannedResources[0].root = 'C:/wrong-root'; },
      (intent) => { intent.plannedResources[0].slot = 'handoff:wrong-task'; },
      (intent) => { intent.plannedResources[1].user = 'other'; },
      (intent) => { intent.plannedResources[2].client = 'other-client'; },
      (intent) => { intent.plannedResources[2].nonce = crypto.randomUUID(); },
    ];
    for (const tamper of tampers) {
      const changed = structuredClone(exact);
      tamper(changed.p4.handoff);
      await fs.writeFile(taskPath, `${JSON.stringify(changed, null, 2)}\n`);
      const logLength = (await readJson(context.registry)).log.length;
      await assert.rejects(handoffAgentWorkspaceP4(handoffOptions(context, prepared)), /durable handoff intent/);
      assert.equal((await readJson(context.registry)).log.length, logLength);
    }
    await fs.writeFile(taskPath, `${JSON.stringify(exact, null, 2)}\n`);
  } finally {
    delete process.env.AGENT_WORKSPACE_TEST_FAIL_AFTER_HANDOFF_INTENT_TAMPER;
    await dispose(context);
  }
});

test('cleanup recovers an incomplete exact intent and blocks ambiguous shelf evidence before source deletion', async () => {
  const context = await setup(1);
  try {
    await run(context.initArgs, { timeout: 120000 });
    const prepared = await prepareShelf(context);
    const beforeHandoff = await readJson(context.registry);
    beforeHandoff.faults.reshelve = { times: 1, afterCreate: true, error: 'connection dropped after reshelve' };
    await fs.writeFile(context.registry, `${JSON.stringify(beforeHandoff, null, 2)}\n`);
    process.env.AGENT_WORKSPACE_TEST_FAIL_AFTER_HANDOFF_RESHELVE_AMBIGUITY = context.stateDir;
    try {
      await assert.rejects(handoffAgentWorkspaceP4(handoffOptions(context, prepared)), /simulated crash/);
    } finally {
      delete process.env.AGENT_WORKSPACE_TEST_FAIL_AFTER_HANDOFF_RESHELVE_AMBIGUITY;
    }
    const task = await readJson(path.join(context.stateDir, 'tasks', `${prepared.taskId}.json`));
    const registry = await readJson(context.registry);
    registry.shelves[task.p4.handoff.destinationChange][0].digest = crypto.randomBytes(16).toString('hex');
    await fs.writeFile(context.registry, `${JSON.stringify(registry, null, 2)}\n`);

    await assert.rejects(run(['cleanup', '--state-dir', context.stateDir], { timeout: 120000 }), /do not exactly match/);
    const retained = await readJson(context.registry);
    assert.ok(retained.clients[task.p4.client]);
    assert.ok(retained.changes[task.p4.changeResource.change]);
    assert.ok(retained.shelves[task.p4.changeResource.change]);
    assert.equal(await fs.access(context.stateDir).then(() => true, () => false), true);
  } finally {
    delete process.env.AGENT_WORKSPACE_TEST_FAIL_AFTER_HANDOFF_RESHELVE_AMBIGUITY;
    await dispose(context);
  }
});

test('cleanup does not recover P4 handoff intent before the workers-stopped fence', async () => {
  const context = await setup(1);
  try {
    await run(context.initArgs, { timeout: 120000 });
    const prepared = await prepareShelf(context);
    process.env.AGENT_WORKSPACE_TEST_FAIL_AFTER_HANDOFF_PREDECLARE_ORDERING = context.stateDir;
    try {
      await assert.rejects(handoffAgentWorkspaceP4(handoffOptions(context, prepared)), /simulated crash/);
    } finally {
      delete process.env.AGENT_WORKSPACE_TEST_FAIL_AFTER_HANDOFF_PREDECLARE_ORDERING;
    }
    const task = await readJson(path.join(context.stateDir, 'tasks', `${prepared.taskId}.json`));
    const cleaning = run(['cleanup', '--state-dir', context.stateDir], {
      timeout: 30000,
      env: { AGENT_WORKSPACE_TEST_CLEANUP_WORKERS_STOPPED_DELAY_MS: '1000' },
    });
    const journalPath = `${context.stateDir}.cleanup-journal.json`;
    const deadline = Date.now() + 5000;
    let journal;
    while (Date.now() < deadline) {
      journal = await readJson(journalPath).catch(() => null);
      if (journal?.phases?.cancel_tasks?.completedAt && !journal.phases.workers_stopped) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(journal?.phases?.cancel_tasks?.completedAt);
    const pausedRegistry = await readJson(context.registry);
    assert.equal(pausedRegistry.clients[task.p4.handoff.reviewClient], undefined);
    assert.equal(pausedRegistry.reshelves?.length ?? 0, 0);
    await cleaning;
    const cleaned = await readJson(context.registry);
    assert.ok(cleaned.clients[task.p4.handoff.reviewClient]);
  } finally {
    delete process.env.AGENT_WORKSPACE_TEST_FAIL_AFTER_HANDOFF_PREDECLARE_ORDERING;
    await dispose(context);
  }
});

test('cleanup rejects partial, duplicate, wrong-transaction, and non-P4 handoff exclusions before P4 deletion', async () => {
  const context = await setup(1);
  try {
    await run(context.initArgs, { timeout: 120000 });
    const prepared = await prepareShelf(context);
    await handoffAgentWorkspaceP4(handoffOptions(context, prepared));
    const ownershipPath = path.join(context.stateDir, 'ownership.json');
    const exact = await readJson(ownershipPath);
    const exclusionIndexes = exact.resources.map((resource, index) => resource.handedOff === true ? index : -1).filter((index) => index >= 0);
    assert.equal(exclusionIndexes.length, 3);
    const cases = [
      (value) => value.resources.splice(exclusionIndexes[0], 1),
      (value) => value.resources.push(structuredClone(value.resources[exclusionIndexes[0]])),
      (value) => { value.resources[exclusionIndexes[0]].handoffTransaction = crypto.randomUUID(); },
      (value) => value.resources.push({ type: 'rogue-resource', brokerUuid: value.brokerUuid, nonce: crypto.randomUUID(), handedOff: true, handoffTransaction: crypto.randomUUID() }),
    ];
    for (const tamper of cases) {
      const value = structuredClone(exact);
      tamper(value);
      await fs.writeFile(ownershipPath, `${JSON.stringify(value, null, 2)}\n`);
      const before = await readJson(context.registry);
      await assert.rejects(run(['cleanup', '--state-dir', context.stateDir], { timeout: 120000 }), /handoff|ownership commit/);
      const after = await readJson(context.registry);
      assert.deepEqual(after.clients, before.clients);
      assert.deepEqual(after.changes, before.changes);
      assert.deepEqual(after.shelves, before.shelves);
    }
    await fs.writeFile(ownershipPath, `${JSON.stringify(exact, null, 2)}\n`);
  } finally {
    await dispose(context);
  }
});
});
