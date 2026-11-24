import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';

const durationMs = Number(process.argv[2] ?? 1000);
const intervalMs = Number(process.argv[3] ?? 100);
const exitCode = Number(process.argv[4] ?? 0);
const childPidPath = process.argv[5];

if (childPidPath) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: false,
    stdio: 'ignore',
    windowsHide: true,
  });
  await fs.writeFile(childPidPath, String(child.pid));
  console.log(`child-started-${child.pid}`);
}

console.log('task-started');
let sequence = 0;
const interval = setInterval(() => {
  sequence += 1;
  console.log(`progress-${sequence}`);
}, intervalMs);

setTimeout(() => {
  clearInterval(interval);
  console.log('task-finished');
  process.exit(exitCode);
}, durationMs);
