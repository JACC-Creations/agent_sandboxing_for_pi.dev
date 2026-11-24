import fs from 'node:fs/promises';
import { inspectAgentWorkspace } from './api.mjs';
import {
  readProjectPreference,
  validateRevisionControlMode,
  writeProjectPreference,
} from './revision-control-preference.mjs';
import { defaultStateDir, statePaths } from './state.mjs';

export function revisionControlCompletions(prefix) {
  if (/\s/.test(prefix)) return null;
  const items = ['p4', 'lore']
    .filter((mode) => mode.startsWith(prefix.trim()))
    .map((mode) => ({ value: mode, label: mode }));
  return items.length > 0 ? items : null;
}

export async function runRevisionControlCommand(args, context, configDirectoryName = '.pi') {
  if (typeof context.isProjectTrusted === 'function' && !context.isProjectTrusted()) {
    context.ui.notify('Revision-control preference changes require a trusted project.', 'error');
    return;
  }
  const values = args.trim() ? args.trim().split(/\s+/) : [];
  if (values.length > 1) {
    context.ui.notify('Usage: /revision-control [p4|lore]', 'error');
    return;
  }

  let mode = null;
  if (values.length === 1) {
    try {
      mode = validateRevisionControlMode(values[0]);
    } catch {
      context.ui.notify('Usage: /revision-control [p4|lore]', 'error');
      return;
    }
  }

  if (mode === null) {
    const [preference, active] = await Promise.all([
      readProjectPreference(context.cwd, configDirectoryName),
      inspectActiveGeneration(context.cwd),
    ]);
    const projectText = preference?.revisionControl ?? 'not set (effective default: p4)';
    if (active.state === 'unavailable') {
      context.ui.notify(`Project revision-control preference: ${projectText}. Active default generation could not be safely inspected.`, 'warning');
      return;
    }
    const activeText = active.summary
      ? ` Active generation: ${active.summary.revisionControl.mode}.`
      : ' No active default generation.';
    context.ui.notify(`Project revision-control preference: ${projectText}.${activeText}`, 'info');
    return;
  }

  await writeProjectPreference(context.cwd, mode, configDirectoryName);
  const active = await inspectActiveGeneration(context.cwd);
  if (active.state === 'unavailable') {
    context.ui.notify(`Project revision-control preference set to ${mode}. Active default generation could not be safely inspected; cleanup and reinitialization may be required.`, 'warning');
    return;
  }
  if (active.summary && active.summary.revisionControl.mode !== mode) {
    context.ui.notify(`Project revision-control preference set to ${mode}. Active generation remains ${active.summary.revisionControl.mode}; cleanup and reinitialization are required to switch.`, 'warning');
    return;
  }
  context.ui.notify(`Project revision-control preference set to ${mode}.`, 'info');
}

async function inspectActiveGeneration(cwd) {
  const stateDir = defaultStateDir(cwd);
  const exists = await fs.access(statePaths(stateDir).config).then(() => true, () => false);
  if (!exists) return { state: 'absent', summary: null };
  try {
    return { state: 'ready', summary: await inspectAgentWorkspace(stateDir) };
  } catch {
    return { state: 'unavailable', summary: null };
  }
}
