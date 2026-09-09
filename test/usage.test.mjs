// Usage accounting: what the harness measured, and what a provider reports,
// must stay separate and must not invent numbers.
import { summarize, normalizeProviderLimits, WINDOWS } from '../src/core/usage.js';

const fail = [];
const check = (label, cond, extra = '') => {
  if (!cond) fail.push(label);
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? `  ${extra}` : ''}`);
};

const now = Date.now();
const hour = 3600_000;
const asst = (model, ts, input, output, tools = 0, cached = 0) => ({
  type: 'assistant', model, ts, usage: { input, output, cached, ms: 1000 },
  toolCalls: Array.from({ length: tools }, (_, i) => ({ id: `c${i}`, name: 'bash', args: {} })),
});

const sessions = [
  { id: 's1', events: [asst('opus', now - hour, 100, 50, 2), asst('local', now - hour, 10, 5)] },
  { id: 's2', events: [asst('opus', now - 3 * 24 * hour, 200, 80, 1, 500)] },
  { id: 's3', events: [asst('opus', now - 20 * 24 * hour, 999, 999)] }, // outside 7 days
];
const models = {
  opus: { label: 'Claude Opus', provider: 'claude-cli' },
  local: { label: 'Qwen', provider: 'openai' },
  gpt: { label: 'GPT', provider: 'openai', priceIn: 2, priceOut: 10, limits: { tokens: 1000 } },
};

const week = summarize(sessions, models, { window: 'seven_day', now });
const opus = week.find((r) => r.alias === 'opus');
check('sums only events inside the window', opus.input === 300 && opus.output === 130,
  JSON.stringify({ input: opus.input, output: opus.output }));
check('counts turns, tools, cached and sessions',
  opus.turns === 2 && opus.tools === 3 && opus.cached === 500 && opus.sessions === 2,
  JSON.stringify(opus));

const all = summarize(sessions, models, { window: 'all', now });
check('all-time includes the older event', all.find((r) => r.alias === 'opus').input === 1299);

const fiveHour = summarize(sessions, models, { window: 'five_hour', now });
check('a short window excludes older turns', fiveHour.find((r) => r.alias === 'opus').turns === 1);

check('a subscription model gets no invented price', opus.cost === 0, String(opus.cost));

// priced model
const priced = summarize(
  [{ id: 'p', events: [asst('gpt', now - hour, 1_000_000, 100_000)] }], models, { window: 'seven_day', now },
);
const g = priced.find((r) => r.alias === 'gpt');
check('a priced model computes cost', Math.abs(g.cost - (2 + 1)) < 0.001, String(g.cost));
check('a declared token ceiling produces a percentage',
  g.limit?.kind === 'tokens' && g.limit.max === 1000 && g.limit.pct > 1, JSON.stringify(g.limit));

check('models are ordered by activity', week[0].turns >= week[week.length - 1].turns);
check('every window is offered', Object.keys(WINDOWS).length === 4);

// provider report
const norm = normalizeProviderLimits({
  status: 'allowed', rateLimitType: 'five_hour', isUsingOverage: false,
  unifiedWindows: { five_hour: { utilization: 0.01, resetsAt: 1788844200 }, seven_day: { utilization: 0.42, resetsAt: 1788840000 } },
});
check('provider windows are normalised', norm.windows.length === 2
  && norm.windows.find((w) => w.name === 'seven_day').pct === 0.42);
check('reset times become milliseconds', norm.windows[0].resetsAt === 1788844200 * 1000);
check('a missing report is null, not a fake zero', normalizeProviderLimits(null) === null);

console.log(`\n${fail.length ? `${fail.length} FAILED` : 'all green'}`);
process.exit(fail.length ? 1 : 0);
