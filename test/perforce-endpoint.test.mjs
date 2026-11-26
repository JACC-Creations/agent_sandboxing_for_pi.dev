import {
  assert,
  dispose,
  fs,
  path,
  readJson,
  run,
  setup,
  test,
} from './helpers/perforce-integration-fixture.mjs';

function withoutFlag(args, flag) {
  const index = args.indexOf(flag);
  return index < 0 ? [...args] : [...args.slice(0, index), ...args.slice(index + 2)];
}

async function updateRegistry(context, callback) {
  const registry = await readJson(context.registry);
  callback(registry);
  await fs.writeFile(context.registry, `${JSON.stringify(registry, null, 2)}\n`);
}

test('init persists and uses effective P4PORT instead of info serverAddress', async () => {
  const context = await setup(1);
  try {
    await updateRegistry(context, (registry) => {
      registry.serverAddress = 'internal-node.example:1666';
      registry.settings = { P4PORT: 'edge.example:1666' };
      registry.requiredPort = 'edge.example:1666';
    });
    await run(withoutFlag(context.initArgs, '--p4-port'), { timeout: 120000 });
    const config = await readJson(path.join(context.stateDir, 'config.json'));
    assert.equal(config.p4.port, 'edge.example:1666');
    assert.equal(config.p4.reconnect.port, 'edge.example:1666');
    assert.notEqual(config.p4.port, 'internal-node.example:1666');
    const registry = await readJson(context.registry);
    assert.ok(registry.log.some((entry) => entry.command === 'set' && entry.args[1] === 'P4PORT'));
    assert.ok(registry.log.some((entry) => entry.command === 'info'));
  } finally {
    await dispose(context);
  }
});

test('explicit endpoint settings take precedence over ambient p4 set values', async () => {
  const context = await setup(1);
  try {
    await updateRegistry(context, (registry) => {
      registry.serverAddress = 'internal-node.example:1666';
      registry.settings = { P4PORT: 'wrong.example:1666', P4CHARSET: 'utf16' };
      registry.requiredPort = 'fake:1666';
    });
    await run(context.initArgs, { timeout: 120000 });
    const config = await readJson(path.join(context.stateDir, 'config.json'));
    assert.equal(config.p4.port, 'fake:1666');
    assert.equal(config.p4.charset, 'utf8');
    const queried = (await readJson(context.registry)).log
      .filter((entry) => entry.command === 'set')
      .map((entry) => entry.args[1]);
    assert.equal(queried.includes('P4PORT'), false);
    assert.equal(queried.includes('P4CHARSET'), false);
  } finally {
    await dispose(context);
  }
});

test('missing, malformed, or unusable effective P4PORT fails before generation resources exist', async () => {
  for (const configure of [
    (registry) => { registry.settings = {}; },
    (registry) => { registry.settings = { P4PORT: 'bad endpoint' }; },
    (registry) => { registry.settings = { P4PORT: ' edge.example:1666' }; },
    (registry) => { registry.settings = { P4PORT: 'edge.example:1666 ' }; },
    (registry) => { registry.settings = { P4PORT: 'unusable.example:1666' }; registry.requiredPort = 'other.example:1666'; },
  ]) {
    const context = await setup(1);
    try {
      await updateRegistry(context, configure);
      await assert.rejects(run(withoutFlag(context.initArgs, '--p4-port'), { timeout: 30000 }));
      assert.equal(await fs.access(context.stateDir).then(() => true, () => false), false);
      assert.equal(await fs.access(context.rootParent).then(() => true, () => false), false);
    } finally {
      await dispose(context);
    }
  }
});

test('effective P4TICKETS accepts a bounded 32 KiB path without truncating framing', async () => {
  const context = await setup(1);
  try {
    const prefix = `${path.parse(context.temporaryRoot).root}tickets-`;
    const ticketFile = `${prefix}${'x'.repeat(32_768 - Buffer.byteLength(prefix, 'utf8'))}`;
    assert.equal(Buffer.byteLength(ticketFile, 'utf8'), 32_768);
    await updateRegistry(context, (registry) => {
      registry.settings = { P4PORT: 'fake:1666', P4TICKETS: ticketFile };
      registry.requiredPort = 'fake:1666';
    });
    const args = withoutFlag(withoutFlag(context.initArgs, '--p4-port'), '--p4-charset');
    await run(args, { timeout: 120000 });
    const config = await readJson(path.join(context.stateDir, 'config.json'));
    assert.equal(config.p4.ticketFile, ticketFile);
    assert.equal(config.p4.reconnect.ticketFile, ticketFile);
  } finally {
    await dispose(context);
  }
});
