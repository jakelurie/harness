/* Harness, phone edition. Talks to the same core the desktop app drives. */

const $ = (id) => document.getElementById(id);

// Anything that throws where nobody is catching used to vanish and leave a
// dead-looking UI. Surface it instead.
window.addEventListener('unhandledrejection', (e) => {
  showBanner(e.reason?.message ?? String(e.reason));
});
window.addEventListener('error', (e) => showBanner(e.message));
const api = async (url, opts = {}) => {
  const res = await fetch(url, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `${res.status}`);
  return body;
};

// Each tab is a separate session with its own transcript and its own stream:
// the chat tab talks to the project, the monitoring tab talks to a companion
// session whose job is the panel above it.
const tabs = {
  chat: { session: null, stream: null, running: false, live: null, startedAt: null },
  monitor: { session: null, stream: null, running: false, live: null, startedAt: null },
};

const state = {
  models: {}, default: null, sessions: [], beacons: {},
  session: null,          // the chat session; identity of the pair
  home: '',
  tab: 'chat',
};

const cur = () => tabs[state.tab];

// Images chosen but not yet sent. Uploaded immediately so the send is quick and
// so a failed conversion is visible before you commit to the message.
let pendingShots = [];

const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

/**
 * Enough markdown to read like prose rather than source. Headings, bold, lists
 * and code - not a full parser, because anything it does not recognise should
 * survive as literal text rather than disappear.
 */
function render(text) {
  const parts = String(text ?? '').split(/```/);
  return parts
    .map((chunk, i) => {
      if (i % 2) {
        const body = chunk.replace(/^[\w+-]*\n/, '');
        return `<pre><code>${esc(body)}</code></pre>`;
      }
      return inline(chunk);
    })
    .join('');
}

function inline(chunk) {
  const lines = esc(chunk).split('\n');
  const out = [];
  let list = null;

  const closeList = () => {
    if (list) { out.push(`</${list}>`); list = null; }
  };
  const openList = (tag) => {
    if (list !== tag) { closeList(); out.push(`<${tag}>`); list = tag; }
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);

    if (heading) {
      closeList();
      const level = Math.min(4, heading[1].length + 2); // h1 in a chat is shouting
      out.push(`<h${level}>${emphasis(heading[2])}</h${level}>`);
    } else if (bullet) {
      openList('ul');
      out.push(`<li>${emphasis(bullet[1])}</li>`);
    } else if (numbered) {
      openList('ol');
      out.push(`<li>${emphasis(numbered[1])}</li>`);
    } else if (!line.trim()) {
      closeList();
      out.push('<br>');
    } else {
      closeList();
      out.push(`${emphasis(line)}<br>`);
    }
  }
  closeList();
  return out.join('');
}

/** Applied to already-escaped text, so it can only add the markup it intends. */
function emphasis(t) {
  return t
    // Markdown links. A model handing back a file writes one constantly, and
    // unrendered they spill an absolute path across several lines.
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, href) => {
      // Only schemes that are safe to put in an href; a local path becomes a
      // preview link into the harness rather than a dead file:// URL.
      if (/^https?:\/\//i.test(href)) {
        return `<a href="${href}" target="_blank" rel="noopener">${label}</a>`;
      }
      if (href.startsWith('/')) {
        return `<a href="/api/file?path=${encodeURIComponent(href)}" target="_blank" rel="noopener">${label}</a>`;
      }
      return label;   // relative or unknown: show the words, drop the link
    })
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
}

/** Minimal wall-clock stamp: what time did this happen. */
const clock = (ts) => (ts
  ? new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  : '');

const compact = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));

const shortDir = (p) => String(p ?? '').replace(state.home, '~');

// ------------------------------------------------------------------ sheet

function openSheet(html) {
  $('sheet').innerHTML = html;
  $('sheet-back').hidden = false;
}
function closeSheet() {
  $('sheet-back').hidden = true;
  $('sheet').innerHTML = '';
}

// ------------------------------------------------------------- transcript

/**
 * @param reveal  show the output without a tap. Used when the assistant said
 *                nothing of its own: a collapsed tool call would otherwise be
 *                the entire reply, which reads as no answer at all.
 */
function toolBlock(call, result, reveal = false) {
  const status = !result
    ? '<span class="tool-status pending">running…</span>'
    : result.ok
      ? '<span class="tool-status ok">ok</span>'
      : '<span class="tool-status err">failed</span>';
  const arg = describe(call);
  const body = result
    ? `<pre class="tool-body"${reveal ? '' : ' hidden'}>${esc(result.output)}</pre>`
    : '';
  return `<div class="tool" data-call="${esc(call.id)}">
      <div class="tool-head"><span class="tool-name">${esc(call.name)}</span>
      <span class="tool-arg">${esc(arg)}</span>
      <span class="at">${clock(result?.ts)}</span>${status}</div>${body}</div>`;
}

function describe(call) {
  const a = call.args ?? {};
  switch (call.name) {
    case 'bash': return a.command ?? '';
    case 'read_file':
    case 'list_dir': return a.path ?? '.';
    case 'write_file': return `${a.path ?? ''} (${String(a.content ?? '').split('\n').length} lines)`;
    case 'edit_file': return a.path ?? '';
    default: return JSON.stringify(a).slice(0, 120);
  }
}

/**
 * The plain text behind each reply, so it can be copied out and pasted into
 * another session as context.
 *
 * Kept in a map rather than a data- attribute because `esc` above deliberately
 * leaves quotes alone, and a reply containing one would break out of the
 * attribute. The map is rebuilt with the transcript, so it cannot drift from
 * what is on screen or grow without bound.
 */
const copyTexts = new Map();

/**
 * Copy text, on a phone, over both of the ways this harness is reached.
 *
 * The async clipboard API exists only in a secure context. Over Tailscale that
 * is HTTPS and it works; over plain HTTP on the LAN `navigator.clipboard` is
 * simply undefined, so the old selection trick is kept as the path for that
 * rather than letting the button do nothing. iOS ignores a readonly textarea,
 * hence the contentEditable range dance.
 */
async function copyText(text) {
  // Neither route can write to the clipboard while the document is unfocused,
  // and `execCommand` will still cheerfully return true when it wrote nothing.
  // Checking first is what keeps the button from claiming a copy that did not
  // happen - a button that lies is worse than one that says it could not.
  if (!document.hasFocus()) {
    window.focus();
    if (!document.hasFocus()) return false;
  }

  if (window.isSecureContext && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch { /* denied or unavailable - fall through */ }
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.contentEditable = 'true';
  ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
  document.body.appendChild(ta);
  try {
    const range = document.createRange();
    range.selectNodeContents(ta);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    ta.setSelectionRange(0, text.length);
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    ta.remove();
  }
}

/** Last resort: put the reply under a selection so it can be copied by hand. */
function selectReply(button) {
  const body = button.closest('.turn.assistant')?.querySelector('.body');
  if (!body) return;
  const range = document.createRange();
  range.selectNodeContents(body);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

/**
 * A turn is what a person actually thinks in: something I asked, some work, an
 * answer. The event log is flatter than that - assistant, tool_result,
 * assistant, tool_result - so it gets regrouped here.
 */
function turnsFrom(events) {
  const turns = [];
  let cur = null;
  const start = (user) => {
    cur = { user, steps: [], texts: [], notes: [], files: [], model: null, endedOn: null };
    turns.push(cur);
    return cur;
  };

  for (const e of events) {
    if (e.type === 'user') { start(e); continue; }
    if (!cur) start(null);

    if (e.type === 'assistant') {
      cur.model = e.model || cur.model;
      if (e.text?.trim()) { cur.texts.push(e); cur.endedOn = 'reply'; }
      for (const c of e.toolCalls ?? []) cur.steps.push({ call: c, result: null });
    } else if (e.type === 'tool_result') {
      const step = cur.steps.find((x) => x.call.id === e.callId && !x.result);
      if (step) step.result = e;
      else cur.steps.push({ call: { id: e.callId, name: e.name, args: {} }, result: e });
      cur.endedOn = 'tool';
    } else if (e.type === 'note') {
      cur.notes.push(e);
    } else if (e.type === 'files') {
      cur.files.push(...(e.files ?? []));
    }
  }
  return turns;
}

/**
 * One chip for a whole turn's work.
 *
 * Deliberately not a progress bar: an agent turn has no known length, so a bar
 * would have to invent a denominator and would lie. A chip that pulses while
 * work is happening says the true thing - something is going on - and the
 * colour says how it is going.
 *
 * Green while it is getting somewhere, red only when a failure actually ended
 * the turn: a command that failed and was then worked around is not something
 * to alarm the user about. Amber marks that recovery, because "it worked, but
 * not first try" is worth knowing and is neither of the other two.
 */
function activityChip(turn, key, running) {
  const total = turn.steps.length;
  if (!total) return '';

  const done = turn.steps.filter((s) => s.result).length;
  const failures = turn.steps.filter((s) => s.result && !s.result.ok).length;
  const last = turn.steps[total - 1];
  const endedBadly = !running && last?.result && !last.result.ok;

  // A turn that ran tools and then said nothing is not the same as one that
  // finished and explained itself. Without this it reads as "done, fine,
  // nothing to see" while the answer sits collapsed two taps away.
  const silent = !running && !turn.texts.length;

  const tone = endedBadly ? 'bad' : failures ? 'warn' : silent ? 'warn' : 'ok';
  const label = running
    ? `working · ${esc(last?.call?.name ?? '')}`
    : endedBadly
      ? `stopped on ${esc(last.call.name)}`
      : silent
        ? `${done} step${done === 1 ? '' : 's'} · no summary, output below`
        : failures
          ? `${done} steps · ${failures} recovered`
          : `${done} step${done === 1 ? '' : 's'}`;

  return `<button class="act ${tone}${running ? ' live' : ''}" data-act="${key}">
      <span class="act-dot"></span>
      <span class="act-label">${label}</span>
      <span class="act-at">${clock(turn.steps[0]?.result?.ts ?? turn.user?.ts)}</span>
      <span class="act-caret">${silent ? '▴' : '▾'}</span>
    </button>
    <div class="act-detail" id="act-${key}"${silent ? '' : ' hidden'}>
      ${turn.steps.map((s, i) => toolBlock(s.call, s.result, silent && i === total - 1)).join('')}
    </div>`;
}

/**
 * What one question cost.
 *
 * A backend that streams its own agent loop reports fragments per message and
 * the real total once at the end, flagged. When that flag is present it is the
 * answer; otherwise every message carried its own true figure and they sum.
 */
function turnUsage(turn) {
  const authoritative = turn.texts.find((a) => a.usage?.total)
    ?? [...turn.texts].reverse().find((a) => a.usage?.total);
  if (authoritative) return authoritative.usage;

  return turn.texts.reduce((acc, a) => ({
    input: acc.input + (a.usage?.input ?? 0),
    cached: acc.cached + (a.usage?.cached ?? 0),
    output: acc.output + (a.usage?.output ?? 0),
    ms: acc.ms + (a.usage?.ms ?? 0),
  }), { input: 0, cached: 0, output: 0, ms: 0 });
}

/**
 * Which turns are open.
 *
 * Keyed by the user message's own id rather than a position, because the
 * transcript re-renders on every streamed event and an index-keyed set would
 * silently reassign what the reader had opened. The newest turn is open by
 * default; anything explicitly closed stays closed.
 */
const openedFolds = new Set();
const closedFolds = new Set();

const foldKey = (turn, i) => turn.user?.id ?? `t${i}`;

function foldIsOpen(turn, i, isLast, running) {
  const key = foldKey(turn, i);
  if (running) return true;                    // watch work as it happens
  if (openedFolds.has(key)) return true;
  if (closedFolds.has(key)) return false;
  return isLast;                               // the latest result is what you came back for
}

/** One line describing everything a question set off. */
function foldSummary(turn, running) {
  const steps = turn.steps.length;
  const done = turn.steps.filter((s) => s.result).length;
  const failures = turn.steps.filter((s) => s.result && !s.result.ok).length;
  const last = turn.steps[steps - 1];
  const endedBadly = !running && last?.result && !last.result.ok;
  const silent = !running && steps > 0 && !turn.texts.length;

  // A turn that stopped straight after a tool, with no closing message, is the
  // case that reads as "still going" when it is not. Name it.
  const stoppedShort = !running && turn.endedOn === 'tool';

  const tone = endedBadly ? 'bad' : (failures || silent || stoppedShort) ? 'warn' : 'ok';
  const parts = [];
  if (running) {
    parts.push(`working${last?.call?.name ? ` · ${esc(last.call.name)}` : ''}`);
  } else if (endedBadly) {
    parts.push(`stopped on ${esc(last.call.name)}`);
  } else {
    // "done" first, so the state is the first thing read rather than inferred.
    parts.push(stoppedShort ? 'ended without a summary' : 'done');
    if (turn.texts.length) parts.push(`${turn.texts.length} repl${turn.texts.length === 1 ? 'y' : 'ies'}`);
    if (steps) parts.push(`${done} step${done === 1 ? '' : 's'}`);
    if (failures) parts.push(`${failures} recovered`);
    if (silent) parts.push('output below');
  }
  // A turn that produced nothing at all is not a green outcome.
  const empty = !running && !turn.texts.length && !turn.steps.length;
  return { tone: empty ? 'warn' : tone, text: parts.join(' · ') };
}

function turnHtml(turn, i, running, number, isLast) {
  const key = foldKey(turn, i);
  const open = foldIsOpen(turn, i, isLast, running);
  const bits = [];

  if (turn.user) {
    const u = turnUsage(turn);
    const read = (u.input ?? 0) + (u.cached ?? 0);
    const cost = [];
    if (read) cost.push(`${compact(read)} in`);
    if (u.output) cost.push(`${compact(u.output)} out`);
    if (u.ms > 1500) cost.push(`${(u.ms / 1000).toFixed(0)}s`);

    bits.push(`<div class="turn user">
      <div class="who"><span class="qn">${number}</span> you
        <span class="at">${clock(turn.user.ts)}</span></div>
      <div class="bubble">${esc(turn.user.text)}${
  (turn.user.attachments ?? []).length
    ? `<div class="shots">${turn.user.attachments.map((a) => (a.role === 'document'
      ? `<button class="file-card sent-doc" data-open-file="${esc(a.path)}" data-file-kind="${a.mime === 'application/pdf' ? 'pdf' : 'text'}">
           <span class="file-icon">${a.mime === 'application/pdf' ? '📕' : '📄'}</span>
           <span class="file-meta"><span class="file-name">${esc(a.name)}</span>
           <span class="file-sub">${humanSize(a.bytes ?? 0)}</span></span>
         </button>`
      : `<img src="/api/file?path=${encodeURIComponent(a.path)}" alt="${esc(a.name)}">`)).join('')}</div>`
    : ''}</div>
      ${cost.length ? `<div class="usage turn-cost">${cost.join(' · ')}</div>` : ''}</div>`);
  }

  // Everything the question caused - what was said back and what was run -
  // lives inside one fold, with the step list as a further fold inside it.
  const inner = [];
  for (const [j, a] of turn.texts.entries()) {
    const think = a.thinking ? `<div class="thinking">${esc(a.thinking)}</div>` : '';
    // The markdown source, not the rendered text: code fences and list markers
    // are exactly what makes it worth pasting somewhere else.
    const copyId = `${key}-${j}`;
    copyTexts.set(copyId, a.text);
    inner.push(`<div class="turn assistant">
      <div class="who"><span class="tag">${esc(a.model)}</span>
        ${a.servedModel && a.servedModel !== a.model
          ? `<span class="served">${esc(a.servedModel)}</span>` : ''}
        <span class="at">${clock(a.ts)}</span>
        <button class="copy-reply" data-copy="${esc(copyId)}"
          aria-label="Copy this reply as plain text">copy</button></div>
      ${think}<div class="body">${render(a.text)}</div></div>`);
  }
  inner.push(activityChip(turn, key, running));
  for (const n of turn.notes) {
    const bad = /error|failed|not in models|stopped/i.test(n.text);
    inner.push(`<div class="note${bad ? ' error' : ''}">${esc(n.text)}</div>`);
  }

  const body = inner.join('').trim();
  if (!body) return bits.join('');

  // Files the turn produced, shown as part of the reply rather than filed away
  // somewhere else to be hunted for.
  if (turn.files.length) {
    const seen = new Set();
    const unique = turn.files.filter((f) => !seen.has(f.path) && seen.add(f.path));
    const shown = unique.slice(0, 12);
    bits.push(`<div class="files">
      ${shown.map((f) => `
        <button class="file-card" data-open-file="${esc(f.path)}" data-file-kind="${f.kind}">
          <span class="file-icon">${FILE_ICON[f.kind] ?? '📄'}</span>
          <span class="file-meta">
            <span class="file-name">${esc(f.rel || f.name)}</span>
            <span class="file-sub">${humanSize(f.size)}</span>
          </span>
          <a class="file-dl" href="/api/file?path=${encodeURIComponent(f.path)}&download=1"
             download="${esc(f.name)}" aria-label="Download">⤓</a>
        </button>`).join('')}
      ${unique.length > shown.length
    ? `<div class="dim" style="padding:4px 2px">…and ${unique.length - shown.length} more</div>` : ''}
    </div>`);
  }

  const sum = foldSummary(turn, running);
  bits.push(`<button class="fold ${sum.tone}${running ? ' live' : ''}" data-fold="${esc(key)}">
      <span class="act-dot"></span>
      <span class="fold-label">${sum.text}</span>
      <span class="act-caret">${open ? '▴' : '▾'}</span>
    </button>
    <div class="fold-body" id="fold-${esc(key)}"${open ? '' : ' hidden'}>${body}</div>`);

  return bits.join('');
}

function drawTranscript() {
  const s = cur().session;
  const el = $('transcript');
  if (!s) {
    el.innerHTML = '<div class="empty"><p>nothing open</p><p class="dim">tap ☰ for your apps &amp; sessions</p></div>';
    return;
  }
  if (!s.events.length) {
    el.innerHTML = state.tab === 'monitor'
      ? `<div class="empty"><p>monitoring</p>
         <p class="dim">ask about the view above, or change it</p>
         <p class="dim">"is this current?" · "refresh it" · "show failures too"</p></div>`
      : `<div class="empty"><p>${esc(s.name)}</p><p class="dim">${esc(shortDir(s.projectDir))}</p><p class="dim">say what you want built</p></div>`;
    return;
  }
  const turns = turnsFrom(s.events);
  copyTexts.clear();
  let n = 0;
  el.innerHTML = turns
    .map((t, i) => turnHtml(
      t, i,
      cur().running && i === turns.length - 1,
      t.user ? (n += 1) : n,
      i === turns.length - 1,
    ))
    .join('');
  scrollDown();
}

let pinned = true;
function scrollDown(force = false) {
  const el = $('transcript');
  if (force || pinned) el.scrollTop = el.scrollHeight;
}

// Streaming: append into a scratch turn that is replaced by the real event.
function liveTurn(tab = state.tab) {
  const t = tabs[tab];
  if (!t.live) {
    const div = document.createElement('div');
    div.className = 'turn assistant';
    div.innerHTML = `<div class="who"><span class="tag">${esc(t.session?.model ?? '')}</span></div>
      <div class="thinking" hidden></div><div class="body"></div>`;
    if (tab === state.tab) $('transcript').append(div);
    t.live = div;
  }
  return t.live;
}
function clearLive(tab = state.tab) {
  tabs[tab].live?.remove();
  tabs[tab].live = null;
}

// ---------------------------------------------------------------- session

async function openSession(id) {
  window.cancelDictation?.();
  const session = await api(`/api/sessions/${id}`);
  state.session = session;
  tabs.chat.session = session;
  tabs.monitor.session = null;          // loaded when the tab is first opened
  tabs.monitor.stream?.close();
  tabs.monitor.stream = null;
  localStorage.setItem('lastSession', id);

  clearLive('chat');
  clearLive('monitor');
  setTab('chat');
  listen('chat', id);
  refreshBackground();
  closeSheet();
}

/** The monitoring tab's companion session, created on the server on demand. */
async function ensureMonitorSession() {
  if (tabs.monitor.session) return tabs.monitor.session;
  const companion = await api(`/api/sessions/${state.session.id}/monitor`);
  tabs.monitor.session = companion;
  listen('monitor', companion.id);
  return companion;
}

async function setTab(name) {
  window.cancelDictation?.();
  state.tab = name;
  document.querySelectorAll('.tab').forEach((el) => {
    el.classList.toggle('on', el.dataset.tab === name);
  });

  // The panel exists only in the monitoring tab; the chat tab is just a chat.
  const monitoring = name === 'monitor';
  $('panel').hidden = !monitoring;
  $('panel').classList.toggle('pinned', monitoring);
  document.body.classList.toggle('tab-monitor', monitoring);
  // The monitoring tab is the monitoring view. Its chat is available when
  // wanted rather than permanently occupying a third of the screen.
  document.body.classList.toggle('chat-open', !monitoring || monitorChatOpen);
  $('mon-chat-toggle').hidden = !monitoring;
  $('mon-chat-toggle').textContent = monitorChatOpen ? 'hide chat ▾' : 'chat about this ▴';

  if (monitoring) {
    $('panel-body').hidden = false;
    panelOpen = true;
    $('transcript').innerHTML = '<div class="empty"><p class="dim">loading…</p></div>';
    try {
      await ensureMonitorSession();
    } catch (e) {
      showBanner(e.message);
    }
    startPanelPolling();
  } else {
    panelOpen = false;
    stopPanelPolling();
  }

  drawTranscript();
  paintHeader();
  const t = cur();
  setRunning(t.running, t.startedAt, null, name);
  scrollDown(true);
}

function paintHeader() {
  const s = state.session;
  const t = cur();
  $('title-name').textContent = s ? s.name : 'harness';
  $('title-sub').textContent = s
    ? `${s.model}${s.mode === 'chat' ? ' · chat' : ''} · ${shortDir(s.projectDir)}`
    : 'pick a session';
  $('send').disabled = !t.session;
  $('input').placeholder = idlePlaceholder();
  const model = s && state.models[s.model];
  if (s && s.projectDir === state.home) {
    showBanner('this session is rooted at your home folder — every project is in its scope. Tap 🔧 to give it its own directory.', true);
  } else if (s?.projectDirMissing) {
    showBanner(`${shortDir(s.projectDir)} no longer exists — tap ⚙ to point this session somewhere else`, true);
  } else if (s && model && !model.hasKey) {
    showBanner(`${s.model} has no API key — tap ⚙ to add one`, true);
  } else {
    showBanner('');
  }
}

function showBanner(msg, warn = false) {
  const b = $('banner');
  b.textContent = msg;
  b.hidden = !msg;
  b.classList.toggle('warn', warn);
}

function setRunning(on, startedAt = null, last = null, tab = state.tab) {
  tabs[tab].running = on;
  if (startedAt) tabs[tab].startedAt = startedAt;
  if (tab !== state.tab) return;   // background tab: remember, do not repaint
  $('send').hidden = on;
  $('stop').hidden = !on;
  $('working').hidden = !on;
  $('input').placeholder = on ? 'working — tap stop to interrupt' : idlePlaceholder();
  if (last !== null) setActivity(last);
  if (on) startClock(startedAt); else stopClock();
}

const idlePlaceholder = () => (state.tab === 'monitor'
  ? 'ask about or change the view above…'
  : 'Describe what to build…');

function setActivity(name) {
  $('working-what').textContent = name ? `· ${name}` : '';
}

// A turn can be quiet for a long time. Show that it is alive, and for how long.
let clockFrom = 0;
let clockTimer = null;
function startClock(startedAt) {
  // Anchor on the server's start time so a reload continues the count instead
  // of restarting at zero and implying the turn just began.
  if (startedAt) clockFrom = startedAt;
  else if (!clockTimer) clockFrom = Date.now();
  const tick = () => {
    const s = Math.round((Date.now() - clockFrom) / 1000);
    $('working-time').textContent = s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
  };
  tick();
  clearInterval(clockTimer);
  clockTimer = setInterval(tick, 1000);
}
function stopClock() {
  clearInterval(clockTimer);
  clockTimer = null;
  setActivity('');
}

function listen(tab, id) {
  const t = tabs[tab];
  t.stream?.close();
  const es = new EventSource(`/api/sessions/${id}/events`);
  t.stream = es;

  es.onmessage = (msg) => {
    const p = JSON.parse(msg.data);
    const active = tab === state.tab;

    if (p.kind === 'hello') return setRunning(p.running, p.startedAt, p.last, tab);

    if (p.kind === 'delta') {
      const d = p.delta;
      if (d.kind === 'text') {
        const body = liveTurn(tab).querySelector('.body');
        body.dataset.raw = (body.dataset.raw ?? '') + d.text;
        body.innerHTML = render(body.dataset.raw);
      } else if (d.kind === 'thinking') {
        const el = liveTurn(tab).querySelector('.thinking');
        el.hidden = false;
        el.textContent += d.text;
      } else if (d.kind === 'tool_start') {
        liveTurn(tab).insertAdjacentHTML('beforeend', toolBlock(d.call, null));
        if (active) setActivity(d.call?.name);
      } else if (d.kind === 'tool_end') {
        const el = liveTurn(tab).querySelector(`[data-call="${CSS.escape(d.result.callId)}"] .tool-status`);
        if (el) {
          el.className = `tool-status ${d.result.ok ? 'ok' : 'err'}`;
          el.textContent = d.result.ok ? 'ok' : 'failed';
        }
      }
      if (active) scrollDown();
      return;
    }

    if (p.kind === 'event') {
      clearLive(tab);
      t.session?.events.push(p.event);
      if (active) drawTranscript();
      if (p.event.type === 'assistant') setRunning(true, t.startedAt || null, null, tab);
      return;
    }

    if (p.kind === 'error' && active) showBanner(p.error);

    if (p.kind === 'done') {
      clearLive(tab);
      setRunning(false, null, null, tab);
      t.startedAt = null;
      if (active) {
        // Repaint: the fold and chip were rendered in their running state and
        // would otherwise keep claiming "working" after the turn had ended.
        drawTranscript();
        refreshState();
        refreshPanel();
        refreshBackground();
      }
      // A monitoring turn usually just changed the panel; show the result.
      if (tab === 'monitor') refreshPanel();
    }
  };
  es.onerror = () => {}; // EventSource reconnects on its own
}

async function send() {
  if (window.dictationBusy?.()) return showBanner('Finish or cancel dictation before sending.');
  const text = $('input').value.trim();
  const shots = pendingShots.filter((a) => !a.uploading && a.path);
  if (!text && !shots.length) return;
  if (pendingShots.some((a) => a.uploading)) return showBanner('still uploading — one moment');
  const t = cur();
  if (!t.session) return showBanner('open a session first — tap ☰');
  if (t.running) return showBanner('a turn is already running — tap stop to interrupt it');
  $('input').value = '';
  $('input').style.height = 'auto';
  setRunning(true);
  showBanner('');
  pinned = true;
  try {
    await api(`/api/sessions/${t.session.id}/send`, {
      method: 'POST',
      body: JSON.stringify({
        text,
        attachments: shots.map(({ name, path, mime, bytes }) => ({ name, path, mime, bytes })),
      }),
    });
    pendingShots = [];
    paintPending();
  } catch (e) {
    setRunning(false);
    showBanner(e.message);
  }
}

// ------------------------------------------------------------------ menus

async function refreshState() {
  const s = await api('/api/state');
  // Assign field by field. A blanket Object.assign once let the server's
  // `running` (an array of busy session ids) land on top of the local boolean
  // of the same name - and [] is truthy, so send() silently refused forever.
  state.models = s.models ?? {};
  state.default = s.default;
  state.sessions = s.sessions ?? [];
  state.home = s.home ?? '';
  state.busy = s.running ?? [];
  state.beacons = s.beacons ?? {};
  if (s.error) showBanner(s.error);
  // Keep the composer honest if the page was reloaded mid-turn.
  // Each tab is a different session, so each is reconciled against its own
  // status rather than the chat session's.
  for (const [name, tab] of Object.entries(tabs)) {
    if (!tab.session) continue;
    const id = tab.session.id;
    const info = s.turns?.[id];
    const busy = state.busy.includes(id);

    // We thought a turn was running and the server says it is not: the end of
    // it was missed, so the transcript is short by however much arrived after
    // the connection dropped. Re-read it rather than showing a stale tail.
    if (tab.running && !busy) {
      api(`/api/sessions/${id}`).then((fresh) => {
        tab.session = fresh;
        if (name === 'chat') state.session = fresh;
        if (name === state.tab) drawTranscript();
      }).catch(() => {});
    }

    setRunning(busy, info?.startedAt ?? null, info?.last ?? null, name);
  }
  return s;
}

function modelOptions(selected) {
  return Object.values(state.models)
    .map((m) => `<option value="${esc(m.alias)}"${m.alias === selected ? ' selected' : ''}>
      ${esc(m.label ?? m.alias)}${m.hasKey ? '' : ' — no key'}</option>`)
    .join('');
}

/**
 * What a session is doing, at a glance in the browser.
 *
 * Three states worth telling apart: working, waiting on you, and working but
 * gone quiet for longer than its backend should. The last one matters because
 * an agent CLI can be silent for a long time legitimately, so it is reported as
 * "quiet" rather than as a failure.
 */
function sessionStatus(s) {
  // `busy`, not `running`: a local boolean already owns that name here.
  const running = (state.busy ?? []).includes(s.id);
  if (!running) return '<span class="sstat waiting">waiting for you</span>';
  const b = state.beacons?.[s.id];
  if (b?.stalled) {
    return `<span class="sstat quiet">quiet ${Math.round(b.silentMs / 60000)}m</span>`;
  }
  const what = b?.lastActivity ? String(b.lastActivity).split(/\s+/)[0] : '';
  return `<span class="sstat thinking"><span class="pulse"></span>thinking${what ? ` · ${esc(what)}` : ''}</span>`;
}

// Sessions and apps live in one view (see appsSheet). Kept as an alias so
// existing callers that refresh the list still work.
async function sessionsSheet() { return appsSheet(); }

let draft = {};   // survives a detour through the directory browser

async function newSheet() {
  // Each session gets its own folder. Inheriting the previous session's meant
  // one session started at ~ and every later one did too, so every project on
  // the machine was in scope for all of them.
  const dir = draft.dir ?? '';
  // An app owns its directory. Attaching a session to one is the normal case:
  // several sessions on one app, each free to run a different model.
  let appList = [];
  try { appList = (await api('/api/apps')).apps; } catch { /* apps are optional */ }
  openSheet(`<h2>New session</h2>
    <label>App</label>
    <select id="n-app">
      <option value="">— no app, just a folder —</option>
      ${appList.map((a) => `<option value="${esc(a.id)}"${draft.appId === a.id ? ' selected' : ''}>${esc(a.name)}</option>`).join('')}
    </select>
    <label>Name</label><input id="n-name" placeholder="what you're building" />
    <label>Model</label><select id="n-model">${modelOptions(state.default)}</select>
    <label>Mode</label>
    <select id="n-mode">
      <option value="agent">agent — tools, works in a project folder</option>
      <option value="chat">chat — plain Q&amp;A, no tools</option>
    </select>
    <label>Project directory — its own folder, created if new</label>
    <div class="row"><input id="n-dir" value="${esc(dir)}" placeholder="~/Projects/…" spellcheck="false" />
    <button class="ghost" id="n-browse" style="flex:0 0 92px">browse</button></div>
    <label>Extra instructions (optional)</label><textarea id="n-sys"></textarea>
    <div class="actions"><button class="ghost" id="n-cancel">cancel</button>
    <button class="primary" id="n-go">create</button></div>`);

  if (draft.name) $('n-name').value = draft.name;
  if (draft.system) $('n-sys').value = draft.system;
  if (draft.dir) $('n-dir').value = draft.dir;
  if (draft.model && state.models[draft.model]) $('n-model').value = draft.model;
  if (draft.mode) $('n-mode').value = draft.mode;

  const keep = () => {
    draft = {
      name: $('n-name').value, system: $('n-sys').value,
      dir: $('n-dir').value, model: $('n-model').value, mode: $('n-mode').value,
    };
  };

  // Suggest a folder from the name, and stop as soon as the user edits it.
  let dirTouched = Boolean(draft.dir);
  const slug = (t) => t.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const suggest = () => {
    if (dirTouched) return;
    const name = slug($('n-name').value) || 'session';
    $('n-dir').value = `${state.home}/Projects/${name}`;
  };
  $('n-name').addEventListener('input', suggest);
  $('n-dir').addEventListener('input', () => { dirTouched = true; });
  suggest();

  // The app's directory wins, and the field goes read-only so the two cannot
  // disagree about where the session is working.
  const applyApp = () => {
    const app = appList.find((a) => a.id === $('n-app').value);
    if (app) {
      $('n-dir').value = app.dir;
      $('n-dir').disabled = true;
      dirTouched = true;
    } else {
      $('n-dir').disabled = false;
    }
  };
  $('n-app').addEventListener('change', applyApp);
  applyApp();

  $('n-cancel').onclick = () => { draft = {}; sessionsSheet(); };
  $('n-browse').onclick = () => {
    keep();
    browseSheet($('n-dir').value, (chosen) => { draft.dir = chosen; newSheet(); });
  };
  $('n-go').onclick = async () => {
    const chosen = $('n-dir').value.trim().replace(/\/+$/, '');
    if (!chosen && !$('n-app').value) return showBanner('give this session a folder of its own');
    if (chosen === state.home.replace(/\/+$/, '')) {
      return showBanner('that is your home folder — give the session its own directory, or everything on the machine is in scope');
    }
    const session = await api('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({
        appId: $('n-app').value || null,
        name: $('n-name').value.trim() || 'untitled',
        model: $('n-model').value,
        mode: $('n-mode').value,
        projectDir: chosen,
        system: $('n-sys').value,
      }),
    });
    draft = {};
    openSession(session.id);
  };
}

async function forkSheet() {
  openSheet(`<h2>Fork onto another model</h2>
    <p class="dim">Copies the whole history so the second model starts from identical context.</p>
    <label>Model</label><select id="f-model">${modelOptions(state.session.model)}</select>
    <div class="actions"><button class="ghost" id="f-cancel">cancel</button>
    <button class="primary" id="f-go">fork</button></div>`);
  $('f-cancel').onclick = sessionsSheet;
  $('f-go').onclick = async () => {
    const twin = await api(`/api/sessions/${state.session.id}/fork`, {
      method: 'POST',
      body: JSON.stringify({ model: $('f-model').value }),
    });
    openSession(twin.id);
  };
}

async function browseSheet(start, pick, back = newSheet) {
  const load = async (p) => {
    let d;
    try {
      d = await api(`/api/dirs?path=${encodeURIComponent(p)}`);
    } catch (err) {
      openSheet(`<h2>Choose directory</h2><p class="dim">could not read that folder: ${esc(err.message)}</p>
        <div class="actions"><button class="ghost" id="b-home">go home</button></div>`);
      $('b-home').onclick = () => load(state.home);
      return;
    }
    openSheet(`<h2>Choose directory</h2><p class="dim">${esc(shortDir(d.path))}</p>
      ${d.note ? `<p class="dim warn-text">${esc(d.note)}</p>` : ''}
      ${d.parent ? `<div class="item" data-go="${esc(d.parent)}"><div class="grow"><div class="t">../</div></div></div>` : ''}
      ${d.dirs.map((x) => `<div class="item" data-go="${esc(x.path)}"><div class="grow"><div class="t">${esc(x.name)}/</div></div></div>`).join('')}
      <div class="actions"><button class="ghost" id="b-new">new folder</button>
      <button class="primary" id="b-use">use this one</button></div>
      <div class="actions"><button class="ghost" id="b-cancel">cancel</button></div>`);
    $('sheet').querySelectorAll('[data-go]').forEach((el) => { el.onclick = () => load(el.dataset.go); });
    $('b-cancel').onclick = back;
    $('b-use').onclick = () => pick(d.path);
    $('b-new').onclick = async () => {
      const name = prompt('New folder name');
      if (!name?.trim()) return;
      const made = await api('/api/dirs', {
        method: 'POST',
        body: JSON.stringify({ parent: d.path, name: name.trim() }),
      });
      load(made.path);
    };
  };
  load(start || state.home);
}

async function settingsSheet() {
  await refreshState();
  const session = cur().session;
  openSheet(`
    ${session ? `<h2>This ${state.tab === 'monitor' ? 'monitoring ' : ''}session</h2>
      <label>Name</label>
      <div class="row"><input id="s-name" value="${esc(session.name ?? '')}" spellcheck="false" />
      <button class="ghost" id="s-rename" style="flex:0 0 80px">rename</button></div>
      <label>Model — tap to switch, history carries over</label>
      <div id="s-models">${Object.values(state.models).map((m) => `
        <div class="item${m.alias === session.model ? ' on' : ''}" data-switch="${esc(m.alias)}">
          <div class="grow"><div class="t">${esc(m.label ?? m.alias)}</div>
          <div class="s">${esc(m.provider)} · ${esc(m.model)}</div></div>
          ${m.alias === session.model
            ? '<span class="pill ready">in use</span>'
            : `<span class="pill ${m.hasKey ? '' : 'missing'}">${m.hasKey ? 'switch' : 'no key'}</span>`}
        </div>`).join('')}</div>
      <label>Mode</label>
      <div class="row">
        <button class="ghost${session.mode !== 'chat' ? ' on' : ''}" data-mode="agent">agent</button>
        <button class="ghost${session.mode === 'chat' ? ' on' : ''}" data-mode="chat">chat</button>
      </div>
      <p class="dim">chat sends no tools and no project rules — much less context, better for plain questions.</p>
      <label>Project folder${session.projectDirMissing ? ' — missing!' : ''}</label>
      <div class="row"><input id="s-dir" value="${esc(session.projectDir)}" spellcheck="false" />
      <button class="ghost" id="s-browse" style="flex:0 0 92px">browse</button></div>
      <div class="actions"><button class="ghost" id="s-dir-save">save folder</button></div>
      <label>Reference folders (read-only)</label>
      <textarea id="s-readable" spellcheck="false"
        placeholder="/Users/you/Projects/otherProject">${esc((session.readableDirs ?? []).join('\n'))}</textarea>
      <p class="dim">Let the agent’s file tools read reference material outside this project without granting write access. Enter one folder per line; leave empty if unneeded.</p>
      <div class="actions"><button class="ghost" id="s-readable-save">save folders</button></div>
      <label>Git</label>
      <div id="s-git"><p class="dim">checking…</p></div>
      ${(() => {
        const m = state.models[session.model];
        if (!m?.softLimitTokens) return '';
        const on = Boolean(session.allowLongContext);
        return `<label>Context band</label>
          <div class="row">
            <button class="ghost${on ? '' : ' on'}" data-band="off">stay under ${compact(m.softLimitTokens)}</button>
            <button class="ghost${on ? ' on' : ''}" data-band="on">allow up to ${compact(m.contextTokens)}</button>
          </div>
          <p class="dim">${esc(m.label ?? m.alias)} reprices the whole request past
            ${compact(m.softLimitTokens)} input tokens — roughly double. Staying under trims old tool
            output to fit; allowing it keeps everything and pays the higher rate.</p>`;
      })()}` : ''}

    <h3>Harness</h3>
    <div class="rowlinks">
      <button class="rowlink" id="h-files"><span>Files</span><span class="chev">›</span></button>
      <button class="rowlink" id="h-models"><span>Models &amp; keys</span><span class="chev">›</span></button>
      <button class="rowlink" id="h-voice"><span>Voice setup</span><span class="chev">›</span></button>
      <button class="rowlink" id="h-notify"><span>Notifications</span><span class="chev">›</span></button>
      <button class="rowlink" id="h-email"><span>Email</span><span class="chev">›</span></button>
    </div>
    <div class="actions"><button class="primary" id="s-close">done</button></div>`);

  $('h-files').onclick = () => filesSheet();
  $('h-models').onclick = modelsSheet;
  $('h-voice').onclick = () => window.voiceSetup();
  $('h-notify').onclick = notifySheet;
  $('h-email').onclick = emailSheet;

  $('s-close').onclick = closeSheet;
  if ($('s-rename')) {
    const rename = async () => {
      const name = $('s-name').value.trim();
      if (!name || name === session.name) return;
      const updated = await api(`/api/sessions/${session.id}`, {
        method: 'PATCH', body: JSON.stringify({ name }),
      });
      const t = cur();
      t.session = updated;
      if (state.tab === 'chat') state.session = updated;
      paintHeader();
      await refreshState();          // the ☰ list shows the old name otherwise
      showBanner(`renamed to "${name}"`);
    };
    $('s-rename').onclick = rename;
    // Enter should work too; a phone keyboard offers "done", not a button.
    $('s-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); rename(); } });
  }
  if ($('s-readable-save')) {
    $('s-readable-save').onclick = async () => {
      const dirs = $('s-readable').value.split('\n').map((x) => x.trim()).filter(Boolean);
      const updated = await api(`/api/sessions/${session.id}`, {
        method: 'PATCH', body: JSON.stringify({ readableDirs: dirs }),
      });
      const t = cur();
      t.session = updated;
      if (state.tab === 'chat') state.session = updated;
      showBanner(dirs.length ? `${dirs.length} folder(s) readable` : 'no extra folders');
      settingsSheet();
    };
  }
  if ($('s-git')) paintGit(session);
  $('sheet').querySelectorAll('[data-band]').forEach((el) => {
    el.onclick = async () => {
      const t = cur();
      try {
        const updated = await api(`/api/sessions/${t.session.id}`, {
          method: 'PATCH', body: JSON.stringify({ allowLongContext: el.dataset.band === 'on' }),
        });
        t.session = updated;
        if (state.tab === 'chat') state.session = updated;
        settingsSheet();
      } catch (e) { showBanner(`couldn't change that: ${e.message}`, true); }
    };
  });
  $('sheet').querySelectorAll('[data-mode]').forEach((el) => {
    el.onclick = async () => {
      const t = cur();
      const want = el.dataset.mode;
      // Always send it — never trust local state to decide "already there", or a
      // stale copy could block the very switch the user is trying to make.
      // A silently-failed PATCH used to leave the toggle looking stuck — the
      // reported "switched to chat and couldn't switch back". Show what happened.
      el.textContent = '…';
      try {
        const updated = await api(`/api/sessions/${t.session.id}`, {
          method: 'PATCH', body: JSON.stringify({ mode: want }),
        });
        t.session = updated;
        if (state.tab === 'chat') state.session = updated;
        paintHeader();
        settingsSheet();
      } catch (e) {
        showBanner(`couldn't switch mode: ${e.message} — tap again`, true);
        settingsSheet();   // restore the buttons to their true state
      }
    };
  });
  $('sheet').querySelectorAll('[data-switch]').forEach((el) => {
    el.onclick = async () => {
      await setSessionModel(el.dataset.switch);
      settingsSheet();   // redraw so "in use" moves to the model just chosen
    };
  });
  if ($('s-browse')) {
    $('s-browse').onclick = () => browseSheet($('s-dir').value, async (chosen) => {
      await setProjectDir(chosen);
      settingsSheet();
    }, settingsSheet);
    $('s-dir-save').onclick = () => setProjectDir($('s-dir').value.trim()).then(settingsSheet);
  }
}

/**
 * Harness-wide settings, one sheet each.
 *
 * These used to sit inline below the session settings, which made one very
 * long scroll — and put a second full list of model cards under the first,
 * which was mistaken for the switcher more than once. Each now has its own
 * sheet with a way back, so the main settings stay one screen.
 */
const backToSettings = '<div class="actions"><button class="ghost" id="sub-back">‹ settings</button></div>';

async function modelsSheet() {
  await refreshState();
  const rows = Object.values(state.models).map((m) => `
    <div class="item" data-model="${esc(m.alias)}">
      <div class="grow"><div class="t">${esc(m.label ?? m.alias)}</div>
      <div class="s">${esc(m.provider)} · ${esc(m.model)}</div></div>
      <span class="pill ${m.hasKey ? 'ready' : 'missing'}">${m.hasKey ? (m.keySource ?? 'ready') : 'no key'}</span>
    </div>`).join('');
  openSheet(`<h2>Models &amp; keys</h2>
    <p class="dim">Keys and endpoints — this edits what a model <em>is</em>, for every session. To switch what this session uses, go back and tap a model there.</p>
    ${rows}${backToSettings}`);
  $('sub-back').onclick = settingsSheet;
  $('sheet').querySelectorAll('[data-model]').forEach((el) => {
    el.onclick = () => modelSheet(el.dataset.model);
  });
}

function notifySheet() {
  openSheet(`<h2>Notifications</h2>
    <p class="dim">When a turn finishes, and when one stalls.</p>
    <div id="s-notify"><p class="dim">loading…</p></div>${backToSettings}`);
  $('sub-back').onclick = settingsSheet;
  paintNotify();
}

function emailSheet() {
  openSheet(`<h2>Email</h2>
    <p class="dim">Any session can email you with <span class="mono">send_email</span> — useful when a long run finishes and you are not watching.</p>
    <div id="s-email"><p class="dim">loading…</p></div>${backToSettings}`);
  $('sub-back').onclick = settingsSheet;
  paintEmail();
}

/**
 * Switch the open session's model.
 *
 * Both `state.session` and the tab's own copy have to be replaced: they started
 * as the same object, so assigning only one leaves the transcript rendering
 * against a stale session that still claims the old model.
 */
async function setSessionModel(alias) {
  const t = cur();
  if (!t.session || alias === t.session.model) return;

  const updated = await api(`/api/sessions/${t.session.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ model: alias }),
  });
  t.session = updated;
  if (state.tab === 'chat') state.session = updated;
  drawTranscript();
  paintHeader();
}

/** Outbound email — one harness-wide setting, used by every session's send_email tool. */
async function paintEmail() {
  const box = $('s-email');
  if (!box) return;
  let e;
  try { e = await api('/api/email'); } catch (err) { box.innerHTML = `<p class="dim">${esc(err.message)}</p>`; return; }

  box.innerHTML = `
    <label>Send to</label>
    <input id="em-to" value="${esc(e.to ?? '')}" placeholder="you@example.com" inputmode="email" spellcheck="false" />
    <label>Resend API key ${e.hasKey ? '<span class="pill ready">saved</span>' : '<span class="pill missing">none</span>'}</label>
    <input id="em-key" value="" placeholder="${e.hasKey ? 'saved — type to replace' : 're_...'}" spellcheck="false" />
    <div class="actions">
      <button class="ghost" id="em-save">save</button>
      <button class="ghost" id="em-test"${e.hasKey && e.to ? '' : ' disabled'}>send test</button>
    </div>
    <p class="dim" id="em-msg"></p>`;

  $('em-save').onclick = async () => {
    const body = { to: $('em-to').value.trim() };
    // An empty box means "leave it alone", not "erase the key".
    const key = $('em-key').value.trim();
    if (key) body.apiKey = key;
    $('em-msg').textContent = 'saving…';
    try { await api('/api/email', { method: 'POST', body: JSON.stringify(body) }); paintEmail(); }
    catch (err) { $('em-msg').textContent = err.message; }
  };
  $('em-test').onclick = async () => {
    $('em-msg').textContent = 'sending…';
    try {
      const r = await api('/api/email/test', { method: 'POST' });
      $('em-msg').textContent = `sent to ${r.to}`;
    } catch (err) { $('em-msg').textContent = err.message; }
  };
}

/** Notification settings — global, not per session. */
async function paintNotify() {
  const box = $('s-notify');
  if (!box) return;
  let n;
  try { n = await api('/api/notify'); } catch (e) { box.innerHTML = `<p class="dim">${esc(e.message)}</p>`; return; }

  const kinds = [
    ['sms', 'text (SMS)'],
    ['webhook', 'push (ntfy)'],
    ['messages', 'iMessage'],
    ['command', 'shell command'],
  ];
  box.innerHTML = `
    <div class="row">
      <button class="ghost${n.enabled ? '' : ' on'}" data-notify="off">off</button>
      <button class="ghost${n.enabled ? ' on' : ''}" data-notify="on">on</button>
    </div>
    <div class="row" style="margin-top:8px">
      ${kinds.map(([k, label]) =>
    `<button class="ghost${n.kind === k ? ' on' : ''}" data-nkind="${k}">${label}</button>`).join('')}
    </div>
    ${n.kind === 'sms'
      ? `<label>Phone number</label>
         <input id="n-to" value="${esc(n.to ?? '')}" placeholder="8045551234" inputmode="tel" />
         <label>Gmail address it sends from</label>
         <input id="n-guser" value="${esc(n.gmailUser ?? '')}" placeholder="you@gmail.com" inputmode="email" spellcheck="false" />
         <label>Gmail app password ${n.hasGmailPass ? '<span class="pill ready">saved</span>' : '<span class="pill missing">none</span>'}</label>
         <input id="n-gpass" value="" placeholder="${n.hasGmailPass ? 'saved — type to replace' : 'abcd efgh ijkl mnop'}" spellcheck="false" />
         <p class="dim">Not your Google password — make one at myaccount.google.com → Security → App passwords. It only works if 2-step verification is on.</p>
         <label>Carrier</label>
         <select id="n-carrier">
           <option value="">try every carrier (first test)</option>
           ${['verizon', 'att', 'tmobile', 'googlefi', 'sprint', 'uscellular', 'cricket', 'boost', 'mint', 'visible']
    .map((c) => `<option value="${c}"${n.carrier === c ? ' selected' : ''}>${c}</option>`).join('')}
         </select>
         <p class="dim">This sends mail to your carrier's SMS gateway, so it arrives as a normal text. Nothing on the Mac is involved — it works with the lid shut.</p>`
      : n.kind === 'messages'
        ? `<label>Phone number</label><input id="n-to" value="${esc(n.to ?? '')}" placeholder="+18045551234" inputmode="tel" />
           <p class="dim">Sends through the Messages app, which needs the Mac's screen awake — it cannot work with the lid shut.</p>`
      : n.kind === 'webhook'
        ? `<label>Webhook URL</label><input id="n-url" value="${esc(n.url ?? '')}" placeholder="https://ntfy.sh/your-topic" spellcheck="false" inputmode="url" />`
        : `<label>Command (<span class="mono">{{message}}</span> is substituted)</label>
           <input id="n-cmd" value="${esc(n.command ?? '')}" spellcheck="false" />`}
    <label>Only for turns longer than</label>
    <div class="row">
      ${[0, 60, 300].map((sec) =>
    `<button class="ghost${(n.minSeconds ?? 60) === sec ? ' on' : ''}" data-nmin="${sec}">${sec === 0 ? 'always' : `${sec / 60} min`}</button>`).join('')}
    </div>
    <div class="actions">
      <button class="ghost" id="n-save">save</button>
      <button class="ghost" id="n-test">send a test</button>
    </div>`;

  const patch = async (body) => { await api('/api/notify', { method: 'POST', body: JSON.stringify(body) }); paintNotify(); };
  box.querySelectorAll('[data-notify]').forEach((el) => {
    el.onclick = () => patch({ enabled: el.dataset.notify === 'on' });
  });
  box.querySelectorAll('[data-nkind]').forEach((el) => {
    el.onclick = () => patch({ kind: el.dataset.nkind });
  });
  box.querySelectorAll('[data-nmin]').forEach((el) => {
    el.onclick = () => patch({ minSeconds: Number(el.dataset.nmin) });
  });

  const fields = () => ({
    ...($('n-to') ? { to: $('n-to').value.trim() } : {}),
    ...($('n-url') ? { url: $('n-url').value.trim() } : {}),
    ...($('n-cmd') ? { command: $('n-cmd').value.trim() } : {}),
  });

  // The Gmail credential belongs with the other secrets, not in notify.json,
  // so it is saved through the email settings instead.
  const saveGmail = async () => {
    if (!$('n-guser')) return;
    const body = { gmailUser: $('n-guser').value.trim(), carrier: $('n-carrier').value };
    // An empty box means "leave it alone", never "erase the password".
    const pass = $('n-gpass').value.trim();
    if (pass) body.gmailPass = pass;
    await api('/api/email', { method: 'POST', body: JSON.stringify(body) });
  };
  $('n-save').onclick = async () => { await saveGmail(); await patch(fields()); showBanner('notification settings saved'); };
  $('n-test').onclick = async () => {
    const btn = $('n-test');
    btn.textContent = 'sending…';
    btn.disabled = true;
    try {
      await saveGmail();
      await api('/api/notify', { method: 'POST', body: JSON.stringify(fields()) });
      const r = await api('/api/notify/test', { method: 'POST', body: JSON.stringify({}) });
      showBanner(r.ok ? `sent (${r.via})` : `failed: ${r.reason}`, !r.ok);
    } catch (e) {
      // A thrown request used to leave the button reading "sending…" for good,
      // which is indistinguishable from the thing still being in flight.
      showBanner(`test failed: ${e.message}`, true);
    } finally {
      btn.disabled = false;
      paintNotify();
    }
  };
}

/**
 * Git panel for a session. Shows the repo as it really is, rather than assuming
 * — a missing remote is the usual reason a push silently does nothing.
 */
async function paintGit(session) {
  const box = $('s-git');
  if (!box) return;
  let g;
  try {
    g = await api(`/api/git?session=${encodeURIComponent(session.id)}`);
  } catch (e) {
    box.innerHTML = `<p class="dim warn-text">${esc(e.message)}</p>`;
    return;
  }

  if (!g.repo) {
    box.innerHTML = `<p class="dim">${esc(shortDir(session.projectDir))} is not a git repository.</p>
      <label>Connect a remote (creates the repo)</label>
      <div class="row"><input id="g-remote" placeholder="git@github.com:you/repo.git" spellcheck="false" />
      <button class="ghost" id="g-connect" style="flex:0 0 80px">connect</button></div>`;
  } else {
    const on = Boolean(g.enabled);
    box.innerHTML = `
      <div class="row">
        <button class="ghost${on ? '' : ' on'}" data-git="off">don't push</button>
        <button class="ghost${on ? ' on' : ''}" data-git="on">push after each turn</button>
      </div>
      <p class="dim">branch <span class="mono">${esc(g.branch ?? '?')}</span>
        · ${g.changed} uncommitted
        · ${g.remote ? `remote <span class="mono">${esc(g.remote)}</span>` : '<span class="warn-text">no remote</span>'}</p>
      ${g.lastCommit ? `<p class="dim">last: <span class="mono">${esc(g.lastCommit)}</span></p>` : '<p class="dim">no commits yet</p>'}
      ${g.remote ? '' : `<label>Add a remote</label>
        <div class="row"><input id="g-remote" placeholder="git@github.com:you/repo.git" spellcheck="false" />
        <button class="ghost" id="g-connect" style="flex:0 0 80px">connect</button></div>`}
      <div id="g-vis"></div>
      <div class="actions"><button class="ghost" id="g-now">commit &amp; push now</button></div>`;
  }

  box.querySelectorAll('[data-git]').forEach((el) => {
    el.onclick = async () => {
      const updated = await api(`/api/sessions/${session.id}`, {
        method: 'PATCH', body: JSON.stringify({ gitPush: el.dataset.git === 'on' }),
      });
      const t = cur();
      t.session = updated;
      if (state.tab === 'chat') state.session = updated;
      paintGit(updated);
    };
  });
  if ($('g-connect')) {
    $('g-connect').onclick = async () => {
      const remote = $('g-remote').value.trim();
      if (!remote) return;
      const r = await api('/api/git/connect', {
        method: 'POST', body: JSON.stringify({ session: session.id, remote }),
      });
      if (!r.ok) showBanner(r.error);
      paintGit(session);
    };
  }
  if ($('g-vis')) {
    api('/api/git/visibility', { method: 'POST', body: JSON.stringify({ session: session.id }) })
      .then((v) => {
        const box = $('g-vis');
        if (!box) return;
        if (!v.ok) { box.innerHTML = `<p class="dim">${esc(v.reason)}</p>`; return; }
        const pub = v.visibility === 'public';
        box.innerHTML = `<p class="dim"><span class="mono">${esc(v.repo)}</span> is
            <strong class="${pub ? 'warn-text' : ''}">${esc(v.visibility)}</strong></p>
          <div class="row">
            <button class="ghost${pub ? '' : ' on'}" data-vis="private">private</button>
            <button class="ghost${pub ? ' on' : ''}" data-vis="public">public</button>
          </div>`;
        box.querySelectorAll('[data-vis]').forEach((el) => {
          el.onclick = async () => {
            const want = el.dataset.vis;
            if (want === v.visibility) return;
            if (want === 'public'
              && !confirm(`Make ${v.repo} public? Anyone will be able to read it and its full history.`)) return;
            const r = await api('/api/git/visibility', {
              method: 'POST', body: JSON.stringify({ session: session.id, visibility: want }),
            });
            showBanner(r.ok ? `${v.repo} is now ${r.visibility}` : `could not change: ${r.reason}`);
            paintGit(session);
          };
        });
      })
      .catch(() => {});
  }
  if ($('g-now')) {
    $('g-now').onclick = async () => {
      $('g-now').textContent = 'working…';
      const r = await api('/api/git/push', { method: 'POST', body: JSON.stringify({ session: session.id }) });
      showBanner(r.skipped === 'no changes' ? 'nothing to commit'
        : !r.ok ? `git: ${r.error}`
          : r.pushed ? `pushed ${r.files.length} files · ${r.sha}`
            : `committed ${r.sha} — not pushed: ${r.reason}`);
      paintGit(session);
    };
  }
}

/** Repoint a session at another folder, creating it if it isn't there. */
async function setProjectDir(dir) {
  if (!dir) return;
  state.session = await api(`/api/sessions/${state.session.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ projectDir: dir }),
  });
  state.session = await api(`/api/sessions/${state.session.id}`);
  paintHeader();
}

function modelSheet(alias) {
  const m = state.models[alias];
  openSheet(`<h2>${esc(m.label ?? alias)}</h2>
    <p class="dim">${esc(m.provider)} · key falls back to $${esc(m.keyEnv || 'none')}</p>
    <label>API key ${m.keySource === 'stored' ? '(a key is already saved)' : ''}</label>
    <input id="m-key" type="password" placeholder="paste key — leave blank to keep" autocomplete="off" />
    <label>Model id</label><input id="m-model" value="${esc(m.model ?? '')}" spellcheck="false" />
    <label>Base URL ${m.provider === 'anthropic' ? '(leave blank for Anthropic default)' : ''}</label>
    <input id="m-base" value="${esc(m.baseUrl ?? '')}" placeholder="https://…/v1" spellcheck="false" inputmode="url" />
    <div class="actions"><button class="ghost" id="m-discover">what does it serve?</button></div>
    <div id="m-list"></div>
    <div class="actions"><button class="ghost" id="m-cancel">back</button>
    <button class="primary" id="m-save">save</button></div>`);

  $('m-discover').onclick = async () => {
    $('m-list').innerHTML = '<p class="dim">asking the endpoint…</p>';
    // Save whatever is typed first, so it queries the endpoint and key on screen.
    const typed = $('m-key').value.trim();
    if (typed) await api('/api/models/key', { method: 'POST', body: JSON.stringify({ alias, apiKey: typed }) });
    await api('/api/models/patch', {
      method: 'POST',
      body: JSON.stringify({ alias, patch: { baseUrl: $('m-base').value.trim() } }),
    });

    const r = await api('/api/models/discover', { method: 'POST', body: JSON.stringify({ alias }) });
    if (!r.ok) {
      $('m-list').innerHTML = `<p class="dim warn-text">${esc(r.error)}</p>`;
      return;
    }
    $('m-list').innerHTML = `<p class="dim">${r.count} models available — tap one</p>`
      + r.models.map((id) => `<div class="item" data-pick="${esc(id)}"><div class="grow">
          <div class="t">${esc(id)}</div></div></div>`).join('');
    $('m-list').querySelectorAll('[data-pick]').forEach((el) => {
      el.onclick = () => { $('m-model').value = el.dataset.pick; };
    });
  };

  $('m-cancel').onclick = settingsSheet;
  $('m-save').onclick = async () => {
    const key = $('m-key').value.trim();
    if (key) await api('/api/models/key', { method: 'POST', body: JSON.stringify({ alias, apiKey: key }) });
    await api('/api/models/patch', {
      method: 'POST',
      body: JSON.stringify({
        alias,
        patch: { model: $('m-model').value.trim(), baseUrl: $('m-base').value.trim() },
      }),
    });
    modelsSheet();
  };
}

// ------------------------------------------------------------------- wire

// ------------------------------------------------- this session's own panel
//
// Nothing here runs until the button is pressed. Pressing it kicks off a
// sample; while it stays open it refreshes; closing it stops everything. An
// empty result is a real answer - "nothing is running" - not a failure.

let panelTimer = null;
let panelOpen = false;
let monitorChatOpen = false;

const agoText = (ms) => {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
};

/**
 * The panel is the agent's to own. If it has authored a view for this session,
 * that view is the whole surface; otherwise the built-in default below runs so
 * the tab is never empty before anyone has asked for anything.
 */
function renderActivity(d) {
  // Two parts, always. The first is whatever the user chose to see; the second
  // is what is actually running, which they did not choose and should not have
  // to go looking for.
  const view = d.samples.find((sm) => sm.role === 'view');
  const monitors = d.samples.filter((sm) => sm.role !== 'view');

  const yours = view
    ? (view.error
      ? `<div class="mon"><div class="mon-head">${esc(view.label)}
           <span class="tool-status err">error</span></div>
         <pre class="mon-pre">${esc(view.error)}</pre></div>`
      : `<div class="mon-html view">${view.html || ''}</div>`)
    : monitors.length
      ? monitors.map(monitorCard).join('')
      : `<p class="dim mon-empty">Nothing set up yet — open the chat and ask for
          whatever you want to watch: a log, a count, a progress table.</p>`;

  const procs = d.procs.length
    ? d.procs.map(procCard).join('')
    : '<p class="dim mon-empty">No processes running for this session.</p>';

  return `
    <section class="mon-section">
      <h4 class="mon-title">Your view</h4>
      ${d.running ? `<div class="mon"><div class="mon-head">this session
        <span class="tool-status pending">turn running${d.startedAt ? ` · ${agoText(Date.now() - d.startedAt)}` : ''}</span>
        </div></div>` : ''}
      ${yours}
    </section>
    <section class="mon-section">
      <h4 class="mon-title">Background processes${d.procs.length ? ` · ${d.procs.length}` : ''}</h4>
      ${procs}
    </section>`;
}

function monitorCard(sm) {
  if (sm.kind === 'panel') {
    return `<div class="mon"><div class="mon-head">${esc(sm.label)}</div>
      <div class="mon-html">${sm.error ? esc(sm.error) : (sm.html || '')}</div></div>`;
  }
  const badge = sm.kind === 'process'
    ? `<span class="tool-status ${sm.count ? 'ok' : 'err'}">${sm.count ? `${sm.count} running` : 'stopped'}</span>`
    : sm.ok === false ? '<span class="tool-status err">error</span>' : '';
  return `<div class="mon"><div class="mon-head">${esc(sm.label)} ${badge}</div>
    <pre class="mon-pre">${esc(sm.error ?? sm.text ?? '')}</pre></div>`;
}

function procCard(p) {
  const idle = p.cpu < 0.5;
  return `<div class="mon">
    <div class="mon-head">${esc(p.command.split(' ').slice(0, 3).join(' '))}
      <span class="tool-status ${idle ? 'pending' : 'ok'}">${p.cpu.toFixed(0)}% cpu</span></div>
    <pre class="mon-pre">pid ${p.pid} · ${esc(p.etime)} · ${p.rssMb} MB${p.detached ? ' · detached' : ''}${p.log ? `\nlog: ${esc(p.log)}` : ''}</pre>
    <div class="row" style="padding:0 10px 10px">
      ${p.log ? `<button class="ghost" data-log="${esc(p.log)}">watch log</button>` : ''}
      <button class="ghost" data-stop="${p.pid}">stop</button>
    </div></div>`;
}

function defaultActivity(d) {
  const bits = [];

  if (d.running) {
    bits.push(`<div class="mon"><div class="mon-head">this session
      <span class="tool-status pending">turn running${d.startedAt ? ` · ${agoText(Date.now() - d.startedAt)}` : ''}</span>
      </div></div>`);
  }

  for (const sm of d.samples) {
    if (sm.kind === 'panel') {
      bits.push(`<div class="mon"><div class="mon-head">${esc(sm.label)}</div>
        <div class="mon-html">${sm.error ? esc(sm.error) : (sm.html || '')}</div></div>`);
      continue;
    }
    const badge = sm.kind === 'process'
      ? `<span class="tool-status ${sm.count ? 'ok' : 'err'}">${sm.count ? `${sm.count} running` : 'stopped'}</span>`
      : sm.ok === false ? '<span class="tool-status err">error</span>' : '';
    bits.push(`<div class="mon"><div class="mon-head">${esc(sm.label)} ${badge}</div>
      <pre class="mon-pre">${esc(sm.error ?? sm.text ?? '')}</pre></div>`);
  }

  for (const p of d.procs) {
    const idle = p.cpu < 0.5;
    bits.push(`<div class="mon">
      <div class="mon-head">${esc(p.command.split(' ').slice(0, 3).join(' '))}
        <span class="tool-status ${idle ? 'pending' : 'ok'}">${p.cpu.toFixed(0)}% cpu</span></div>
      <pre class="mon-pre">pid ${p.pid} · ${esc(p.etime)} · ${p.rssMb} MB${p.detached ? ' · detached' : ''}${p.log ? `\nlog: ${esc(p.log)}` : ''}</pre>
      <div class="row" style="padding:0 10px 10px">
        ${p.log ? `<button class="ghost" data-log="${esc(p.log)}">watch log</button>` : ''}
        <button class="ghost" data-stop="${p.pid}">stop</button>
      </div></div>`);
  }

  if (!bits.length) {
    bits.push(`<p class="dim" style="padding:4px 2px 10px">Nothing running for this session.
      ${d.projectDir ? `Watching <span class="mono">${esc(shortDir(d.projectDir))}</span>.` : ''}
      <br>Ask below to change what this shows.</p>`);
  }
  return bits.join('');
}

async function refreshPanel() {
  if (!panelOpen || !state.session) return;
  let d;
  try {
    // Always the chat session's id: the companion watches it, not itself.
    d = await api(`/api/activity?session=${encodeURIComponent(state.session.id)}`);
  } catch (e) {
    $('panel-body').innerHTML = `<p class="dim">${esc(e.message)}</p>`;
    return;
  }

  $('panel-body').innerHTML = renderActivity(d);

  $('panel-body').querySelectorAll('[data-log]').forEach((el) => {
    el.onclick = () => watchLog(el.dataset.log);
  });
  $('panel-body').querySelectorAll('[data-stop]').forEach((el) => {
    el.onclick = async () => {
      if (!confirm(`Stop process ${el.dataset.stop}?`)) return;
      await api('/api/procs/stop', { method: 'POST', body: JSON.stringify({ pid: Number(el.dataset.stop) }) });
      refreshPanel();
    };
  });
}

function startPanelPolling() {
  clearInterval(panelTimer);
  refreshPanel();
  panelTimer = setInterval(refreshPanel, 3000);
}
function stopPanelPolling() {
  clearInterval(panelTimer);
  panelTimer = null;
}


// -------------------------------------------------------- background jobs

let jobsTimer = null;

/** Tail a log, refreshing on a timer, pinned to the newest line. */
async function watchLog(file) {
  const name = file.split('/').pop();
  const load = async () => {
    let text;
    try {
      text = await (await fetch(`/api/file?path=${encodeURIComponent(file)}&tail=1`)).text();
    } catch (e) {
      text = `could not read: ${e.message}`;
    }
    const pre = $('log-body');
    if (!pre) return;
    pre.textContent = text;
    pre.scrollTop = pre.scrollHeight;   // newest output is what matters
  };

  openSheet(`<h2>${esc(name)}</h2>
    <pre id="log-body" class="file-body">loading…</pre>
    <div class="actions">
      <button class="ghost" id="l-auto">auto-refresh</button>
      <button class="primary" id="l-close">done</button>
    </div>`);
  await load();

  $('l-auto').onclick = () => {
    if (jobsTimer) {
      clearInterval(jobsTimer);
      jobsTimer = null;
      $('l-auto').textContent = 'auto-refresh';
    } else {
      jobsTimer = setInterval(load, 3000);
      $('l-auto').textContent = 'stop auto-refresh';
    }
  };
  const done = () => { clearInterval(jobsTimer); jobsTimer = null; };
  $('l-close').onclick = () => { done(); closeSheet(); };
}

$('mon-chat-toggle').onclick = () => {
  monitorChatOpen = !monitorChatOpen;
  document.body.classList.toggle('chat-open', monitorChatOpen);
  $('mon-chat-toggle').textContent = monitorChatOpen ? 'hide chat ▾' : 'chat about this ▴';
  if (monitorChatOpen) { drawTranscript(); scrollDown(true); $('input').focus(); }
};

document.querySelectorAll('.tab').forEach((el) => {
  el.onclick = () => {
    if (!state.session) return showBanner('open a session first — tap ☰');
    setTab(el.dataset.tab);
  };
});


// ---------------------------------------------------------------- usage

const WINDOW_LABEL = {
  five_hour: 'last 5 hours', seven_day: 'last 7 days', month: 'last 30 days', all: 'all time',
};

const num = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));
const dur = (ms) => {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
};
const untilReset = (at) => {
  if (!at) return '';
  const mins = Math.round((at - Date.now()) / 60000);
  if (mins <= 0) return 'resetting';
  return mins < 60 ? `resets in ${mins}m` : `resets in ${Math.floor(mins / 60)}h ${mins % 60}m`;
};

function bar(pct, tone = '') {
  const clamped = Math.max(0, Math.min(1, pct));
  return `<div class="bar"><div class="bar-fill ${tone}" style="width:${(clamped * 100).toFixed(1)}%"></div></div>`;
}

let usageWindow = 'seven_day';


/**
 * Apps: the durable things. A session comes and goes; an app has a directory, a
 * repository, a port and two addresses, and is still here after a reboot.
 *
 * Both addresses are always shown together. The harness's tailscaled runs with
 * userspace networking, so the laptop cannot resolve its own .ts.net name —
 * showing only the tailnet link leaves you unable to open your own app on the
 * machine running it.
 */
// Which apps are expanded to show their sessions. Survives re-renders.
const expandedApps = new Set();

/**
 * One home for everything: apps at the top level, each expandable to the
 * sessions working on it. There is no separate sessions list — a session is
 * reached by opening its app. Sessions not tied to an app are grouped at the end.
 */
let lastAppsData = null;   // cached so expand/collapse re-renders without refetching

async function appsSheet() {
  let d;
  try { d = await api('/api/apps'); }
  catch (e) { return openSheet(`<h2>Apps</h2><p class="dim">${esc(e.message)}</p>`); }
  await refreshState();
  lastAppsData = d;
  renderAppsSheet(d);
}

/**
 * Draw the apps-and-sessions sheet from already-fetched data.
 *
 * Toggling an app's expander used to call appsSheet(), which re-hit /api/apps —
 * and that endpoint probes every app over HTTP, reads the Tailscale table and
 * asks gh for visibility, so a tap felt sluggish. Expansion is a pure view
 * change, so it re-renders from the cached data instead.
 */
function renderAppsSheet(d) {
  const sessionsFor = (id) => state.sessions.filter((x) => x.appId === id);
  const known = new Set(d.apps.map((a) => a.id));
  const loose = state.sessions.filter((x) => !x.appId || !known.has(x.appId));

  const sessionRow = (sn) => `
    <div class="item sub-session${sn.id === state.session?.id ? ' on' : ''}" data-open="${esc(sn.id)}">
      <div class="grow"><div class="t">${esc(sn.name)} ${sessionStatus(sn)}</div>
        <div class="s">${esc(sn.model)} · ${sn.turns} turns</div></div>
      <button class="x" data-fork="${esc(sn.id)}" title="Fork onto another model">⑂</button>
      <button class="x" data-rename="${esc(sn.id)}" title="Rename">✎</button>
      <button class="x" data-del="${esc(sn.id)}" title="Delete">×</button>
    </div>`;

  const appCard = (a) => {
    const mine = sessionsFor(a.id);
    const open = expandedApps.has(a.id);
    const label = !a.running ? 'stopped' : a.reachable ? 'running' : 'starting';
    const links = [];
    if (a.urls?.phone) links.push(`<a href="${esc(a.urls.phone)}" target="_blank" rel="noopener">phone: ${esc(a.urls.phone)}</a>`);
    if (a.urls?.desktop) links.push(`<a href="${esc(a.urls.desktop)}" target="_blank" rel="noopener">laptop: ${esc(a.urls.desktop)}</a>`);

    // The built-in Harness app is special: it *is* the running harness, its
    // sessions edit the harness itself, and it cannot be started, edited as a
    // record, or deleted.
    const meta = a.builtin
      ? `<div class="s dim">the harness itself — sessions here edit its code</div>`
      : `<div class="s">${esc(shortDir(a.dir))}${a.start ? '' : ' · no start command'}</div>
         ${a.running && a.reachable && links.length ? `<div class="s app-links">${links.join('<br>')}</div>` : ''}`;
    const pill = a.builtin
      ? '<span class="pill self">self</span>'
      : `<span class="pill ${a.reachable ? 'ready' : a.running ? 'warm' : ''}">${label}</span>`;
    const actions = a.builtin
      ? `<div class="app-actions">
          <button class="x" data-harness-restart="1" title="Restart the harness to apply edits made to its own code">⟳</button>
        </div>`
      : `<div class="app-actions">
          <button class="x" data-app-run="${esc(a.id)}" title="${a.running ? 'Stop' : a.start ? 'Start' : 'No start command yet — tap to add one'}">${a.running ? '■' : '▶'}</button>
          <button class="x" data-app-edit="${esc(a.id)}" title="Edit app">✎</button>
        </div>`;

    return `<div class="app-block${open ? ' open' : ''}${a.builtin ? ' builtin' : ''}">
      <div class="item app-card" data-app-toggle="${esc(a.id)}">
        <span class="app-caret">${open ? '▾' : '▸'}</span>
        <div class="grow">
          <div class="t">${esc(a.name)} ${pill}</div>
          ${meta}
          <div class="s dim">${mine.length} session${mine.length === 1 ? '' : 's'}</div>
        </div>
        ${actions}
      </div>
      ${open ? `<div class="app-sessions">
        ${mine.length ? mine.map(sessionRow).join('') : '<p class="dim sub-empty">no sessions yet</p>'}
        <button class="ghost sub-new" data-new-in="${esc(a.id)}">+ new session in ${esc(a.name)}</button>
      </div>` : ''}
    </div>`;
  };

  const appsHtml = d.apps.length ? d.apps.map(appCard).join('') : '<p class="dim">no apps yet — an app is a project you can launch, open and work on</p>';
  const looseHtml = loose.length
    ? `<h3>Not in an app</h3>${loose.map(sessionRow).join('')}`
    : '';

  openSheet(`<h2>Apps &amp; sessions</h2>${appsHtml}${looseHtml}
    <div class="actions">
      <button class="primary" id="app-new">new app</button>
      <button class="ghost" id="sess-new">new session</button>
    </div>`);

  // --- app-level actions ---
  $('app-new').onclick = () => appEditSheet(null);
  $('sess-new').onclick = () => { draft = {}; newSheet(); };
  $('sheet').querySelectorAll('[data-app-toggle]').forEach((el) => {
    el.onclick = (e) => {
      if (e.target.closest('.app-actions') || e.target.closest('a')) return;  // buttons/links are their own
      const id = el.dataset.appToggle;
      if (expandedApps.has(id)) expandedApps.delete(id); else expandedApps.add(id);
      renderAppsSheet(d);   // instant: no refetch, just redraw
    };
  });
  $('sheet').querySelectorAll('[data-app-edit]').forEach((el) => {
    el.onclick = (e) => { e.stopPropagation(); appEditSheet(d.apps.find((a) => a.id === el.dataset.appEdit)); };
  });
  $('sheet').querySelectorAll('[data-app-run]').forEach((el) => {
    el.onclick = (e) => { e.stopPropagation(); runApp(d.apps.find((a) => a.id === el.dataset.appRun), el); };
  });
  $('sheet').querySelectorAll('[data-harness-restart]').forEach((el) => {
    el.onclick = async (e) => {
      e.stopPropagation();
      // Two taps: restarting drops every live connection for a few seconds.
      if (el.dataset.armed !== '1') {
        el.dataset.armed = '1'; el.textContent = '⟳?'; el.title = 'Tap again to restart the harness';
        setTimeout(() => { el.dataset.armed = ''; el.textContent = '⟳'; }, 3000);
        return;
      }
      el.disabled = true; el.textContent = '…';
      try {
        await api('/api/harness/restart', { method: 'POST' });
        showBanner('restarting the harness — back in a few seconds…');
        // Poll until it answers again, then reload so the new code is what runs.
        const started = Date.now();
        const tick = async () => {
          try { await fetch('/api/state', { cache: 'no-store' }); location.reload(); }
          catch { if (Date.now() - started < 30_000) setTimeout(tick, 700); else showBanner('the harness did not come back — check server.log in its data folder', true); }
        };
        setTimeout(tick, 1500);
      } catch (err) { showBanner(err.message, true); el.disabled = false; el.textContent = '⟳'; }
    };
  });
  $('sheet').querySelectorAll('[data-new-in]').forEach((el) => {
    el.onclick = () => { draft = { appId: el.dataset.newIn }; newSheet(); };
  });

  // --- session-level actions ---
  $('sheet').querySelectorAll('[data-open]').forEach((el) => {
    el.onclick = (e) => {
      if (e.target.dataset.del || e.target.dataset.rename || e.target.dataset.fork) return;
      openSession(el.dataset.open);
    };
  });
  $('sheet').querySelectorAll('[data-fork]').forEach((el) => {
    el.onclick = async (e) => { e.stopPropagation(); await openSession(el.dataset.fork); forkSheet(); };
  });
  $('sheet').querySelectorAll('[data-rename]').forEach((el) => {
    el.onclick = async (e) => {
      e.stopPropagation();
      const id = el.dataset.rename;
      const current = state.sessions.find((x) => x.id === id)?.name ?? '';
      const name = prompt('Rename session', current);
      if (!name?.trim() || name === current) return;
      await api(`/api/sessions/${id}`, { method: 'PATCH', body: JSON.stringify({ name: name.trim() }) });
      if (state.session?.id === id) {
        const fresh = await api(`/api/sessions/${id}`);
        tabs.chat.session = fresh; state.session = fresh; paintHeader();
      }
      appsSheet();
    };
  });
  $('sheet').querySelectorAll('[data-del]').forEach((el) => {
    el.onclick = async (e) => {
      e.stopPropagation();
      const id = el.dataset.del;
      if (!confirm('Delete this session?')) return;
      await api(`/api/sessions/${id}`, { method: 'DELETE' });
      if (state.session?.id === id) { state.session = null; drawTranscript(); paintHeader(); }
      appsSheet();
    };
  });
}

/** Start or stop an app, with clear feedback. Shared by the app card. */
async function runApp(app, el) {
  if (!app.running && !app.start?.trim()) {
    showBanner(`${app.name} has no start command yet — add one here, then tap ▶`, true);
    appEditSheet(app);
    return;
  }
  if (el) { el.disabled = true; el.textContent = '…'; }
  showBanner(app.running ? `stopping ${app.name}…` : `starting ${app.name}…`);
  try {
    const r = await api(`/api/apps/${app.id}/${app.running ? 'stop' : 'start'}`, { method: 'POST' });
    if (r.unconfirmed) showBanner(`${app.name} did not confirm it stopped — something is still holding its port`, true);
    else if (r.launchdRemoved?.length) showBanner(`${app.name} stopped — also unregistered its background service so it stays down`);
    else if (app.running) showBanner(`${app.name} stopped`);
    else {
      const fresh = (await api('/api/apps')).apps.find((x) => x.id === app.id);
      if (fresh?.reachable) showBanner(`${app.name} is running — laptop ${fresh.urls.desktop}${fresh.urls.phone ? ` · phone ${fresh.urls.phone}` : ''}`);
      else showBanner(`${app.name} was launched but is not answering yet — check its log (✎ → view log) if it doesn't come up`, true);
    }
  } catch (e) { showBanner(e.message, true); }
  appsSheet();
}

/**
 * GitHub visibility for one app, inside its edit sheet.
 *
 * Read on open so it reflects the true state on GitHub, not a guess. Making a
 * repo public is hard to undo, so that direction takes a second, deliberate
 * tap rather than a single one.
 */
async function paintAppVisibility(app) {
  const box = $('ap-vis');
  if (!box) return;
  let v;
  try { v = await api(`/api/apps/${app.id}/git`); }
  catch (e) { box.innerHTML = `<p class="dim">${esc(e.message)}</p>`; return; }
  if (!v.ok) {
    box.innerHTML = `<p class="dim">${esc(v.reason || 'visibility unavailable')} — is <span class="mono">gh</span> signed in?</p>`;
    return;
  }
  const isPublic = v.visibility === 'public';
  box.innerHTML = `
    <div class="row">
      <button class="ghost${isPublic ? '' : ' on'}" data-setvis="private">🔒 private</button>
      <button class="ghost${isPublic ? ' on' : ''}" data-setvis="public">🌐 public</button>
    </div>
    <p class="dim">${isPublic
      ? 'Anyone can see this repository.'
      : 'Only you can see this repository.'} <a href="${esc(v.url)}" target="_blank" rel="noopener">${esc(v.repo)}</a></p>`;

  box.querySelectorAll('[data-setvis]').forEach((el) => {
    el.onclick = async () => {
      const want = el.dataset.setvis;
      if (want === v.visibility) return;
      // Public is the irreversible-feeling direction; confirm it explicitly.
      if (want === 'public' && el.dataset.armed !== '1') {
        el.dataset.armed = '1';
        el.textContent = '🌐 tap again to make public';
        setTimeout(() => { el.dataset.armed = ''; el.textContent = '🌐 public'; }, 3000);
        return;
      }
      box.innerHTML = '<p class="dim">changing…</p>';
      try {
        const r = await api(`/api/apps/${app.id}/visibility`, { method: 'POST', body: JSON.stringify({ visibility: want }) });
        showBanner(r.ok ? `${app.name} is now ${want} on GitHub` : `couldn't change: ${r.reason}`, !r.ok);
      } catch (e) { showBanner(e.message, true); }
      paintAppVisibility(app);
    };
  });
}

function appEditSheet(app = null, draft = null) {
  const existing = Boolean(app?.id);
  const a = draft ?? app ?? { name: '', dir: '', start: '', repo: '' };

  openSheet(`<h2>${existing ? 'Edit app' : 'New app'}</h2>
    <label>Name</label><input id="ap-name" value="${esc(a.name ?? '')}" spellcheck="false" placeholder="what you're building" />
    <label>Folder${existing ? '' : ' — made for you from the name'}</label>
    <div class="row"><input id="ap-dir" value="${esc(a.dir ?? '')}" spellcheck="false" ${existing ? 'disabled' : ''} />
      ${existing ? '' : '<button class="ghost" id="ap-browse" style="flex:0 0 80px">browse</button>'}</div>
    <label>Start command</label>
    <input id="ap-start" value="${esc(a.start ?? '')}" spellcheck="false" placeholder="npm run dev" />
    <p class="dim">Runs in the app's folder with <span class="mono">PORT</span> set${existing ? ` to ${app.port}` : ' to the port this app is given'}.</p>
    <label>Repository (optional)</label>
    <input id="ap-repo" value="${esc(a.repo ?? '')}" spellcheck="false" placeholder="git@github.com:you/app.git" />
    ${existing && a.repo ? `<label>GitHub visibility</label>
      <div id="ap-vis"><p class="dim">checking…</p></div>` : ''}
    <div class="actions">
      <button class="primary" id="ap-save">${existing ? 'save' : 'create app'}</button>
      <button class="ghost" id="ap-back">back</button>
      ${existing ? '<button class="ghost" id="ap-log">view log</button><button class="ghost" id="ap-del">delete</button>' : ''}
    </div>`);

  const values = () => ({
    name: $('ap-name').value, dir: $('ap-dir').value,
    start: $('ap-start').value, repo: $('ap-repo').value,
  });

  // Every app gets its own folder under ~/Projects without the user typing a
  // path. Typing in the field yourself stops the suggestion taking over.
  if (!existing) {
    let touched = Boolean(a.dir);
    const slugify = (t) => t.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const suggest = () => {
      if (touched) return;
      const name = slugify($('ap-name').value);
      $('ap-dir').value = name ? `${state.home}/Projects/${name}` : '';
    };
    $('ap-name').addEventListener('input', suggest);
    $('ap-dir').addEventListener('input', () => { touched = true; });
    suggest();
    $('ap-browse').onclick = () => browseSheet($('ap-dir').value || `${state.home}/Projects`,
      (chosen) => appEditSheet(app, { ...values(), dir: chosen }),
      () => appEditSheet(app, values()));
  }

  $('ap-back').onclick = appsSheet;
  if ($('ap-vis')) paintAppVisibility(app);

  if ($('ap-log')) $('ap-log').onclick = async () => {
    const text = await (await fetch(`/api/apps/${app.id}/log`)).text();
    openSheet(`<h2>Log — ${esc(app.name)}</h2><pre class="log">${esc(text.slice(-8000) || '(empty)')}</pre>`
      + `<div class="actions"><button class="ghost" id="lb">back</button></div>`);
    $('lb').onclick = () => appEditSheet(app);
  };
  if ($('ap-del')) $('ap-del').onclick = () => appDeleteSheet(app);
  $('ap-save').onclick = async () => {
    const v = values();
    const body = { name: v.name.trim(), start: v.start.trim(), repo: v.repo.trim() || null };
    if (!body.name && !existing) return showBanner('give the app a name');
    try {
      if (existing) await api(`/api/apps/${app.id}`, { method: 'PATCH', body: JSON.stringify(body) });
      else await api('/api/apps', { method: 'POST', body: JSON.stringify({ ...body, dir: v.dir.trim() }) });
      appsSheet();
    } catch (e) { showBanner(e.message, true); }
  };
}


/**
 * Deleting an app, with the consequences spelled out.
 *
 * Removing the record is cheap and reversible — recreate the app and point it
 * at the same folder. Deleting the folder is neither, so it is off by default,
 * named in full, and needs a second tap that says what it is about to erase.
 */
async function appDeleteSheet(app) {
  let mine = [];
  try {
    await refreshState();
    mine = state.sessions.filter((x) => x.appId === app.id);
  } catch { /* the counts are a courtesy, not a gate */ }

  openSheet(`<h2>Delete ${esc(app.name)}</h2>
    <p class="dim">Stopping it, retiring its Tailscale address and discarding its log happens either way.</p>
    <label>Also delete</label>
    <div class="item">
      <label class="grow"><input type="checkbox" id="del-files" />
        the folder <span class="mono">${esc(shortDir(app.dir))}</span> and everything in it</label>
    </div>
    <div class="item">
      <label class="grow"><input type="checkbox" id="del-sessions" ${mine.length ? '' : 'disabled'} />
        ${mine.length ? `its ${mine.length} session${mine.length === 1 ? '' : 's'} and their transcripts` : 'no sessions are attached'}</label>
    </div>
    <p class="dim" id="del-warn"></p>
    <div class="actions">
      <button class="ghost" id="del-cancel">cancel</button>
      <button class="primary danger" id="del-go">delete app</button>
    </div>`);

  const warn = () => {
    const f = $('del-files').checked;
    const s2 = $('del-sessions').checked;
    $('del-warn').textContent = f || s2
      ? `This cannot be undone. ${[f ? shortDir(app.dir) : null, s2 ? `${mine.length} transcript${mine.length === 1 ? '' : 's'}` : null].filter(Boolean).join(' and ')} will be erased.`
      : 'The folder stays on disk; only the harness forgets the app.';
    $('del-go').textContent = f || s2 ? 'delete permanently' : 'remove from harness';
  };
  $('del-files').onchange = warn;
  $('del-sessions').onchange = warn;
  warn();

  $('del-cancel').onclick = () => appEditSheet(app);
  $('del-go').onclick = async () => {
    const f = $('del-files').checked;
    const s2 = $('del-sessions').checked;
    // A second tap for the irreversible half, because this is a phone and the
    // first one is easy to hit by accident.
    if ((f || s2) && $('del-go').dataset.armed !== '1') {
      $('del-go').dataset.armed = '1';
      $('del-go').textContent = 'tap again to erase';
      return;
    }
    $('del-go').disabled = true;
    try {
      const r = await api(`/api/apps/${app.id}?files=${f ? 1 : 0}&sessions=${s2 ? 1 : 0}`, { method: 'DELETE' });
      // Report what actually happened rather than assuming it all worked.
      const bits = [];
      if (r.stopped === false) bits.push('it would not confirm it stopped');
      if (r.dirError) bits.push(`the folder was kept: ${r.dirError}`);
      if (f && r.dir) bits.push('folder deleted');
      if (r.removedSessions?.length) bits.push(`${r.removedSessions.length} session(s) deleted`);
      if (bits.length) showBanner(`${r.name}: ${bits.join(' · ')}`, Boolean(r.dirError || r.stopped === false));
      appsSheet();
    } catch (e) {
      showBanner(e.message, true);
      $('del-go').disabled = false;
    }
  };
}

async function usageSheet() {
  let d;
  try {
    d = await api(`/api/usage?window=${usageWindow}`);
  } catch (e) {
    return openSheet(`<h2>Usage</h2><p class="dim">${esc(e.message)}</p>`);
  }

  const money = (n) => (n >= 1 ? `$${n.toFixed(2)}` : n > 0 ? `$${n.toFixed(3)}` : '$0');
  const spend = d.models.reduce((n, m) => n + (m.cost || 0), 0);

  /**
   * One card per model, all the same weight.
   *
   * Only some backends report a limit. Both subscription CLIs send real
   * window utilisation — Claude Code down its stream, Codex via the rollout
   * file its turn leaves behind — while a metered API has no ceiling to show.
   * Rather than inventing a percentage for the ones that do not publish one,
   * each card says what is actually known about it.
   */
  const card = (m) => {
    const p = d.provider?.[m.alias];
    const windows = p?.windows ?? [];

    let limit;
    if (windows.length) {
      limit = windows.map((w) => `
        <div class="meter">
          <div class="meter-head"><span>${esc(WINDOW_LABEL[w.name] ?? w.name)}</span>
            <span class="mono">${(w.pct * 100).toFixed(w.pct < 0.1 ? 1 : 0)}%</span></div>
          ${bar(w.pct, w.pct > 0.9 ? 'hot' : w.pct > 0.7 ? 'warm' : '')}
          <div class="s">${esc(untilReset(w.resetsAt))}</div>
        </div>`).join('');
    } else if (m.provider === 'codex-cli' || m.provider === 'claude-cli') {
      limit = '<p class="s">Plan limits apply — the figure arrives with this model\'s next turn.</p>';
    } else if (m.limit) {
      limit = `<div class="meter">
        <div class="meter-head"><span>${m.limit.kind === 'cost' ? 'budget' : 'token limit'}</span>
          <span class="mono">${(m.limit.pct * 100).toFixed(0)}%</span></div>
        ${bar(m.limit.pct, m.limit.pct > 0.9 ? 'hot' : m.limit.pct > 0.7 ? 'warm' : '')}</div>`;
    } else {
      limit = '<p class="s">Metered — no ceiling. You pay per token.</p>';
    }

    const cachedShare = m.input ? Math.min(100, Math.round((m.cached / m.input) * 100)) : 0;
    return `<div class="item usage-card">
      <div class="tool-head" style="padding:0">
        <span class="t" style="flex:1">${esc(m.label)}</span>
        <span class="spend-amt">${m.cost > 0 ? money(m.cost) : m.turns ? 'no charge' : '—'}</span>
      </div>
      <div class="s">${esc(m.provider)} · ${m.turns} turns · ${num(m.input)} in (${cachedShare}% cached) · ${num(m.output)} out</div>
      ${limit}
    </div>`;
  };

  // Used first, then the rest — but every card is the same size and shape.
  const ordered = [...d.models].sort((a, b) => b.turns - a.turns);

  openSheet(`<h2>Usage</h2>
    <div class="row" style="margin-bottom:12px">
      ${d.windows.map((w) => `<button class="ghost win${w === d.window ? ' on' : ''}" data-win="${w}">${esc(WINDOW_LABEL[w] ?? w)}</button>`).join('')}
    </div>
    ${ordered.map(card).join('')}
    <p class="dim">${money(spend)} metered spend in this window. Subscription models bill against
      their plan instead, so they show no charge.</p>
    <div class="actions"><button class="primary" id="u-close">done</button></div>`);

  $('u-close').onclick = closeSheet;
  $('sheet').querySelectorAll('[data-win]').forEach((el) => {
    el.onclick = () => { usageWindow = el.dataset.win; usageSheet(); };
  });
}

$('usage').onclick = usageSheet;

// ------------------------------------------------------------- file browser

const humanSize = (n) => {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
};

const FILE_ICON = { image: '🖼', text: '📄', pdf: '📕', other: '📦' };

let filesAt = null;   // remembered so reopening lands where you left off

async function filesSheet(start) {
  const where = start ?? filesAt ?? state.session?.projectDir ?? state.home;
  let d;
  try {
    d = await api(`/api/files?path=${encodeURIComponent(where)}`);
  } catch (e) {
    openSheet(`<h2>Files</h2><p class="dim">${esc(e.message)}</p>
      <div class="actions"><button class="ghost" id="f-home">go home</button></div>`);
    $('f-home').onclick = () => filesSheet(state.home);
    return;
  }
  filesAt = d.path;

  const rows = [
    d.parent ? `<div class="item" data-dir="${esc(d.parent)}"><div class="grow"><div class="t">../</div></div></div>` : '',
    ...d.dirs.map((x) => `<div class="item" data-dir="${esc(x.path)}">
        <div class="grow"><div class="t">📂 ${esc(x.name)}</div></div></div>`),
    ...d.files.map((f) => `<div class="item" data-file="${esc(f.path)}" data-kind="${f.kind}">
        <div class="grow"><div class="t">${FILE_ICON[f.kind]} ${esc(f.name)}</div>
        <div class="s">${humanSize(f.size)}</div></div></div>`),
  ].join('');

  openSheet(`<h2>Files</h2>
    <p class="dim">${esc(shortDir(d.path))}</p>
    ${d.note ? `<p class="dim warn-text">${esc(d.note)}</p>` : ''}
    ${rows || '<p class="dim">empty folder</p>'}
    <div class="actions">
      <button class="ghost" id="f-back">‹ settings</button>
      ${state.session ? '<button class="ghost" id="f-proj">project folder</button>' : ''}
      <button class="primary" id="f-close">done</button>
    </div>`);

  $('f-close').onclick = closeSheet;
  $('f-back').onclick = settingsSheet;
  if ($('f-proj')) $('f-proj').onclick = () => filesSheet(state.session.projectDir);
  $('sheet').querySelectorAll('[data-dir]').forEach((el) => {
    el.onclick = () => filesSheet(el.dataset.dir);
  });
  $('sheet').querySelectorAll('[data-file]').forEach((el) => {
    el.onclick = () => viewFile(el.dataset.file, el.dataset.kind);
  });
}

async function viewFile(file, kind) {
  const name = file.split('/').pop();
  const src = `/api/file?path=${encodeURIComponent(file)}`;
  const back = `<div class="actions"><button class="ghost" id="v-back">back</button>
    <button class="primary" id="v-close">done</button></div>`;

  if (kind === 'image') {
    openSheet(`<h2>${esc(name)}</h2>
      <img src="${src}" alt="${esc(name)}" style="width:100%;border:1px solid var(--line);border-radius:10px" />
      ${back}`);
  } else if (kind === 'pdf') {
    // iOS Safari will not inline a PDF in a sheet; open it in its own tab.
    openSheet(`<h2>${esc(name)}</h2>
      <p class="dim"><a href="${src}" target="_blank" rel="noopener" style="color:var(--accent)">open ${esc(name)}</a></p>
      ${back}`);
  } else {
    let text;
    try {
      text = await (await fetch(src)).text();
    } catch (e) {
      text = `could not read: ${e.message}`;
    }
    openSheet(`<h2>${esc(name)}</h2>
      <pre class="file-body">${esc(text)}</pre>${back}`);
  }

  $('v-back').onclick = () => filesSheet(filesAt);
  $('v-close').onclick = closeSheet;
}


// --------------------------------------------------------- laptop's screen

$('menu').onclick = sessionsSheet;
$('gear').onclick = settingsSheet;
function paintPending() {
  const box = $('pending');
  box.hidden = pendingShots.length === 0;
  box.innerHTML = pendingShots.map((a, i) => `
    <div class="thumb${a.uploading ? ' busy' : ''}">
      ${a.preview ? `<img src="${a.preview}" alt="">` : ''}
      <button class="drop" data-drop-shot="${i}" aria-label="Remove">×</button>
    </div>`).join('');
  box.querySelectorAll('[data-drop-shot]').forEach((el) => {
    el.onclick = () => {
      pendingShots.splice(Number(el.dataset.dropShot), 1);
      paintPending();
    };
  });
}

$('attach').onclick = () => {
  if (!cur().session) return showBanner('open a session first — tap ☰');
  $('pick').click();
};

$('pick').onchange = async () => {
  const files = [...$('pick').files];
  $('pick').value = '';                       // so the same photo can be picked twice
  const session = cur().session;
  if (!session) return;

  for (const file of files) {
    const entry = { name: file.name, uploading: true, preview: URL.createObjectURL(file) };
    pendingShots.push(entry);
    paintPending();
    try {
      const res = await fetch(`/api/sessions/${session.id}/upload`, {
        method: 'POST',
        headers: { 'X-Filename': encodeURIComponent(file.name), 'Content-Type': 'application/octet-stream' },
        body: file,
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `upload failed (${res.status})`);
      Object.assign(entry, body, { uploading: false });
    } catch (e) {
      pendingShots = pendingShots.filter((x) => x !== entry);
      showBanner(e.message);
    }
    paintPending();
  }
};

$('send').onclick = send;
$('stop').onclick = () => api(`/api/sessions/${cur().session.id}/stop`, { method: 'POST' });

$('sheet-back').onclick = (e) => {
  if (e.target.id !== 'sheet-back') return;
  clearInterval(jobsTimer);
  jobsTimer = null;
  closeSheet();
};

$('input').addEventListener('input', (e) => {
  e.target.style.height = 'auto';
  e.target.style.height = `${Math.min(e.target.scrollHeight, window.innerHeight * 0.4)}px`;
});

$('transcript').addEventListener('scroll', () => {
  const el = $('transcript');
  pinned = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
});

// Tap the chip to see what actually ran; tap a step inside it for its output.
$('transcript').addEventListener('click', async (e) => {
  const copy = e.target.closest('.copy-reply');
  if (copy) {
    // Inside the fold header's own click target, so stop it toggling the fold.
    e.stopPropagation();
    const text = copyTexts.get(copy.dataset.copy);
    if (text == null) return;
    const ok = await copyText(text);
    // Say what happened. A copy button that silently failed is the sort of
    // thing you only discover after pasting nothing into the other session.
    // When it cannot copy, it selects the reply instead, so the fallback is
    // one long-press away rather than a dead end.
    if (!ok) selectReply(copy);
    // Kept short: this sits in a header beside the model name on a phone.
    copy.textContent = ok ? 'copied' : 'selected';
    copy.title = ok ? '' : 'Clipboard unavailable here — long-press the highlighted text to copy';
    copy.classList.toggle('failed', !ok);
    setTimeout(() => {
      copy.textContent = 'copy';
      copy.classList.remove('failed');
    }, ok ? 1200 : 3000);
    return;
  }

  const fold = e.target.closest('.fold');
  if (fold) {
    const key = fold.dataset.fold;
    const body = $(`fold-${key}`);
    if (body) {
      body.hidden = !body.hidden;
      // Record the choice explicitly, so a re-render mid-stream cannot quietly
      // reopen something just closed.
      if (body.hidden) { closedFolds.add(key); openedFolds.delete(key); }
      else { openedFolds.add(key); closedFolds.delete(key); }
      fold.querySelector('.act-caret').textContent = body.hidden ? '▾' : '▴';
    }
    return;
  }

  const card = e.target.closest('.file-card');
  if (card) {
    if (e.target.closest('.file-dl')) return;   // let the download link do its job
    viewFile(card.dataset.openFile, card.dataset.fileKind);
    return;
  }

  const chip = e.target.closest('.act');
  if (chip) {
    const detail = $(`act-${chip.dataset.act}`);
    if (detail) {
      detail.hidden = !detail.hidden;
      chip.querySelector('.act-caret').textContent = detail.hidden ? '▾' : '▴';
    }
    return;
  }
  const head = e.target.closest('.tool-head');
  if (!head) return;
  const body = head.parentElement.querySelector('.tool-body');
  if (body) body.hidden = !body.hidden;
});

/**
 * On a phone the stream is not reliable: the radio sleeps, the tab backgrounds,
 * the connection drops on a cell handover. EventSource reconnects itself, but a
 * missed `done` would leave the composer insisting a turn is still running, or
 * worse, showing idle while the laptop is busy. So the truth is re-checked
 * whenever the tab comes back, and on a slow timer while it is open.
 */
async function reconcile() {
  if (document.hidden || !state.session) return;
  try {
    await refreshState();
    await refreshBackground();
  } catch {
    // offline for the moment; the next tick will try again
  }
}

/**
 * Background work belonging to this session, shown even when no turn is running.
 *
 * A turn finishing does not mean the session is idle — an agent can leave a
 * crawler running behind it. Previously that was only visible by opening the
 * monitoring tab, so a quiet chat tab looked like "nothing is happening" when
 * something was.
 */
async function refreshBackground() {
  const bar = $('background');
  if (!bar || !state.session) return;
  if (cur().running) { bar.hidden = true; return; }   // the working bar covers this

  let d;
  try {
    d = await api(`/api/activity?session=${encodeURIComponent(state.session.id)}&raw=1`);
  } catch {
    return;
  }
  const busy = d.procs.filter((p) => p.cpu >= 0.5);
  const idle = d.procs.length - busy.length;

  bar.hidden = d.procs.length === 0;
  if (d.procs.length) {
    const names = d.procs.slice(0, 2).map((p) => p.command.split(' ').slice(0, 2).join(' ')).join(', ');
    bar.innerHTML = `<span class="pulse-dot${busy.length ? '' : ' off'}"></span>
      <span class="bg-label">${d.procs.length} background ${d.procs.length === 1 ? 'process' : 'processes'}
        · ${esc(names)}${idle && !busy.length ? ' · idle' : ''}</span>
      <span class="bg-more">monitoring ›</span>`;
    bar.onclick = () => setTab('monitor');
  }
}

document.addEventListener('visibilitychange', reconcile);
window.addEventListener('online', reconcile);
setInterval(reconcile, 20_000);

(async () => {
  await refreshState();
  const last = localStorage.getItem('lastSession');
  if (last && state.sessions.some((s) => s.id === last)) await openSession(last);
  else paintHeader();
})();
