/**
 * Where the harness keeps its outbound-mail settings.
 *
 * The API key lives in the same 0600 secrets file as the model keys, under a
 * reserved alias, so it is never written into the shareable config. The
 * destination address sits beside it in plain config because it is not a
 * secret and is useful to see.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { loadSecrets, setSecret } from './secrets.js';

export const RESEND_ALIAS = '__resend';

export function emailConfigPath(userDataDir) {
  return path.join(userDataDir, 'email.json');
}

export async function loadEmailConfig(userDataDir) {
  let file = {};
  try {
    file = JSON.parse(await fs.readFile(emailConfigPath(userDataDir), 'utf8'));
  } catch { /* absent: not configured yet, which is not an error */ }

  const secrets = await loadSecrets(userDataDir);
  return {
    to: file.to ?? null,
    from: file.from ?? null,
    // The environment stays a fallback, matching how model keys behave.
    apiKey: secrets[RESEND_ALIAS] ?? process.env.RESEND_API_KEY ?? null,
  };
}

export async function saveEmailConfig(userDataDir, { to, from, apiKey }) {
  if (apiKey !== undefined) await setSecret(userDataDir, RESEND_ALIAS, apiKey);

  const current = await loadEmailConfig(userDataDir);
  const next = { to: to ?? current.to, from: from ?? current.from };
  await fs.mkdir(userDataDir, { recursive: true });
  const file = emailConfigPath(userDataDir);
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  await fs.rename(tmp, file);
  return loadEmailConfig(userDataDir);
}
