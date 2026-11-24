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

test('lazy open shelves and replaces the same artifact across reruns while protected paths reject by default', async () => {
  const context = await setup(1);
  try {
    await run(context.initArgs, { timeout: 120000 });
    const started = JSON.parse((await run(['start', '--state-dir', context.stateDir, '--resource-class', 'light', '--', process.execPath, '-e', 'process.exit(0)'])).stdout);
    await waitFor(context.stateDir, started.taskId, (task) => task.state === 'completed', 60000);
    await assert.rejects(run(['p4', 'open', '--state-dir', context.stateDir, started.taskId, '--action', 'edit', '--', protectedPath]), /protected/);
    await run(['p4', 'open', '--state-dir', context.stateDir, started.taskId, '--action', 'edit', '--', normalPath]);
    await run(['run', '--state-dir', context.stateDir, started.taskId, '--resource-class', 'light', '--', process.execPath, '-e', 'process.exit(0)']);
    let task = await waitFor(context.stateDir, started.taskId, (candidate) => candidate.attempt === 2 && candidate.state === 'completed', 60000);
    assert.equal(task.p4.artifactState, 'shelved');
    const change = task.p4.changeResource.change;
    await run(['run', '--state-dir', context.stateDir, started.taskId, '--resource-class', 'light', '--', process.execPath, '-e', 'process.exit(0)']);
    task = await waitFor(context.stateDir, started.taskId, (candidate) => candidate.attempt === 3 && candidate.state === 'completed', 60000);
    assert.equal(task.p4.changeResource.change, change);
    const registry = await readJson(context.registry);
    assert.ok(registry.shelves[change]);
    assert.equal(registry.log.filter((entry) => entry.command === 'change' && entry.args[0] === '-i').length, 1);
    assert.ok(registry.log.some((entry) => entry.command === 'shelve' && entry.args.includes('-r')));
  } finally {
    await dispose(context);
  }
});

test('protected opt-in persists for automatic checkpoint while protected unshelve rejects by default', async () => {
  const context = await setup(1);
  try {
    await run(context.initArgs, { timeout: 120000 });
    const started = JSON.parse((await run(['start', '--state-dir', context.stateDir, '--resource-class', 'light', '--', process.execPath, '-e', 'process.exit(0)'])).stdout);
    await waitFor(context.stateDir, started.taskId, (task) => task.state === 'completed', 60000);
    await run(['p4', 'open', '--state-dir', context.stateDir, started.taskId, '--action', 'edit', '--allow-protected-base', '--', protectedPath]);
    let task = await readJson(path.join(context.stateDir, 'tasks', `${started.taskId}.json`));
    assert.deepEqual(task.p4.allowedProtectedPaths, [protectedPath]);
    await run(['run', '--state-dir', context.stateDir, started.taskId, '--resource-class', 'light', '--', process.execPath, '-e', 'process.exit(0)']);
    task = await waitFor(context.stateDir, started.taskId, (candidate) => candidate.attempt === 2 && candidate.state === 'completed', 60000);
    assert.equal(task.p4.artifactState, 'shelved');
    const registry = await readJson(context.registry);
    registry.shelves[9000] = [{ depotFile: protectedPath, action: 'edit', rev: '10' }];
    registry.opened = registry.opened.filter((entry) => entry.client !== task.p4.client);
    await fs.writeFile(context.registry, `${JSON.stringify(registry, null, 2)}\n`);
    await assert.rejects(run(['p4', 'unshelve', '--state-dir', context.stateDir, started.taskId, '--source-change', '9000']), /unshelve rejects inherited protected/);
  } finally {
    await dispose(context);
  }
});

test('rerun with no opens retains the stable shelf artifact', async () => {
  const context = await setup(1);
  try {
    await run(context.initArgs, { timeout: 120000 });
    const started = JSON.parse((await run(['start', '--state-dir', context.stateDir, '--resource-class', 'light', '--', process.execPath, '-e', 'process.exit(0)'])).stdout);
    await waitFor(context.stateDir, started.taskId, (task) => task.state === 'completed', 60000);
    await run(['p4', 'open', '--state-dir', context.stateDir, started.taskId, '--action', 'edit', '--', normalPath]);
    await run(['run', '--state-dir', context.stateDir, started.taskId, '--resource-class', 'light', '--', process.execPath, '-e', 'process.exit(0)']);
    const shelved = await waitFor(context.stateDir, started.taskId, (task) => task.attempt === 2 && task.state === 'completed', 60000);
    const registry = await readJson(context.registry);
    registry.opened = registry.opened.filter((entry) => entry.client !== shelved.p4.client);
    await fs.writeFile(context.registry, `${JSON.stringify(registry, null, 2)}\n`);
    await run(['run', '--state-dir', context.stateDir, started.taskId, '--resource-class', 'light', '--', process.execPath, '-e', 'process.exit(0)']);
    const retained = await waitFor(context.stateDir, started.taskId, (task) => task.attempt === 3 && task.state === 'completed', 60000);
    assert.equal(retained.p4.artifactState, 'shelf_retained');
    assert.equal(retained.p4.shelfResource.change, shelved.p4.changeResource.change);
  } finally {
    await dispose(context);
  }
});

test('handoff rejects an empty task before creating review resources', async () => {
  const context = await setup(1);
  try {
    await run(context.initArgs, { timeout: 120000 });
    const started = JSON.parse((await run(['start', '--state-dir', context.stateDir, '--resource-class', 'light', '--', process.execPath, '-e', 'process.exit(0)'])).stdout);
    await waitFor(context.stateDir, started.taskId, (task) => task.state === 'completed', 60000);
    const beforeOwnership = await readJson(path.join(context.stateDir, 'ownership.json'));
    await assert.rejects(run(['p4', 'handoff', '--state-dir', context.stateDir, started.taskId]), /nonempty stable shelf/);
    assert.deepEqual(await readJson(path.join(context.stateDir, 'ownership.json')), beforeOwnership);
    const registry = await readJson(context.registry);
    assert.equal(registry.log.some((entry) => entry.command === 'reshelve'), false);
  } finally {
    await dispose(context);
  }
});
