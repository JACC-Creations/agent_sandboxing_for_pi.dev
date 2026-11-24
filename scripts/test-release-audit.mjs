import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryBase = "https://github.com/JACC-Creations/agent_sandboxing_for_pi.dev";
const canonicalOrigin = `${repositoryBase}.git`;
const oldRepositoryName = ["sandboxie", "for", "pi", "dev"].join("_");
const companyName = ["epic", "games"].join("");
const personalGivenName = ["ja", "red"].join("");
const personalFamilyName = ["cot", "ton"].join("");

const forbiddenTrackedValues = [
  { label: "personal given name", pattern: new RegExp(`\\b${personalGivenName}\\b`, "i") },
  { label: "personal family name", pattern: new RegExp(`\\b${personalFamilyName}\\b`, "i") },
  { label: "company email address", pattern: new RegExp(`@${companyName}\\.com\\b`, "i") },
  { label: "company network domain", pattern: new RegExp(`\\b${companyName}\\.net\\b`, "i") },
  { label: "internal cloud hostname", pattern: new RegExp("\\.compute\\.internal\\b", "i") },
  { label: "old repository name", pattern: new RegExp(`\\b${oldRepositoryName}\\b`, "i") },
];

function git(args) {
  const result = spawnSync("git", args, {
    cwd: projectRoot,
    encoding: args.includes("-z") ? "buffer" : "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(
    result.status,
    0,
    `git ${args.join(" ")} failed:\n${result.stderr?.toString() || result.stdout?.toString()}`,
  );
  return result.stdout;
}

function findForbiddenValue(value) {
  return forbiddenTrackedValues.find(({ pattern }) => pattern.test(value));
}

const packageJson = JSON.parse(await fs.readFile(path.join(projectRoot, "package.json"), "utf8"));
assert.deepEqual(packageJson.repository, {
  type: "git",
  url: `git+${canonicalOrigin}`,
});
assert.equal(packageJson.homepage, `${repositoryBase}#readme`);
assert.deepEqual(packageJson.bugs, { url: `${repositoryBase}/issues` });

const readme = await fs.readFile(path.join(projectRoot, "README.md"), "utf8");
const pinnedInstallCommand = `pi install git:${canonicalOrigin}@v0.1.0`;
assert.ok(readme.includes(pinnedInstallCommand), `README must contain: ${pinnedInstallCommand}`);

const origin = git(["config", "--get", "remote.origin.url"]).trim();
assert.notEqual(origin, `https://github.com/JACC-Creations/${oldRepositoryName}.git`, "origin uses the stale repository URL");
assert.equal(origin, canonicalOrigin, `origin must be ${canonicalOrigin}`);

const trackedOutput = git(["ls-files", "-z"]);
const trackedFiles = trackedOutput.toString("utf8").split("\0").filter(Boolean);
const violations = [];
for (const relativePath of trackedFiles) {
  let bytes;
  try {
    bytes = await fs.readFile(path.join(projectRoot, relativePath));
  } catch (error) {
    if (error.code === "ENOENT") continue;
    throw error;
  }
  if (bytes.includes(0)) continue;

  const text = bytes.toString("utf8");
  for (const rule of forbiddenTrackedValues) {
    const match = rule.pattern.exec(text);
    if (!match) continue;
    const line = text.slice(0, match.index).split(/\r?\n/).length;
    violations.push(`${relativePath}:${line}: ${rule.label}`);
  }
}
assert.deepEqual(violations, [], `public-release values found in tracked files:\n${violations.join("\n")}`);

const metadata = git(["show", "-s", "--format=%an%x00%ae%x00%cn%x00%ce", "HEAD"])
  .trimEnd()
  .split("\0");
assert.equal(metadata.length, 4, "unable to read HEAD author and committer metadata");
const [authorName, authorEmail, committerName, committerEmail] = metadata;
for (const [field, value] of [
  ["author name", authorName],
  ["author email", authorEmail],
  ["committer name", committerName],
  ["committer email", committerEmail],
]) {
  const violation = findForbiddenValue(value);
  assert.ok(!violation, `HEAD ${field} contains ${violation?.label}`);
}
for (const [field, email] of [["author", authorEmail], ["committer", committerEmail]]) {
  assert.match(email, /^[^@\s]+@users\.noreply\.github\.com$/i, `HEAD ${field} must use a GitHub no-reply email`);
}

console.log(`Release audit passed for ${trackedFiles.length} tracked files, canonical package metadata, origin, and HEAD identity.`);
