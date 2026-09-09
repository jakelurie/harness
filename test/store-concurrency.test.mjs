// Saves race. An agent backend streams steps faster than a write completes, and
// a shared temp filename meant the second rename found nothing there — which
// crashed the server in the middle of a turn.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import * as store from '../src/core/store.js';

const fail = [];
const check = (label, cond, extra = '') => {
  if (!cond) fail.push(label);
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? `  ${extra}` : ''}`);
};

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-store-'));
await store.init(dir);

const session = store.newSession({ name: 'race', model: 'm', projectDir: dir });

// Fire many saves at once, as a streaming backend does.
const saves = [];
for (let i = 0; i < 40; i += 1) {
  session.events.push({ id: `e${i}`, ts: Date.now(), type: 'note', text: `step ${i}` });
  saves.push(store.save(session));
}
const settled = await Promise.allSettled(saves);
const rejected = settled.filter((r) => r.status === 'rejected');
check('40 concurrent saves all succeed', rejected.length === 0,
  rejected[0]?.reason?.code ?? '');

const loaded = await store.load(session.id);
check('the transcript survives intact', loaded.events.length === 40, String(loaded.events.length));
check('and is valid JSON on disk, not truncated',
  JSON.parse(await fs.readFile(path.join(dir, 'sessions', `${session.id}.json`), 'utf8')).events.length === 40);

const leftovers = (await fs.readdir(path.join(dir, 'sessions'))).filter((f) => f.includes('.tmp'));
check('no temp files are left behind', leftovers.length === 0, leftovers.join(','));

await fs.rm(dir, { recursive: true, force: true });
console.log(`\n${fail.length ? `${fail.length} FAILED` : 'all green'}`);
process.exit(fail.length ? 1 : 0);
