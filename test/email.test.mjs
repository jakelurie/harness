// Every session can reach the user by email, but never sees the credential and
// cannot aim the mail anywhere except his own address.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { sendEmail, isConfigured } from '../src/core/email.js';
import { loadEmailConfig, saveEmailConfig, RESEND_ALIAS } from '../src/core/email-config.js';

const fail = [];
const check = (label, cond, extra = '') => {
  if (!cond) fail.push(label);
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? `  ${extra}` : ''}`);
};

const cfg = { apiKey: 'k_test', to: 'someone@example.com' };
let seen = null;
const fakeFetch = async (url, opts) => {
  seen = { url, opts, body: JSON.parse(opts.body) };
  return { ok: true, status: 200, json: async () => ({ id: 'msg_1' }) };
};

const sent = await sendEmail(cfg, { subject: 'done', text: 'the run finished', session: 's1' }, { fetchImpl: fakeFetch });
check('it posts to Resend', seen.url === 'https://api.resend.com/emails');
check('the key travels as a bearer token', seen.opts.headers.Authorization === 'Bearer k_test');
check('it goes to the configured address', seen.body.to[0] === 'someone@example.com');
check('the subject survives', seen.body.subject === 'done');
check('the sending session is named in the body', seen.body.text.includes('s1'), seen.body.text);
check('the id comes back', sent.id === 'msg_1');
check('a default from-address is used so no domain needs verifying',
  seen.body.from.includes('resend.dev'), seen.body.from);

// ---- refusals, each said plainly rather than silently swallowed
const rejects = async (label, c, m) => {
  try { await sendEmail(c, m, { fetchImpl: fakeFetch }); check(label, false, 'did not throw'); }
  catch (e) { check(label, true, e.message.slice(0, 50)); }
};
await rejects('no key is refused', { to: 'a@b.c' }, { subject: 's', text: 't' });
await rejects('no destination is refused', { apiKey: 'k' }, { subject: 's', text: 't' });
await rejects('an empty subject is refused', cfg, { subject: '  ', text: 't' });
await rejects('an empty body is refused', cfg, { subject: 's', text: '' });

const errFetch = async () => ({ ok: false, status: 422, json: async () => ({ message: 'domain not verified' }) });
try {
  await sendEmail(cfg, { subject: 's', text: 't' }, { fetchImpl: errFetch });
  check("Resend's own refusal is surfaced", false);
} catch (e) {
  check("Resend's own refusal is surfaced", e.message.includes('domain not verified'), e.message);
}

// ---- config: the key goes to the 0600 secrets file, not the shareable config
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'email-'));
check('nothing configured yet', !isConfigured(await loadEmailConfig(dir)));

await saveEmailConfig(dir, { to: 'jake@example.com', apiKey: 're_secret' });
const loaded = await loadEmailConfig(dir);
check('it is configured now', isConfigured(loaded));
check('the address round-trips', loaded.to === 'jake@example.com');
check('and so does the key', loaded.apiKey === 're_secret');

const plain = await fs.readFile(path.join(dir, 'email.json'), 'utf8');
check('the key is NOT in the shareable config file', !plain.includes('re_secret'), plain.trim());
const secrets = JSON.parse(await fs.readFile(path.join(dir, 'secrets.json'), 'utf8'));
check('it is in the secrets file under a reserved alias', secrets[RESEND_ALIAS] === 're_secret');
const mode = (await fs.stat(path.join(dir, 'secrets.json'))).mode & 0o777;
check('which stays owner-only', mode === 0o600, mode.toString(8));

// Changing the address must not wipe the key.
await saveEmailConfig(dir, { to: 'other@example.com' });
check('updating the address keeps the key', (await loadEmailConfig(dir)).apiKey === 're_secret');

await fs.rm(dir, { recursive: true, force: true });
console.log(fail.length ? `\nFAILED: ${fail.join(', ')}` : '\nall green');
process.exit(fail.length ? 1 : 0);
