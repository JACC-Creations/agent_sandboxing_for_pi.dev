import fs from 'node:fs/promises';

const output = process.argv[2];
await fs.writeFile(output, `${JSON.stringify({
  P4CLIENT: process.env.P4CLIENT ?? null,
  P4PORT: process.env.P4PORT ?? null,
  P4USER: process.env.P4USER ?? null,
  P4CHARSET: process.env.P4CHARSET ?? null,
  P4_CHANGE: process.env.P4_CHANGE ?? null,
  AGENT_WORKSPACE_P4_CHANGE: process.env.AGENT_WORKSPACE_P4_CHANGE ?? null,
  AGENT_WORKSPACE_STATE_DIR: process.env.AGENT_WORKSPACE_STATE_DIR ?? null,
  TASK_ID: process.env.TASK_ID ?? null,
  secretKeys: Object.keys(process.env).filter((key) => /^p4(passwd|tickets|config|trust|loginsso|enviro)$/i.test(key)),
}, null, 2)}\n`);
