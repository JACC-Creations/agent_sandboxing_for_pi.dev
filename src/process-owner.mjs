import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { atomicWriteJson, delay, isProcessAlive, readJsonIfPresent } from './state.mjs';
import { getProcessIdentity } from './process-identity.mjs';

const execFileAsync = promisify(execFile);

export function usesNativeSupervisor(config) {
  return process.platform === 'win32'
    && config.adapter === 'projfs'
    && config.testMode !== true;
}

export function ownershipDescriptor(stateDir, config, kind, nonce) {
  const launchManifestPath = path.join(stateDir, 'launches', `${kind}-${nonce}.json`);
  return {
    ownerUuid: config.brokerUuid,
    nonce,
    kind,
    launchManifestPath,
    jobName: `Local\\AgentWorkspace-${config.brokerUuid}-${nonce}`,
  };
}

export async function launchOwned(config, descriptor, executable, args, options) {
  await fs.mkdir(path.dirname(descriptor.launchManifestPath), { recursive: true });
  await Promise.all([
    fs.mkdir(path.dirname(options.stdoutPath), { recursive: true }),
    fs.mkdir(path.dirname(options.stderrPath), { recursive: true }),
  ]);
  await Promise.all([
    fs.appendFile(options.stdoutPath, ''),
    fs.appendFile(options.stderrPath, ''),
  ]);
  if (usesNativeSupervisor(config)) {
    const commitPath = `${descriptor.launchManifestPath}.commit`;
    const intentPath = `${descriptor.launchManifestPath}.intent`;
    await Promise.all([
      fs.unlink(descriptor.launchManifestPath).catch((error) => { if (error.code !== 'ENOENT') throw error; }),
      fs.unlink(commitPath).catch((error) => { if (error.code !== 'ENOENT') throw error; }),
    ]);
    await atomicWriteJson(intentPath, { version: 1, ...descriptor, state: 'launch-intent' });
    const supervisorArgs = [
      'launch', '--manifest', descriptor.launchManifestPath,
      '--owner', descriptor.ownerUuid, '--nonce', descriptor.nonce,
      '--kind', descriptor.kind, '--job-name', descriptor.jobName, '--commit', commitPath,
      '--commit-timeout-ms', String(options.launchTimeoutMs),
      '--cwd', options.cwd, '--stdout', options.stdoutPath, '--stderr', options.stderrPath,
      '--', executable, ...args,
    ];
    const supervisor = spawn(config.launchSupervisorExe, supervisorArgs, {
      cwd: options.cwd,
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
      env: options.env,
    });
    await waitForSpawn(supervisor);
    const closed = new Promise((resolve) => supervisor.once('close', resolve));
    const publicationDeadline = Date.now() + options.launchTimeoutMs;
    while (Date.now() < publicationDeadline) {
      const manifest = await readJsonIfPresent(descriptor.launchManifestPath).catch(() => null);
      if (isValidOwnershipManifest(manifest, descriptor) && manifest.state === 'prepared') {
        await atomicWriteJson(commitPath, { version: 1, ownerUuid: descriptor.ownerUuid, nonce: descriptor.nonce });
        const commitDeadline = Date.now() + options.launchTimeoutMs;
        while (Date.now() < commitDeadline) {
          const committed = await readOwnedProcess(descriptor);
          if (committed?.state === 'running' || committed?.state === 'exited') {
            supervisor.unref();
            return { ...committed, native: true, child: null };
          }
          if (committed?.state === 'aborted' || supervisor.exitCode !== null) break;
          await delay(20);
        }
        break;
      }
      if (supervisor.exitCode !== null) break;
      await delay(20);
    }
    await Promise.race([closed, delay(Math.max(options.launchTimeoutMs + 1000, 2000))]);
    if (supervisor.exitCode === null && supervisor.signalCode === null) {
      supervisor.kill();
      await Promise.race([closed, delay(1000)]);
    }
    const manifest = await readOwnedProcess(descriptor);
    if (manifest && manifest.state !== 'aborted' && manifest.state !== 'exited') {
      await terminateOwned(config, descriptor, Math.max(options.launchTimeoutMs, 1000)).catch(() => false);
    }
    const empty = await queryOwnedJobEmpty(config, { ...descriptor, verificationPath: intentPath }, Math.max(options.launchTimeoutMs, 1000)).catch(() => false);
    if (!empty) {
      throw new Error(`native launch supervisor timed out and its owned job could not be proven empty for ${descriptor.kind}`);
    }
    throw new Error(`native launch supervisor did not publish durable committed ${descriptor.kind} ownership within ${options.launchTimeoutMs}ms; supervisor exited and owned job is empty`);
  }

  const output = await fs.open(options.stdoutPath, 'a');
  const error = await fs.open(options.stderrPath, 'a');
  let child;
  try {
    child = spawn(executable, args, {
      cwd: options.cwd,
      detached: true,
      windowsHide: true,
      stdio: ['ignore', output.fd, error.fd],
      env: options.env,
    });
    await waitForSpawn(child);
    let creationIdentity = await getProcessIdentity(child.pid);
    if (!creationIdentity && child.exitCode !== null) {
      creationIdentity = `exited:${child.pid}:${Date.now()}`;
    }
    if (!creationIdentity) {
      child.kill('SIGTERM');
      throw new Error(`owned ${descriptor.kind} launch produced a null process identity`);
    }
    const manifest = {
      version: 1,
      ...descriptor,
      pid: child.pid,
      creationIdentity,
      supervisorPid: process.pid,
      state: child.exitCode === null ? 'running' : 'exited',
      ...(child.exitCode === null ? {} : { exitCode: child.exitCode }),
      native: false,
    };
    await atomicWriteJson(descriptor.launchManifestPath, manifest);
    if (child.exitCode === null) {
      child.once('close', (exitCode) => {
        atomicWriteJson(descriptor.launchManifestPath, {
          ...manifest,
          state: 'exited',
          exitCode: Number.isInteger(exitCode) ? exitCode : null,
        }).catch(() => {});
      });
    }
    return { ...manifest, child };
  } finally {
    await Promise.allSettled([output.close(), error.close()]);
  }
}

export async function readOwnedProcess(descriptor) {
  const manifest = await readJsonIfPresent(descriptor.launchManifestPath).catch(() => null);
  return isValidOwnershipManifest(manifest, descriptor) ? manifest : null;
}

export async function isOwnedProcessAlive(descriptor) {
  const manifest = await readOwnedProcess(descriptor);
  if (!manifest || manifest.state !== 'running' || !manifest.creationIdentity) return false;
  return isProcessAlive(manifest.pid) && await getProcessIdentity(manifest.pid) === manifest.creationIdentity;
}

export async function terminatePreparedOwned(config, descriptor, timeoutMs) {
  const manifest = await readOwnedProcess(descriptor);
  if (manifest?.state !== 'prepared') return false;
  return terminateOwned(config, descriptor, timeoutMs);
}

export async function terminateOwned(config, descriptor, timeoutMs) {
  if (process.env.AGENT_WORKSPACE_TEST_TERMINATE_FAILURE === '1') return false;
  const manifest = await readOwnedProcess(descriptor);
  if (!manifest?.creationIdentity) return false;
  if (usesNativeSupervisor(config)) {
    await execFileAsync(config.launchSupervisorExe, [
      'terminate', '--manifest', descriptor.verificationPath ?? descriptor.launchManifestPath,
      '--owner', descriptor.ownerUuid, '--nonce', descriptor.nonce, '--job-name', descriptor.jobName,
      '--timeout-ms', String(timeoutMs),
    ], { windowsHide: true, timeout: Math.max(timeoutMs + 1000, 2000) });
    return queryOwnedJobEmpty(config, descriptor, timeoutMs);
  }
  if (!isProcessAlive(manifest.pid)) return true;
  if (await getProcessIdentity(manifest.pid) !== manifest.creationIdentity) return true;
  if (process.platform === 'win32') {
    await execFileAsync('taskkill.exe', ['/pid', String(manifest.pid), '/t', '/f'], { windowsHide: true }).catch(() => {});
  } else {
    try { process.kill(-manifest.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const identity = await getProcessIdentity(manifest.pid);
    if (identity !== manifest.creationIdentity) return true;
    await delay(50);
  }
  return false;
}

export async function queryOwnedJobEmpty(config, descriptor, timeoutMs = 1000) {
  if (process.env.AGENT_WORKSPACE_TEST_QUERY_JOB_NONEMPTY === '1') return false;
  if (!usesNativeSupervisor(config)) return !(await isOwnedProcessAlive(descriptor));
  try {
    await execFileAsync(config.launchSupervisorExe, [
      'query', '--manifest', descriptor.verificationPath ?? descriptor.launchManifestPath,
      '--owner', descriptor.ownerUuid, '--nonce', descriptor.nonce, '--job-name', descriptor.jobName,
    ], { windowsHide: true, timeout: Math.max(timeoutMs, 1000) });
    return true;
  } catch {
    return false;
  }
}

export function isValidOwnershipManifest(manifest, descriptor) {
  return Boolean(manifest
    && manifest.version === 1
    && manifest.ownerUuid === descriptor.ownerUuid
    && manifest.nonce === descriptor.nonce
    && manifest.kind === descriptor.kind
    && manifest.jobName === descriptor.jobName
    && Number.isSafeInteger(manifest.pid)
    && manifest.pid > 0
    && typeof manifest.creationIdentity === 'string'
    && manifest.creationIdentity.length > 0);
}

function waitForSpawn(child) {
  return new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
}
