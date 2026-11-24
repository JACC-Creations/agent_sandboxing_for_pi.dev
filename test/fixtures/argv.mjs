import fs from 'node:fs/promises';

const outputPath = process.argv[2];
const values = process.argv.slice(3);
await fs.writeFile(outputPath, JSON.stringify(values));
console.log(JSON.stringify(values));
