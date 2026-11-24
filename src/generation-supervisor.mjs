import fs from 'node:fs/promises';
import path from 'node:path';
import { loadConfig } from './broker.mjs';
import { inspectProjfsSafety, quarantineLower } from './projfs.mjs';
import { readOwnedProcess, terminateOwned } from './process-owner.mjs';
import { atomicWriteJson, delay, listTasks, writeTask } from './state.mjs';

const terminalStates = new Set(['completed', 'artifact_failed', 'failed', 'timed_out', 'cancelled', 'termination_failed']);

async function enforceTaskQuarantine(stateDir, config, quarantine) {
  const tasks = await listTasks(stateDir).catch(() => []);
  for (const task of tasks) {
    if (terminalStates.has(task.state)) continue;
    const now = new Date().toISOString();
    task.cancelRequestedAt ??= now;
    task.state = 'cancel_requested';
    task.error = `generation quarantined: ${quarantine.reason}`;
    await writeTask(stateDir, task);
    if (!task.processOwnership) continue;
    const manifest = await readOwnedProcess(task.processOwnership).catch(() => null);
    if (!manifest?.creationIdentity) continue;
    const stopped = await terminateOwned(config, task.processOwnership, config.terminationWaitMs).catch(() => false);
    if (!stopped) {
      task.state = 'termination_failed';
      task.error = `generation supervisor could not terminate owned task job after quarantine: ${quarantine.reason}`;
      task.endedAt = new Date().toISOString();
      await writeTask(stateDir, task);
    }
  }
}

export async function runGenerationSupervisor(stateDir) {
  const config = await loadConfig(stateDir);
  const statePath = path.join(stateDir, 'generation-supervisor-state.json');
  let stopping = false;
  const stop = () => { stopping = true; };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  if (process.platform === 'win32') process.on('SIGBREAK', stop);
  else process.on('SIGHUP', stop);

  console.log('GENERATION_SUPERVISOR_READY');
  while (!stopping) {
    let safety;
    try {
      safety = await inspectProjfsSafety(stateDir, config, { skipSupervisorValidation: true });
    } catch (error) {
      const quarantine = await quarantineLower(stateDir, config, `generation supervisor could not verify watcher: ${error.message}`, {
        source: 'generation_supervisor',
      });
      safety = { quarantined: true, quarantine };
    }
    await atomicWriteJson(statePath, {
      version: 1,
      brokerUuid: config.brokerUuid,
      phase: safety.quarantined ? 'quarantined' : 'ready',
      pid: process.pid,
      heartbeatAt: new Date().toISOString(),
      quarantineReason: safety.quarantine?.reason ?? null,
    });
    if (safety.quarantined) {
      await enforceTaskQuarantine(stateDir, config, safety.quarantine);
    }
    await delay(Math.max(250, Math.min(config.pollMs, 1000)));
  }
}
