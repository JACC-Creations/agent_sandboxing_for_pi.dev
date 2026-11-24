import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { canonicalShelf, createP4, verifyHandoffShelf } from '../src/perforce.mjs';

const fakeP4 = fileURLToPath(new URL('./fixtures/fake-p4.mjs', import.meta.url));
const earlyExitP4 = fileURLToPath(new URL('./fixtures/early-exit-p4.mjs', import.meta.url));

async function withFakeShelf(callback) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'p4-handoff-metadata-'));
  const registry = path.join(root, 'registry.json');
  const base = {
    user: 'agent',
    clients: {},
    have: {},
    opened: [],
    changes: {},
    shelves: {},
    nextChange: 1,
    faults: {},
    log: [],
  };
  const write = async (overrides = {}) => {
    await fs.writeFile(registry, `${JSON.stringify({ ...base, ...overrides }, null, 2)}\n`);
  };
  const makeP4 = (options = {}) => createP4({
    executable: fakeP4,
    testMode: true,
    fakeScript: fakeP4,
    env: { FAKE_P4_REGISTRY: registry },
    P4PORT: 'fake:1666',
    P4USER: 'agent',
    ...options,
  });
  const p4 = makeP4();
  try {
    await callback({ p4, makeP4, registry, write });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

const contentFile = { depotFile: '//Depot/Main/File.cpp', action: 'edit', rev: '7', type: 'text', digest: 'shelf-digest', fileSize: '123' };

test('canonical shelf metadata accepts complete shelf/direct families and prefers shelf-specific fields', async () => {
  await withFakeShelf(async ({ p4, write }) => {
    for (const shape of ['shelved', 'direct', 'both']) {
      await write({ shelves: { 10: [{ ...contentFile, fstatShape: shape }] } });
      const shelf = await canonicalShelf(p4, { client: 'worker', change: 10 });
      assert.equal(shelf.records[0].metadata.digest, 'shelf-digest');
      assert.equal(shelf.records[0].metadata.fileSize, '123');
      assert.equal(shelf.records[0].metadata.type, 'text');
    }

    const moved = [
      { depotFile: '//Depot/Main/New.cpp', action: 'move/add', rev: '8', type: 'text', movedFile: '//Depot/Main/Old.cpp', movedRev: '7', fstatShape: 'shelved' },
      { depotFile: '//Depot/Main/Old.cpp', action: 'move/delete', rev: '7', type: 'text', movedFile: '//Depot/Main/New.cpp', movedRev: '8', fstatShape: 'shelved' },
      { depotFile: '//Depot/Main/Gone.cpp', action: 'delete', rev: '4', type: 'binary', fstatShape: 'direct' },
    ];
    await write({ shelves: { 11: moved } });
    const shelf = await canonicalShelf(p4, { client: 'worker', change: 11 });
    assert.deepEqual(shelf.records.find((record) => record.action === 'move/delete').metadata, {
      depotFile: '//Depot/Main/Old.cpp', digest: null, fileSize: null, type: 'text',
    });
    assert.deepEqual(shelf.records.find((record) => record.action === 'delete').metadata, {
      depotFile: '//Depot/Main/Gone.cpp', digest: null, fileSize: null, type: 'binary',
    });
  });
});

test('canonical shelf metadata streams exact binary print with bounded content only when metadata is wholly absent', async () => {
  await withFakeShelf(async ({ p4, makeP4, registry, write }) => {
    const content = Buffer.from([0x00, 0xff, 0x80, 0x41, 0x0a, 0xc3, 0x28]);
    await write({
      shelves: {
        12: [{ ...contentFile, fstatShape: 'absent', contentBase64: content.toString('base64') }],
      },
    });
    const shelf = await canonicalShelf(p4, { client: 'worker', change: 12 });
    assert.equal(shelf.records[0].metadata.digest, crypto.createHash('sha256').update(content).digest('hex'));
    assert.equal(shelf.records[0].metadata.fileSize, String(content.length));
    assert.equal(shelf.records[0].metadata.type, 'text');

    const exactLimit = Buffer.alloc(1024, 0xa5);
    exactLimit[0] = 0x00;
    exactLimit[1] = 0xff;
    exactLimit[2] = 0x80;
    await write({
      shelves: {
        13: [{ ...contentFile, fstatShape: 'absent', contentBase64: exactLimit.toString('base64') }],
      },
    });
    const boundedP4 = makeP4({ maxShelvedFileBytes: exactLimit.length });
    const boundedShelf = await canonicalShelf(boundedP4, { client: 'worker', change: 13 });
    assert.equal(boundedShelf.records[0].metadata.digest, crypto.createHash('sha256').update(exactLimit).digest('hex'));
    assert.equal(boundedShelf.records[0].metadata.fileSize, String(exactLimit.length));
    const state = JSON.parse(await fs.readFile(registry, 'utf8'));
    const print = state.log.find((entry) => entry.command === 'print');
    assert.equal(print.argv.includes('-ztag'), false);
    assert.deepEqual(print.args, ['-q', '//Depot/Main/File.cpp@=13']);

    const overLimit = Buffer.concat([exactLimit, Buffer.from([0x00])]);
    await write({
      shelves: {
        14: [{ ...contentFile, fstatShape: 'absent', contentBase64: overLimit.toString('base64') }],
      },
    });
    await assert.rejects(
      canonicalShelf(boundedP4, { client: 'worker', change: 14 }),
      (error) => error.message === 'p4 print failed for exact shelved content',
    );
  });
});

test('binary print rejection waits for the spawned child to exit', async () => {
  await withFakeShelf(async ({ p4, registry, write }) => {
    const exitMarker = `${registry}.print-exiting`;
    await write({
      shelves: {
        15: [{ ...contentFile, fstatShape: 'absent', contentBase64: 'AA==' }],
      },
      printExitMarker: exitMarker,
    });

    await assert.rejects(
      canonicalShelf(p4, { client: 'worker', change: 15 }),
      (error) => error.message === 'p4 print failed for exact shelved content',
    );
    assert.equal(await fs.readFile(exitMarker, 'utf8'), 'exiting\n');
  });
});

test('canonical shelf metadata rejects incomplete, mixed, head-only, duplicate, and malformed evidence', async () => {
  await withFakeShelf(async ({ p4, write }) => {
    for (const shape of ['missing-digest', 'missing-size', 'mixed', 'head-only', 'duplicate']) {
      await write({ shelves: { 20: [{ ...contentFile, fstatShape: shape }] } });
      await assert.rejects(canonicalShelf(p4, { client: 'worker', change: 20 }), /incomplete|exact shelved evidence|duplicate/);
    }

    await write({ shelves: { 21: [{ ...contentFile, describeShape: 'missing-action' }] } });
    await assert.rejects(canonicalShelf(p4, { client: 'worker', change: 21 }), /missing action/);

    await write({ shelves: { 22: [contentFile] }, describeShape: 'duplicate-first' });
    await assert.rejects(canonicalShelf(p4, { client: 'worker', change: 22 }), /duplicate indexed field/);

    await write({ shelves: { 23: [{ ...contentFile, action: 'move/add', movedFile: '//Depot/Main/Missing.cpp', movedRev: '1' }] } });
    await assert.rejects(canonicalShelf(p4, { client: 'worker', change: 23 }), /move pair/);
  });
});

test('binary print fallback rejects mismatch and sanitizes print, timeout, and early-stdin failures', async () => {
  await withFakeShelf(async ({ p4, makeP4, write }) => {
    const ownership = {
      brokerUuid: 'broker',
      nonce: 'nonce',
      client: 'review',
      change: '31',
      taskId: 'task',
      user: 'agent',
    };
    const description = [
      'AgentWorkspace-Owned: true',
      'AgentWorkspace-Broker: broker',
      'AgentWorkspace-Nonce: nonce',
      'AgentWorkspace-Task: task',
      'AgentWorkspace-Client: review',
      'AgentWorkspace-Change: review-handoff',
    ].join('\n');
    await write({
      changes: {
        31: { Change: '31', Client: 'review', User: 'agent', Status: 'pending', Description: description },
      },
      shelves: {
        30: [{ ...contentFile, fstatShape: 'absent', contentBase64: Buffer.from([0x00, 0xff]).toString('base64') }],
        31: [{ ...contentFile, fstatShape: 'absent', contentBase64: Buffer.from([0x00, 0xfe]).toString('base64') }],
      },
    });
    await assert.rejects(verifyHandoffShelf(p4, {
      sourceClient: 'worker',
      sourceChange: 30,
      destinationChangeResource: ownership,
    }), /do not exactly match/);

    await write({
      shelves: { 32: [{ ...contentFile, fstatShape: 'absent', contentBase64: 'AA==' }] },
      faults: { print: { times: 1, error: 'sensitive fake output' } },
    });
    await assert.rejects(
      canonicalShelf(p4, { client: 'worker', change: 32 }),
      (error) => error.message === 'p4 print failed for exact shelved content',
    );

    await write({
      shelves: { 33: [{ ...contentFile, fstatShape: 'absent', contentBase64: 'AA==' }] },
      printDelayMs: 1_000,
    });
    await assert.rejects(
      canonicalShelf(makeP4({ timeoutMs: 500 }), { client: 'worker', change: 33 }),
      (error) => error.message === 'p4 print failed for exact shelved content',
    );
  });

  const earlyExit = createP4({
    executable: earlyExitP4,
    testMode: true,
    fakeScript: earlyExitP4,
    P4PORT: 'fake:1666',
    P4USER: 'agent',
  });
  await assert.rejects(
    earlyExit.run(['client', '-i'], { input: Buffer.alloc(8 * 1024 * 1024, 0xa5) }),
    /p4 client failed: early exit from fake p4/,
  );
});
