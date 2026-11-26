import { cleanupAgentWorkspace } from '../src/api.mjs';
import { cleanupAgentWorkspaceAfterApproval, inspectAgentWorkspaceCleanupRequirement } from '../src/internal-api.mjs';
import {
  assert,
  dispose,
  environmentFixture,
  fs,
  normalPath,
  path,
  protectedPath,
  readJson,
  run,
  setup,
  test,
  waitFor,
} from './helpers/perforce-integration-fixture.mjs';

test('recovery monitor adoption cannot cross cleanup workers-stopped and P4 deletion', async () => {
  const context = await setup(1);
  try {
    await run(context.initArgs, { timeout: 120000 });
    const started = JSON.parse((await run(['start', '--state-dir', context.stateDir, '--resource-class', 'light', '--', process.execPath, '-e', 'setTimeout(() => {}, 30000)'])).stdout);
    const taskPath = path.join(context.stateDir, 'tasks', `${started.taskId}.json`);
    const running = await waitFor(context.stateDir, started.taskId, (task) => task.state === 'running', 60000);
    process.kill(running.monitorPid, 'SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 100));
    const stale = await readJson(taskPath);
    stale.monitorPid = 99999999;
    stale.heartbeatAt = '1970-01-01T00:00:00.000Z';
    await fs.writeFile(taskPath, `${JSON.stringify(stale, null, 2)}\n`);
    const cleanup = run(['cleanup', '--state-dir', context.stateDir], {
      timeout: 30000,
      env: { AGENT_WORKSPACE_TEST_CLEANUP_AFTER_GENERATION_DELAY_MS: '500' },
    });
    const journalPath = `${context.stateDir}.cleanup-journal.json`;
    const deadline = Date.now() + 5000;
    while (!await fs.access(journalPath).then(() => true, () => false) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const statusRefusal = assert.rejects(run(['status', '--state-dir', context.stateDir, started.taskId], { timeout: 10000 }));
    await cleanup;
    await statusRefusal;
    const receipt = await readJson(`${context.stateDir}.cleanup-receipt.json`);
    assert.equal(receipt.state, 'completed');
    assert.deepEqual(Object.keys((await readJson(context.registry)).clients), ['base']);
  } finally {
    await dispose(context);
  }
});

test('cleanup requires every task owned Job to be empty before P4 mutation', async () => {
  const context = await setup(1);
  try {
    await run(context.initArgs, { timeout: 120000 });
    const started = JSON.parse((await run(['start', '--state-dir', context.stateDir, '--resource-class', 'light', '--', process.execPath, '-e', 'process.exit(0)'])).stdout);
    await waitFor(context.stateDir, started.taskId, (task) => task.state === 'completed', 60000);
    await assert.rejects(run(['cleanup', '--state-dir', context.stateDir], {
      timeout: 120000,
      env: { AGENT_WORKSPACE_TEST_QUERY_JOB_NONEMPTY: '1' },
    }), /owned Job is not empty/);
    const registry = await readJson(context.registry);
    assert.ok(Object.keys(registry.clients).some((client) => client !== 'base'));
    assert.equal(Object.keys(registry.changes).length, 1);
  } finally {
    await dispose(context);
  }
});

async function makeLegacyEndpointStale(context) {
  const configPath = path.join(context.stateDir, 'config.json');
  const config = await readJson(configPath);
  config.p4.port = 'stale.invalid.example:1666';
  config.p4.reconnect.port = 'stale.invalid.example:1666';
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  const registry = await readJson(context.registry);
  registry.settings = { P4PORT: 'fake:1666', P4CHARSET: 'utf8' };
  registry.requiredPort = 'fake:1666';
  await fs.writeFile(context.registry, `${JSON.stringify(registry, null, 2)}\n`);
  return config.brokerUuid;
}

function destructiveCommands(registry) {
  return registry.log.filter((entry) => ['shelve', 'change', 'client'].includes(entry.command) && entry.args[0] === '-d');
}

test('cleanup requirement inspection is generation-pinned and survives cleanup markers and completion', async () => {
  const context = await setup(1);
  try {
    await run(context.initArgs, { timeout: 120000 });
    const config = await readJson(path.join(context.stateDir, 'config.json'));
    const slotsPath = path.join(context.stateDir, 'slots.json');
    const slots = await readJson(slotsPath);
    slots.slots[0].humanOwner = 'retained-human';
    slots.slots[0].humanOwnerState = 'ready';
    await fs.writeFile(slotsPath, `${JSON.stringify(slots, null, 2)}\n`);
    await fs.writeFile(path.join(context.stateDir, 'CLEANUP_IN_PROGRESS'), `${config.brokerUuid}\n`);

    const active = await inspectAgentWorkspaceCleanupRequirement({
      stateDir: context.stateDir, brokerUuid: config.brokerUuid,
    });
    assert.deepEqual(Object.keys(active).sort(), ['brokerUuidMatches', 'completed', 'hasHumanSlots']);
    assert.deepEqual(active, { brokerUuidMatches: true, completed: false, hasHumanSlots: true });
    const mismatch = await inspectAgentWorkspaceCleanupRequirement({
      stateDir: context.stateDir, brokerUuid: '00000000-0000-4000-8000-000000000000',
    });
    assert.equal(mismatch.brokerUuidMatches, false);

    await cleanupAgentWorkspaceAfterApproval({
      stateDir: context.stateDir, brokerUuid: config.brokerUuid, allowHumanSlots: true,
    });
    const completed = await inspectAgentWorkspaceCleanupRequirement({
      stateDir: context.stateDir, brokerUuid: config.brokerUuid,
    });
    assert.deepEqual(completed, { brokerUuidMatches: true, completed: true, hasHumanSlots: false });
  } finally {
    await dispose(context);
  }
});

test('public cleanup cannot recover a legacy endpoint but the internal typed path can bind and resume', async () => {
  const context = await setup(1);
  try {
    await run(context.initArgs, { timeout: 120000 });
    const brokerUuid = await makeLegacyEndpointStale(context);
    await assert.rejects(cleanupAgentWorkspace({ stateDir: context.stateDir, expectedBrokerUuid: brokerUuid }));
    assert.deepEqual(destructiveCommands(await readJson(context.registry)), []);
    const journalBefore = await readJson(`${context.stateDir}.cleanup-journal.json`);
    assert.equal(journalBefore.p4Recovery, undefined);

    const result = await cleanupAgentWorkspaceAfterApproval({
      stateDir: context.stateDir, brokerUuid, allowHumanSlots: false,
    });
    assert.equal(result.state, 'completed');
    const completedJournal = await readJson(`${context.stateDir}.cleanup-journal.json`);
    assert.equal(completedJournal.p4Recovery.brokerUuid, brokerUuid);
    assert.equal(completedJournal.p4Recovery.profile.port, 'fake:1666');
  } finally {
    await dispose(context);
  }
});

test('cleanup recovery binding survives a crash, resets stale P4 phases, and ignores ambient drift', async () => {
  const context = await setup(1);
  try {
    await run(context.initArgs, { timeout: 120000 });
    const brokerUuid = await makeLegacyEndpointStale(context);
    process.env.AGENT_WORKSPACE_TEST_FAIL_AFTER_CLEANUP_RECOVERY_BINDING = '1';
    try {
      await assert.rejects(cleanupAgentWorkspaceAfterApproval({
        stateDir: context.stateDir, brokerUuid, allowHumanSlots: false,
      }), /simulated crash/);
    } finally {
      delete process.env.AGENT_WORKSPACE_TEST_FAIL_AFTER_CLEANUP_RECOVERY_BINDING;
    }
    const journalPath = `${context.stateDir}.cleanup-journal.json`;
    const journal = await readJson(journalPath);
    assert.equal(journal.p4Recovery.profile.port, 'fake:1666');
    await assert.rejects(cleanupAgentWorkspace({
      stateDir: context.stateDir, expectedBrokerUuid: brokerUuid,
    }), /endpoint recovery requires internal authorization/);
    assert.deepEqual(destructiveCommands(await readJson(context.registry)), []);
    journal.state = 'failed';
    journal.errors = ['stale failure'];
    journal.phases.prepare_p4_endpoint = { completedAt: new Date().toISOString() };
    journal.phases.cleanup_owned_integrations = { completedAt: new Date().toISOString() };
    await fs.writeFile(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
    const registry = await readJson(context.registry);
    registry.settings.P4PORT = 'drifted.example:1666';
    await fs.writeFile(context.registry, `${JSON.stringify(registry, null, 2)}\n`);
    const setCallsBeforeRetry = registry.log.filter((entry) => entry.command === 'set').length;

    const result = await cleanupAgentWorkspaceAfterApproval({
      stateDir: context.stateDir, brokerUuid, allowHumanSlots: false,
    });
    assert.equal(result.state, 'completed');
    const after = await readJson(context.registry);
    assert.equal(after.log.filter((entry) => entry.command === 'set').length, setCallsBeforeRetry);
    assert.ok(destructiveCommands(after).length > 0);
  } finally {
    await dispose(context);
  }
});

test('cleanup recovery rejects identity and ownership mismatch without destructive P4 commands', async () => {
  for (const corrupt of [
    (registry) => { registry.user = 'other'; },
    (registry) => { registry.serverID = 'other-server'; },
    (registry) => { registry.clients[Object.keys(registry.clients).find((name) => name !== 'base')].Root += '-foreign'; },
  ]) {
    const context = await setup(1);
    try {
      await run(context.initArgs, { timeout: 120000 });
      const brokerUuid = await makeLegacyEndpointStale(context);
      const registry = await readJson(context.registry);
      corrupt(registry);
      await fs.writeFile(context.registry, `${JSON.stringify(registry, null, 2)}\n`);
      await assert.rejects(cleanupAgentWorkspaceAfterApproval({
        stateDir: context.stateDir, brokerUuid, allowHumanSlots: false,
      }));
      assert.deepEqual(destructiveCommands(await readJson(context.registry)), []);
    } finally {
      await dispose(context);
    }
  }
});

test('cleanup fails closed on unrecorded opens and retains providers, roots, and state', async () => {
  const context = await setup(1);
  try {
    await run(context.initArgs, { timeout: 120000 });
    const slots = await readJson(path.join(context.stateDir, 'slots.json'));
    const registry = await readJson(context.registry);
    registry.opened.push({ client: slots.slots[0].p4.client, depotFile: normalPath, action: 'edit', change: 'default' });
    await fs.writeFile(context.registry, `${JSON.stringify(registry, null, 2)}\n`);
    await assert.rejects(run(['cleanup', '--state-dir', context.stateDir], { timeout: 120000 }), /unrecorded opens/);
    assert.equal(await fs.access(context.stateDir).then(() => true, () => false), true);
    assert.equal(await fs.access(slots.slots[0].root).then(() => true, () => false), true);
    const retainedSlots = await readJson(path.join(context.stateDir, 'slots.json'));
    assert.notEqual(retainedSlots.slots[0].provider?.state, 'stopped');
  } finally {
    await dispose(context);
  }
});
