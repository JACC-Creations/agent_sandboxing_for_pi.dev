import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { delay, isProcessAlive } from './state.mjs';

const execFileAsync = promisify(execFile);

export function configureProcessIdentity(config) {
  if (config?.testMode || config?.adapter === 'test') {
    process.env.AGENT_WORKSPACE_INTERNAL_TEST_MODE = '1';
    delete process.env.AGENT_WORKSPACE_IDENTITY_EXE;
    return;
  }
  delete process.env.AGENT_WORKSPACE_INTERNAL_TEST_MODE;
  delete process.env.AGENT_WORKSPACE_IDENTITY_EXE;
  if (config?.launchSupervisorExe) {
    process.env.AGENT_WORKSPACE_IDENTITY_EXE = config.launchSupervisorExe;
  }
}

export async function classifyProcessIdentity(pid, expectedIdentity, options = {}) {
  const attempts = options.attempts ?? 3;
  const retryMs = options.retryMs ?? 50;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const alive = isProcessAlive(pid);
    if (!alive) return { state: 'dead', identity: null };
    const identity = await getProcessIdentity(pid);
    if (identity === expectedIdentity) return { state: 'matching', identity };
    if (identity !== null) return { state: 'reused', identity };
    if (attempt + 1 < attempts) await delay(retryMs);
  }
  return isProcessAlive(pid)
    ? { state: 'unknown-live', identity: null }
    : { state: 'dead', identity: null };
}

export async function getProcessIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  if (process.env.AGENT_WORKSPACE_TEST_IDENTITY_UNAVAILABLE_PID === String(pid)) return null;
  if (process.env.AGENT_WORKSPACE_INTERNAL_TEST_MODE === '1') {
    return isProcessAlive(pid) ? `test:${pid}` : null;
  }
  if (process.platform === 'win32') {
    try {
      const helper = process.env.AGENT_WORKSPACE_IDENTITY_EXE;
      if (helper) {
        const { stdout } = await execFileAsync(helper, ['identity', '--pid', String(pid)], {
          windowsHide: true,
          timeout: 1000,
        });
        return stdout.trim() || null;
      }
      const script = `$p=Get-Process -Id ${pid} -ErrorAction Stop; [Console]::Write($p.StartTime.ToUniversalTime().Ticks)`;
      const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        windowsHide: true,
        timeout: 2000,
      });
      return stdout.trim() ? `win:${stdout.trim()}` : null;
    } catch { return null; }
  }
  if (process.platform === 'linux') {
    try {
      const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
      const end = stat.lastIndexOf(')');
      return `linux:${stat.slice(end + 2).split(' ')[19]}`;
    } catch { return null; }
  }
  return isProcessAlive(pid) ? `pid:${pid}` : null;
}
