import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const bundledLaunchSupervisor = fileURLToPath(new URL(
  '../native/projfs-provider/bin/win32-x64/launch-supervisor.exe',
  import.meta.url,
));

const taskIdPattern = /^\d{14}-[0-9a-f]{12}$/;

export function defaultStateDir(cwd = process.cwd()) {
  return path.join(cwd, '.agent-workspace');
}

export function statePaths(stateDir) {
  return {
    config: path.join(stateDir, 'config.json'),
    slots: path.join(stateDir, 'slots.json'),
    tasks: path.join(stateDir, 'tasks'),
    logs: path.join(stateDir, 'logs'),
    locks: path.join(stateDir, 'locks'),
    secrets: path.join(stateDir, 'secrets'),
  };
}

export async function ensureStateDirectories(stateDir) {
  const paths = statePaths(stateDir);
  await Promise.all([
    fs.mkdir(paths.tasks, { recursive: true }),
    fs.mkdir(paths.logs, { recursive: true }),
    fs.mkdir(paths.locks, { recursive: true }),
    fs.mkdir(paths.secrets, { recursive: true }),
  ]);
}

export async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

export async function readJsonIfPresent(filePath) {
  try {
    return await readJson(filePath);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

export async function atomicWriteJson(filePath, value, internals = {}) {
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true });
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${crypto.randomBytes(6).toString('hex')}.tmp`,
  );
  const contents = `${JSON.stringify(value, null, 2)}\n`;
  let handle;
  try {
    handle = await fs.open(temporaryPath, 'wx');
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    const platform = internals.platform ?? process.platform;
    if (platform === 'win32') {
      const durableReplace = internals.durableReplace ?? durableReplaceWindows;
      await durableReplace(temporaryPath, filePath);
    } else {
      await fs.rename(temporaryPath, filePath);
      await syncContainingDirectory(directory);
    }
  } finally {
    await handle?.close().catch(() => {});
    await fs.unlink(temporaryPath).catch((error) => {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    });
  }
}

export async function syncContainingDirectory(directory, fileSystem = fs, platform = process.platform) {
  let handle;
  try {
    handle = await fileSystem.open(directory, 'r');
    await handle.sync();
  } catch (error) {
    // Node/libuv documents directory handles or fsync as unsupported on some filesystems.
    if (!['EINVAL', 'ENOTSUP', 'EISDIR'].includes(error.code)) throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

export async function durableReplaceWindows(sourcePath, targetPath, internals = {}) {
  if (!path.isAbsolute(sourcePath) || !path.isAbsolute(targetPath)
    || path.dirname(sourcePath).toLowerCase() !== path.dirname(targetPath).toLowerCase()
    || sourcePath.toLowerCase() === targetPath.toLowerCase()) {
    throw new Error('durable replace requires distinct absolute paths in one directory');
  }
  const helperPath = internals.helperPath ?? bundledLaunchSupervisor;
  await new Promise((resolve, reject) => {
    execFile(
      helperPath,
      ['durable-replace', '--source', sourcePath, '--target', targetPath],
      { windowsHide: true, shell: false },
      (error) => error ? reject(new Error('native durable replace failed', { cause: error })) : resolve(),
    );
  });
}

export async function withLifecycleLock(stateDir, callback, options = {}) {
  const lifecycleStateDir = `${path.resolve(stateDir)}.lifecycle`;
  return withLock(lifecycleStateDir, 'broker', callback, {
    timeoutMs: options.timeoutMs ?? 30000,
    staleMs: options.staleMs ?? 30000,
    ...options,
  });
}

export async function withLock(stateDir, name, callback, options = {}) {
  const timeoutMs = options.timeoutMs ?? 5000;
  const staleMs = options.staleMs ?? 30000;
  const heartbeatMs = options.heartbeatMs ?? Math.max(25, Math.floor(staleMs / 3));
  const lockPath = path.join(statePaths(stateDir).locks, `${name}.lock`);
  const token = crypto.randomBytes(16).toString('hex');
  const ownerPath = path.join(lockPath, `${token}.owner.json`);
  const startedAt = Date.now();
  await fs.mkdir(path.dirname(lockPath), { recursive: true });

  while (true) {
    try {
      await fs.mkdir(lockPath);
      const now = new Date().toISOString();
      await fs.writeFile(ownerPath, `${JSON.stringify({ version: 1, token, pid: process.pid, acquiredAt: now, heartbeatAt: now })}\n`, { flag: 'wx' });
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') {
        throw error;
      }
      await reclaimStaleLock(lockPath, staleMs);
      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error(`timed out waiting for state lock '${name}'`);
      }
      await delay(25);
    }
  }

  let heartbeatPromise = Promise.resolve();
  const heartbeat = setInterval(() => {
    heartbeatPromise = heartbeatPromise.then(() => refreshLockOwner(lockPath, ownerPath, token)).catch(() => {});
  }, heartbeatMs);
  heartbeat.unref();

  try {
    return await callback();
  } finally {
    clearInterval(heartbeat);
    await heartbeatPromise;
    await releaseOwnedLock(lockPath, ownerPath, token);
  }
}

async function refreshLockOwner(lockPath, ownerPath, token) {
  const owner = await readJsonIfPresent(ownerPath);
  if (owner?.token !== token) {
    return;
  }
  const now = new Date();
  await fs.utimes(lockPath, now, now);
}

async function reclaimStaleLock(lockPath, staleMs) {
  const { owner } = await readLockOwner(lockPath);
  const stats = await fs.stat(lockPath).catch(() => null);
  const recordedHeartbeat = owner?.heartbeatAt ? Date.parse(owner.heartbeatAt) : 0;
  const heartbeatTime = Math.max(recordedHeartbeat || 0, stats?.mtimeMs || 0);
  if (isProcessAlive(owner?.pid)) {
    return false;
  }
  if (!owner && (!heartbeatTime || Date.now() - heartbeatTime <= staleMs)) {
    return false;
  }

  const quarantinePath = `${lockPath}.stale.${process.pid}.${crypto.randomBytes(6).toString('hex')}`;
  try {
    await fs.rename(lockPath, quarantinePath);
  } catch (error) {
    if (['ENOENT', 'EEXIST'].includes(error.code)) {
      return false;
    }
    throw error;
  }
  await fs.rm(quarantinePath, { recursive: true, force: true });
  return true;
}

async function readLockOwner(lockPath) {
  const names = await fs.readdir(lockPath).catch(() => []);
  const ownerName = names.find((name) => name.endsWith('.owner.json')) ?? names.find((name) => name === 'owner.json');
  if (!ownerName) {
    return { owner: null, ownerPath: null };
  }
  const ownerPath = path.join(lockPath, ownerName);
  return { owner: await readJsonIfPresent(ownerPath).catch(() => null), ownerPath };
}

async function releaseOwnedLock(lockPath, ownerPath, token) {
  const owner = await readJsonIfPresent(ownerPath).catch(() => null);
  if (owner?.token !== token) {
    return false;
  }
  try {
    await fs.unlink(ownerPath);
    await fs.rmdir(lockPath);
    return true;
  } catch (error) {
    if (['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) {
      return false;
    }
    throw error;
  }
}

export function isProcessAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

export function validateTaskId(taskId) {
  if (typeof taskId !== 'string' || !taskIdPattern.test(taskId)) {
    throw new Error(`invalid task ID '${taskId}'`);
  }
  return taskId;
}

export function taskPath(stateDir, taskId) {
  validateTaskId(taskId);
  return path.join(statePaths(stateDir).tasks, `${taskId}.json`);
}

export async function readTask(stateDir, taskId) {
  const task = await readJsonIfPresent(taskPath(stateDir, taskId));
  if (!task) {
    throw new Error(`unknown task '${taskId}'`);
  }
  return task;
}

export async function writeTask(stateDir, task) {
  validateTaskId(task.id);
  task.updatedAt = new Date().toISOString();
  await atomicWriteJson(taskPath(stateDir, task.id), task);
}

export async function listTasks(stateDir) {
  const paths = statePaths(stateDir);
  let names;
  try {
    names = await fs.readdir(paths.tasks);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
  const tasks = await Promise.all(
    names.filter((name) => taskIdPattern.test(name.slice(0, -5)) && name.endsWith('.json'))
      .map((name) => readJson(path.join(paths.tasks, name))),
  );
  return tasks.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export async function updateLogStats(task) {
  try {
    const stats = await fs.stat(task.logPath);
    task.logBytes = stats.size;
    task.logMtime = stats.mtime.toISOString();
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
    task.logBytes = 0;
    task.logMtime = null;
  }
  const end = task.finishedAt ? Date.parse(task.finishedAt) : Date.now();
  task.elapsedMs = Math.max(0, end - Date.parse(task.attemptCreatedAt ?? task.createdAt));
}

export function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
