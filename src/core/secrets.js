/**
 * API keys entered through the UI.
 *
 * Kept out of models.json on purpose: that file is meant to be readable,
 * editable and shareable, and secrets in it would leak the moment it was
 * copied. This file is chmod 0600 and holds nothing but alias -> key.
 *
 * An environment variable still wins nothing and loses nothing: a key stored
 * here takes precedence, and the env var remains the fallback.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

export function secretsPath(userDataDir) {
  return path.join(userDataDir, 'secrets.json');
}

export async function loadSecrets(userDataDir) {
  try {
    return JSON.parse(await fs.readFile(secretsPath(userDataDir), 'utf8'));
  } catch {
    return {}; // absent or unreadable: no stored keys, not an error
  }
}

export async function setSecret(userDataDir, alias, apiKey) {
  const file = secretsPath(userDataDir);
  const all = await loadSecrets(userDataDir);

  if (apiKey) all[alias] = apiKey;
  else delete all[alias];

  await fs.mkdir(userDataDir, { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(all, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await fs.rename(tmp, file);
  await fs.chmod(file, 0o600).catch(() => {});
  return all;
}
