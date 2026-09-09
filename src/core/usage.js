/**
 * Usage accounting across every session.
 *
 * Two different things get called "usage" and they do not mix:
 *
 *  - What the harness observed. Tokens, time and tool calls summed from the
 *    transcripts it wrote. Always available, for every backend, but it only
 *    knows about work done through this app.
 *  - What the provider reports. A subscription's rolling-window utilisation,
 *    which counts everything on the account including sessions the harness
 *    never saw. Authoritative, but only some backends report it.
 *
 * Both are shown, labelled, and never added together.
 */

export const WINDOWS = {
  five_hour: 5 * 60 * 60 * 1000,
  seven_day: 7 * 24 * 60 * 60 * 1000,
  month: 30 * 24 * 60 * 60 * 1000,
  all: Infinity,
};

/** Per-model totals over one rolling window, from the transcripts. */
export function summarize(sessions, models, { window = 'seven_day', now = Date.now() } = {}) {
  const span = WINDOWS[window] ?? WINDOWS.seven_day;
  const since = span === Infinity ? 0 : now - span;

  const rows = {};
  const rowFor = (alias) =>
    (rows[alias] ||= {
      alias,
      label: models?.[alias]?.label ?? alias,
      provider: models?.[alias]?.provider ?? 'unknown',
      turns: 0, input: 0, output: 0, cached: 0, ms: 0, tools: 0, cost: 0, sessions: 0,
    });

  for (const session of sessions) {
    const seen = new Set();
    for (const e of session.events ?? []) {
      if (e.type !== 'assistant' || e.ts < since) continue;
      const row = rowFor(e.model || 'unknown');
      seen.add(e.model || 'unknown');

      row.turns += 1;
      row.input += e.usage?.input || 0;
      row.output += e.usage?.output || 0;
      row.cached += e.usage?.cached || 0;
      row.ms += e.usage?.ms || 0;
      row.tools += (e.toolCalls || []).length;

      // A price is only meaningful if models.json states one. A subscription
      // backend has no per-token price, so it stays at zero rather than
      // inventing a number.
      const spec = models?.[e.model];
      if (spec?.priceIn || spec?.priceOut) {
        row.cost +=
          ((e.usage?.input || 0) * (spec.priceIn || 0) +
            (e.usage?.output || 0) * (spec.priceOut || 0)) / 1e6;
      }
    }
    for (const alias of seen) rowFor(alias).sessions += 1;
  }

  // Attach whatever ceiling the model declares, so a bar can be drawn.
  for (const row of Object.values(rows)) {
    const limits = models?.[row.alias]?.limits;
    if (!limits) continue;
    if (limits.tokens) {
      row.limit = {
        kind: 'tokens', max: limits.tokens, window: limits.window ?? window,
        used: row.input + row.output,
        pct: (row.input + row.output) / limits.tokens,
      };
    } else if (limits.cost) {
      row.limit = {
        kind: 'cost', max: limits.cost, window: limits.window ?? window,
        used: row.cost, pct: row.cost / limits.cost,
      };
    }
  }

  return Object.values(rows).sort((a, b) => b.turns - a.turns);
}

/**
 * A provider's own rolling-window report, normalised for display.
 * Shape follows the `rate_limit_event` the claude CLI emits.
 */
export function normalizeProviderLimits(info) {
  if (!info) return null;
  const windows = Object.entries(info.unifiedWindows ?? {}).map(([name, w]) => ({
    name,
    pct: w.utilization ?? 0,
    resetsAt: w.resetsAt ? w.resetsAt * 1000 : null,
  }));
  return {
    status: info.status ?? null,
    kind: info.rateLimitType ?? null,
    usingOverage: Boolean(info.isUsingOverage),
    windows: windows.sort((a, b) => a.name.localeCompare(b.name)),
  };
}
