import fs from 'node:fs/promises';

const args = process.argv.slice(2);
if (process.env.FAKE_OIDC_ARGS_PATH) {
  await fs.writeFile(process.env.FAKE_OIDC_ARGS_PATH, JSON.stringify(args));
}
if (process.env.FAKE_OIDC_DELAY_MS) {
  await new Promise((resolve) => setTimeout(resolve, Number(process.env.FAKE_OIDC_DELAY_MS)));
}
if (process.env.FAKE_OIDC_EXIT_CODE) {
  process.exitCode = Number(process.env.FAKE_OIDC_EXIT_CODE);
} else {
  const outIndex = args.indexOf('--OutFile');
  if (outIndex === -1 || !args[outIndex + 1]) {
    process.exitCode = 2;
  } else {
    const expiresAt = process.env.FAKE_OIDC_EXPIRES_AT ?? new Date(Date.now() + 60 * 60 * 1000).toISOString();
    await fs.writeFile(args[outIndex + 1], JSON.stringify({
      Token: process.env.FAKE_OIDC_TOKEN ?? 'fake-horde-token',
      ExpiresAt: expiresAt,
      ExpiresAtUtc: expiresAt,
    }));
  }
}
