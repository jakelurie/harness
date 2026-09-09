// The usage ledger: incremental, additive, and cheap to read.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import * as U from '../src/core/usage-store.js';

const fail = [];
const check = (label, cond, extra = '') => {
  if (!cond) fail.push(label);
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? `  ${extra}` : ''}`);
};

const HOUR = 3600_000;
const now = Date.now();
const asst = (model, ts, input, output, tools = 0) => ({
  type: 'assistant', model, ts, usage: { input, output, cached: 0, ms: 500 },
  toolCalls: Array.from({ length: tools }, () => ({ name: 'bash', args: {} })),
});

const models = {
  opus: { label: 'Opus', provider: 'claude-cli' },
  gpt: { label: 'GPT', provider: 'openai', priceIn: 2, priceOut: 10, limits: { tokens: 1000 } },
};

let state = { version: 1, buckets: {}, cursors: {}, limits: {}, periods: [], updatedAt: 0 };

// --- incremental ingestion is the whole point
const session = { id: 's1', events: [asst('opus', now - HOUR, 100, 20, 2)] };
check('first pass ingests', U.ingestSession(state, session, models) === 1);
check('a second pass with no new events ingests nothing',
  U.ingestSession(state, session, models) === 0);

session.events.push(asst('opus', now - HOUR, 50, 10));
check('only the new event is folded in', U.ingestSession(state, session, models) === 1);

const week = U.query(state, { from: now - 7 * 24 * HOUR, to: now, models });
check('totals accumulate correctly',
  week[0].input === 150 && week[0].output === 30 && week[0].turns === 2 && week[0].tools === 2,
  JSON.stringify(week[0]));
check('no double counting after repeated passes', week.length === 1);

// --- time ranges are a sum over buckets
state = { version: 1, buckets: {}, cursors: {}, limits: {}, periods: [], updatedAt: 0 };
U.ingestSession(state, { id: 'a', events: [
  asst('opus', now - 2 * HOUR, 10, 1),
  asst('opus', now - 48 * HOUR, 100, 10),
  asst('opus', now - 40 * 24 * HOUR, 1000, 100),
] }, models);
check('a 5-hour window sees only recent work',
  U.query(state, { from: now - 5 * HOUR, to: now, models })[0].input === 10);
check('a 7-day window includes the older turn',
  U.query(state, { from: now - 7 * 24 * HOUR, to: now, models })[0].input === 110);
check('an all-time query includes everything',
  U.query(state, { from: 0, to: now, models })[0].input === 1110);
check('an arbitrary range works — the point of buckets',
  U.query(state, { from: now - 72 * HOUR, to: now - 24 * HOUR, models })[0].input === 100);

// --- a shrinking transcript must rebuild rather than mis-count
const before = U.query(state, { from: 0, to: now, models })[0].turns;
U.ingestSession(state, { id: 'a', events: [asst('opus', now - HOUR, 5, 5)] }, models);
const after = U.query(state, { from: 0, to: now, models })[0];
check('a shrunken transcript rebuilds instead of double counting',
  after.turns === 1 && after.input === 5, `${before} -> ${JSON.stringify(after)}`);

// --- pricing and ceilings
state = { version: 1, buckets: {}, cursors: {}, limits: {}, periods: [], updatedAt: 0 };
U.ingestSession(state, { id: 'p', events: [asst('gpt', now - HOUR, 1_000_000, 100_000)] }, models);
const priced = U.query(state, { from: 0, to: now, models })[0];
check('priced models compute cost', Math.abs(priced.cost - 3) < 0.001, String(priced.cost));
check('a declared ceiling yields a percentage', priced.limit?.pct > 1, JSON.stringify(priced.limit));

// --- pruning keeps the ledger bounded
U.ingestSession(state, { id: 'old', events: [asst('opus', now - 400 * 24 * HOUR, 5, 5)] }, models);
const removed = U.prune(state, { days: 180, now });
check('old buckets are pruned', removed >= 1, `removed ${removed}`);
check('recent buckets survive pruning', U.query(state, { from: 0, to: now, models }).length >= 1);

// --- user-controlled periods
state.periods = [{ id: 'sprint', label: 'This sprint', from: new Date(now - 3 * 24 * HOUR).toISOString() }];
const sprint = U.resolvePeriod(state, 'sprint', now);
check('a user-defined period resolves', sprint && sprint.label === 'This sprint' && sprint.to === now);
check('rolling windows still resolve', U.resolvePeriod(state, 'seven_day', now).from === now - 7 * 24 * HOUR);
check('an unknown period is null', U.resolvePeriod(state, 'nope', now) === null);

// --- persistence round-trip
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-usage-'));
await U.save(dir, state);
const reloaded = await U.load(dir);
check('the ledger survives a restart',
  JSON.stringify(U.query(reloaded, { from: 0, to: now, models }))
  === JSON.stringify(U.query(state, { from: 0, to: now, models })));
check('a missing ledger loads as empty, not an error',
  (await U.load(path.join(dir, 'nowhere'))).buckets && Object.keys((await U.load(path.join(dir, 'nowhere'))).buckets).length === 0);
await fs.rm(dir, { recursive: true, force: true });

console.log(`\n${fail.length ? `${fail.length} FAILED` : 'all green'}`);
process.exit(fail.length ? 1 : 0);
