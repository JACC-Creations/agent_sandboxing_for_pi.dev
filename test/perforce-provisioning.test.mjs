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

test('init provisions distinct empty clients and persists the exact protected baseline', async () => {
  const context = await setup();
  try {
    const initialized = await run(context.initArgs, { timeout: 20000 });
    assert.equal(initialized.stdout.includes('serverFingerprint'), false);
    assert.equal(initialized.stdout.includes('reconnect'), false);
    const [config, slots, registry] = await Promise.all([
      readJson(path.join(context.stateDir, 'config.json')),
      readJson(path.join(context.stateDir, 'slots.json')),
      readJson(context.registry),
    ]);
    assert.equal(config.version, 10);
    assert.deepEqual(config.revisionControl, { version: 1, mode: 'p4' });
    assert.deepEqual(config.p4.baseline.protectedDepotPaths, [protectedPath]);
    assert.equal(config.p4.baseline.opened.length, 1);
    assert.deepEqual(config.p4.baseline.opened[0], {
      depotFile: protectedPath,
      haveRev: '10',
      action: 'edit',
      change: '8123',
      client: 'base',
      relativeLowerPath: 'Protected.cpp',
      sha256: 'acd177914d93ccb72de1cf51c1792eb1eacec49fcbb82fde92e5d4c874e19bf3',
    });
    assert.equal(slots.version, 4);
    assert.equal(new Set(slots.slots.map((slot) => slot.p4.client)).size, 2);
    for (const slot of slots.slots) {
      assert.equal(slot.p4.state, 'ready');
      assert.equal(registry.clients[slot.p4.client].Root, slot.root);
      assert.deepEqual(registry.have[slot.p4.client], {});
    }
    const statusOutput = (await run(['status', '--state-dir', context.stateDir])).stdout;
    assert.equal(statusOutput.includes('serverFingerprint'), false);
    assert.equal(statusOutput.includes('reconnect'), false);
    const cleanedOutput = (await run(['cleanup', '--state-dir', context.stateDir], { timeout: 120000 })).stdout;
    assert.equal(cleanedOutput.includes('serverFingerprint'), false);
    assert.equal(cleanedOutput.includes('p4Reconnect'), false);
    const cleaned = JSON.parse(cleanedOutput);
    const receipt = await readJson(`${context.stateDir}.cleanup-receipt.json`);
    assert.equal(receipt.version, 2);
    assert.equal(typeof receipt.p4Reconnect.serverFingerprint, 'string');
    const afterCleanup = await readJson(context.registry);
    assert.deepEqual(Object.keys(afterCleanup.clients), ['base']);
    assert.ok(cleaned.removed.findIndex((resource) => resource.type === 'p4-client')
      < cleaned.removed.findIndex((resource) => resource.type === 'projfs-root'));
  } finally {
    await dispose(context);
  }
});

test('mutation between preliminary discovery and guard readiness fails and quarantines provisioning', async () => {
  const context = await setup(1);
  try {
    await fs.writeFile(path.join(context.lower, '.fake-lower-guard.json'), `${JSON.stringify({
      mutateBeforeReady: { relativePath: 'Protected.cpp', contents: 'mutated after discovery' },
    })}\n`);
    await assert.rejects(run(context.initArgs, { timeout: 20000 }), /protected baseline no longer exactly matches/);
    const quarantine = await readJson(path.join(context.stateDir, 'lower-quarantine.json'));
    assert.equal(quarantine.state, 'quarantined');
    assert.match(quarantine.reason, /Perforce provisioning failed/);
  } finally {
    await dispose(context);
  }
});

test('partial provisioning remains cleanup-capable and cleanup preserves the base client', async () => {
  const context = await setup(2, { client: { times: 1, args0: '-i', error: 'injected provisioning failure' } });
  try {
    await assert.rejects(run(context.initArgs, { timeout: 20000 }), /provisioning failure/);
    const slots = await readJson(path.join(context.stateDir, 'slots.json'));
    assert.equal(slots.slots[0].p4.state, 'quarantined');
    await run(['cleanup', '--state-dir', context.stateDir], { timeout: 120000 });
    const registry = await readJson(context.registry);
    assert.ok(registry.clients.base);
    assert.deepEqual(Object.keys(registry.clients), ['base']);
    assert.equal(await fs.access(context.rootParent).then(() => true, () => false), true);
    assert.deepEqual(await fs.readdir(context.rootParent), []);
  } finally {
    await dispose(context);
  }
});

test('tampered ownership fails closed without deleting the client or projected root', async () => {
  const context = await setup(1);
  try {
    await run(context.initArgs, { timeout: 20000 });
    const slots = await readJson(path.join(context.stateDir, 'slots.json'));
    const registry = await readJson(context.registry);
    registry.clients[slots.slots[0].p4.client].Description = registry.clients[slots.slots[0].p4.client].Description.replace(slots.slots[0].p4.nonce, 'foreign-nonce');
    await fs.writeFile(context.registry, `${JSON.stringify(registry, null, 2)}\n`);
    await assert.rejects(run(['cleanup', '--state-dir', context.stateDir], { timeout: 120000 }), /ownership verification failed/);
    assert.equal(await fs.access(slots.slots[0].root).then(() => true, () => false), true);
    assert.ok((await readJson(context.registry)).clients[slots.slots[0].p4.client]);
  } finally {
    await dispose(context);
  }
});
