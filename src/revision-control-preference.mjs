import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteJson, readJson } from './state.mjs';

export const revisionControlModes = Object.freeze(['p4', 'lore']);

export function projectPreferencePath(cwd = process.cwd(), configDirectoryName = '.pi') {
  if (typeof configDirectoryName !== 'string' || !configDirectoryName
    || path.basename(configDirectoryName) !== configDirectoryName
    || ['.', '..'].includes(configDirectoryName)) {
    throw new Error('project config directory name must be one relative path segment');
  }
  return path.join(path.resolve(cwd), configDirectoryName, 'agent-workspace.json');
}

export function validateRevisionControlMode(value, name = 'revision-control mode') {
  if (!revisionControlModes.includes(value)) {
    throw new Error(`${name} must be exactly 'p4' or 'lore'`);
  }
  return value;
}

export async function readProjectPreference(cwd = process.cwd(), configDirectoryName = '.pi') {
  const filePath = projectPreferencePath(cwd, configDirectoryName);
  let value;
  try {
    value = await readJson(filePath);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  validatePreference(value, filePath);
  return Object.freeze({ version: 1, revisionControl: value.revisionControl });
}

export async function writeProjectPreference(cwd, revisionControl, configDirectoryName = '.pi') {
  const mode = validateRevisionControlMode(revisionControl);
  const filePath = projectPreferencePath(cwd, configDirectoryName);
  await assertSafePreferenceDirectory(cwd, path.dirname(filePath));
  const value = { version: 1, revisionControl: mode };
  await atomicWriteJson(filePath, value);
  return Object.freeze(value);
}

async function assertSafePreferenceDirectory(cwd, directory) {
  await fs.mkdir(directory, { recursive: true });
  const directoryStats = await fs.lstat(directory);
  if (directoryStats.isSymbolicLink()) {
    throw new Error('project config directory must not be a symbolic link or junction');
  }
  const [projectRealPath, directoryRealPath] = await Promise.all([
    fs.realpath(path.resolve(cwd)),
    fs.realpath(directory),
  ]);
  const relative = path.relative(projectRealPath, directoryRealPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('project config directory resolves outside the project');
  }
}

function validatePreference(value, filePath) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`invalid agent-workspace project preference at ${filePath}: expected an object`);
  }
  const keys = Object.keys(value).sort();
  if (keys.length !== 2 || keys[0] !== 'revisionControl' || keys[1] !== 'version') {
    throw new Error(`invalid agent-workspace project preference at ${filePath}: expected only version and revisionControl`);
  }
  if (value.version !== 1) {
    throw new Error(`invalid agent-workspace project preference at ${filePath}: version must be 1`);
  }
  validateRevisionControlMode(value.revisionControl, `revisionControl in ${filePath}`);
}
