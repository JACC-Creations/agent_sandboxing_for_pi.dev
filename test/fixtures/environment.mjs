import fs from 'node:fs/promises';

const [outputPath, behavior] = process.argv.slice(2);
if (behavior === 'print-token') {
  const token = process.env.UE_HORDE_TOKEN ?? '';
  const midpoint = Math.floor(token.length / 2);
  process.stdout.write(token.slice(0, midpoint));
  setImmediate(() => process.stdout.write(`${token.slice(midpoint)}\n`));
}
await fs.writeFile(outputPath, JSON.stringify({
  hordeUrl: process.env.UE_HORDE_URL ?? null,
  hordeToken: process.env.UE_HORDE_TOKEN ?? null,
}));
