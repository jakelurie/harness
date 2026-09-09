// Telling the user a turn finished — without ever holding up the turn.
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { loadNotify, saveNotify, send, summarise } from '../src/core/notify.js';

const fail = [];
const check = (label, cond, extra = '') => {
  if (!cond) fail.push(label);
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? `  ${extra}` : ''}`);
};

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-notify-'));

check('absent config is off, not broken', (await loadNotify(dir)).enabled === false);
await saveNotify(dir, { enabled: true, kind: 'webhook', url: 'x', minSeconds: 30 });
check('config round-trips', (await loadNotify(dir)).minSeconds === 30);

check('disabled sends nothing', (await send({ enabled: false }, 'hi')).ok === false);
check('messages with no number is refused', (await send({ enabled: true, kind: 'messages', to: '' }, 'hi')).reason === 'no phone number set');
check('an unknown kind is reported', /unknown notifier/.test((await send({ enabled: true, kind: 'smoke' }, 'hi')).reason));

// webhook, against a real listener
let got = null;
const srv = http.createServer((req, res) => {
  let b = '';
  req.on('data', (c) => { b += c; });
  req.on('end', () => { got = b; res.writeHead(200); res.end('ok'); });
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${srv.address().port}/`;

const ok = await send({ enabled: true, kind: 'webhook', url }, 'turn finished');
check('a webhook is delivered', ok.ok === true, JSON.stringify(ok));
check('with the message as the body', got === 'turn finished', JSON.stringify(got));

const bad = await send({ enabled: true, kind: 'webhook', url: 'http://127.0.0.1:1/' }, 'x');
check('an unreachable webhook fails without throwing', bad.ok === false && Boolean(bad.reason));
srv.close();

// command
const marker = path.join(dir, 'fired.txt');
const cmd = await send({ enabled: true, kind: 'command', command: `printf '%s' '{{message}}' > ${marker}` }, 'from command');
check('a shell command notifier runs', cmd.ok === true, JSON.stringify(cmd));
check('and receives the message', (await fs.readFile(marker, 'utf8')) === 'from command');

// a hanging notifier must not hang the caller
const started = Date.now();
const slow = await send({ enabled: true, kind: 'command', command: 'sleep 40' }, 'x');
check('a hanging notifier is bounded', Date.now() - started < 30_000, `${Date.now() - started}ms`);
check('and reports rather than silently passing', slow.ok === false);

// the summary must not leak what was typed
const line = summarise({
  sessionName: 'JobScraper', model: 'astra', steps: 12, seconds: 94,
  failed: false, lastText: 'Wrote 3 files and re-ran the crawl.',
});
check('the summary names session, model and duration',
  line.includes('JobScraper') && line.includes('astra') && line.includes('94s'), line);
check('it carries the reply, which is the useful part', line.includes('Wrote 3 files'));
check('a failed turn says so', summarise({ sessionName: 's', model: 'm', steps: 1, seconds: 5, failed: true }).includes('stopped on an error'));
check('long replies are truncated', summarise({ sessionName: 's', model: 'm', steps: 1, seconds: 5, lastText: 'z'.repeat(500) }).length < 250);

await fs.rm(dir, { recursive: true, force: true });
console.log(`\n${fail.length ? `${fail.length} FAILED` : 'all green'}`);
process.exit(fail.length ? 1 : 0);
