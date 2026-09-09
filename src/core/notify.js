/**
 * Telling you a turn finished, when you are not looking at the screen.
 *
 * Three ways, because none of them is universally available:
 *
 *  - messages   free real SMS/iMessage through Messages.app, but macOS wants a
 *               one-time Automation consent. That dialog appears on the Mac's
 *               screen, so it has to be approved with the lid open once.
 *  - webhook    a POST to any URL - ntfy.sh, Pushover, Slack, whatever. Needs
 *               no permission and works headless, which is why it exists here.
 *  - command    any shell command, for a sender not covered above.
 *
 * Every send is bounded. A notifier that hangs must never hold up a turn.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

export function notifyPath(userDataDir) {
  return path.join(userDataDir, 'notify.json');
}

export async function loadNotify(userDataDir) {
  try {
    return { enabled: false, kind: 'messages', minSeconds: 60, ...JSON.parse(await fs.readFile(notifyPath(userDataDir), 'utf8')) };
  } catch {
    return { enabled: false, kind: 'messages', to: '', url: '', command: '', minSeconds: 60 };
  }
}

export async function saveNotify(userDataDir, cfg) {
  const file = notifyPath(userDataDir);
  await fs.mkdir(userDataDir, { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
  await fs.rename(tmp, file);
  return cfg;
}

const APPLESCRIPT = `on run argv
  set phoneNumber to item 1 of argv
  set msg to item 2 of argv
  tell application "Messages"
    try
      set svc to 1st account whose service type = iMessage
      send msg to participant phoneNumber of svc
      return "imessage"
    on error e1
      try
        set svc to 1st account whose service type = SMS
        send msg to participant phoneNumber of svc
        return "sms"
      on error e2
        return "failed: " & e1 & " / " & e2
      end try
    end try
  end tell
end run`;

/** Never let a notifier outlive its usefulness. */
function bounded(promise, ms, onTimeout) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((resolve) => { timer = setTimeout(() => resolve(onTimeout), ms); }),
  ]);
}

export async function send(cfg, text) {
  if (!cfg?.enabled) return { ok: false, reason: 'notifications are off' };

  if (cfg.kind === 'messages') {
    if (!cfg.to) return { ok: false, reason: 'no phone number set' };
    const run = new Promise((resolve) => {
      execFile('osascript', ['-e', APPLESCRIPT, cfg.to, text], { timeout: 25_000 },
        (err, stdout, stderr) => resolve(
          err
            ? { ok: false, reason: (stderr || err.message || '').trim().slice(0, 200) }
            : { ok: !/^failed/.test(stdout.trim()), via: stdout.trim(), reason: /^failed/.test(stdout.trim()) ? stdout.trim() : null },
        ));
    });
    return bounded(run, 28_000, {
      ok: false,
      reason: 'Messages did not respond — macOS is probably waiting on an Automation permission dialog. Approve it once with the lid open (System Settings → Privacy & Security → Automation).',
    });
  }

  if (cfg.kind === 'webhook') {
    if (!cfg.url) return { ok: false, reason: 'no webhook URL set' };
    try {
      const res = await fetch(cfg.url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: text,
        signal: AbortSignal.timeout(15_000),
      });
      return res.ok ? { ok: true, via: `webhook ${res.status}` } : { ok: false, reason: `webhook returned ${res.status}` };
    } catch (e) {
      return { ok: false, reason: e?.message ?? String(e) };
    }
  }

  if (cfg.kind === 'command') {
    if (!cfg.command) return { ok: false, reason: 'no command set' };
    const run = new Promise((resolve) => {
      execFile('/bin/sh', ['-c', cfg.command.replaceAll('{{message}}', text.replaceAll("'", "'\\''"))],
        { timeout: 20_000 },
        (err, stdout, stderr) => resolve(err ? { ok: false, reason: (stderr || err.message).slice(0, 200) } : { ok: true, via: 'command' }));
    });
    return bounded(run, 22_000, { ok: false, reason: 'command timed out' });
  }

  return { ok: false, reason: `unknown notifier "${cfg.kind}"` };
}

/** A short, factual line. No prompt text — the same rule as commit messages. */
export function summarise({ sessionName, model, steps, seconds, failed, lastText }) {
  const head = `${sessionName} · ${model} · ${Math.round(seconds)}s`;
  const what = failed ? 'stopped on an error' : `${steps} step${steps === 1 ? '' : 's'}`;
  const tail = lastText ? ` — ${lastText.replace(/\s+/g, ' ').slice(0, 140)}` : '';
  return `${head} · ${what}${tail}`;
}
