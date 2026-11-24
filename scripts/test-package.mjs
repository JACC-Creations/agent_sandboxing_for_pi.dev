import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nativeBinaryDirectory = "native/projfs-provider/bin/win32-x64";
const nativeBinaryNames = [
  "projfs-provider.exe",
  "launch-supervisor.exe",
  "lower-freeze-guard.exe",
  "generation-supervisor.exe"
];
const nativeExecutableFiles = new Set(nativeBinaryNames.map((name) => `${nativeBinaryDirectory}/${name}`));
const nativeManifestFile = `${nativeBinaryDirectory}/SHA256SUMS`;
const requiredFiles = new Set([
  "LICENSE",
  "README.md",
  "bin/agent-workspace.mjs",
  "extensions/agent-workspace/index.ts",
  "native/projfs-provider/CMakeLists.txt",
  "native/projfs-provider/README.md",
  nativeManifestFile,
  ...nativeExecutableFiles,
  "native/projfs-provider/generation-supervisor.cpp",
  "native/projfs-provider/launch-supervisor.cpp",
  "native/projfs-provider/lower-freeze-guard.cpp",
  "native/projfs-provider/provider.cpp",
  "native/projfs-provider/provider.manifest",
  "package.json",
  "scripts/inspect-secret-acl.ps1",
  "scripts/restrict-secret-acl.ps1",
  "scripts/restrict-secret-directory-acl.ps1",
  "skills/agent-workspace/SKILL.md",
  "src/api.mjs",
  "src/auth.mjs",
  "src/broker.mjs",
  "src/cleanup.mjs",
  "src/cli.mjs",
  "src/generation-supervisor.mjs",
  "src/internal-api.mjs",
  "src/ownership.mjs",
  "src/perforce-state.mjs",
  "src/perforce.mjs",
  "src/process-identity.mjs",
  "src/process-owner.mjs",
  "src/projfs.mjs",
  "src/redact.mjs",
  "src/review-disposal.mjs",
  "src/revision-control-command.mjs",
  "src/revision-control-preference.mjs",
  "src/revision-control.mjs",
  "src/state.mjs",
  "src/task-runner.mjs",
  "src/worker.mjs"
]);

function runNpmPack() {
  if (process.env.npm_execpath) {
    return spawnSync(
      process.execPath,
      [process.env.npm_execpath, "pack", "--dry-run", "--json"],
      { cwd: projectRoot, encoding: "utf8" }
    );
  }

  return spawnSync("npm pack --dry-run --json", {
    cwd: projectRoot,
    encoding: "utf8",
    shell: true
  });
}

const pack = runNpmPack();
assert.equal(pack.status, 0, `npm pack --dry-run failed:\n${pack.stderr || pack.stdout}`);

let report;
try {
  [report] = JSON.parse(pack.stdout);
} catch (error) {
  throw new Error(`npm pack did not return valid JSON:\n${pack.stdout}`, { cause: error });
}

assert.ok(report && Array.isArray(report.files), "npm pack returned no file list");
const payloadFiles = report.files.map(({ path: filePath }) => filePath.replaceAll("\\", "/"));
const payloadSet = new Set(payloadFiles);

const missingFiles = [...requiredFiles].filter((filePath) => !payloadSet.has(filePath));
assert.deepEqual(missingFiles, [], `required package files are missing: ${missingFiles.join(", ")}`);

const forbiddenFiles = payloadFiles.filter((filePath) =>
  filePath === "native/projfs-provider/main-probe.py" ||
  /(^|\/)(test|tests)(\/|$)/i.test(filePath) ||
  /(^|\/)(build|diagnostics?)(\/|$)/i.test(filePath) ||
  /(^|\/)(test[_-].*|.*[._-](test|spec))(\.|\/|$)/i.test(filePath) ||
  /(^|\/).*probe.*(\.|\/|$)/i.test(filePath) ||
  /\.(dll|pdb|lib|obj)$/i.test(filePath) ||
  (/\.exe$/i.test(filePath) && !nativeExecutableFiles.has(filePath))
);
assert.deepEqual(forbiddenFiles, [], `forbidden package files are present: ${forbiddenFiles.join(", ")}`);

const unexpectedFiles = payloadFiles.filter((filePath) => !requiredFiles.has(filePath));
assert.deepEqual(unexpectedFiles, [], `unexpected package files are present: ${unexpectedFiles.join(", ")}`);

const manifestText = await fs.readFile(path.join(projectRoot, nativeManifestFile), "utf8");
const manifestEntries = new Map();
for (const line of manifestText.trimEnd().split(/\r?\n/)) {
  const match = /^([0-9a-f]{64})  ([^/\\]+)$/.exec(line);
  assert.ok(match, `invalid SHA256SUMS line: ${line}`);
  assert.ok(!manifestEntries.has(match[2]), `duplicate SHA256SUMS entry: ${match[2]}`);
  manifestEntries.set(match[2], match[1]);
}
assert.deepEqual(
  [...manifestEntries.keys()].sort(),
  [...nativeBinaryNames].sort(),
  "SHA256SUMS must name exactly the four bundled executables"
);

for (const name of nativeBinaryNames) {
  const filePath = path.join(projectRoot, nativeBinaryDirectory, name);
  const bytes = await fs.readFile(filePath);
  const actualHash = crypto.createHash("sha256").update(bytes).digest("hex");
  assert.equal(actualHash, manifestEntries.get(name), `SHA-256 mismatch for ${name}`);

  assert.ok(bytes.length >= 64, `${name} is too short to be a PE file`);
  assert.equal(bytes.readUInt16LE(0), 0x5a4d, `${name} has no DOS MZ signature`);
  const peOffset = bytes.readUInt32LE(0x3c);
  assert.ok(peOffset >= 64 && peOffset + 26 <= bytes.length, `${name} has an invalid PE header offset`);
  assert.equal(bytes.readUInt32LE(peOffset), 0x00004550, `${name} has no PE signature`);
  assert.equal(bytes.readUInt16LE(peOffset + 4), 0x8664, `${name} is not an AMD64 PE`);
  assert.ok((bytes.readUInt16LE(peOffset + 22) & 0x0002) !== 0, `${name} is not marked executable`);
  assert.equal(bytes.readUInt16LE(peOffset + 24), 0x020b, `${name} is not a PE32+ image`);
}

const scriptFiles = payloadFiles.filter((candidate) => /\.(js|mjs)$/.test(candidate));
for (const filePath of scriptFiles) {
  const syntaxCheck = spawnSync(process.execPath, ["--check", path.join(projectRoot, filePath)], {
    encoding: "utf8"
  });
  assert.equal(
    syntaxCheck.status,
    0,
    `syntax check failed for ${filePath}:\n${syntaxCheck.stderr || syntaxCheck.stdout}`
  );
}

console.log(
  `Package payload validated: ${report.entryCount} files, ${report.size} packed bytes, ` +
  `${report.unpackedSize} unpacked bytes; ${scriptFiles.length} JavaScript files passed syntax checks.`
);
