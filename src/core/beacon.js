/**
 * Liveness for a running turn.
 *
 * The harness knows whether a turn is *running*; it has never known whether a
 * turn is *progressing*. Those came apart every time something went wrong: a
 * tool blocked on a macOS consent dialog with the lid shut, a stop that never
 * took, a provider that stopped talking. In each case the harness happily
 * reported a healthy turn.
 *
 * So every turn keeps a beacon — a timestamp of the last observed progress,
 * updated on each delta. A watcher outside the model checks freshness, because
 * a stalled agent cannot be the thing that notices it has stalled. When a
 * beacon goes stale the alarm fires once per stall, not once per check: an
 * alarm that repeats every few seconds trains you to ignore it.
 */

/**
 * How long a turn may go quiet before it counts as wedged.
 *
 * This has to be per-backend, and the first version was not, which made it cry
 * wolf. When the harness drives the loop it sees a tool start and finish, and a
 * tool cannot outlive its own timeout, so silence of more than a few minutes
 * really is suspicious. An agent CLI is the opposite: the whole turn is one
 * opaque call while it runs its own loop with its own tools, and it can
 * legitimately say nothing for a long stretch. Measured against real
 * transcripts here, both `claude-cli` and `codex-cli` went over five minutes
 * mid-turn while working perfectly well.
 *
 * A false alarm is worse than a late one. Someone who gets emailed about a
 * healthy turn learns to ignore the next email, including the true one.
 */
export const DEFAULT_STALL_MS = 8 * 60_000;

/** Agent backends run their own loop and stream sparsely. */
export const AGENT_STALL_MS = 25 * 60_000;

const AGENT_PROVIDERS = new Set(['claude-cli', 'codex-cli']);

export function stallMsFor(spec) {
  if (!spec) return DEFAULT_STALL_MS;
  if (AGENT_PROVIDERS.has(spec.provider)) return AGENT_STALL_MS;
  // A harness-driven turn cannot be silent for longer than a tool is allowed
  // to run, plus room for the model to answer.
  const toolMs = spec.toolTimeoutMs ?? 120_000;
  return Math.max(DEFAULT_STALL_MS, toolMs * 3);
}

/** Never alarm about the same stall more than once inside this window. */
export const RENOTIFY_MS = 30 * 60_000;

export function createBeacons({ now = () => Date.now() } = {}) {
  const beacons = new Map();   // sessionId -> { startedAt, at, last, alarmedAt, model }

  return {
    start(sessionId, { model, stallMs } = {}) {
      // The threshold belongs to the turn, because it depends on which backend
      // is running it, and the model can be switched between turns.
      beacons.set(sessionId, { startedAt: now(), at: now(), last: null, alarmedAt: null, model, stallMs });
    },

    /** Any sign of life: a token, a tool starting, a tool finishing. */
    touch(sessionId, label) {
      const b = beacons.get(sessionId);
      if (!b) return;
      b.at = now();
      if (label) b.last = label;
      // Progress clears a previous alarm, so a turn that recovers and stalls
      // again is reported again rather than staying silently marked.
      b.alarmedAt = null;
    },

    stop(sessionId) {
      beacons.delete(sessionId);
    },

    get(sessionId) {
      return beacons.get(sessionId) ?? null;
    },

    /**
     * Which turns look wedged and are due an alarm.
     *
     * Returns only the ones that should be reported now; asking does not
     * re-report something already raised inside the renotify window.
     */
    due({ stallMs, renotifyMs = RENOTIFY_MS } = {}) {
      const t = now();
      const out = [];
      for (const [id, b] of beacons) {
        // An explicit argument overrides the per-turn threshold, so a caller
        // can force a stricter or looser check; otherwise the turn's own
        // backend-derived value decides.
        const limit = stallMs ?? b.stallMs ?? DEFAULT_STALL_MS;
        const silentFor = t - b.at;
        if (silentFor < limit) continue;
        if (b.alarmedAt && t - b.alarmedAt < renotifyMs) continue;
        b.alarmedAt = t;
        out.push({
          sessionId: id,
          model: b.model ?? null,
          silentMs: silentFor,
          runningMs: t - b.startedAt,
          lastActivity: b.last,
        });
      }
      return out;
    },

    /** Everything currently tracked, for the dashboard. */
    all({ stallMs = DEFAULT_STALL_MS } = {}) {
      const t = now();
      return [...beacons.entries()].map(([id, b]) => ({
        sessionId: id,
        model: b.model ?? null,
        startedAt: b.startedAt,
        beatAt: b.at,
        silentMs: t - b.at,
        stallMs: b.stallMs ?? stallMs,
        stalled: t - b.at >= (b.stallMs ?? stallMs),
        lastActivity: b.last,
      }));
    },
  };
}

/** What the user is told when a turn goes quiet. */
export function wedgeMessage({ sessionName, model, silentMs, runningMs, lastActivity }) {
  const mins = Math.round(silentMs / 60_000);
  const ran = runningMs ? ` The turn has been going ${Math.round(runningMs / 60_000)} minutes.` : '';
  return `"${sessionName}" has shown no progress for ${mins} minute${mins === 1 ? '' : 's'}`
    + `${model ? ` (${model})` : ''}.${ran}`
    + `${lastActivity ? ` Last activity: ${lastActivity}.` : ''}`
    + ' It may be stuck on a prompt or a blocked command. Open the harness to stop it or take over.';
}
