import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { defaultAuthMinValidMs, readAndValidateTokenFile, withoutHordeSecrets } from './auth.mjs';
import { createSecretRedactor } from './redact.mjs';

delete process.env.UE_HORDE_TOKEN;
delete process.env.UE_HORDE_URL;

const parsed = parseRunnerArguments(process.argv.slice(2));
if (!parsed) {
  console.error('usage: node task-runner.mjs [--horde-token-file FILE --horde-url URL] -- LOG_PATH PROGRAM [ARG...]');
  process.exitCode = 1;
} else {
  await run(parsed);
}

async function run(options) {
  await fs.mkdir(path.dirname(options.logPath), { recursive: true });
  const output = await fs.open(options.logPath, 'a');
  let child;
  let secret = null;
  try {
    const env = withoutHordeSecrets(process.env);
    if (options.tokenFile) {
      const token = await readAndValidateTokenFile(options.tokenFile, options.minValidMs);
      secret = token.token;
      env.UE_HORDE_URL = options.hordeUrl;
      env.UE_HORDE_TOKEN = secret;
    }
    child = spawn(options.executable, options.args, {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });
  } catch (error) {
    await output.write(`${safeError(error)}\n`);
    await output.close();
    process.exitCode = 1;
    return;
  }

  let writeQueue = Promise.resolve();
  const copy = async (stream) => {
    const redactor = createSecretRedactor(secret);
    for await (const chunk of stream) {
      const pending = writeQueue.then(() => {
        const contents = redactor.push(chunk);
        return contents ? output.write(contents) : undefined;
      });
      writeQueue = pending.catch(() => {});
      await pending;
    }
    const pending = writeQueue.then(() => {
      const contents = redactor.finish();
      return contents ? output.write(contents) : undefined;
    });
    writeQueue = pending.catch(() => {});
    await pending;
  };
  const spawnError = new Promise((resolve) => child.once('error', resolve));
  const close = new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal })));
  const copies = Promise.all([copy(child.stdout), copy(child.stderr)]);
  const result = await Promise.race([
    close,
    spawnError.then((error) => ({ error })),
  ]);

  if (result.error) {
    await Promise.allSettled([copies, writeQueue]);
    await output.write(`${safeError(result.error)}\n`);
    await output.close();
    process.exitCode = 1;
    return;
  }

  await copies;
  await writeQueue;
  await output.close();
  process.exitCode = Number.isInteger(result.code) ? result.code : 1;
}

function parseRunnerArguments(args) {
  const separator = args.indexOf('--');
  if (separator === -1) {
    return null;
  }
  const options = new Map();
  for (let index = 0; index < separator; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!name?.startsWith('--') || value === undefined) {
      return null;
    }
    options.set(name.slice(2), value);
  }
  const [logPath, executable, ...commandArgs] = args.slice(separator + 1);
  if (!logPath || !executable) {
    return null;
  }
  const tokenFile = options.get('horde-token-file') ?? null;
  const hordeUrl = options.get('horde-url') ?? null;
  if (Boolean(tokenFile) !== Boolean(hordeUrl)) {
    return null;
  }
  const minValidText = options.get('horde-min-valid-ms');
  const minValidMs = minValidText === undefined ? defaultAuthMinValidMs : Number(minValidText);
  if (!Number.isSafeInteger(minValidMs) || minValidMs < 0) {
    return null;
  }
  return { tokenFile, hordeUrl, minValidMs, logPath, executable, args: commandArgs };
}

function safeError(error) {
  if (typeof error?.message === 'string') {
    return error.message;
  }
  return 'task runner failed';
}
