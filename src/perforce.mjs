import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ownedMarker = 'AgentWorkspace-Owned: true';
const permittedClientFields = ['Stream', 'Options', 'SubmitOptions', 'Host', 'ServerID', 'Type', 'LineEnd'];
const secretEnvironmentNames = new Set(['P4PASSWD', 'P4TICKETS', 'P4CONFIG', 'P4TRUST', 'P4LOGINSSO', 'P4ENVIRO']);
const serverIdentityFields = ['serverAddress', 'serverRoot', 'serverServices', 'serverName', 'serverID', 'caseHandling', 'unicode'];
const validatedBaselines = new WeakSet();

function requireText(value, name) {
  if (typeof value !== 'string' || value.length === 0 || /[\r\n\0]/.test(value)) throw new Error(`${name} must be non-empty text without control newlines`);
  return value;
}

function requireOwnership(ownership) {
  return Object.freeze({
    brokerUuid: requireText(ownership?.brokerUuid, 'brokerUuid'),
    nonce: requireText(ownership?.nonce, 'nonce'),
  });
}

function ownershipLines(ownership, extra = {}) {
  const exact = requireOwnership(ownership);
  return [
    ownedMarker,
    `AgentWorkspace-Broker: ${exact.brokerUuid}`,
    `AgentWorkspace-Nonce: ${exact.nonce}`,
    ...Object.entries(extra).map(([key, value]) => `AgentWorkspace-${key}: ${requireText(String(value), key)}`),
  ];
}

function ownershipDescription(ownership, extra = {}) {
  return ownershipLines(ownership, extra).join('\n');
}

function assertOwnedDescription(description, ownership, extra = {}) {
  const actual = new Set(String(description ?? '').split(/\r?\n/).map((line) => line.trim()));
  for (const marker of ownershipLines(ownership, extra)) {
    if (!actual.has(marker)) throw new Error(`Perforce ownership verification failed: missing '${marker}'`);
  }
}

export function parseTaggedOutput(output) {
  const records = [];
  let record = {};
  let lastKey = null;
  const finish = () => {
    if (Object.keys(record).length > 0) records.push(record);
    record = {};
    lastKey = null;
  };
  for (const rawLine of String(output).split(/\r?\n/)) {
    if (rawLine === '') {
      finish();
      continue;
    }
    const match = /^\.\.\. ([^ ]+)(?: (.*))?$/.exec(rawLine);
    if (!match) {
      if (lastKey) record[lastKey] += `\n${rawLine}`;
      continue;
    }
    const [, key, value = ''] = match;
    if (Object.hasOwn(record, key)) finish();
    record[key] = value;
    lastKey = key;
  }
  finish();
  return records;
}

export function parseP4Form(text) {
  const form = {};
  let active = null;
  for (const line of String(text).replace(/\r/g, '').split('\n')) {
    const field = /^([A-Za-z][A-Za-z0-9]*):(?:\s*(.*))?$/.exec(line);
    if (field) {
      active = field[1];
      form[active] = field[2] ?? '';
      continue;
    }
    const continuation = /^\t(.*)$/.exec(line);
    if (continuation && active) form[active] += `${form[active] ? '\n' : ''}${continuation[1]}`;
  }
  return form;
}

export function formatP4Form(fields) {
  const lines = [];
  for (const [key, rawValue] of Object.entries(fields)) {
    if (rawValue === undefined || rawValue === null || rawValue === '') continue;
    const parts = String(rawValue).split('\n');
    if (parts.length === 1) lines.push(`${key}: ${parts[0]}`);
    else lines.push(`${key}:`, ...parts.map((part) => `\t${part}`));
  }
  return `${lines.join('\n')}\n`;
}

export function createP4(options = {}) {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const maxOutputBytes = options.maxOutputBytes ?? 1024 * 1024;
  const maxBoundedOutputBytes = options.maxBoundedOutputBytes ?? 8 * 1024 * 1024;
  const maxShelvedFileBytes = options.maxShelvedFileBytes ?? 256 * 1024 * 1024;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('timeoutMs must be a positive integer');
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1024) throw new Error('maxOutputBytes must be at least 1024');
  if (!Number.isSafeInteger(maxBoundedOutputBytes) || maxBoundedOutputBytes < maxOutputBytes) throw new Error('maxBoundedOutputBytes must cover maxOutputBytes');
  if (!Number.isSafeInteger(maxShelvedFileBytes) || maxShelvedFileBytes < 1024) throw new Error('maxShelvedFileBytes must be at least 1024');
  const executable = options.testMode ? process.execPath : (options.executable ?? 'p4.exe');
  const prefixArgs = options.testMode ? [requireText(options.fakeScript, 'fakeScript')] : [];
  const connection = {};
  for (const name of ['P4PORT', 'P4USER', 'P4CHARSET']) if (options[name] !== undefined) connection[name] = requireText(options[name], name);

  const environment = () => {
    const env = { ...process.env, ...options.env };
    for (const key of Object.keys(env)) {
      const upper = key.toUpperCase();
      if (upper === 'P4EDITOR' || options.controlledEnvironment && upper.startsWith('P4')
        || !options.preserveAmbientCredentials && secretEnvironmentNames.has(upper)) delete env[key];
    }
    Object.assign(env, connection);
    if (options.ticketFile) env.P4TICKETS = requireText(options.ticketFile, 'ticketFile');
    if (options.trustFile) env.P4TRUST = requireText(options.trustFile, 'trustFile');
    env.P4EDITOR = '';
    return env;
  };
  const clientArguments = (client) => client ? ['-c', requireText(client, 'client')] : [];

  return Object.freeze({
    async run(args, runOptions = {}) {
      if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string' || /[\0\r\n]/.test(arg))) throw new Error('P4 arguments must be an array of strings without control newlines');
      const requestedMax = runOptions.maxOutputBytes ?? maxOutputBytes;
      if (!Number.isSafeInteger(requestedMax) || requestedMax < 1024 || requestedMax > maxBoundedOutputBytes) throw new Error('bounded p4 output limit is invalid');
      const argv = [...prefixArgs, '-ztag', ...clientArguments(runOptions.client), ...args];
      try {
        const result = await executeFile(executable, argv, { cwd: options.cwd, env: environment(), input: runOptions.input, timeoutMs, maxOutputBytes: requestedMax });
        const stdout = result.stdout.toString('utf8');
        const stderr = result.stderr.toString('utf8');
        const records = parseTaggedOutput(stdout);
        const failure = records.find((record) => record.code === 'error');
        if (failure) {
          const error = new Error(`p4 ${args[0] ?? ''} failed: ${failure.data ?? 'tagged error'}`);
          error.records = records;
          throw error;
        }
        return { records, stdout, stderr };
      } catch (error) {
        if (error.message.startsWith(`p4 ${args[0] ?? ''} failed:`)) throw error;
        const records = parseTaggedOutput(String(error.stdout ?? ''));
        const message = records.find((record) => record.code === 'error')?.data || String(error.stderr ?? '').trim() || error.message;
        const wrapped = new Error(`p4 ${args[0] ?? ''} failed: ${message}`);
        wrapped.cause = error;
        wrapped.records = records;
        throw wrapped;
      }
    },
    async readShelvedFileMetadata(depotFile, change, readOptions = {}) {
      const exactDepotFile = requireText(depotFile, 'depotFile');
      const exactChange = requireText(String(change), 'change');
      if (!/^\/\//.test(exactDepotFile) || !/^\d+$/.test(exactChange)) throw new Error('exact shelved file identity is invalid');
      const requestedMax = readOptions.maxOutputBytes ?? maxShelvedFileBytes;
      if (!Number.isSafeInteger(requestedMax) || requestedMax < 1024 || requestedMax > maxShelvedFileBytes) throw new Error('bounded shelved content limit is invalid');
      const argv = [...prefixArgs, ...clientArguments(readOptions.client), 'print', '-q', `${exactDepotFile}@=${exactChange}`];
      try {
        return await executeDigestStream(executable, argv, {
          cwd: options.cwd,
          env: environment(),
          timeoutMs,
          maxContentBytes: requestedMax,
          maxStderrBytes: maxOutputBytes,
        });
      } catch {
        throw new Error('p4 print failed for exact shelved content');
      }
    },
    connection: Object.freeze({ ...connection }),
  });
}

export async function readP4ServerBinding(p4) {
  const records = (await p4.run(['info'])).records.filter((record) => Object.hasOwn(record, 'userName'));
  if (records.length !== 1) throw new Error('Perforce info returned ambiguous live identity');
  const info = records[0];
  const user = requireText(info.userName, 'live Perforce user');
  const identity = {};
  for (const field of serverIdentityFields) {
    if (info[field] !== undefined && info[field] !== '') identity[field] = requireText(info[field], `p4 info ${field}`);
  }
  if (!identity.serverAddress || !identity.serverServices) throw new Error('Perforce info lacks stable server identity fields');
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex');
  return Object.freeze({ user, fingerprint });
}

function executeFile(executable, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: options.cwd, env: options.env, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    let pendingError = null;
    let closed = false;
    const timer = setTimeout(() => {
      pendingError ??= new Error(`p4 timed out after ${options.timeoutMs}ms`);
      child.kill();
    }, options.timeoutMs);
    const collect = (target) => (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > options.maxOutputBytes) {
        pendingError ??= new Error(`p4 output exceeded ${options.maxOutputBytes} bytes`);
        child.kill();
        return;
      }
      target.push(chunk);
    };
    child.stdout.on('data', collect(stdout));
    child.stderr.on('data', collect(stderr));
    child.stdin.on('error', (error) => { pendingError ??= error; });
    child.on('error', (error) => { pendingError ??= error; });
    child.on('close', (code, signal) => {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      const result = { stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), code };
      const error = pendingError ?? (code === 0 ? null : new Error(`p4 exited with code ${code}${signal ? ` (${signal})` : ''}`));
      if (error) {
        Object.assign(error, result);
        reject(error);
      } else resolve(result);
    });
    child.stdin.end(options.input ?? '');
  });
}

function executeDigestStream(executable, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: options.cwd, env: options.env, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    const hash = crypto.createHash('sha256');
    const stderr = [];
    let contentBytes = 0;
    let stderrBytes = 0;
    let pendingError = null;
    let settled = false;
    let escalationTimer = null;

    const clearTimers = () => {
      clearTimeout(timeoutTimer);
      if (escalationTimer) clearTimeout(escalationTimer);
    };
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimers();
      if (error) reject(error);
      else resolve(value);
    };
    const terminate = (error) => {
      pendingError ??= error;
      if (!child.killed) child.kill();
      escalationTimer ??= setTimeout(() => child.kill('SIGKILL'), 250);
    };
    const timeoutTimer = setTimeout(() => {
      terminate(new Error(`p4 timed out after ${options.timeoutMs}ms`));
    }, options.timeoutMs);

    child.stdout.on('data', (chunk) => {
      contentBytes += chunk.length;
      if (contentBytes > options.maxContentBytes) {
        terminate(new Error(`p4 output exceeded ${options.maxContentBytes} bytes`));
        return;
      }
      hash.update(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > options.maxStderrBytes) {
        terminate(new Error(`p4 stderr exceeded ${options.maxStderrBytes} bytes`));
        return;
      }
      stderr.push(chunk);
    });
    child.on('error', (error) => terminate(error));
    child.on('close', (code, signal) => {
      const error = pendingError ?? (code === 0 ? null : new Error(`p4 exited with code ${code}${signal ? ` (${signal})` : ''}`));
      if (error) {
        error.stderr = Buffer.concat(stderr);
        finish(error);
        return;
      }
      finish(null, { digest: hash.digest('hex'), fileSize: String(contentBytes) });
    });
  });
}

async function outputForm(p4, args, client) {
  const result = await p4.run(args, { client });
  const data = result.records.find((record) => record.data)?.data;
  if (data) return parseP4Form(data.replace(/\\n/g, '\n'));
  const form = Object.assign({}, ...result.records);
  if (Object.keys(form).length === 0) throw new Error(`p4 ${args.join(' ')} returned no form`);
  return form;
}

async function openedRecords(p4, args, client) {
  try {
    return (await p4.run(args, { client })).records.filter((record) => record.depotFile);
  } catch (error) {
    if (/file\(s\) not opened on this client\.$/i.test(error.message)) return [];
    throw error;
  }
}

function resourceRecord(type, values, ownership) {
  const exact = requireOwnership(ownership);
  return Object.freeze({ type, ...values, ...exact, handedOff: false });
}

function assertExactPlanned(actual, expectedType, values) {
  if (!actual || actual.type !== expectedType || actual.handedOff !== false) throw new Error(`durably predeclared ${expectedType} resource is required`);
  for (const [key, value] of Object.entries(values)) if (actual[key] !== value) throw new Error(`planned ${expectedType} resource '${key}' mismatch`);
  requireOwnership(actual);
  return actual;
}

export function planP4ClientResource(options) {
  return resourceRecord('p4-client', {
    client: requireText(options.client, 'client'), slot: String(options.slot), root: requireText(options.projectedRoot, 'projectedRoot'),
  }, options.ownership);
}

export function planP4ChangeResource(options) {
  return resourceRecord('p4-change', {
    client: requireText(options.client, 'client'), change: null, taskId: requireText(options.taskId, 'taskId'), user: requireText(options.user, 'user'),
  }, options.ownership);
}

export function planP4HandoffResources(options) {
  const client = requireText(options.client, 'client');
  const taskId = requireText(options.taskId, 'taskId');
  const user = requireText(options.user, 'user');
  const root = requireText(options.root, 'root');
  const common = { client, taskId, user };
  return [
    resourceRecord('p4-client', { ...common, root, slot: `handoff:${taskId}` }, options.ownership),
    resourceRecord('p4-change', { ...common, change: null }, options.ownership),
    resourceRecord('p4-shelf', { ...common, change: null }, options.ownership),
  ];
}

export async function validateDiscoverBase(p4, options) {
  const baseClient = requireText(options.baseClient, 'baseClient');
  const expectedLowerRoot = path.resolve(requireText(options.expectedLowerRoot, 'expectedLowerRoot'));
  const form = await outputForm(p4, ['client', '-o', baseClient]);
  if (form.Client !== baseClient) throw new Error(`base client identity mismatch: expected '${baseClient}'`);
  if (path.resolve(form.Root) !== expectedLowerRoot) throw new Error(`base client Root '${form.Root}' does not exactly match frozen lower '${expectedLowerRoot}'`);
  if (!form.Stream) throw new Error('base client must be a stream client');
  const openedRecordsValue = await openedRecords(p4, ['opened', '-C', baseClient]);
  const opened = [];
  for (const record of openedRecordsValue) {
    const depotFile = record.depotFile;
    const have = (await p4.run(['have', depotFile], { client: baseClient })).records.filter((entry) => entry.depotFile === depotFile && /^\d+$/.test(entry.haveRev ?? ''));
    if (have.length !== 1) throw new Error(`protected base have revision is unavailable or ambiguous for '${depotFile}'`);
    const where = (await p4.run(['where', depotFile], { client: baseClient })).records.filter((entry) => entry.depotFile === depotFile && entry.path);
    if (where.length !== 1) throw new Error(`protected base mapping is unavailable or ambiguous for '${depotFile}'`);
    const mappedPath = path.resolve(where[0].path);
    const relativeLowerPath = path.relative(expectedLowerRoot, mappedPath);
    if (!relativeLowerPath || relativeLowerPath === '..' || relativeLowerPath.startsWith(`..${path.sep}`) || path.isAbsolute(relativeLowerPath)) {
      throw new Error(`protected base mapping for '${depotFile}' is not beneath the exact lower root`);
    }
    const lowerBytes = await fs.readFile(mappedPath);
    opened.push(Object.freeze({
      depotFile,
      haveRev: have[0].haveRev,
      action: record.action,
      change: record.change ?? 'default',
      client: baseClient,
      relativeLowerPath,
      sha256: crypto.createHash('sha256').update(lowerBytes).digest('hex'),
    }));
  }
  const baseline = Object.freeze({
    baseClient, root: form.Root,
    fields: Object.freeze(Object.fromEntries(permittedClientFields.map((key) => [key, form[key]]).filter(([, value]) => value))),
    opened: Object.freeze(opened), protectedDepotPaths: Object.freeze([...new Set(opened.map((entry) => entry.depotFile))]),
  });
  validatedBaselines.add(baseline);
  return baseline;
}

function requireBaseline(options) {
  const baseline = options.baseline;
  if (!baseline || !validatedBaselines.has(baseline)) throw new Error('validated protected baseline from discover is required');
  if (options.baseClient !== undefined && options.baseClient !== baseline.baseClient) throw new Error('baseClient does not match validated baseline');
  return baseline;
}

async function exactClientOrNull(p4, client) {
  const matches = (await p4.run(['clients', '-e', client])).records.filter((record) => record.client === client);
  if (matches.length === 0) return null;
  if (matches.length !== 1) throw new Error(`client existence query for '${client}' was ambiguous`);
  return outputForm(p4, ['client', '-o', client]);
}

export async function provisionSlotClient(p4, options) {
  const baseline = requireBaseline(options);
  const client = requireText(options.client, 'client');
  const root = requireText(options.projectedRoot, 'projectedRoot');
  const slot = String(options.slot);
  const planned = assertExactPlanned(options.plannedResource, 'p4-client', { client, root, slot });
  const existing = await exactClientOrNull(p4, client);
  if (!existing) {
    const form = { Client: client, Root: root, Description: ownershipDescription(planned, { Slot: slot, Client: client }) };
    for (const key of permittedClientFields) if (baseline.fields[key]) form[key] = baseline.fields[key];
    try {
      await p4.run(['client', '-i'], { input: formatP4Form(form) });
    } catch (error) {
      const recovered = await exactClientOrNull(p4, client);
      if (!recovered) throw error;
    }
  }
  const verified = await verifySlotClient(p4, { client, projectedRoot: root, slot, ownership: planned });
  for (const key of permittedClientFields) if ((verified[key] ?? '') !== (baseline.fields[key] ?? '')) throw new Error(`existing slot client field '${key}' does not match the validated base`);
  return planned;
}

export async function verifySlotClient(p4, options) {
  const form = await outputForm(p4, ['client', '-o', options.client]);
  if (form.Client !== options.client || form.Root !== options.projectedRoot) throw new Error('slot client identity or Root was tampered');
  assertOwnedDescription(form.Description, options.ownership, { Slot: String(options.slot), Client: options.client });
  return form;
}

function taskChangeMarkers(resource) {
  return { Task: resource.taskId, Client: resource.client, Change: 'stable' };
}

function verifyChangeForm(form, resource) {
  if (form.Client !== resource.client || form.User !== resource.user || form.Status !== 'pending') throw new Error('stable changelist client, user, or pending status mismatch');
  assertOwnedDescription(form.Description, resource, taskChangeMarkers(resource));
}

export async function findPlannedTaskChange(p4, options) {
  const planned = assertExactPlanned(options.plannedResource, 'p4-change', {
    client: options.plannedResource?.client, change: null, taskId: options.plannedResource?.taskId, user: options.plannedResource?.user,
  });
  const pending = (await p4.run(['changes', '-s', 'pending', '-c', planned.client])).records.filter((record) => record.change);
  const found = [];
  for (const candidate of pending) {
    const form = await outputForm(p4, ['change', '-o', candidate.change], planned.client);
    try {
      assertOwnedDescription(form.Description, planned, taskChangeMarkers(planned));
    } catch (error) {
      if (/ownership verification failed/.test(error.message)) continue;
      throw error;
    }
    verifyChangeForm(form, planned);
    found.push(form.Change);
  }
  if (found.length > 1) throw new Error('multiple stable task changelists have the same ownership nonce');
  return found.length === 1 ? resourceRecord('p4-change', { client: planned.client, change: found[0], taskId: planned.taskId, user: planned.user }, planned) : null;
}

export async function ensureStableTaskChange(p4, options) {
  const planned = assertExactPlanned(options.plannedResource, 'p4-change', {
    client: requireText(options.client, 'client'), change: null, taskId: requireText(options.taskId, 'taskId'), user: requireText(options.user, 'user'),
  });
  let resource = await findPlannedTaskChange(p4, { plannedResource: planned });
  if (!resource) {
    const form = { Change: 'new', Client: planned.client, User: planned.user, Status: 'new', Description: ownershipDescription(planned, taskChangeMarkers(planned)) };
    try {
      const created = await p4.run(['change', '-i'], { client: planned.client, input: formatP4Form(form) });
      const change = created.records.find((record) => record.change)?.change;
      if (change) resource = resourceRecord('p4-change', { client: planned.client, change, taskId: planned.taskId, user: planned.user }, planned);
    } catch (error) {
      resource = await findPlannedTaskChange(p4, { plannedResource: planned });
      if (!resource) throw error;
    }
    resource ??= await findPlannedTaskChange(p4, { plannedResource: planned });
    if (!resource) throw new Error('Perforce did not return or retain a created changelist number');
  }
  const form = await outputForm(p4, ['change', '-o', resource.change], resource.client);
  verifyChangeForm(form, resource);
  const defaults = await openedRecords(p4, ['opened', '-C', resource.client, '-c', 'default']);
  if (defaults.length > 0) await p4.run(['reopen', '-c', resource.change, ...defaults.map((record) => record.depotFile)], { client: resource.client });
  return resource;
}

function uniqueDepotPaths(paths) {
  const result = [...new Set(paths.map((value) => requireText(value, 'depot path')))];
  if (result.some((value) => !value.startsWith('//'))) throw new Error('all lazy seed paths must be absolute depot paths');
  return result;
}

function batchesByArgumentBytes(values, maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 256) throw new Error('maxBatchArgumentBytes must be at least 256');
  const batches = [];
  let batch = [];
  let bytes = 0;
  for (const value of values) {
    const size = Buffer.byteLength(value, 'utf8') + 3;
    if (size > maxBytes) throw new Error(`single depot argument exceeds bounded command line: '${value}'`);
    if (batch.length > 0 && bytes + size > maxBytes) {
      batches.push(batch);
      batch = [];
      bytes = 0;
    }
    batch.push(value);
    bytes += size;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

export async function seedExactPaths(p4, options) {
  const baseline = requireBaseline(options);
  const paths = uniqueDepotPaths(options.depotPaths ?? []);
  const maxBytes = options.maxBatchArgumentBytes ?? 24_000;
  const revisions = [];
  for (const batch of batchesByArgumentBytes(paths, maxBytes)) {
    const records = (await p4.run(['have', ...batch], { client: baseline.baseClient, maxOutputBytes: Math.max(1024, batch.length * 1024) })).records.filter((record) => record.depotFile);
    for (const depotFile of batch) {
      const matches = records.filter((record) => record.depotFile === depotFile && /^\d+$/.test(record.haveRev ?? ''));
      if (matches.length !== 1) throw new Error(`base have revision is unavailable or ambiguous for '${depotFile}'`);
      revisions.push({ depotFile, haveRev: matches[0].haveRev });
    }
  }
  const specs = revisions.map(({ depotFile, haveRev }) => `${depotFile}#${haveRev}`);
  for (const batch of batchesByArgumentBytes(specs, maxBytes)) await p4.run(['sync', '-k', '-L', ...batch], { client: options.workerClient, maxOutputBytes: Math.max(1024, batch.length * 1024) });
  for (const batch of batchesByArgumentBytes(paths, maxBytes)) {
    const records = (await p4.run(['have', ...batch], { client: options.workerClient, maxOutputBytes: Math.max(1024, batch.length * 1024) })).records.filter((record) => record.depotFile);
    for (const depotFile of batch) {
      const expected = revisions.find((entry) => entry.depotFile === depotFile);
      const matches = records.filter((record) => record.depotFile === depotFile && record.haveRev === expected.haveRev);
      if (matches.length !== 1) throw new Error(`worker have verification failed for '${depotFile}'`);
    }
  }
  return revisions;
}

function assertPathsAreAllowed(paths, baseline, options, operation) {
  const explicitlyAllowed = new Set(options.allowedProtectedPaths ?? []);
  const protectedPaths = new Set(baseline.protectedDepotPaths);
  const rejected = paths.filter((depotFile) => protectedPaths.has(depotFile)
    && options.allowProtectedBase !== true && !explicitlyAllowed.has(depotFile));
  if (rejected.length > 0) throw new Error(`${operation} rejects inherited protected path(s): ${rejected.join(', ')}`);
}

export async function openPaths(p4, options) {
  const baseline = requireBaseline(options);
  const action = options.action;
  if (!['edit', 'add', 'delete'].includes(action)) throw new Error("open action must be 'edit', 'add', or 'delete'");
  const paths = uniqueDepotPaths(options.depotPaths ?? []);
  assertPathsAreAllowed(paths, baseline, options, 'open');
  if (action !== 'add') await seedExactPaths(p4, { ...options, baseline, depotPaths: paths });
  if (paths.length > 0) await p4.run([action, ...(options.change === undefined ? [] : ['-c', String(options.change)]), ...paths], { client: options.workerClient });
  return { action, paths };
}

function indexedShelfFiles(records) {
  const supportedActions = new Set(['add', 'edit', 'delete', 'branch', 'integrate', 'move/add', 'move/delete']);
  const indexedFields = new Map();
  for (const record of records) {
    for (const [key, value] of Object.entries(record)) {
      const match = /^(depotFile|action|rev|type|movedFile|movedRev)(\d+)$/.exec(key);
      if (!match) continue;
      const [, field, suffix] = match;
      const fields = indexedFields.get(suffix) ?? {};
      if (Object.hasOwn(fields, field)) throw new Error(`shelf describe contains duplicate indexed field '${key}'`);
      fields[field] = value;
      indexedFields.set(suffix, fields);
    }
  }
  const files = [...indexedFields.entries()].map(([suffix, fields]) => {
    for (const required of ['depotFile', 'action', 'rev', 'type']) {
      if (typeof fields[required] !== 'string' || fields[required].length === 0) {
        throw new Error(`shelf describe indexed file ${suffix} has missing ${required}`);
      }
    }
    if (!/^\d+$/.test(fields.rev)) throw new Error(`shelf describe indexed file ${suffix} has invalid revision`);
    if (!supportedActions.has(fields.action)) throw new Error(`shelf describe indexed file ${suffix} has unsupported action '${fields.action}'`);
    const isMove = fields.action === 'move/add' || fields.action === 'move/delete';
    const hasMovedFile = typeof fields.movedFile === 'string' && fields.movedFile.length > 0;
    const hasMovedRev = typeof fields.movedRev === 'string' && /^\d+$/.test(fields.movedRev);
    if (isMove !== hasMovedFile || isMove !== hasMovedRev) {
      throw new Error(`shelf describe indexed file ${suffix} has invalid move metadata`);
    }
    return {
      depotFile: fields.depotFile,
      action: fields.action,
      rev: fields.rev,
      type: fields.type,
      movedFile: fields.movedFile ?? null,
      movedRev: fields.movedRev ?? null,
    };
  });
  const byPath = new Map(files.map((file) => [file.depotFile, file]));
  for (const file of files.filter((candidate) => candidate.action.startsWith('move/'))) {
    const peer = byPath.get(file.movedFile);
    const expectedAction = file.action === 'move/add' ? 'move/delete' : 'move/add';
    if (!peer || peer.action !== expectedAction || peer.movedFile !== file.depotFile) {
      throw new Error(`shelf describe move pair for '${file.depotFile}' is incomplete or inconsistent`);
    }
  }
  return files.sort((left, right) => left.depotFile.localeCompare(right.depotFile));
}

function shelfActionNeedsHave(action) {
  return action === 'edit' || action === 'delete' || action === 'integrate' || action === 'move/delete';
}

export async function importShelf(p4, options) {
  const baseline = requireBaseline(options);
  const described = await p4.run(['describe', '-S', '-s', String(options.shelf)]);
  const files = indexedShelfFiles(described.records);
  if (files.length === 0) throw new Error('shelf describe returned no indexed files');
  assertPathsAreAllowed(files.map((file) => file.depotFile), baseline, options, 'unshelve');
  await seedExactPaths(p4, { ...options, baseline, depotPaths: files.filter((file) => shelfActionNeedsHave(file.action)).map((file) => file.depotFile) });
  await p4.run(['unshelve', '-s', String(options.shelf), '-c', String(options.change)], { client: options.workerClient });
  return { files, paths: files.map((file) => file.depotFile) };
}

export async function shelfExists(p4, change) {
  try {
    const described = await p4.run(['describe', '-S', '-s', String(change)]);
    return indexedShelfFiles(described.records).length > 0;
  } catch (error) {
    if (new RegExp(`^p4 describe failed: Change ${change} (?:has no shelved files|unknown)\\.$`, 'i').test(error.message)) return false;
    throw error;
  }
}

export async function checkpoint(p4, options) {
  const baseline = requireBaseline(options);
  const resource = options.changeResource;
  if (!resource || resource.type !== 'p4-change' || String(resource.change) !== String(options.change) || resource.client !== options.client) throw new Error('exact owned p4-change resource is required');
  const form = await outputForm(p4, ['change', '-o', String(resource.change)], resource.client);
  verifyChangeForm(form, resource);
  const opened = await openedRecords(p4, ['opened', '-C', resource.client]);
  assertPathsAreAllowed(opened.map((record) => record.depotFile), baseline, options, 'checkpoint');
  const defaults = opened.filter((record) => (record.change ?? 'default') === 'default');
  if (defaults.length > 0) await p4.run(['reopen', '-c', String(resource.change), ...defaults.map((record) => record.depotFile)], { client: resource.client });
  const relevant = opened.filter((record) => (record.change ?? 'default') === 'default' || String(record.change) === String(resource.change));
  if (relevant.length === 0) {
    if (!await shelfExists(p4, resource.change)) return { state: 'no_changes', change: String(resource.change), opened: [] };
    const shelfResource = resourceRecord('p4-shelf', { client: resource.client, change: String(resource.change), taskId: resource.taskId }, resource);
    return { state: 'shelf_retained', change: String(resource.change), opened: [], shelfResource };
  }
  const replacing = await shelfExists(p4, resource.change);
  await p4.run(['shelve', ...(replacing ? ['-r'] : []), '-c', String(resource.change)], { client: resource.client });
  const shelfResource = resourceRecord('p4-shelf', { client: resource.client, change: String(resource.change), taskId: resource.taskId }, resource);
  return { state: 'shelved', change: String(resource.change), opened: relevant.map((record) => record.depotFile), replaced: replacing, shelfResource };
}

async function changeOrNull(p4, resource) {
  try {
    return await outputForm(p4, ['change', '-o', String(resource.change)], resource.client);
  } catch (error) {
    if (new RegExp(`^p4 change failed: Change ${resource.change} (?:does not exist|unknown)\\.$`, 'i').test(error.message)) return null;
    throw error;
  }
}

async function clientOrNull(p4, client) {
  return exactClientOrNull(p4, client);
}

function matchingShelfResource(resources, changeResource) {
  return resources.find((resource) => resource.type === 'p4-shelf' && resource.client === changeResource.client && String(resource.change) === String(changeResource.change)
    && resource.taskId === changeResource.taskId && resource.brokerUuid === changeResource.brokerUuid && resource.nonce === changeResource.nonce);
}

export async function cleanupResources(p4, options) {
  if (options.workersStopped !== true) throw new Error('cleanup requires workersStopped === true fence');
  const resources = options.resources ?? [];
  if (resources.some((resource) => resource.handedOff)) throw new Error('cleanup rejects handed-off resources');
  const changes = [];
  for (const resource of resources.filter((entry) => entry.type === 'p4-change')) {
    if (resource.change !== null) changes.push(resource);
    else {
      const recovered = await findPlannedTaskChange(p4, { plannedResource: resource });
      if (recovered) changes.push(recovered);
    }
  }
  const clients = resources.filter((resource) => resource.type === 'p4-client');
  let foundLiveResource = false;

  for (const resource of changes) {
    requireOwnership(resource);
    const form = await changeOrNull(p4, resource);
    if (!form) continue;
    foundLiveResource = true;
    verifyChangeForm(form, resource);
    const hasShelf = await shelfExists(p4, resource.change);
    if (hasShelf && !matchingShelfResource(resources, resource)) throw new Error('owned change shelf is missing its exact p4-shelf ledger resource');
  }
  for (const resource of clients) {
    requireOwnership(resource);
    const form = await clientOrNull(p4, resource.client);
    if (!form) continue;
    foundLiveResource = true;
    if (form.Root !== resource.root) throw new Error('client Root identity was tampered');
    assertOwnedDescription(form.Description, resource, { Slot: String(resource.slot), Client: resource.client });
    const allowed = new Set(changes.filter((change) => change.client === resource.client).map((change) => String(change.change)));
    const opens = await openedRecords(p4, ['opened', '-C', resource.client]);
    if (opens.some((record) => !allowed.has(String(record.change ?? 'default')))) throw new Error(`client '${resource.client}' has unrecorded opens`);
    const pending = (await p4.run(['changes', '-s', 'pending', '-c', resource.client])).records.filter((record) => record.change);
    if (pending.some((record) => !allowed.has(String(record.change)))) throw new Error(`client '${resource.client}' has unrecorded pending changes`);
  }

  for (const resource of changes) {
    let form = await changeOrNull(p4, resource);
    if (!form) continue;
    verifyChangeForm(form, resource);
    let opens = await openedRecords(p4, ['opened', '-C', resource.client, '-c', String(resource.change)]);
    if (opens.length > 0) {
      form = await changeOrNull(p4, resource);
      if (!form) throw new Error('owned change disappeared before revert');
      verifyChangeForm(form, resource);
      opens = await openedRecords(p4, ['opened', '-C', resource.client, '-c', String(resource.change)]);
      if (opens.length > 0) await p4.run(['revert', '-k', '-c', String(resource.change), `//${resource.client}/...`], { client: resource.client });
    }
    if (await shelfExists(p4, resource.change)) {
      form = await changeOrNull(p4, resource);
      if (!form) throw new Error('owned change disappeared before shelf delete');
      verifyChangeForm(form, resource);
      if (!matchingShelfResource(resources, resource)) throw new Error('owned change shelf is missing its exact p4-shelf ledger resource');
      await p4.run(['shelve', '-d', '-c', String(resource.change)], { client: resource.client });
    }
    form = await changeOrNull(p4, resource);
    if (form) {
      verifyChangeForm(form, resource);
      const remaining = await openedRecords(p4, ['opened', '-C', resource.client, '-c', String(resource.change)]);
      if (remaining.length > 0 || await shelfExists(p4, resource.change)) throw new Error('owned change is not empty immediately before delete');
      await p4.run(['change', '-d', String(resource.change)], { client: resource.client });
    }
  }
  for (const resource of clients) {
    const form = await clientOrNull(p4, resource.client);
    if (!form) continue;
    if (form.Root !== resource.root) throw new Error('client Root identity was tampered');
    assertOwnedDescription(form.Description, resource, { Slot: String(resource.slot), Client: resource.client });
    const opens = await openedRecords(p4, ['opened', '-C', resource.client]);
    const pending = (await p4.run(['changes', '-s', 'pending', '-c', resource.client])).records.filter((record) => record.change);
    if (opens.length > 0 || pending.length > 0) throw new Error('client is not empty immediately before delete');
    await p4.run(['client', '-d', resource.client]);
  }
  return { cleaned: true, idempotent: !foundLiveResource };
}

function reviewMarkers(resource) {
  return { Task: resource.taskId, Client: resource.client, Change: 'review-handoff' };
}

function disposalResources(resources) {
  const byType = new Map(resources.map((resource) => [resource.type, resource]));
  return {
    client: byType.get('p4-client'),
    change: byType.get('p4-change'),
    shelf: byType.get('p4-shelf'),
  };
}

async function exactLiveUser(p4, expectedUser) {
  const records = (await p4.run(['info'])).records.filter((record) => Object.hasOwn(record, 'userName'));
  if (records.length !== 1 || records[0].userName !== expectedUser) throw new Error('live Perforce user does not match review ownership');
}

function assertExactDisposalDescription(description, resource, extra) {
  const expected = ownershipLines(resource, extra);
  const lines = String(description ?? '').split(/\r?\n/).map((line) => line.trim());
  for (const marker of expected) {
    const separator = marker.indexOf(':');
    const prefix = separator < 0 ? marker : marker.slice(0, separator + 1);
    const matches = lines.filter((line) => separator < 0 ? line === prefix : line.startsWith(prefix));
    if (matches.length !== 1 || matches[0] !== marker) throw new Error('review ownership description is not exact');
  }
}

export async function inspectReviewDisposal(p4, options) {
  const resources = disposalResources(options.resources ?? []);
  if (!resources.client || !resources.change || !resources.shelf) throw new Error('exact review resources are required');
  await exactLiveUser(p4, resources.client.user);

  const clientForm = await clientOrNull(p4, resources.client.client);
  const changeForm = await changeOrNull(p4, resources.change);
  const hasShelf = changeForm ? await shelfExists(p4, resources.change.change) : false;
  const opens = clientForm ? await openedRecords(p4, ['opened', '-C', resources.client.client]) : [];
  const pending = clientForm
    ? (await p4.run(['changes', '-s', 'pending', '-c', resources.client.client])).records.filter((record) => record.change)
    : [];

  if (clientForm) {
    if (clientForm.Client !== resources.client.client || clientForm.Root !== resources.client.root || clientForm.Owner !== resources.client.user) {
      throw new Error('review client identity, Root, or Owner mismatch');
    }
    assertExactDisposalDescription(clientForm.Description, resources.client, {
      Task: resources.client.taskId, Client: resources.client.client, Resource: 'review-handoff',
    });
  }
  if (changeForm) {
    if (changeForm.Client !== resources.change.client || changeForm.User !== resources.change.user || changeForm.Status !== 'pending') {
      throw new Error('review changelist client, user, or pending status mismatch');
    }
    assertExactDisposalDescription(changeForm.Description, resources.change, reviewMarkers(resources.change));
  }
  if (hasShelf && (!changeForm || resources.shelf.change !== resources.change.change)) throw new Error('review shelf identity mismatch');
  if (opens.length > 0) throw new Error('review client has open files');
  const allowedPending = changeForm ? new Set([String(resources.change.change)]) : new Set();
  if (pending.some((record) => !allowedPending.has(String(record.change)))) throw new Error('review client has unrelated pending changes');
  if (changeForm && !pending.some((record) => String(record.change) === String(resources.change.change))) {
    throw new Error('review change is not the exact pending change');
  }
  return { client: Boolean(clientForm), change: Boolean(changeForm), shelf: hasShelf };
}

export async function deleteReviewDisposalResource(p4, options) {
  const resources = disposalResources(options.resources ?? []);
  if (options.phase === 'shelf') {
    await p4.run(['shelve', '-d', '-c', String(resources.shelf.change)], { client: resources.client.client });
    return;
  }
  if (options.phase === 'change') {
    await p4.run(['change', '-d', String(resources.change.change)], { client: resources.client.client });
    return;
  }
  if (options.phase === 'client') {
    await p4.run(['client', '-d', resources.client.client]);
    return;
  }
  throw new Error('unknown review disposal phase');
}

function verifyReviewChangeForm(form, resource) {
  if (form.Client !== resource.client || form.User !== resource.user || form.Status !== 'pending') {
    throw new Error('review changelist client, user, or pending status mismatch');
  }
  assertOwnedDescription(form.Description, resource, reviewMarkers(resource));
}

function verifyReviewClientForm(form, resource, baseline) {
  if (!form || form.Client !== resource.client || form.Root !== resource.root) throw new Error('review client identity or Root mismatch');
  assertOwnedDescription(form.Description, resource, { Task: resource.taskId, Client: resource.client, Resource: 'review-handoff' });
  if (form.Owner !== resource.user) throw new Error('review client owner does not match the configured user');
  for (const key of permittedClientFields) if ((form[key] ?? '') !== (baseline.fields[key] ?? '')) {
    throw new Error(`review client field '${key}' does not match the validated base`);
  }
}

export async function verifyReviewClient(p4, options) {
  const resource = options.resource;
  requireOwnership(resource);
  const form = await exactClientOrNull(p4, resource.client);
  verifyReviewClientForm(form, resource, options.baseline);
  return resource;
}

export async function ensureReviewClient(p4, options) {
  const resource = assertExactPlanned(options.resource, 'p4-client', {
    client: requireText(options.client, 'client'), root: requireText(options.root, 'root'), slot: `handoff:${requireText(options.taskId, 'taskId')}`,
  });
  let form = await exactClientOrNull(p4, resource.client);
  if (!form) {
    const created = {
      Client: resource.client,
      Root: resource.root,
      Owner: resource.user,
      Description: ownershipDescription(resource, { Task: resource.taskId, Client: resource.client, Resource: 'review-handoff' }),
    };
    for (const key of permittedClientFields) if (options.baseline.fields[key]) created[key] = options.baseline.fields[key];
    try {
      await p4.run(['client', '-i'], { input: formatP4Form(created) });
    } catch (error) {
      form = await exactClientOrNull(p4, resource.client);
      if (!form) throw error;
    }
    form ??= await exactClientOrNull(p4, resource.client);
  }
  verifyReviewClientForm(form, resource, options.baseline);
  return resource;
}

async function findReviewChange(p4, resource) {
  const pending = (await p4.run(['changes', '-s', 'pending', '-c', resource.client, '-u', resource.user])).records.filter((record) => record.change);
  const matches = [];
  for (const candidate of pending) {
    const form = await outputForm(p4, ['change', '-o', String(candidate.change)], resource.client);
    try {
      assertOwnedDescription(form.Description, resource, reviewMarkers(resource));
    } catch (error) {
      if (/ownership verification failed/.test(error.message)) continue;
      throw error;
    }
    verifyReviewChangeForm(form, resource);
    matches.push(form.Change);
  }
  if (matches.length > 1) throw new Error('multiple review changelists have the exact handoff nonce');
  return matches[0] ?? null;
}

export async function ensureReviewChange(p4, options) {
  const resource = assertExactPlanned(options.resource, 'p4-change', {
    client: requireText(options.client, 'client'), change: null, taskId: requireText(options.taskId, 'taskId'), user: requireText(options.user, 'user'),
  });
  let change = await findReviewChange(p4, resource);
  if (!change) {
    const form = {
      Change: 'new', Client: resource.client, User: resource.user, Status: 'new',
      Description: ownershipDescription(resource, reviewMarkers(resource)),
    };
    try {
      change = (await p4.run(['change', '-i'], { client: resource.client, input: formatP4Form(form) })).records.find((record) => record.change)?.change;
    } catch (error) {
      change = await findReviewChange(p4, resource);
      if (!change) throw error;
    }
    change ??= await findReviewChange(p4, resource);
    if (!change) throw new Error('Perforce did not return or retain a review changelist number');
  }
  const actual = resourceRecord('p4-change', {
    client: resource.client, change: String(change), taskId: resource.taskId, user: resource.user,
  }, resource);
  verifyReviewChangeForm(await outputForm(p4, ['change', '-o', actual.change], actual.client), actual);
  return actual;
}

export async function detectReshelvePromotion(p4) {
  const info = Object.assign({}, ...(await p4.run(['info'])).records);
  const services = String(info.serverServices ?? '').trim().toLowerCase();
  if (services.includes('edge-server')) return { promote: true, state: 'promoted' };
  if (services === 'standard' || services.includes('commit-server')) return { promote: false, state: 'not_required' };
  throw new Error(`unsupported Perforce serverServices topology '${services || 'missing'}'`);
}

function requireMetadataValue(record, field, family, change) {
  const value = record[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`shelf ${change} has incomplete ${family} content metadata for '${record.depotFile}'`);
  }
  return value;
}

async function canonicalShelfMetadata(p4, record, file, change, client) {
  const deleting = file.action === 'delete' || file.action === 'move/delete';
  const shelfFields = ['shelvedDigest', 'shelvedFileSize', 'shelvedType'];
  const directContentFields = ['digest', 'fileSize'];
  const hasShelfFamily = shelfFields.some((field) => Object.hasOwn(record, field));
  if (!Object.hasOwn(record, 'shelved')) throw new Error(`shelf ${change} fstat record is not exact shelved evidence for '${file.depotFile}'`);
  if (record.change !== change) throw new Error(`shelf ${change} fstat change does not match for '${file.depotFile}'`);
  if (record.action !== file.action) throw new Error(`shelf ${change} action metadata does not match describe for '${file.depotFile}'`);
  if (deleting) {
    const typeField = hasShelfFamily ? 'shelvedType' : 'type';
    const type = requireMetadataValue(record, typeField, hasShelfFamily ? 'shelved' : 'direct', change);
    if (type !== file.type) throw new Error(`shelf ${change} type metadata does not match describe for '${file.depotFile}'`);
    return { depotFile: record.depotFile, digest: null, fileSize: null, type };
  }
  const hasDirectContent = directContentFields.some((field) => Object.hasOwn(record, field));
  if (!hasShelfFamily && !hasDirectContent) {
    const type = requireMetadataValue(record, 'type', 'direct', change);
    if (type !== file.type) throw new Error(`shelf ${change} type metadata does not match describe for '${file.depotFile}'`);
    if (typeof p4.readShelvedFileMetadata !== 'function') throw new Error(`shelf ${change} has no supported exact content evidence for '${file.depotFile}'`);
    const contentMetadata = await p4.readShelvedFileMetadata(file.depotFile, change, { client });
    return {
      depotFile: record.depotFile,
      digest: contentMetadata.digest,
      fileSize: contentMetadata.fileSize,
      type,
    };
  }
  const family = hasShelfFamily ? 'shelved' : 'direct';
  const [digestField, fileSizeField, typeField] = hasShelfFamily
    ? ['shelvedDigest', 'shelvedFileSize', 'shelvedType']
    : ['digest', 'fileSize', 'type'];
  const digest = requireMetadataValue(record, digestField, family, change);
  const fileSize = requireMetadataValue(record, fileSizeField, family, change);
  const type = requireMetadataValue(record, typeField, family, change);
  if (!/^\d+$/.test(fileSize)) throw new Error(`shelf ${change} has invalid ${family} file size for '${record.depotFile}'`);
  if (type !== file.type) throw new Error(`shelf ${change} type metadata does not match describe for '${file.depotFile}'`);
  return { depotFile: record.depotFile, digest, fileSize, type };
}

export async function canonicalShelf(p4, options) {
  const change = String(options.change);
  const described = await p4.run(['describe', '-S', '-s', change], { client: options.client });
  const files = indexedShelfFiles(described.records);
  if (files.length === 0) throw new Error(`shelf ${change} is empty`);
  const paths = new Set();
  for (const file of files) {
    if (paths.has(file.depotFile)) throw new Error(`shelf ${change} contains duplicate depot path '${file.depotFile}'`);
    paths.add(file.depotFile);
  }
  const metadataRecords = (await p4.run(['fstat', '-e', change, '-Rs', '-Ol', '//...'], { client: options.client })).records.filter((record) => record.depotFile);
  const metadataRecordsByPath = new Map();
  for (const record of metadataRecords) {
    if (metadataRecordsByPath.has(record.depotFile)) throw new Error(`shelf ${change} fstat contains duplicate depot path '${record.depotFile}'`);
    metadataRecordsByPath.set(record.depotFile, record);
  }
  if (metadataRecordsByPath.size !== files.length || files.some((file) => !metadataRecordsByPath.has(file.depotFile))) {
    throw new Error(`shelf ${change} fstat path set does not exactly match describe`);
  }
  const records = [];
  for (const file of files) {
    records.push({
      ...file,
      metadata: await canonicalShelfMetadata(p4, metadataRecordsByPath.get(file.depotFile), file, change, options.client),
    });
  }
  return { records, fingerprint: crypto.createHash('sha256').update(JSON.stringify(records)).digest('hex') };
}

export async function reshelveHandoff(p4, options) {
  const promotion = await detectReshelvePromotion(p4);
  const args = ['reshelve', ...(promotion.promote ? ['-p'] : []), '-s', String(options.sourceChange), '-c', String(options.destinationChange)];
  try {
    await p4.run(args, { client: options.destinationClient });
  } catch (error) {
    const destination = await canonicalShelf(p4, { client: options.destinationClient, change: options.destinationChange }).catch(() => null);
    if (!destination) throw error;
  }
  return promotion;
}

export async function verifyHandoffShelf(p4, options) {
  const destinationResource = options.destinationChangeResource;
  verifyReviewChangeForm(await outputForm(p4, ['change', '-o', String(destinationResource.change)], destinationResource.client), destinationResource);
  const source = await canonicalShelf(p4, { client: options.sourceClient, change: options.sourceChange });
  const destination = await canonicalShelf(p4, { client: destinationResource.client, change: destinationResource.change });
  if (JSON.stringify(source.records) !== JSON.stringify(destination.records)) {
    throw new Error('source and destination shelf records do not exactly match');
  }
  return { source, destination, fileCount: source.records.length };
}

export function buildSanitizedWorkerEnv(baseEnv, values) {
  const env = { ...baseEnv };
  for (const key of Object.keys(env)) if (secretEnvironmentNames.has(key.toUpperCase()) || key.toUpperCase() === 'P4EDITOR') delete env[key];
  for (const name of ['P4CLIENT', 'P4PORT', 'P4USER', 'P4CHARSET', 'P4_CHANGE', 'AGENT_WORKSPACE_P4_CHANGE']) {
    if (values[name] !== undefined) env[name] = requireText(values[name], name);
  }
  env.P4EDITOR = '';
  return env;
}
