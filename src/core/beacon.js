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

/** How long a turn may go without any sign of progress before it counts as wedged. */
export const DEFAULT_STALL_MS = 5 * 60_000;

/** Never alarm about the same stall more than once inside this window. */
export const RENOTIFY_MS = 30 * 60_000;

export function createBeacons({ now = () => Date.now() } = {}) {
  const beacons = new Map();   // sessionId -> { startedAt, at, last, alarmedAt, model }

  return {
    start(sessionId, { model } = {}) {
      beacons.set(sessionId, { startedAt: now(), at: now(), last: null, alarmedAt: null, model });
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
    due({ stallMs = DEFAULT_STALL_MS, renotifyMs = RENOTIFY_MS } = {}) {
      const t = now();
      const out = [];
      for (const [id, b] of beacons) {
        const silentFor = t - b.at;
        if (silentFor < stallMs) continue;
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
        stalled: t - b.at >= stallMs,
        lastActivity: b.last,
      }));
    },
  };
}

/** What the user is told when a turn goes quiet. */
export function wedgeMessage({ sessionName, model, silentMs, lastActivity }) {
  const mins = Math.round(silentMs / 60_000);
  return `"${sessionName}" has shown no progress for ${mins} minute${mins === 1 ? '' : 's'}`
    + `${model ? ` (${model})` : ''}.`
    + `${lastActivity ? ` Last activity: ${lastActivity}.` : ''}`
    + ' It may be stuck on a prompt or a blocked command. Open the harness to stop it or take over.';
}
