import fs from 'node:fs/promises';
import path from 'node:path';

const options = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  options.set(process.argv[index], process.argv[index + 1]);
}
const lower = options.get('--lower');
const root = options.get('--root');
await fs.mkdir(root, { recursive: true });
await fs.writeFile(path.join(root, '.fake-provider.json'), JSON.stringify({ pid: process.pid, lower, root }));
const noReady = await fs.access(path.join(lower, '.fake-provider-no-ready')).then(() => true, () => false);
const wrongReady = await fs.access(path.join(lower, '.fake-provider-wrong-ready')).then(() => true, () => false);
const delayedReady = await fs.readFile(path.join(lower, '.fake-provider-delay-ready'), 'utf8').then(Number, () => 0);
if (Number.isFinite(delayedReady) && delayedReady > 0) {
  await new Promise((resolve) => setTimeout(resolve, delayedReady));
}
if (wrongReady) {
  console.log('prefix PROJFS_READY');
} else if (!noReady) {
  console.log('PROJFS_READY');
}
console.error(`fake provider ${process.pid} for ${root}`);
const stop = () => process.exit(0);
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
if (process.platform === 'win32') process.on('SIGBREAK', stop);
else process.on('SIGHUP', stop);
setInterval(() => {}, 1000);
