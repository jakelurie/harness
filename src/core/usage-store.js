/**
 * Usage store: a small service that accumulates token usage into time buckets,
 * so reading it is a lookup rather than a scan.
 *
 * The previous design recomputed everything from every transcript each time the
 * tab opened - fine with one session, quadratic with a year of them. Here a
 * collector folds new events into hourly buckets and remembers how far it got
 * in each session, so each pass touches only what has changed. Buckets are
 * additive, which is what makes an arbitrary reporting period a sum over a
 * range instead of a re-read of history.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

const HOUR = 3600_000;

/** Hour index for a timestamp. Buckets are hourly: fine enough for a day view,
 *  coarse enough that a year of six models is a few thousand rows. */
const hourOf = (ts) => Math.floor(ts / HOUR);

const emptyState = () => ({
  version: 1,
  buckets: {},   // "<model>|<hour>" -> totals
  cursors: {},   // sessionId -> { events, ts }
  limits: {},    // model -> last provider rate-limit report
  periods: [],   // user-defined reporting windows
  updatedAt: 0,
});

export function storePath(userDataDir) {
  return path.join(userDataDir, 'usage.json');
}

export async function load(userDataDir) {
  try {
    const raw = JSON.parse(await fs.readFile(storePath(userDataDir), 'utf8'));
    return { ...emptyState(), ...raw };
  } catch {
    return emptyState();
  }
}

export async function save(userDataDir, state) {
  const file = storePath(userDataDir);
  await fs.mkdir(userDataDir, { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(state), 'utf8');
  await fs.rename(tmp, file);   // atomic: never a half-written ledger
  return state;
}

const blank = () => ({ turns: 0, input: 0, output: 0, cached: 0, cacheWrite: 0, ms: 0, tools: 0, cost: 0 });

/**
 * What one exchange actually cost.
 *
 * Three things a naive `input × price` gets wrong:
 *
 *  - Providers report `input` as the TOTAL, with `cached` a subset of it. The
 *    cached part bills far cheaper, so charging full rate for it overstates the
 *    bill badly - by about 6x on a session that reuses a long context.
 *  - Cache writes are their own, higher rate.
 *  - Some models price by band: past a threshold the WHOLE request reprices,
 *    rather than only the excess.
 */
export function costOf(usage, spec) {
  if (!spec?.priceIn && !spec?.priceOut) return 0;   // subscription models have no per-token price

  // Older events recorded `input` excluding the cached part; if cached exceeds
  // input that is what happened, so the true total is the sum. Without this,
  // history is priced as though almost nothing was read.
  const rawIn = usage?.input || 0;
  const rawCached = usage?.cached || 0;
  const input = rawCached > rawIn ? rawIn + rawCached : rawIn;
  const cached = Math.min(rawCached, input);
  const cacheWrite = usage?.cacheWrite || 0;
  const output = usage?.output || 0;

  const band = spec.longContextPricing;
  const rates = band && input > (band.threshold ?? Infinity) ? band : spec;

  const priceIn = rates.priceIn ?? spec.priceIn ?? 0;
  const priceCached = rates.priceCached ?? (priceIn / 10);   // a sane default when unstated
  const priceWrite = rates.priceCacheWrite ?? priceIn * 1.25;
  const priceOut = rates.priceOut ?? spec.priceOut ?? 0;

  return ((input - cached) * priceIn
    + cached * priceCached
    + cacheWrite * priceWrite
    + output * priceOut) / 1e6;
}

/**
 * Fold a session's new events into the buckets. Returns how many were added.
 *
 * Sessions are append-only in normal use, so the cursor is an event count. If a
 * transcript ever gets shorter - a crash repair rewrote it, or it was replaced -
 * the count no longer lines up, so that session is rebuilt from scratch rather
 * than silently double-counting or skipping.
 */
export function ingestSession(state, session, models) {
  const id = session.id;
  const events = session.events ?? [];
  const cursor = state.cursors[id];

  let from = 0;
  if (cursor) {
    if (events.length >= cursor.events) from = cursor.events;
    else dropSession(state, id, models); // shrunk: rebuild
  }

  let added = 0;
  for (let i = from; i < events.length; i += 1) {
    const e = events[i];
    if (e.type !== 'assistant') continue;

    const alias = e.model || 'unknown';
    const key = `${alias}|${hourOf(e.ts ?? Date.now())}`;
    const b = (state.buckets[key] ||= blank());

    b.turns += 1;
    // Older events recorded `input` excluding the cached part; newer ones
    // include it. Normalise to the total so a cached share is meaningful.
    const rawIn = e.usage?.input || 0;
    const rawCached = e.usage?.cached || 0;
    b.input += rawCached > rawIn ? rawIn + rawCached : rawIn;
    b.output += e.usage?.output || 0;
    b.cached += rawCached;
    b.cacheWrite += e.usage?.cacheWrite || 0;
    b.ms += e.usage?.ms || 0;
    b.tools += (e.toolCalls || []).length;

    b.cost += costOf(e.usage, models?.[alias]);
    added += 1;
  }

  state.cursors[id] = { events: events.length, ts: Date.now() };
  return added;
}

/** Forget a session: used when a transcript is rebuilt or deleted. */
export function dropSession(state, id, models) {
  delete state.cursors[id];
  // Buckets are aggregate and carry no session identity, so a rebuild has to
  // start from an empty ledger. Cheap, and only happens on repair or delete.
  state.buckets = {};
  for (const other of Object.keys(state.cursors)) delete state.cursors[other];
  void models;
}

/** Sum buckets over [from, to). Both are epoch ms; `to` defaults to now. */
export function query(state, { from = 0, to = Date.now(), models } = {}) {
  const lo = hourOf(from);
  const hi = hourOf(to - 1);
  const rows = {};

  for (const [key, b] of Object.entries(state.buckets)) {
    const split = key.lastIndexOf('|');
    const alias = key.slice(0, split);
    const hour = Number(key.slice(split + 1));
    if (hour < lo || hour > hi) continue;

    const row = (rows[alias] ||= {
      alias,
      label: models?.[alias]?.label ?? alias,
      provider: models?.[alias]?.provider ?? 'unknown',
      ...blank(),
    });
    for (const k of Object.keys(blank())) row[k] += b[k] || 0;
  }

  for (const row of Object.values(rows)) {
    const limits = models?.[row.alias]?.limits;
    if (!limits) continue;
    if (limits.tokens) {
      const used = row.input + row.output;
      row.limit = { kind: 'tokens', max: limits.tokens, used, pct: used / limits.tokens };
    } else if (limits.cost) {
      row.limit = { kind: 'cost', max: limits.cost, used: row.cost, pct: row.cost / limits.cost };
    }
  }

  return Object.values(rows).sort((a, b) => b.turns - a.turns);
}

/** A per-hour series for a model (or all models), for a sparkline. */
export function series(state, { from, to = Date.now(), alias } = {}) {
  const lo = hourOf(from);
  const hi = hourOf(to - 1);
  const out = [];
  for (let h = lo; h <= hi; h += 1) {
    let input = 0;
    let output = 0;
    for (const [key, b] of Object.entries(state.buckets)) {
      const split = key.lastIndexOf('|');
      if (Number(key.slice(split + 1)) !== h) continue;
      if (alias && key.slice(0, split) !== alias) continue;
      input += b.input || 0;
      output += b.output || 0;
    }
    out.push({ hour: h * HOUR, input, output });
  }
  return out;
}

/** Drop buckets older than `days`, so the ledger cannot grow without bound. */
export function prune(state, { days = 180, now = Date.now() } = {}) {
  const cutoff = hourOf(now - days * 24 * HOUR);
  let removed = 0;
  for (const key of Object.keys(state.buckets)) {
    if (Number(key.slice(key.lastIndexOf('|') + 1)) < cutoff) {
      delete state.buckets[key];
      removed += 1;
    }
  }
  return removed;
}

/** Rolling windows, plus whatever periods the user defined. */
export function resolvePeriod(state, id, now = Date.now()) {
  const rolling = {
    five_hour: 5 * HOUR,
    day: 24 * HOUR,
    seven_day: 7 * 24 * HOUR,
    month: 30 * 24 * HOUR,
  };
  if (rolling[id]) return { id, label: id, from: now - rolling[id], to: now };
  if (id === 'all') return { id, label: 'all time', from: 0, to: now };

  const custom = (state.periods ?? []).find((p) => p.id === id);
  if (custom) {
    return {
      id,
      label: custom.label ?? id,
      from: custom.from ? new Date(custom.from).getTime() : 0,
      to: custom.to ? new Date(custom.to).getTime() : now,
    };
  }
  return null;
}
