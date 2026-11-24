import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import {
  cancelTask,
  getTask,
  getTasks,
  initialize,
  isWindowsX64Pe,
  loadConfig,
  readSlots,
  rerunTask,
  startTask,
} from './broker.mjs';
import { createHumanSlot, humanSlotGuidance, inspectProjfsSafety, refreshProviderStates } from './projfs.mjs';
import { atomicWriteJson, defaultStateDir } from './state.mjs';
import { getAuthStatus, inspectConfiguredAuth, prepareAuth } from './auth.mjs';
import { runWorker } from './worker.mjs';
import { cleanupBroker } from './cleanup.mjs';
import { runGenerationSupervisor } from './generation-supervisor.mjs';
import { revisionControlBackend, revisionControlStatus } from './revision-control.mjs';
import { readProjectPreference } from './revision-control-preference.mjs';
import { withLifecycleLock } from './state.mjs';

const bundledProviderExe = fileURLToPath(new URL('../native/projfs-provider/bin/win32-x64/projfs-provider.exe', import.meta.url));

export function resolveProviderExecutable({ adapter = 'projfs', testMode = false, providerExe } = {}) {
  if (providerExe !== undefined || adapter !== 'projfs' || testMode) {
    return providerExe;
  }
  return bundledProviderExe;
}

export async function main(argv) {
  const command = argv[0];
  if (!command || ['help', '--help', '-h'].includes(command)) {
    printHelp();
    return;
  }

  const { flags, positionals, commandArgs } = parseArguments(argv.slice(1));
  const stateDir = path.resolve(stringFlag(flags, 'state-dir') ?? process.env.AGENT_WORKSPACE_STATE_DIR ?? defaultStateDir());

  switch (command) {
    case 'doctor':
      await doctor(stateDir, flags);
      return;
    case 'auth':
      await authCommand(stateDir, flags, positionals);
      return;
    case 'init':
      await initCommand(stateDir, flags);
      return;
    case 'human-slot':
      await humanSlotCommand(stateDir, flags, positionals);
      return;
    case 'base-change':
      await baseChangeCommand(stateDir, flags, positionals);
      return;
    case 'start':
      await startCommand(stateDir, flags, [...positionals, ...commandArgs]);
      return;
    case 'run':
      await runCommand(stateDir, flags, positionals, commandArgs);
      return;
    case 'status':
      await statusCommand(stateDir, positionals);
      return;
    case 'p4':
      await p4Command(stateDir, flags, positionals, commandArgs);
      return;
    case 'logs':
      await logsCommand(stateDir, flags, positionals);
      return;
    case 'cancel':
      await cancelCommand(stateDir, positionals);
      return;
    case 'cleanup':
      if (positionals.length !== 0 || commandArgs.length !== 0) {
        throw new Error('cleanup does not accept retention choices, task IDs, or command arguments');
      }
      for (const name of flags.keys()) {
        if (!['state-dir', 'broker-uuid'].includes(name)) {
          throw new Error(`cleanup does not support --${name}`);
        }
      }
      console.log(JSON.stringify(withoutPrivateReconnectBinding(await cleanupBroker(stateDir, {
        expectedBrokerUuid: requiredStringFlag(flags, 'broker-uuid'),
      })), null, 2));
      return;
    case '_worker':
      await runWorker(stateDir, requiredStringFlag(flags, 'task-id'));
      return;
    case '_generation-supervisor':
      await runGenerationSupervisor(stateDir);
      return;
    default:
      throw new Error(`unknown command '${command}'`);
  }
}

export async function doctor(stateDir, flags = new Map()) {
  let config = null;
  try {
    config = await loadConfig(stateDir);
  } catch (error) {
    if (!error.message.startsWith('broker is not initialized')) {
      throw error;
    }
  }

  const isTestAdapter = config?.adapter === 'test';
  const isProjfsAdapter = config?.adapter === 'projfs';
  const checks = {
    node: { ok: Number(process.versions.node.split('.')[0]) >= 20, actual: process.version, expected: '>=20' },
    platform: { ok: process.platform === 'win32' || isTestAdapter, actual: process.platform, expected: 'win32', skipped: isTestAdapter },
    state: { ok: config !== null, actual: config ? stateDir : 'not initialized', expected: 'initialized' },
    workspace: {
      ok: config ? await isDirectory(config.workspace) : false,
      actual: config?.workspace ?? null,
      expected: 'existing directory',
    },
    providerExe: {
      ok: !isProjfsAdapter || config.testMode
        ? !isProjfsAdapter || await isFile(config.providerExe)
        : await isWindowsX64Pe(config.providerExe),
      actual: config?.providerExe ?? null,
      expected: config?.testMode ? 'existing explicit test fixture' : 'Windows x64 PE ProjFS provider',
      skipped: !isProjfsAdapter,
    },
    lowerGuardExe: {
      ok: !isProjfsAdapter || (config.testMode ? await isFile(config.lowerGuardExe) : await isWindowsX64Pe(config.lowerGuardExe)),
      actual: config?.lowerGuardExe ?? null,
      expected: config?.testMode ? 'existing explicit test fixture' : 'Windows x64 PE lower watcher',
      skipped: !isProjfsAdapter,
    },
    nativeSupervisor: {
      ok: !isProjfsAdapter || config.testMode
        || await isWindowsX64Pe(config.launchSupervisorExe) && await isWindowsX64Pe(config.generationSupervisorExe),
      actual: config ? { launch: config.launchSupervisorExe, generation: config.generationSupervisorExe } : null,
      expected: 'Windows x64 PE launch and generation supervisors',
      skipped: !isProjfsAdapter,
    },
  };

  if (config?.auth?.enabled) {
    checks.auth = await inspectConfiguredAuth(config);
  } else {
    checks.auth = { ok: true, configured: false, skipped: true };
  }

  const ok = Object.values(checks).every((check) => check.ok || check.skipped);
  console.log(JSON.stringify({ ok, checks }, null, 2));
  if (!ok) {
    process.exitCode = 1;
  }
  return { ok, checks };
}

async function authCommand(stateDir, flags, positionals) {
  if (positionals.length !== 1 || !['prepare', 'status'].includes(positionals[0])) {
    throw new Error("auth requires exactly one subcommand: 'prepare' or 'status'");
  }
  if (positionals[0] === 'status') {
    console.log(JSON.stringify(await getAuthStatus(stateDir), null, 2));
    return;
  }
  const minValidMs = integerFlag(flags, 'min-valid-ms');
  const status = await prepareAuth(stateDir, {
    hordeUrl: requiredStringFlag(flags, 'horde-url'),
    oidcTokenExe: stringFlag(flags, 'oidc-token-exe'),
    minValidMs,
  });
  console.log(JSON.stringify(status, null, 2));
}

async function initCommand(stateDir, flags) {
  const projectPreference = stringFlag(flags, 'revision-control') === undefined
    ? await readProjectPreference(process.cwd())
    : null;
  const adapter = stringFlag(flags, 'adapter') ?? 'projfs';
  const testMode = booleanFlag(flags, 'test-mode');
  const config = await initialize(stateDir, {
    revisionControl: stringFlag(flags, 'revision-control') ?? projectPreference?.revisionControl ?? 'p4',
    workspace: requiredStringFlag(flags, 'workspace'),
    maxSlots: integerFlag(flags, 'max-agent-workspaces') ?? integerFlag(flags, 'max-slots'),
    adapter,
    roots: stringFlag(flags, 'roots')?.split(',').map((root) => root.trim()).filter(Boolean),
    rootParent: stringFlag(flags, 'root-parent'),
    providerExe: resolveProviderExecutable({
      adapter,
      testMode,
      providerExe: stringFlag(flags, 'provider-exe'),
    }),
    launchSupervisorExe: stringFlag(flags, 'launch-supervisor-exe'),
    lowerGuardExe: stringFlag(flags, 'lower-guard-exe'),
    generationSupervisorExe: stringFlag(flags, 'generation-supervisor-exe'),
    testMode,
    lowerGuardReadyTimeoutMs: integerFlag(flags, 'lower-guard-ready-timeout-ms') ?? 60000,
    lowerGuardHeartbeatStaleMs: integerFlag(flags, 'lower-guard-heartbeat-stale-ms') ?? 10000,
    providerReadyTimeoutMs: integerFlag(flags, 'provider-ready-timeout-ms') ?? 10000,
    providerStopTimeoutMs: integerFlag(flags, 'provider-stop-timeout-ms') ?? 5000,
    maxConcurrentHeavyBuilds: integerFlag(flags, 'max-concurrent-heavy-builds') ?? 5,
    buildCapacityPolicy: stringFlag(flags, 'build-capacity-policy') ?? 'wait',
    buildWaitTimeoutMs: integerFlag(flags, 'build-wait-timeout-ms') ?? 3600000,
    pollMs: integerFlag(flags, 'poll-ms') ?? 200,
    p4Exe: stringFlag(flags, 'p4-exe'),
    p4BaseClient: stringFlag(flags, 'p4-base-client'),
    p4Port: stringFlag(flags, 'p4-port'),
    p4User: stringFlag(flags, 'p4-user'),
    p4Charset: stringFlag(flags, 'p4-charset'),
    p4Tickets: stringFlag(flags, 'p4-tickets'),
    p4Trust: stringFlag(flags, 'p4-trust'),
    p4FakeRegistry: stringFlag(flags, 'p4-fake-registry'),
  });
  console.log(JSON.stringify(withoutPrivateReconnectBinding(config), null, 2));
}

async function startCommand(stateDir, flags, command) {
  const timeoutMs = integerFlag(flags, 'timeout-ms');
  if (timeoutMs !== undefined && timeoutMs < 1) {
    throw new Error('--timeout-ms must be positive');
  }
  const task = await startTask(stateDir, command, {
    timeoutMs,
    authEnabled: !booleanFlag(flags, 'no-auth'),
    resourceClass: stringFlag(flags, 'resource-class'),
  });
  console.log(JSON.stringify({
    taskId: task.id,
    state: task.state,
    slot: task.slot,
    slotName: task.slotName,
    monitorPid: task.monitorPid,
  }));
}

async function runCommand(stateDir, flags, positionals, command) {
  if (positionals.length !== 1) {
    throw new Error('run requires exactly one task ID before --');
  }
  const timeoutMs = integerFlag(flags, 'timeout-ms');
  if (timeoutMs !== undefined && timeoutMs < 1) {
    throw new Error('--timeout-ms must be positive');
  }
  const task = await rerunTask(stateDir, positionals[0], command, {
    timeoutMs,
    authEnabled: !booleanFlag(flags, 'no-auth'),
    resourceClass: stringFlag(flags, 'resource-class'),
  });
  console.log(JSON.stringify({
    taskId: task.id,
    attempt: task.attempt,
    state: task.state,
    slot: task.slot,
    slotName: task.slotName,
    monitorPid: task.monitorPid,
  }));
}

async function statusCommand(stateDir, positionals) {
  if (positionals.length > 1) {
    throw new Error('status accepts at most one task ID');
  }
  if (positionals[0]) {
    console.log(JSON.stringify(await getTask(stateDir, positionals[0]), null, 2));
    return;
  }
  const config = await loadConfig(stateDir);
  await refreshProviderStates(stateDir, config);
  const [slots, tasks] = await Promise.all([readSlots(stateDir), getTasks(stateDir)]);
  const safety = await inspectProjfsSafety(stateDir, config, { verifyGuardIdentity: true });
  const humanOwnerCounts = slots.slots.reduce((counts, slot) => {
    if (slot.humanOwnerState) counts[slot.humanOwnerState] = (counts[slot.humanOwnerState] ?? 0) + 1;
    return counts;
  }, { provisioning: 0, ready: 0, quarantined: 0 });
  console.log(JSON.stringify({ config: withoutPrivateReconnectBinding(config), revisionControl: revisionControlStatus(config), safety, slots: slots.slots, humanOwnerCounts, buildQueue: slots.buildQueue ?? [], tasks }, null, 2));
}

async function humanSlotCommand(stateDir, flags, positionals) {
  if (positionals.length !== 1 || positionals[0] !== 'create') {
    throw new Error("human-slot requires the 'create' subcommand");
  }
  const config = await loadConfig(stateDir);
  console.log(JSON.stringify(await createHumanSlot(stateDir, config, requiredStringFlag(flags, 'name')), null, 2));
}

async function baseChangeCommand(stateDir, flags, positionals) {
  if (positionals.length !== 1 || !['status', 'plan-new-generation'].includes(positionals[0])) {
    throw new Error("base-change requires exactly one subcommand: 'status' or 'plan-new-generation'");
  }
  const config = await loadConfig(stateDir);
  if (config.adapter !== 'projfs') throw new Error('base-change requires an adapter=projfs broker');
  const safety = await inspectProjfsSafety(stateDir, config, { verifyGuardIdentity: true });
  if (positionals[0] === 'status') {
    console.log(JSON.stringify({ safety, guidance: humanSlotGuidance() }, null, 2));
    return;
  }
  if (!booleanFlag(flags, 'acknowledge-safe-boundary')) {
    throw new Error(`base-change ${positionals[0]} requires --acknowledge-safe-boundary`);
  }
  const planning = {
    version: 1,
    brokerUuid: config.brokerUuid,
    choice: positionals[0],
    acknowledgedAt: new Date().toISOString(),
    safeToResume: false,
    quarantineCleared: false,
    rootsReusable: false,
    message: 'Stopped safely: create a new broker/root generation only after cleanup of this quarantined generation. Rebase and Perforce migration are deferred.',
  };
  await atomicWriteJson(path.join(stateDir, `base-change-${positionals[0]}.json`), planning);
  console.log(JSON.stringify({ safety, planning, guidance: humanSlotGuidance() }, null, 2));
}

async function p4Command(stateDir, flags, positionals, depotPaths) {
  const [operation, taskId, ...extra] = positionals;
  if (!operation || !['status', 'open', 'unshelve', 'checkpoint', 'handoff'].includes(operation)) {
    throw new Error("p4 requires status, open, unshelve, checkpoint, or handoff");
  }
  const allowedFlags = {
    status: new Set(['state-dir']),
    open: new Set(['state-dir', 'action', 'allow-protected-base']),
    unshelve: new Set(['state-dir', 'source-change', 'allow-protected-base']),
    checkpoint: new Set(['state-dir']),
    handoff: new Set(['state-dir']),
  }[operation];
  const unsupportedFlags = [...flags.keys()].filter((name) => !allowedFlags.has(name));
  if (unsupportedFlags.length > 0) {
    throw new Error(`p4 ${operation} does not accept flag(s): ${unsupportedFlags.join(', ')}`);
  }
  if (operation !== 'open' && depotPaths.length > 0) {
    throw new Error(`p4 ${operation} does not accept paths or raw Perforce arguments`);
  }
  const config = await loadConfig(stateDir);
  const revisionBackend = revisionControlBackend(config);
  if (revisionBackend.mode !== 'p4') {
    throw new Error(`p4 compatibility commands require revision-control mode 'p4'; active mode is '${revisionBackend.mode}'`);
  }
  if (!revisionBackend.isEnabled(config)) throw new Error('Perforce is not enabled for this broker generation');
  if (operation === 'status' && !taskId) {
    if (extra.length > 0) throw new Error('p4 status accepts at most one task ID');
    await revisionBackend.loadLiveState(config);
    console.log(JSON.stringify((await getTasks(stateDir)).filter((task) => task.p4).map((task) => ({ taskId: task.id, ...task.p4 })), null, 2));
    return;
  }
  if (!taskId || extra.length > 0) throw new Error(`p4 ${operation} requires exactly one task ID`);
  if (operation === 'handoff') {
    const result = await withLifecycleLock(stateDir, () => revisionBackend.operateTask(stateDir, config, taskId, operation));
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (operation === 'open' && !stringFlag(flags, 'action')) throw new Error('p4 open requires --action edit|add|delete');
  if (operation === 'unshelve' && integerFlag(flags, 'source-change') === undefined) throw new Error('p4 unshelve requires --source-change N');
  if (operation === 'open' && depotPaths.length === 0) throw new Error('p4 open requires depot paths after --; local paths are not supported');
  if (depotPaths.some((value) => !value.startsWith('//'))) throw new Error('p4 operations currently accept depot paths only');
  const result = await withLifecycleLock(stateDir, () => revisionBackend.operateTask(stateDir, config, taskId, operation, {
    action: stringFlag(flags, 'action'),
    sourceChange: integerFlag(flags, 'source-change'),
    allowProtectedBase: booleanFlag(flags, 'allow-protected-base'),
    depotPaths,
  }));
  console.log(JSON.stringify(result, null, 2));
}

async function logsCommand(stateDir, flags, positionals) {
  if (positionals.length !== 1) {
    throw new Error('logs requires exactly one task ID');
  }
  const task = await getTask(stateDir, positionals[0]);
  const attempt = integerFlag(flags, 'attempt');
  if (attempt !== undefined && attempt < 1) {
    throw new Error('--attempt must be positive');
  }
  const execution = attempt === undefined || attempt === task.attempt
    ? task
    : task.attempts.find((candidate) => candidate.attempt === attempt);
  if (!execution) {
    throw new Error(`task '${task.id}' has no attempt ${attempt}`);
  }
  for await (const chunk of createReadStream(execution.logPath)) {
    if (!process.stdout.write(chunk)) {
      await once(process.stdout, 'drain');
    }
  }
}

async function cancelCommand(stateDir, positionals) {
  if (positionals.length !== 1) {
    throw new Error('cancel requires exactly one task ID');
  }
  console.log(JSON.stringify(await cancelTask(stateDir, positionals[0]), null, 2));
}

function parseArguments(args) {
  const flags = new Map();
  const positionals = [];
  let commandArgs = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--') {
      commandArgs = args.slice(index + 1);
      break;
    }
    if (!argument.startsWith('--')) {
      positionals.push(argument);
      continue;
    }
    const equals = argument.indexOf('=');
    if (equals !== -1) {
      flags.set(argument.slice(2, equals), argument.slice(equals + 1));
      continue;
    }
    const name = argument.slice(2);
    const next = args[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags.set(name, next);
      index += 1;
      continue;
    }
    flags.set(name, true);
  }
  return { flags, positionals, commandArgs };
}

function stringFlag(flags, name) {
  const value = flags.get(name);
  if (value === undefined) {
    return undefined;
  }
  if (value === true) {
    throw new Error(`--${name} requires a value`);
  }
  return value;
}

function requiredStringFlag(flags, name) {
  const value = stringFlag(flags, name);
  if (!value) {
    throw new Error(`--${name} is required`);
  }
  return value;
}

function booleanFlag(flags, name) {
  const value = flags.get(name);
  if (value === undefined) {
    return false;
  }
  if (value !== true) {
    throw new Error(`--${name} does not take a value`);
  }
  return true;
}

function integerFlag(flags, name) {
  const value = stringFlag(flags, name);
  if (value === undefined) {
    return undefined;
  }
  if (!/^\d+$/.test(value)) {
    throw new Error(`--${name} requires an integer`);
  }
  return Number(value);
}

async function isDirectory(candidate) {
  return fs.stat(candidate).then((stats) => stats.isDirectory(), () => false);
}

async function isFile(candidate) {
  return fs.stat(candidate).then((stats) => stats.isFile(), () => false);
}

function withoutPrivateReconnectBinding(config) {
  const sanitized = structuredClone(config);
  if (sanitized.p4) delete sanitized.p4.reconnect;
  delete sanitized.p4Reconnect;
  return sanitized;
}

function printHelp() {
  console.log(`agent-workspace <command> [options]

Commands:
  doctor [--state-dir DIR]
  auth prepare --state-dir DIR --horde-url URL [--oidc-token-exe FILE] [--min-valid-ms N]
  auth status [--state-dir DIR]
  init --workspace DIR [--max-slots N|--max-agent-workspaces N] [--state-dir DIR]
       [--revision-control p4|lore] [--adapter projfs|test] [--poll-ms 10..60000]
       ProjFS: [--provider-exe FILE] (--root-parent DIR|--roots A,B)
               (defaults to bundled native/projfs-provider/bin/win32-x64/projfs-provider.exe)
               [--max-concurrent-heavy-builds N] [--build-capacity-policy wait|reject]
               [--build-wait-timeout-ms N] [--launch-supervisor-exe FILE]
               [--lower-guard-exe FILE] [--lower-guard-ready-timeout-ms N]
               [--p4-exe FILE --p4-base-client NAME [--p4-port PORT] [--p4-user USER] [--p4-charset CHARSET]
                [--p4-tickets FILE] [--p4-trust FILE]]
  human-slot create --state-dir DIR --name NAME
  base-change status --state-dir DIR
  base-change plan-new-generation --state-dir DIR --acknowledge-safe-boundary
  start [--state-dir DIR] [--timeout-ms N] [--no-auth] [--resource-class light|heavy-build] -- PROGRAM [ARG...]
  run [--state-dir DIR] TASK_ID [--timeout-ms N] [--no-auth] [--resource-class light|heavy-build] -- PROGRAM [ARG...]
  status [--state-dir DIR] [TASK_ID]
  p4 status [--state-dir DIR] TASK_ID
  p4 open [--state-dir DIR] TASK_ID --action edit|add|delete [--allow-protected-base] -- //depot/path...
  p4 unshelve [--state-dir DIR] TASK_ID --source-change N [--allow-protected-base]
  p4 checkpoint [--state-dir DIR] TASK_ID
  p4 handoff [--state-dir DIR] TASK_ID
  logs [--state-dir DIR] TASK_ID [--attempt N]
  cancel [--state-dir DIR] TASK_ID
  cleanup [--state-dir DIR] --broker-uuid UUID

Prepared Horde authentication is injected by default; --no-auth disables it for one attempt.
Revision-control mode is immutable for a broker generation; changing it requires cleanup and reinitialization.
The test adapter is deterministic test infrastructure and is never a production fallback.
Terminal tasks can be run again in the same retained slot with the same task ID unless a handoff intent has sealed them.
A handoff copies the stable shelf server-side into preserved review resources owned by the configured P4 user.
Slots are retained until the aggressive ownership-scoped cleanup command resets the pool.`);
}
