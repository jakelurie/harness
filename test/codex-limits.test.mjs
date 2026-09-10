// Codex reports plan usage, but not down the `--json` stream: it writes it to
// the thread's rollout file. These cover reading it back and translating it
// into the shape the usage card draws, so the Codex card shows real bars
// instead of the old "the CLI does not report how much is left".
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { findRollout, readRateLimits, toUnified } from '../src/core/providers/codex-cli.js';
import { normalizeProviderLimits } from '../src/core/usage.js';

const fail = [];
const check = (label, cond, extra = '') => {
  if (!cond) fail.push(label);
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? `  ${extra}` : ''}`);
};

// Exactly what a live `codex exec --model gpt-6-astra` run left on disk.
const REAL = {
  limit_id: 'codex',
  limit_name: null,
  primary: { used_percent: 7.0, window_minutes: 10080, resets_at: 1789592645 },
  secondary: null,
  credits: { has_credits: false, unlimited: false, balance: '0' },
  individual_limit: null,
  spend_control_reached: null,
  plan_type: 'pro',
  rate_limit_reached_type: null,
};

// ---- translation
const u = toUnified(REAL);
check('a weekly window is named the way the card labels it', Boolean(u?.unifiedWindows?.seven_day));
check('7.0 percent becomes the fraction the card multiplies back up',
  u.unifiedWindows.seven_day.utilization === 0.07, String(u.unifiedWindows.seven_day.utilization));
check('the plan type is carried through', u.status === 'pro');

// The whole point: it must survive the same normaliser Claude's report goes
// through, and come out as a drawable percentage.
const n = normalizeProviderLimits(u);
const w = n.windows.find((x) => x.name === 'seven_day');
check('the normaliser yields one window', n.windows.length === 1, JSON.stringify(n.windows));
check('the card would render 7%', Math.round(w.pct * 100) === 7, String(w.pct));
check('resets_at is scaled from seconds to milliseconds', w.resetsAt === 1789592645 * 1000);

// A five-hour window and a weekly one together, as a busier plan reports.
const both = toUnified({
  primary: { used_percent: 2.5, window_minutes: 300, resets_at: 1789000000 },
  secondary: { used_percent: 41, window_minutes: 10080, resets_at: 1789592645 },
  plan_type: 'pro',
});
check('both windows are kept', Object.keys(both.unifiedWindows).length === 2);
check('300 minutes is the five-hour window', both.unifiedWindows.five_hour.utilization === 0.025);

// ---- nothing invented when there is nothing to report
check('no rate_limits means no report', toUnified(null) === null);
check('an all-null report is not drawn as zero percent',
  toUnified({ primary: null, secondary: null, plan_type: 'pro' }) === null);

// ---- reading it back off disk
const home = await fs.mkdtemp(path.join(os.tmpdir(), 'codexhome-'));
const threadId = '01a08990-cfa9-7783-9e9e-9c931b79f90c';
const now = Date.now();
const pad = (v) => String(v).padStart(2, '0');
const d = new Date(now);
const dir = path.join(home, 'sessions', String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate()));
await fs.mkdir(dir, { recursive: true });
const file = path.join(dir, `rollout-2026-09-09T21-26-04-${threadId}.jsonl`);

const tokenCount = (pct) => JSON.stringify({
  timestamp: new Date().toISOString(), type: 'event_msg',
  payload: {
    type: 'token_count',
    info: { total_token_usage: { input_tokens: 19004, output_tokens: 164 } },
    rate_limits: { ...REAL, primary: { ...REAL.primary, used_percent: pct } },
  },
});
await fs.writeFile(file, [
  JSON.stringify({ type: 'session_meta', payload: { id: threadId } }),
  tokenCount(3),
  JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'ok' } }),
  tokenCount(7),   // the newest figure is the one that counts
  '',
].join('\n'));

const found = await findRollout(threadId, { home, now });
check('the rollout file is found by thread id', found === file, String(found));
const rl = await readRateLimits(found);
check('the newest rate_limits wins', rl?.primary?.used_percent === 7, JSON.stringify(rl?.primary));

// A turn begun before midnight is filed under yesterday's date.
check('yesterday is searched too',
  (await findRollout(threadId, { home, now: now + 86_400_000 })) === file);

check('an unknown thread is not guessed at',
  (await findRollout('no-such-thread', { home, now })) === null);
check('a missing file reports nothing rather than throwing',
  (await readRateLimits(path.join(dir, 'gone.jsonl'))) === null);

// A rollout with no rate-limit line at all must not fabricate one.
const bare = path.join(dir, `rollout-2026-09-09T10-00-00-${'b'.repeat(8)}.jsonl`);
await fs.writeFile(bare, `${JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message' } })}\n`);
check('a rollout without limits reports nothing', (await readRateLimits(bare)) === null);

// A tail read can slice the first line in half; the scan must step past it.
const big = path.join(dir, `rollout-2026-09-09T11-00-00-${'c'.repeat(8)}.jsonl`);
const filler = `${JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'x'.repeat(4000) } })}\n`;
await fs.writeFile(big, filler.repeat(200) + `${tokenCount(12)}\n`);
check('a rollout larger than the tail read still yields the figure',
  (await readRateLimits(big))?.primary?.used_percent === 12);

// ---- the account-wide figure, without waiting for a turn to run here
const { latestRateLimits } = await import('../src/core/providers/codex-cli.js');
// Newest by timestamp, which here is the 21:26 file at 7% — not the larger
// 12% figure sitting in an older 11:00 rollout.
const newest = await latestRateLimits({ home, now });
check('the newest rollout supplies a figure with no turn of our own',
  newest?.unifiedWindows?.seven_day?.utilization === 0.07, JSON.stringify(newest?.unifiedWindows));

const empty = await fs.mkdtemp(path.join(os.tmpdir(), 'codexempty-'));
check('no rollouts at all reports nothing rather than zero',
  (await latestRateLimits({ home: empty, now })) === null);
await fs.rm(empty, { recursive: true, force: true });

await fs.rm(home, { recursive: true, force: true });

console.log(fail.length ? `\nFAILED: ${fail.join(', ')}` : '\nall green');
process.exit(fail.length ? 1 : 0);
