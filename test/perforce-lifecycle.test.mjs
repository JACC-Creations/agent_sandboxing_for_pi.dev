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

test('task creates one stable change, injects sanitized environment, and records no-change checkpoint', async () => {
  const context = await setup(1);
  try {
    await run(context.initArgs, { timeout: 20000 });
    const output = path.join(context.temporaryRoot, 'environment.json');
    const started = JSON.parse((await run(['start', '--state-dir', context.stateDir, '--resource-class', 'light', '--', process.execPath, environmentFixture, output])).stdout);
    const task = await waitFor(context.stateDir, started.taskId, (candidate) => ['completed', 'failed'].includes(candidate.state), 60000);
    assert.equal(task.state, 'completed');
    assert.equal(task.version, 7);
    assert.equal(task.p4.artifactState, 'no_changes');
    const environment = await readJson(output);
    assert.equal(environment.P4CLIENT, task.p4.client);
    assert.equal(environment.P4_CHANGE, task.p4.changeResource.change);
    assert.equal(environment.AGENT_WORKSPACE_P4_CHANGE, task.p4.changeResource.change);
    assert.equal(environment.AGENT_WORKSPACE_STATE_DIR, context.stateDir);
    assert.equal(environment.TASK_ID, task.id);
    assert.deepEqual(environment.secretKeys, []);
    const registry = await readJson(context.registry);
    assert.equal(Object.keys(registry.changes).length, 1);
  } finally {
    await dispose(context);
  }
});

test('unknown task change creation outcome recovers without a duplicate changelist', async () => {
  const context = await setup(1, { change: { times: 1, afterCreate: true, error: 'connection dropped after create' } });
  try {
    await run(context.initArgs, { timeout: 20000 });
    const started = JSON.parse((await run(['start', '--state-dir', context.stateDir, '--resource-class', 'light', '--', process.execPath, '-e', 'process.exit(0)'])).stdout);
    const task = await waitFor(context.stateDir, started.taskId, (candidate) => ['completed', 'failed'].includes(candidate.state), 60000);
    assert.equal(task.state, 'completed');
    const registry = await readJson(context.registry);
    assert.equal(Object.keys(registry.changes).length, 1);
    assert.equal(registry.log.filter((entry) => entry.command === 'change' && entry.args[0] === '-i').length, 1);
  } finally {
    await dispose(context);
  }
});

test('successful command becomes artifact_failed when automatic shelving fails', async () => {
  const context = await setup(1);
  try {
    await run(context.initArgs, { timeout: 20000 });
    const started = JSON.parse((await run(['start', '--state-dir', context.stateDir, '--resource-class', 'light', '--', process.execPath, '-e', 'process.exit(0)'])).stdout);
    await waitFor(context.stateDir, started.taskId, (task) => task.state === 'completed', 60000);
    await run(['p4', 'open', '--state-dir', context.stateDir, started.taskId, '--action', 'edit', '--', normalPath]);
    const registry = await readJson(context.registry);
    registry.faults.shelve = { times: 1, error: 'injected shelf failure' };
    await fs.writeFile(context.registry, `${JSON.stringify(registry, null, 2)}\n`);
    await run(['run', '--state-dir', context.stateDir, started.taskId, '--resource-class', 'light', '--', process.execPath, '-e', 'process.exit(0)']);
    const task = await waitFor(context.stateDir, started.taskId, (candidate) => candidate.state === 'artifact_failed', 60000);
    assert.equal(task.exitCode, 0);
    assert.equal(task.p4.artifactState, 'checkpoint_failed');
    assert.match(task.error, /automatic Perforce checkpoint failed.*injected shelf failure/);
  } finally {
    await dispose(context);
  }
});

test('bind retries converge after faults following each exact ledger replacement', async () => {
  for (const fault of ['AGENT_WORKSPACE_TEST_FAIL_AFTER_CHANGE_LEDGER_REPLACEMENT', 'AGENT_WORKSPACE_TEST_FAIL_AFTER_SHELF_LEDGER_REPLACEMENT']) {
    const context = await setup(1);
    try {
      await run(context.initArgs, { timeout: 20000 });
      const started = JSON.parse((await run(
        ['start', '--state-dir', context.stateDir, '--resource-class', 'light', '--', process.execPath, '-e', 'process.exit(0)'],
        { env: { [fault]: '1' } },
      )).stdout);
      await waitFor(context.stateDir, started.taskId, (task) => task.state === 'failed', 60000);
      await run(['run', '--state-dir', context.stateDir, started.taskId, '--resource-class', 'light', '--', process.execPath, '-e', 'process.exit(0)']);
      const retried = await waitFor(context.stateDir, started.taskId, (task) => task.attempt === 2 && task.state === 'completed', 60000);
      assert.ok(retried.p4.changeResource.change);
      assert.equal(retried.p4.shelfResource.change, retried.p4.changeResource.change);
      assert.equal(Object.keys((await readJson(context.registry)).changes).length, 1);
    } finally {
      await dispose(context);
    }
  }
});
