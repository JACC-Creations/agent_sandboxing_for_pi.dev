import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { atomicWriteJson, readJson, statePaths, withLock } from './state.mjs';

export const defaultAuthMinValidMs = 5 * 60 * 1000;
export const authLifetimeMarginMs = 60 * 1000;
const restrictAclScript = fileURLToPath(new URL('../scripts/restrict-secret-acl.ps1', import.meta.url));
const restrictDirectoryAclScript = fileURLToPath(new URL('../scripts/restrict-secret-directory-acl.ps1', import.meta.url));
const inspectAclScript = fileURLToPath(new URL('../scripts/inspect-secret-acl.ps1', import.meta.url));

export async function prepareAuth(stateDir, options) {
  validateHordeUrl(options.hordeUrl);
  const minValidMs = options.minValidMs ?? defaultAuthMinValidMs;
  if (!Number.isSafeInteger(minValidMs) || minValidMs < 0) {
    throw new Error('--min-valid-ms must be a nonnegative integer');
  }

  return withLock(stateDir, 'auth', async () => {
    const configPath = statePaths(stateDir).config;
    const config = await readJson(configPath).catch((error) => {
      if (error.code === 'ENOENT') {
        throw new Error(`broker is not initialized at ${stateDir}`);
      }
      throw error;
    });
    const secretsDir = statePaths(stateDir).secrets;
    await fs.mkdir(secretsDir, { recursive: true });
    await restrictSecretDirectory(secretsDir);
    const temporaryPath = path.join(secretsDir, `.oidc.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`);
    let installedPath = null;
    try {
      await runOidcToken(options.oidcTokenExe ?? 'OidcToken.exe', options.hordeUrl, temporaryPath);
      const tokenDocument = await readAndValidateTokenFile(temporaryPath, minValidMs);
      await restrictSecretFile(temporaryPath);
      installedPath = path.join(secretsDir, `horde-token.${Date.now()}.${crypto.randomBytes(6).toString('hex')}.json`);
      await fs.rename(temporaryPath, installedPath);

      const now = new Date().toISOString();
      config.auth = {
        enabled: true,
        hordeUrl: options.hordeUrl,
        tokenFile: installedPath,
        expiresAt: tokenDocument.expiresAt,
        preparedAt: now,
        minValidMs,
      };
      await atomicWriteJson(configPath, config);
      return authStatusFromConfig(config);
    } catch (error) {
      if (installedPath) {
        await fs.unlink(installedPath).catch(() => {});
      }
      throw error;
    } finally {
      await fs.unlink(temporaryPath).catch(() => {});
    }
  }, { timeoutMs: 130000, staleMs: 150000 });
}

export async function getAuthStatus(stateDir) {
  const config = await readJson(statePaths(stateDir).config).catch((error) => {
    if (error.code === 'ENOENT') {
      throw new Error(`broker is not initialized at ${stateDir}`);
    }
    throw error;
  });
  return authStatusFromConfig(config);
}

export async function inspectConfiguredAuth(config) {
  if (!config.auth?.enabled) {
    return { ok: true, configured: false, skipped: true };
  }

  const result = {
    ok: false,
    configured: true,
    hordeUrl: config.auth.hordeUrl,
    tokenFile: config.auth.tokenFile,
    expiresAt: config.auth.expiresAt,
    remainingMs: remainingMilliseconds(config.auth.expiresAt),
    expected: `readable token file with at least ${config.auth.minValidMs ?? defaultAuthMinValidMs}ms remaining and restricted access`,
  };
  try {
    validateHordeUrl(config.auth.hordeUrl);
    const tokenDocument = await readAndValidateTokenFile(
      config.auth.tokenFile,
      config.auth.minValidMs ?? defaultAuthMinValidMs,
    );
    const fileAcl = await inspectSecretAccess(config.auth.tokenFile, false);
    const directoryAcl = await inspectSecretAccess(path.dirname(config.auth.tokenFile), true);
    result.expiresAt = tokenDocument.expiresAt;
    result.remainingMs = remainingMilliseconds(tokenDocument.expiresAt);
    result.acl = {
      ok: fileAcl.ok && directoryAcl.ok,
      file: fileAcl,
      directory: directoryAcl,
    };
    result.ok = result.acl.ok;
    if (!result.acl.ok) {
      result.actual = `file: ${fileAcl.actual}; directory: ${directoryAcl.actual}`;
    }
  } catch (error) {
    result.actual = error.message;
  }
  return result;
}

export async function readAndValidateTokenFile(tokenFile, minValidMs = defaultAuthMinValidMs) {
  let value;
  try {
    value = JSON.parse(await fs.readFile(tokenFile, 'utf8'));
  } catch (error) {
    throw new Error(`Horde token file is not readable JSON: ${error.code ?? error.name}`);
  }
  if (typeof value.Token !== 'string' || !value.Token.trim()) {
    throw new Error('Horde token file has no nonempty Token');
  }
  const rawExpiry = value.ExpiresAtUtc ?? value.ExpiresAt;
  const expiryMs = parseExpiry(rawExpiry);
  if (!Number.isFinite(expiryMs)) {
    throw new Error('Horde token file has no parseable ExpiresAtUtc or ExpiresAt');
  }
  const remainingMs = expiryMs - Date.now();
  if (remainingMs <= 0) {
    throw new Error('Horde token is expired');
  }
  if (remainingMs < minValidMs) {
    throw new Error(`Horde token lifetime ${Math.floor(remainingMs)}ms is below required minimum ${minValidMs}ms`);
  }
  return { token: value.Token, expiresAt: new Date(expiryMs).toISOString(), remainingMs };
}

function authStatusFromConfig(config) {
  if (!config.auth?.enabled) {
    return { configured: false, enabled: false };
  }
  return {
    configured: true,
    enabled: true,
    hordeUrl: config.auth.hordeUrl,
    tokenFile: config.auth.tokenFile,
    expiresAt: config.auth.expiresAt,
    preparedAt: config.auth.preparedAt,
    minValidMs: config.auth.minValidMs ?? defaultAuthMinValidMs,
    remainingMs: remainingMilliseconds(config.auth.expiresAt),
  };
}

function remainingMilliseconds(expiry) {
  const expiryMs = Date.parse(expiry);
  return Number.isFinite(expiryMs) ? expiryMs - Date.now() : null;
}

function parseExpiry(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 100000000000 ? value * 1000 : value;
  }
  if (typeof value !== 'string' || !value.trim()) {
    return Number.NaN;
  }
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return numeric < 100000000000 ? numeric * 1000 : numeric;
  }
  return Date.parse(value);
}

function validateHordeUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('--horde-url must be an absolute HTTP(S) URL');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.host || parsed.username || parsed.password) {
    throw new Error('--horde-url must be an absolute HTTP(S) URL without credentials');
  }
}

async function runOidcToken(executable, hordeUrl, outFile) {
  const oidcArgs = [
    '--Service', 'Horde',
    '--HordeUrl', hordeUrl,
    '--Mode', 'GetToken',
    '--Unattended', 'true',
    '--OutFile', outFile,
  ];
  const isNodeScript = /\.(?:cjs|mjs|js)$/i.test(executable);
  const command = isNodeScript ? process.execPath : executable;
  const args = isNodeScript ? [executable, ...oidcArgs] : oidcArgs;
  const child = spawn(command, args, {
    windowsHide: true,
    stdio: 'ignore',
    env: withoutHordeSecrets(process.env),
  });
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('OidcToken timed out while running unattended'));
    }, 120000);
    timer.unref();
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(new Error(`unable to launch OidcToken: ${error.code ?? error.name}`));
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`OidcToken failed in unattended mode (${code ?? signal ?? 'unknown exit'})`));
      }
    });
  });
  return result;
}

export function withoutHordeSecrets(source) {
  const env = { ...source };
  delete env.UE_HORDE_TOKEN;
  delete env.UE_HORDE_URL;
  return env;
}

async function restrictSecretDirectory(directoryPath) {
  if (process.platform === 'win32') {
    await runPowerShell(restrictDirectoryAclScript, directoryPath);
    return;
  }
  await fs.chmod(directoryPath, 0o700);
}

async function restrictSecretFile(filePath) {
  if (process.platform === 'win32') {
    await runPowerShell(restrictAclScript, filePath);
    return;
  }
  await fs.chmod(filePath, 0o600);
}

async function inspectSecretAccess(targetPath, directory) {
  if (process.platform === 'win32') {
    const output = await runPowerShell(inspectAclScript, targetPath, true);
    const value = JSON.parse(output);
    return { ok: value.ok === true, actual: value.actual };
  }
  const stats = await fs.stat(targetPath);
  const mode = stats.mode & 0o777;
  const expected = directory ? 0o700 : 0o600;
  return { ok: mode === expected, actual: `mode ${mode.toString(8).padStart(3, '0')}` };
}

async function runPowerShell(scriptPath, filePath, capture = false) {
  const child = spawn('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', scriptPath, filePath,
  ], {
    windowsHide: true,
    stdio: ['ignore', capture ? 'pipe' : 'ignore', 'ignore'],
    env: withoutHordeSecrets(process.env),
  });
  let stdout = '';
  if (capture) {
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
  }
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  if (code !== 0) {
    throw new Error('unable to restrict or inspect Horde token file access');
  }
  return stdout.trim();
}
