import fs from 'node:fs/promises';
import path from 'node:path';

const options = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  options.set(process.argv[index], process.argv[index + 1]);
}
const lower = options.get('--lower');
const statePath = options.get('--state');
const quarantinePath = options.get('--quarantine');
const brokerUuid = options.get('--broker-uuid');
const controlPath = path.join(lower, '.fake-lower-guard.json');
const now = () => new Date().toISOString();
const atomicJson = async (destination, value) => {
  const temporary = `${destination}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await fs.rm(destination, { force: true });
  await fs.rename(temporary, destination);
};
const writeState = (phase = 'ready', reason = '') => atomicJson(statePath, {
  version: 1,
  brokerUuid,
  phase,
  lower,
  mode: 'continuous_directory_watcher',
  volumeSerial: 1,
  rootFileId: 2,
  heartbeatAt: now(),
  checkpointAt: now(),
  reason,
});

await fs.mkdir(path.dirname(statePath), { recursive: true });
const control = await fs.readFile(controlPath, 'utf8').then(JSON.parse, () => ({}));
if (control.mutateBeforeReady) {
  const mutationPath = path.resolve(lower, control.mutateBeforeReady.relativePath);
  const relative = path.relative(path.resolve(lower), mutationPath);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) process.exit(4);
  await fs.writeFile(mutationPath, control.mutateBeforeReady.contents ?? 'mutated');
}
if (control.startupFailure || process.env.AGENT_WORKSPACE_TEST_GUARD_STARTUP_FAILURE === '1') {
  await writeState('failed', 'deterministic guard startup failure');
  process.exit(2);
}
await writeState();
if (!control.noReady && process.env.AGENT_WORKSPACE_TEST_GUARD_NO_READY !== '1') {
  console.log(control.wrongReady ? 'prefix LOWER_FREEZE_READY' : 'LOWER_FREEZE_READY');
}

let stopped = false;
const stop = () => { stopped = true; process.exit(0); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
if (process.platform === 'win32') process.on('SIGBREAK', stop);
else process.on('SIGHUP', stop);
while (!stopped) {
  await new Promise((resolve) => setTimeout(resolve, 250));
  const current = await fs.readFile(controlPath, 'utf8').then(JSON.parse, () => ({}));
  if (current.exit) process.exit(7);
  if (current.quarantine) {
    const details = {
      version: 1,
      brokerUuid,
      state: 'quarantined',
      detectedAt: now(),
      reason: current.reason ?? 'sealed lower changed',
      action: current.action ?? 'modified',
      path: current.path ?? path.join(lower, 'changed.txt'),
      paths: current.paths ?? [{ path: path.join(lower, 'changed.txt') }],
      volumeSerial: 1,
      rootFileId: 2,
    };
    await atomicJson(quarantinePath, details);
    await writeState('quarantined', details.reason);
    process.exit(3);
  }
  await writeState();
}
