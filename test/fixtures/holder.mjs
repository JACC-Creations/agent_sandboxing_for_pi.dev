import fs from 'node:fs/promises';

const readyPath = process.argv[2];
const releasePath = process.argv[3];
const orderPath = process.argv[4];
const label = process.argv[5];

if (orderPath && label) {
  await fs.appendFile(orderPath, `${label}-start\n`);
}
await fs.writeFile(readyPath, `${process.pid}\n`);
while (!await fs.access(releasePath).then(() => true, () => false)) {
  await new Promise((resolve) => setTimeout(resolve, 10));
}
if (orderPath && label) {
  await fs.appendFile(orderPath, `${label}-end\n`);
}
