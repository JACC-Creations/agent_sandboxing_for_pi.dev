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
