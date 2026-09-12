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

import { sendSms } from './sms.js';
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

/**
 * How long to wait on Messages before calling it stuck.
 *
 * Short on purpose. When it works it is immediate; when it does not it never
 * returns, so a long wait only means staring at "sending…" before getting the
 * same bad news.
 */
const SEND_TIMEOUT_MS = 8000;

const MESSAGES_WEDGED =
  'Messages accepted the connection but never answered. This happens when the Mac\'s display is '
  + 'asleep — its scripting bridge needs a live screen session, so texting cannot work with the lid '
  + 'shut. Open the lid and try again, or switch this to a webhook, which does not depend on the Mac.';

/** osascript buries the real error under the whole script; dig it back out. */
function cleanOsascriptError(stderr, err) {
  const text = String(stderr || err?.message || '').trim();
  // Real failures appear as "execution error: ..." or on the last line;
  // everything before that is the script being echoed back.
  const m = text.match(/execution error:\s*(.+)/i);
  if (m) return m[1].trim().slice(0, 200);
  if (err?.killed || /timed out/i.test(text)) return MESSAGES_WEDGED;
  const last = text.split('\n').filter((l) => l.trim() && !/^\s*(on run|set |tell |try|end |repeat|return|  )/.test(l)).pop();
  return (last || text).slice(0, 200);
}

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

    // Probe first. Talking to Messages at all is instant when it works, while
    // asking it for its accounts hangs outright when the Mac's display is
    // asleep — the scripting bridge needs a live window server. Separating the
    // two turns a 25-second wait on a truncated error into a fast, accurate
    // answer about which part is unavailable.
    const reachable = await bounded(
      new Promise((resolve) => {
        execFile('osascript', ['-e', 'tell application "Messages" to return "ok"'], { timeout: 4000 },
          (err) => resolve(!err));
      }),
      5000,
      false,
    );
    if (!reachable) {
      return { ok: false, reason: 'Messages is not responding to AppleScript. Check System Settings → Privacy & Security → Automation and allow it to be controlled.' };
    }

    const run = new Promise((resolve) => {
      execFile('osascript', ['-e', APPLESCRIPT, cfg.to, text], { timeout: SEND_TIMEOUT_MS },
        (err, stdout, stderr) => {
          const said = stdout.trim();
          if (!err) {
            return resolve({ ok: !/^failed/.test(said), via: said, reason: /^failed/.test(said) ? said : null });
          }
          // execFile puts the entire script into err.message, which buried the
          // real cause under forty lines of AppleScript.
          return resolve({ ok: false, reason: cleanOsascriptError(stderr, err) });
        });
    });
    return bounded(run, SEND_TIMEOUT_MS + 1500, {
      ok: false,
      reason: MESSAGES_WEDGED,
    });
  }

  // A real SMS, through the carrier's email gateway. Unlike the Messages
  // route this needs nothing from the Mac, so it works with the lid shut.
  if (cfg.kind === 'sms') {
    return sendSms({ to: cfg.to, user: cfg.gmailUser, pass: cfg.gmailPass, carrier: cfg.carrier }, text);
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
