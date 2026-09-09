// The usage ledger: incremental, additive, and cheap to read.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import * as U from '../src/core/usage-store.js';
import { costOf } from '../src/core/usage-store.js';

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

// ---- cost, which is easy to get badly wrong ----
{
  const astra = {
    priceIn: 10, priceCached: 1, priceCacheWrite: 12.5, priceOut: 50,
    longContextPricing: { threshold: 272_000, priceIn: 20, priceCached: 2, priceCacheWrite: 25, priceOut: 75 },
  };

  // `input` is the total and `cached` a subset of it — charging full rate for
  // the cached part is the bug this replaced.
  // Kept under the band so this checks the cache rate, not the band rate.
  const c1 = costOf({ input: 200_000, cached: 180_000, output: 10_000 }, astra);
  const expected = (20_000 * 10 + 180_000 * 1 + 10_000 * 50) / 1e6;
  check('cached input bills at the cached rate', Math.abs(c1 - expected) < 1e-9, `$${c1.toFixed(4)}`);
  check('and is far cheaper than charging it all at full rate',
    c1 < (200_000 * 10 + 10_000 * 50) / 1e6 / 2, `$${c1.toFixed(2)} vs $${((200_000 * 10 + 10_000 * 50) / 1e6).toFixed(2)}`);

  const c2 = costOf({ input: 300_000, cached: 0, output: 1_000 }, astra);
  check('crossing the band reprices the whole request',
    Math.abs(c2 - (300_000 * 20 + 1_000 * 75) / 1e6) < 1e-9, `$${c2.toFixed(4)}`);

  const c3 = costOf({ input: 271_000, cached: 0, output: 1_000 }, astra);
  check('just under the band stays at standard rates',
    Math.abs(c3 - (271_000 * 10 + 1_000 * 50) / 1e6) < 1e-9, `$${c3.toFixed(4)}`);
  check('the band is a cliff, not a slope', c2 > c3 * 1.9, `${c3.toFixed(2)} -> ${c2.toFixed(2)}`);

  check('cache writes bill at their own rate',
    Math.abs(costOf({ input: 1000, cached: 0, cacheWrite: 1000, output: 0 }, astra)
      - (1000 * 10 + 1000 * 12.5) / 1e6) < 1e-9);

  check('a subscription model costs nothing per token',
    costOf({ input: 1e6, cached: 5e5, output: 1e4 }, { label: 'opus' }) === 0);
  check('cached is clamped to input, so bad data cannot make it negative',
    costOf({ input: 100, cached: 999_999, output: 0 }, astra) >= 0);
}

// ---- history recorded under the older convention still reads correctly ----
{
  // Back then `input` excluded the cached part, so cached could exceed it.
  const legacy = { input: 1_000, cached: 50_000, output: 100 };
  const c = costOf(legacy, { priceIn: 10, priceCached: 1, priceOut: 50 });
  const expected = (1_000 * 10 + 50_000 * 1 + 100 * 50) / 1e6;
  check('legacy usage is normalised rather than mispriced',
    Math.abs(c - expected) < 1e-9, `$${c.toFixed(4)}`);

  let st2 = { version: 1, buckets: {}, cursors: {}, limits: {}, periods: [], updatedAt: 0 };
  U.ingestSession(st2, { id: 'L', events: [{ type: 'assistant', model: 'm', ts: now, usage: legacy }] },
    { m: { label: 'm' } });
  const row = U.query(st2, { from: 0, to: now + 1000, models: { m: {} } })[0];
  check('and its cached share cannot exceed 100%', row.cached <= row.input,
    `${row.cached} of ${row.input}`);
}

console.log(`\n${fail.length ? `${fail.length} FAILED` : 'all green'}`);
process.exit(fail.length ? 1 : 0);
