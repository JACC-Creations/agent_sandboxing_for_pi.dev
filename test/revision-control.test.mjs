import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
import { openAgentWorkspaceP4 } from '../src/api.mjs';
import { initialize, loadConfig } from '../src/broker.mjs';
import { cleanupBroker } from '../src/cleanup.mjs';
import { resolveProviderExecutable } from '../src/cli.mjs';
import { cleanupP4Ledger } from '../src/perforce-state.mjs';
import { revisionControlCompletions, runRevisionControlCommand } from '../src/revision-control-command.mjs';
import {
  projectPreferencePath,
  readProjectPreference,
  writeProjectPreference,
} from '../src/revision-control-preference.mjs';
import { revisionControlBackend, revisionControlMode, revisionControlStatus } from '../src/revision-control.mjs';

const execFileAsync = promisify(execFile);
const cli = path.resolve(import.meta.dirname, '..', 'bin', 'agent-workspace.mjs');

async function temporaryProject() {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-workspace-revision-control-'));
  const workspace = path.join(cwd, 'workspace');
  await fs.mkdir(workspace);
  return { cwd, workspace, stateDir: path.join(cwd, 'state') };
}

function initOptions(workspace, revisionControl) {
  return {
    workspace,
    maxSlots: 1,
    adapter: 'test',
    pollMs: 50,
    revisionControl,
  };
}

async function removeProject(project) {
  await fs.rm(project.cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

test('CLI resolves the bundled production provider without changing explicit or test selections', () => {
  assert.equal(
    resolveProviderExecutable(),
    path.resolve(import.meta.dirname, '..', 'native', 'projfs-provider', 'bin', 'win32-x64', 'projfs-provider.exe'),
  );
  assert.equal(resolveProviderExecutable({ providerExe: 'C:\\custom\\provider.exe' }), 'C:\\custom\\provider.exe');
  assert.equal(resolveProviderExecutable({ adapter: 'projfs', testMode: true }), undefined);
  assert.equal(resolveProviderExecutable({ adapter: 'test' }), undefined);
});

test('project preference persists atomically and rejects every noncanonical shape', async () => {
  const project = await temporaryProject();
  try {
    assert.equal(await readProjectPreference(project.cwd), null);
    assert.deepEqual(await writeProjectPreference(project.cwd, 'lore'), { version: 1, revisionControl: 'lore' });
    assert.deepEqual(await readProjectPreference(project.cwd), { version: 1, revisionControl: 'lore' });
    assert.deepEqual(await fs.readdir(path.dirname(projectPreferencePath(project.cwd))), ['agent-workspace.json']);
    assert.deepEqual(await writeProjectPreference(project.cwd, 'p4', '.custom-pi'), { version: 1, revisionControl: 'p4' });
    assert.deepEqual(await readProjectPreference(project.cwd, '.custom-pi'), { version: 1, revisionControl: 'p4' });
    await assert.rejects(writeProjectPreference(project.cwd, 'git'), /exactly 'p4' or 'lore'/);
    await assert.rejects(writeProjectPreference(project.cwd, 'p4', '../outside'), /one relative path segment/);

    await fs.writeFile(projectPreferencePath(project.cwd), '{invalid json');
    await assert.rejects(readProjectPreference(project.cwd), /JSON/);

    for (const invalid of [
      null,
      [],
      { version: 2, revisionControl: 'p4' },
      { version: 1, revisionControl: 'git' },
      { version: 1, revisionControl: 'p4', extra: true },
      { revisionControl: 'p4' },
    ]) {
      await fs.writeFile(projectPreferencePath(project.cwd), `${JSON.stringify(invalid)}\n`);
      await assert.rejects(readProjectPreference(project.cwd), /invalid agent-workspace project preference|exactly 'p4' or 'lore'/);
    }

    const linkedTarget = path.join(project.cwd, 'linked-target');
    const linkedConfig = path.join(project.cwd, '.linked-pi');
    await fs.mkdir(linkedTarget);
    await fs.symlink(linkedTarget, linkedConfig, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(writeProjectPreference(project.cwd, 'p4', '.linked-pi'), /symbolic link or junction/);
  } finally {
    await removeProject(project);
  }
});

test('generation config defaults to P4, loads legacy P4, and rejects a missing current selection', async () => {
  const project = await temporaryProject();
  try {
    const config = await initialize(project.stateDir, initOptions(project.workspace));
    assert.deepEqual(config.revisionControl, { version: 1, mode: 'p4' });
    const configPath = path.join(project.stateDir, 'config.json');
    const missingSelection = JSON.parse(await fs.readFile(configPath, 'utf8'));
    delete missingSelection.revisionControl;
    await fs.writeFile(configPath, `${JSON.stringify(missingSelection, null, 2)}\n`);
    await assert.rejects(loadConfig(project.stateDir), /no immutable revisionControl selection/);

    missingSelection.version = 9;
    await fs.writeFile(configPath, `${JSON.stringify(missingSelection, null, 2)}\n`);
    const before = await fs.readFile(configPath, 'utf8');
    assert.equal(revisionControlMode(await loadConfig(project.stateDir)), 'p4');
    assert.equal(await fs.readFile(configPath, 'utf8'), before);
  } finally {
    await removeProject(project);
  }
});

test('CLI explicit revision-control wins over project preference', async () => {
  const project = await temporaryProject();
  try {
    await writeProjectPreference(project.cwd, 'lore');
    await execFileAsync(process.execPath, [
      cli, 'init', '--state-dir', project.stateDir, '--workspace', project.workspace,
      '--max-slots', '1', '--adapter', 'test', '--poll-ms', '50', '--revision-control', 'p4',
    ], { cwd: project.cwd, timeout: 10000 });
    assert.deepEqual((await loadConfig(project.stateDir)).revisionControl, { version: 1, mode: 'p4' });

    const preferenceStateDir = path.join(project.cwd, 'preference-state');
    await assert.rejects(execFileAsync(process.execPath, [
      cli, 'init', '--state-dir', preferenceStateDir, '--workspace', project.workspace,
      '--max-slots', '1', '--adapter', 'test', '--poll-ms', '50',
    ], { cwd: project.cwd, timeout: 10000 }), /Lore revision-control backend is not implemented/);
    await assert.rejects(fs.access(preferenceStateDir), { code: 'ENOENT' });
  } finally {
    await removeProject(project);
  }
});

test('cleanup rejects malformed backend state and disabled Perforce ownership before mutation', async () => {
  const project = await temporaryProject();
  try {
    await fs.mkdir(project.stateDir, { recursive: true });
    await fs.writeFile(path.join(project.stateDir, 'config.json'), `${JSON.stringify({
      version: 10,
      brokerUuid: '00000000-0000-4000-8000-000000000000',
      adapter: 'projfs',
    })}\n`);
    await assert.rejects(cleanupBroker(project.stateDir), /no immutable revisionControl selection/);
    await assert.rejects(fs.access(`${project.stateDir}.cleanup-journal.json`), { code: 'ENOENT' });
    await assert.rejects(fs.access(path.join(project.stateDir, 'CLEANUP_IN_PROGRESS')), { code: 'ENOENT' });

    await assert.rejects(cleanupP4Ledger({ p4: null }, [{ type: 'p4-client' }]), /owned resources exist without enabled Perforce/);
    assert.deepEqual(await cleanupP4Ledger({ p4: null }, []), { cleaned: true, idempotent: true });
  } finally {
    await removeProject(project);
  }
});

test('Lore selection fails closed before creating generation or lifecycle state', async () => {
  const project = await temporaryProject();
  try {
    await assert.rejects(initialize(project.stateDir, initOptions(project.workspace, 'lore')), /Lore revision-control backend is not implemented/);
    await assert.rejects(fs.access(project.stateDir), { code: 'ENOENT' });
    await assert.rejects(fs.access(`${project.stateDir}.lifecycle`), { code: 'ENOENT' });
  } finally {
    await removeProject(project);
  }
});

test('backend registry exposes capabilities and gates P4 compatibility operations by selected mode', async () => {
  const project = await temporaryProject();
  try {
    const config = await initialize(project.stateDir, initOptions(project.workspace));
    config.revisionControl = { version: 1, mode: 'lore' };
    await fs.writeFile(path.join(project.stateDir, 'config.json'), `${JSON.stringify(config, null, 2)}\n`);
    assert.equal(revisionControlBackend(config).mode, 'lore');
    assert.throws(() => revisionControlMode({ revisionControl: { version: 1, mode: 'p4', extra: true } }), /invalid immutable/);
    assert.deepEqual(revisionControlStatus(config), {
      mode: 'lore',
      enabled: false,
      capabilities: {
        explicitOpen: false,
        artifactImport: false,
        automaticCheckpoints: false,
        reviewHandoff: false,
      },
    });
    await assert.rejects(openAgentWorkspaceP4({
      stateDir: project.stateDir,
      expectedBrokerUuid: config.brokerUuid,
      taskId: '20000101000000-000000000000',
      action: 'edit',
      depotPaths: ['//Depot/Main/File.cpp'],
    }), /requires revision-control mode 'p4'/);
  } finally {
    await removeProject(project);
  }
});

test('revision-control slash command reports, persists, warns on active mismatch, rejects bad args, and completes modes', async () => {
  const project = await temporaryProject();
  const notifications = [];
  const context = { cwd: project.cwd, ui: { notify: (message, level) => notifications.push({ message, level }) } };
  try {
    await initialize(path.join(project.cwd, '.agent-workspace'), initOptions(project.workspace));
    await runRevisionControlCommand('', context);
    assert.match(notifications.at(-1).message, /effective default: p4.*Active generation: p4/);

    await runRevisionControlCommand('lore', context);
    assert.deepEqual(await readProjectPreference(project.cwd), { version: 1, revisionControl: 'lore' });
    assert.equal(notifications.at(-1).level, 'warning');
    assert.match(notifications.at(-1).message, /cleanup and reinitialization are required/);
    assert.equal(revisionControlMode(await loadConfig(path.join(project.cwd, '.agent-workspace'))), 'p4');

    const preferenceBeforeInvalid = await fs.readFile(projectPreferencePath(project.cwd), 'utf8');
    await runRevisionControlCommand('git', context);
    await runRevisionControlCommand('p4 extra', context);
    await runRevisionControlCommand('p4', { ...context, isProjectTrusted: () => false });
    assert.equal(await fs.readFile(projectPreferencePath(project.cwd), 'utf8'), preferenceBeforeInvalid);
    assert.equal(notifications.at(-1).level, 'error');
    assert.deepEqual(revisionControlCompletions('l'), [{ value: 'lore', label: 'lore' }]);
    assert.equal(revisionControlCompletions('p4 '), null);
  } finally {
    await removeProject(project);
  }
});
