import fs from 'node:fs/promises';
import path from 'node:path';
import { createP4, readP4ServerBinding } from './perforce.mjs';

const sha256Pattern = /^[0-9a-f]{64}$/;
const settingLimits = Object.freeze({ P4PORT: 1024, P4CHARSET: 128, P4TICKETS: 32_768, P4TRUST: 32_768 });

function requireSetting(value, name) {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()
    || Buffer.byteLength(value, 'utf8') > settingLimits[name] || /[\0-\x1f\x7f]/.test(value)) {
    throw new Error(`invalid effective ${name}`);
  }
  if (name === 'P4PORT' && /\s/.test(value)) throw new Error('invalid effective P4PORT');
  if (name === 'P4CHARSET' && /\s/.test(value)) throw new Error('invalid effective P4CHARSET');
  return value;
}

function optionalAbsolutePath(value, name) {
  if (value === undefined) return undefined;
  return path.resolve(requireSetting(value, name));
}

export async function resolveP4Executable(executable, environment = process.env) {
  const candidate = String(executable ?? '');
  if (!candidate || /[\0\r\n]/.test(candidate)) throw new Error('Perforce executable is required');
  if (path.isAbsolute(candidate) || /[\\/]/.test(candidate)) {
    const resolved = path.resolve(candidate);
    if (!await fs.stat(resolved).then((stats) => stats.isFile(), () => false)) throw new Error(`Perforce executable is not a file: ${resolved}`);
    return resolved;
  }
  const extensions = process.platform === 'win32'
    ? (environment.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : [''];
  for (const directory of String(environment.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const resolved = path.resolve(directory, process.platform === 'win32' && path.extname(candidate) ? candidate : `${candidate}${extension}`);
      if (await fs.stat(resolved).then((stats) => stats.isFile(), () => false)) return resolved;
    }
  }
  throw new Error('Perforce executable is unavailable');
}

async function readEffectiveSetting(p4, name, explicit, environment, allowInvalidEnvironmentFallback) {
  if (explicit !== undefined) return requireSetting(explicit, name);
  if (environment[name] !== undefined) {
    try {
      return requireSetting(environment[name], name);
    } catch (error) {
      if (!allowInvalidEnvironmentFallback) throw error;
    }
  }
  const prefix = `${name}=`;
  const maxOutputBytes = settingLimits[name] + Buffer.byteLength(`${prefix}\r\n`, 'utf8');
  const result = await p4.run(['set', '-q', name], { maxOutputBytes });
  if (result.records.length !== 0) throw new Error(`malformed effective ${name}`);
  let output = result.stdout;
  if (output.endsWith('\r\n')) output = output.slice(0, -2);
  else if (output.endsWith('\n')) output = output.slice(0, -1);
  if (!output) return undefined;
  if (!output.startsWith(prefix)) throw new Error(`malformed effective ${name}`);
  return requireSetting(output.slice(prefix.length), name);
}

export async function resolveEffectiveP4Settings(p4, explicit = {}, environment = process.env, options = {}) {
  const fallback = options.allowInvalidEnvironmentFallback === true;
  const port = await readEffectiveSetting(p4, 'P4PORT', explicit.port, environment, fallback);
  if (port === undefined) throw new Error('effective P4PORT is unavailable');
  const charset = await readEffectiveSetting(p4, 'P4CHARSET', explicit.charset, environment, fallback);
  const tickets = await readEffectiveSetting(p4, 'P4TICKETS', explicit.ticketFile, environment, fallback);
  const trust = await readEffectiveSetting(p4, 'P4TRUST', explicit.trustFile, environment, fallback);
  return {
    port,
    ...(charset === undefined ? {} : { charset }),
    ...(tickets === undefined ? {} : { ticketFile: optionalAbsolutePath(tickets, 'P4TICKETS') }),
    ...(trust === undefined ? {} : { trustFile: optionalAbsolutePath(trust, 'P4TRUST') }),
  };
}

export function validateReconnectProfile(profile) {
  const permitted = new Set([
    'version', 'executable', 'port', 'user', 'charset', 'ticketFile', 'trustFile',
    'serverFingerprint', 'testMode', 'fakeScript', 'fakeRegistry',
  ]);
  if (!profile || Array.isArray(profile) || profile.version !== 1
    || Object.keys(profile).some((key) => !permitted.has(key))
    || !path.isAbsolute(profile.executable ?? '') || typeof profile.user !== 'string' || !profile.user
    || !sha256Pattern.test(profile.serverFingerprint ?? '')) throw new Error('invalid Perforce reconnect profile');
  requireSetting(profile.port, 'P4PORT');
  if (profile.charset !== undefined) requireSetting(profile.charset, 'P4CHARSET');
  for (const [key, name] of [['ticketFile', 'P4TICKETS'], ['trustFile', 'P4TRUST']]) {
    if (profile[key] !== undefined && (!path.isAbsolute(profile[key]) || optionalAbsolutePath(profile[key], name) !== profile[key])) {
      throw new Error('invalid Perforce reconnect profile');
    }
  }
  if (profile.testMode === true) {
    if (!path.isAbsolute(profile.fakeScript ?? '') || !path.isAbsolute(profile.fakeRegistry ?? '')) throw new Error('invalid Perforce reconnect profile');
  } else if (profile.testMode !== undefined || profile.fakeScript !== undefined || profile.fakeRegistry !== undefined) {
    throw new Error('invalid Perforce reconnect profile');
  }
  return structuredClone(profile);
}

export function createControlledP4(profile, factory = createP4) {
  const validated = validateReconnectProfile(profile);
  return factory({
    executable: validated.executable,
    P4PORT: validated.port,
    P4USER: validated.user,
    P4CHARSET: validated.charset,
    ticketFile: validated.ticketFile,
    trustFile: validated.trustFile,
    controlledEnvironment: true,
    ...(validated.testMode ? {
      testMode: true,
      fakeScript: validated.fakeScript,
      env: { FAKE_P4_REGISTRY: validated.fakeRegistry },
    } : {}),
  });
}

export async function verifyControlledEndpoint(p4, profile) {
  const validated = validateReconnectProfile(profile);
  const live = await readP4ServerBinding(p4);
  if (live.user !== validated.user || live.fingerprint !== validated.serverFingerprint) {
    throw new Error('Perforce endpoint identity mismatch');
  }
  return live;
}

function ambientP4Options(executable, test) {
  return {
    executable,
    preserveAmbientCredentials: true,
    ...(test ? {
      testMode: true,
      fakeScript: test.fakeScript,
      env: { FAKE_P4_REGISTRY: test.fakeRegistry },
    } : {}),
  };
}

export async function discoverControlledP4Profile(options) {
  const environment = options.environment ?? process.env;
  const executable = await resolveP4Executable(options.executable, environment);
  const ambientP4 = options.ambientP4 ?? createP4(ambientP4Options(executable, options.test));
  const settings = await resolveEffectiveP4Settings(ambientP4, options.explicit, environment, {
    allowInvalidEnvironmentFallback: options.allowInvalidEnvironmentFallback,
  });
  const initialP4 = options.knownBinding ? null : createP4({
    executable,
    P4PORT: settings.port,
    P4USER: options.user,
    P4CHARSET: settings.charset,
    ticketFile: settings.ticketFile,
    trustFile: settings.trustFile,
    controlledEnvironment: true,
    ...(options.test ? {
      testMode: true,
      fakeScript: options.test.fakeScript,
      env: { FAKE_P4_REGISTRY: options.test.fakeRegistry },
    } : {}),
  });
  const binding = options.knownBinding ?? await readP4ServerBinding(initialP4);
  if (options.user !== undefined && binding.user !== options.user) throw new Error('configured Perforce user does not match the live user');
  if (options.expectedUser !== undefined && binding.user !== options.expectedUser) throw new Error('Perforce user identity mismatch');
  if (options.expectedFingerprint !== undefined && binding.fingerprint !== options.expectedFingerprint) throw new Error('Perforce server identity mismatch');
  const profile = validateReconnectProfile({
    version: 1,
    executable,
    ...settings,
    user: binding.user,
    serverFingerprint: binding.fingerprint,
    ...(options.test ? { testMode: true, fakeScript: options.test.fakeScript, fakeRegistry: options.test.fakeRegistry } : {}),
  });
  const controlledP4 = options.controlledP4Factory
    ? options.controlledP4Factory(structuredClone(profile))
    : createControlledP4(profile);
  await verifyControlledEndpoint(controlledP4, profile);
  return { profile, p4: controlledP4 };
}
