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
  models: {}, default: null, sessions: [],
  session: null,          // the chat session; identity of the pair
  home: '',
  tab: 'chat',
};

const cur = () => tabs[state.tab];

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
 * A turn is what a person actually thinks in: something I asked, some work, an
 * answer. The event log is flatter than that - assistant, tool_result,
 * assistant, tool_result - so it gets regrouped here.
 */
function turnsFrom(events) {
  const turns = [];
  let cur = null;
  const start = (user) => {
    cur = { user, steps: [], texts: [], notes: [], model: null };
    turns.push(cur);
    return cur;
  };

  for (const e of events) {
    if (e.type === 'user') { start(e); continue; }
    if (!cur) start(null);

    if (e.type === 'assistant') {
      cur.model = e.model || cur.model;
      if (e.text?.trim()) cur.texts.push(e);
      for (const c of e.toolCalls ?? []) cur.steps.push({ call: c, result: null });
    } else if (e.type === 'tool_result') {
      const step = cur.steps.find((x) => x.call.id === e.callId && !x.result);
      if (step) step.result = e;
      else cur.steps.push({ call: { id: e.callId, name: e.name, args: {} }, result: e });
    } else if (e.type === 'note') {
      cur.notes.push(e);
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

  const tone = endedBadly ? 'bad' : (failures || silent) ? 'warn' : 'ok';
  const parts = [];
  if (running) parts.push(`working${last?.call?.name ? ` · ${esc(last.call.name)}` : ''}`);
  else if (endedBadly) parts.push(`stopped on ${esc(last.call.name)}`);
  else {
    if (turn.texts.length) parts.push(`${turn.texts.length} repl${turn.texts.length === 1 ? 'y' : 'ies'}`);
    if (steps) parts.push(`${done} step${done === 1 ? '' : 's'}`);
    if (failures) parts.push(`${failures} recovered`);
    if (silent) parts.push('no summary');
    if (!parts.length) parts.push('no output');
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
      <div class="bubble">${esc(turn.user.text)}</div>
      ${cost.length ? `<div class="usage turn-cost">${cost.join(' · ')}</div>` : ''}</div>`);
  }

  // Everything the question caused - what was said back and what was run -
  // lives inside one fold, with the step list as a further fold inside it.
  const inner = [];
  for (const a of turn.texts) {
    const think = a.thinking ? `<div class="thinking">${esc(a.thinking)}</div>` : '';
    inner.push(`<div class="turn assistant">
      <div class="who"><span class="tag">${esc(a.model)}</span>
        ${a.servedModel && a.servedModel !== a.model
          ? `<span class="served">${esc(a.servedModel)}</span>` : ''}
        <span class="at">${clock(a.ts)}</span></div>
      ${think}<div class="body">${render(a.text)}</div></div>`);
  }
  inner.push(activityChip(turn, key, running));
  for (const n of turn.notes) {
    const bad = /error|failed|not in models|stopped/i.test(n.text);
    inner.push(`<div class="note${bad ? ' error' : ''}">${esc(n.text)}</div>`);
  }

  const body = inner.join('').trim();
  if (!body) return bits.join('');

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
    el.innerHTML = '<div class="empty"><p>no session open</p><p class="dim">tap ☰ to start one</p></div>';
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
  state.tab = name;
  document.querySelectorAll('.tab').forEach((el) => {
    el.classList.toggle('on', el.dataset.tab === name);
  });

  // The panel exists only in the monitoring tab; the chat tab is just a chat.
  const monitoring = name === 'monitor';
  $('panel').hidden = !monitoring;
  $('panel').classList.toggle('pinned', monitoring);
  document.body.classList.toggle('tab-monitor', monitoring);

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
  if (s?.projectDirMissing) {
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
  : 'Describe what you want built…');

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
      }
      // A monitoring turn usually just changed the panel; show the result.
      if (tab === 'monitor') refreshPanel();
    }
  };
  es.onerror = () => {}; // EventSource reconnects on its own
}

async function send() {
  const text = $('input').value.trim();
  if (!text) return;
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
      body: JSON.stringify({ text }),
    });
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

async function sessionsSheet() {
  await refreshState();
  const rows = state.sessions.length
    ? state.sessions
        .map(
          (s) => `<div class="item${s.id === state.session?.id ? ' on' : ''}" data-open="${esc(s.id)}">
            <div class="grow"><div class="t">${esc(s.name)}</div>
            <div class="s">${esc(s.model)} · ${s.turns} turns · ${esc(shortDir(s.projectDir))}</div></div>
            <button class="x" data-del="${esc(s.id)}">×</button></div>`,
        )
        .join('')
    : '<p class="dim">no sessions yet</p>';

  openSheet(`<h2>Sessions</h2>${rows}
    <div class="actions">
      <button class="primary" id="new">new session</button>
      ${state.session ? '<button class="ghost" id="fork">fork onto…</button>' : ''}
    </div>`);

  $('new').onclick = newSheet;
  if ($('fork')) $('fork').onclick = forkSheet;

  $('sheet').querySelectorAll('[data-open]').forEach((el) => {
    el.onclick = (e) => {
      if (e.target.dataset.del) return;
      openSession(el.dataset.open);
    };
  });
  $('sheet').querySelectorAll('[data-del]').forEach((el) => {
    el.onclick = async (e) => {
      e.stopPropagation();
      const id = el.dataset.del;
      if (!confirm('Delete this session?')) return;
      await api(`/api/sessions/${id}`, { method: 'DELETE' });
      if (state.session?.id === id) {
        state.session = null;
        drawTranscript();
        paintHeader();
      }
      sessionsSheet();
    };
  });
}

let draft = {};   // survives a detour through the directory browser

async function newSheet() {
  const dir = draft.dir ?? state.session?.projectDir ?? state.home;
  openSheet(`<h2>New session</h2>
    <label>Name</label><input id="n-name" placeholder="what you're building" />
    <label>Model</label><select id="n-model">${modelOptions(state.default)}</select>
    <label>Mode</label>
    <select id="n-mode">
      <option value="agent">agent — tools, works in a project folder</option>
      <option value="chat">chat — plain Q&amp;A, no tools</option>
    </select>
    <label>Project directory</label>
    <div class="row"><input id="n-dir" value="${esc(dir)}" spellcheck="false" />
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

  $('n-cancel').onclick = () => { draft = {}; sessionsSheet(); };
  $('n-browse').onclick = () => {
    keep();
    browseSheet($('n-dir').value, (chosen) => { draft.dir = chosen; newSheet(); });
  };
  $('n-go').onclick = async () => {
    const session = await api('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({
        name: $('n-name').value.trim() || 'untitled',
        model: $('n-model').value,
        mode: $('n-mode').value,
        projectDir: $('n-dir').value.trim(),
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
  const rows = Object.values(state.models)
    .map(
      (m) => `<div class="item" data-model="${esc(m.alias)}">
        <div class="grow"><div class="t">${esc(m.label ?? m.alias)}</div>
        <div class="s">${esc(m.provider)} · ${esc(m.model)}</div></div>
        <span class="pill ${m.hasKey ? 'ready' : 'missing'}">${m.hasKey ? (m.keySource ?? 'ready') : 'no key'}</span></div>`,
    )
    .join('');
  const session = cur().session;
  openSheet(`
    ${session ? `<h2>This ${state.tab === 'monitor' ? 'monitoring ' : ''}session</h2>
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
      })()}
      <label>Also readable (one folder per line, read-only)</label>
      <textarea id="s-readable" spellcheck="false"
        placeholder="/Users/you/Projects/otherProject">${esc((session.readableDirs ?? []).join('\n'))}</textarea>
      <div class="actions"><button class="ghost" id="s-readable-save">save folders</button></div>
      <label>Git</label>
      <div id="s-git"><p class="dim">checking…</p></div>
      <label>Project directory${session.projectDirMissing ? ' — missing!' : ''}</label>
      <div class="row"><input id="s-dir" value="${esc(session.projectDir)}" spellcheck="false" />
      <button class="ghost" id="s-browse" style="flex:0 0 92px">browse</button></div>
      <div class="actions"><button class="ghost" id="s-dir-save">save directory</button></div>` : ''}

    <h3>Configure a model</h3>
    <p class="dim">Keys and endpoints — this does not switch anything.</p>${rows}
    <div class="actions"><button class="primary" id="s-close">done</button></div>`);

  $('s-close').onclick = closeSheet;
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
      const updated = await api(`/api/sessions/${t.session.id}`, {
        method: 'PATCH', body: JSON.stringify({ allowLongContext: el.dataset.band === 'on' }),
      });
      t.session = updated;
      if (state.tab === 'chat') state.session = updated;
      settingsSheet();
    };
  });
  $('sheet').querySelectorAll('[data-mode]').forEach((el) => {
    el.onclick = async () => {
      const t = cur();
      const updated = await api(`/api/sessions/${t.session.id}`, {
        method: 'PATCH', body: JSON.stringify({ mode: el.dataset.mode }),
      });
      t.session = updated;
      if (state.tab === 'chat') state.session = updated;
      paintHeader();
      settingsSheet();
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
  $('sheet').querySelectorAll('[data-model]').forEach((el) => {
    el.onclick = () => modelSheet(el.dataset.model);
  });
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
    settingsSheet();
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
  const view = d.samples.find((sm) => sm.role === 'view');
  if (view) {
    return view.error
      ? `<div class="mon"><div class="mon-head">${esc(view.label)}
           <span class="tool-status err">error</span></div>
         <pre class="mon-pre">${esc(view.error)}</pre></div>`
      : `<div class="mon-html view">${view.html || ''}</div>`;
  }
  return defaultActivity(d);
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

async function jobsSheet() {
  let d;
  try {
    d = await api('/api/procs');
  } catch (e) {
    return openSheet(`<h2>Background jobs</h2><p class="dim">${esc(e.message)}</p>`);
  }

  let mon = { monitors: [], samples: [] };
  try { mon = await api('/api/monitors'); } catch { /* monitors are optional */ }

  const monRows = mon.samples.length
    ? mon.samples.map((sm) => {
        const m = mon.monitors.find((x) => x.id === sm.id) ?? {};
        const state = sm.ok === false
          ? '<span class="tool-status err">error</span>'
          : sm.kind === 'process'
            ? `<span class="tool-status ${sm.count ? 'ok' : 'err'}">${sm.count ? `${sm.count} running` : 'not running'}</span>`
            : sm.status
              ? `<span class="tool-status ${sm.ok ? 'ok' : 'err'}">${sm.status}</span>`
              : '<span class="tool-status ok">ok</span>';
        return `<div class="item" style="display:block">
          <div class="tool-head" style="padding:0">
            <span class="tool-name">${esc(sm.label)}</span>
            <span class="tool-arg">${esc(sm.kind)}</span>${state}</div>
          <pre class="file-body" style="max-height:26vh;margin-top:8px">${esc(sm.error ? sm.error : (sm.text || '(no output)'))}</pre>
          <div class="row" style="margin-top:8px">
            ${m.kind === 'file' && m.path ? `<button class="ghost" data-log="${esc(m.path)}">watch</button>` : ''}
            <button class="ghost" data-drop="${esc(sm.id)}">remove</button>
          </div>
        </div>`;
      }).join('')
    : `<p class="dim">No custom monitors yet. Ask a session to "monitor X" and it will add one — they live in <span class="mono">monitors.json</span>.</p>`;

  const rows = d.procs.length
    ? d.procs.map((p) => {
        const idle = p.cpu < 0.5;
        return `<div class="item" style="display:block">
          <div class="t">${esc(p.command.split(' ').slice(0, 4).join(' '))}</div>
          <div class="s">pid ${p.pid} · ${esc(p.etime)} · ${p.cpu.toFixed(1)}% cpu · ${p.rssMb} MB${p.detached ? ' · detached' : ''}</div>
          ${idle ? '<div class="s warn-text">idle — 0% cpu, may be stalled or waiting</div>' : ''}
          ${p.log ? `<div class="s">log: ${esc(p.log)}</div>` : '<div class="s">no log file found</div>'}
          <div class="row" style="margin-top:8px">
            ${p.log ? `<button class="ghost" data-log="${esc(p.log)}">watch log</button>` : ''}
            <button class="ghost" data-stop="${p.pid}">stop</button>
          </div>
        </div>`;
      }).join('')
    : '<p class="dim">nothing running that the agent started</p>';

  openSheet(`<h2>Monitors</h2>
    ${monRows}
    <h3>Detected processes</h3>
    <p class="dim">Detached processes survive the turn that started them.</p>
    ${rows}
    <div class="actions">
      <button class="ghost" id="j-refresh">refresh</button>
      <button class="primary" id="j-close">done</button>
    </div>`);

  $('j-refresh').onclick = jobsSheet;
  $('j-close').onclick = closeSheet;
  $('sheet').querySelectorAll('[data-log]').forEach((el) => {
    el.onclick = () => watchLog(el.dataset.log);
  });
  $('sheet').querySelectorAll('[data-drop]').forEach((el) => {
    el.onclick = async () => {
      if (!confirm(`Stop watching "${el.dataset.drop}"?`)) return;
      await api('/api/monitors', { method: 'DELETE', body: JSON.stringify({ id: el.dataset.drop }) });
      jobsSheet();
    };
  });
  $('sheet').querySelectorAll('[data-stop]').forEach((el) => {
    el.onclick = async () => {
      const pid = Number(el.dataset.stop);
      if (!confirm(`Stop process ${pid}?`)) return;
      await api('/api/procs/stop', { method: 'POST', body: JSON.stringify({ pid }) });
      jobsSheet();
    };
  });
}

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
      <button class="ghost" id="l-back">back</button>
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
  $('l-back').onclick = () => { done(); jobsSheet(); };
  $('l-close').onclick = () => { done(); closeSheet(); };
}

document.querySelectorAll('.tab').forEach((el) => {
  el.onclick = () => {
    if (!state.session) return showBanner('open a session first — tap ☰');
    setTab(el.dataset.tab);
  };
});

$('jobs').onclick = jobsSheet;

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

async function usageSheet() {
  let d;
  try {
    d = await api(`/api/usage?window=${usageWindow}`);
  } catch (e) {
    return openSheet(`<h2>Usage</h2><p class="dim">${esc(e.message)}</p>`);
  }

  // What the provider reports about the account as a whole.
  const provider = Object.entries(d.provider ?? {});
  const providerHtml = provider.length
    ? provider.map(([alias, p]) => `
        <div class="item" style="display:block">
          <div class="t">${esc(state.models[alias]?.label ?? alias)}</div>
          <div class="s">subscription — counts all Claude use, not just this app</div>
          ${(p.windows ?? []).map((w) => `
            <div class="meter">
              <div class="meter-head"><span>${esc(WINDOW_LABEL[w.name] ?? w.name)}</span>
                <span class="mono">${(w.pct * 100).toFixed(w.pct < 0.1 ? 1 : 0)}%</span></div>
              ${bar(w.pct, w.pct > 0.9 ? 'hot' : w.pct > 0.7 ? 'warm' : '')}
              <div class="s">${esc(untilReset(w.resetsAt))}</div>
            </div>`).join('')}
        </div>`).join('')
    : `<p class="dim">No subscription report yet — it arrives with the first Claude turn after the server starts.</p>`;

  const rows = d.models.map((m) => {
    const limit = m.limit
      ? `<div class="meter"><div class="meter-head">
           <span>${m.limit.kind === 'cost' ? 'budget' : 'token limit'}</span>
           <span class="mono">${(m.limit.pct * 100).toFixed(0)}%</span></div>
         ${bar(m.limit.pct, m.limit.pct > 0.9 ? 'hot' : m.limit.pct > 0.7 ? 'warm' : '')}</div>`
      : '';
    const cost = m.cost > 0 ? ` · $${m.cost.toFixed(2)}` : '';
    return `<div class="item" style="display:block">
      <div class="t">${esc(m.label)}</div>
      <div class="s">${esc(m.provider)} · ${m.turns} turns · ${m.sessions} sessions</div>
      <div class="s">${num(m.input)} in · ${num(m.output)} out · ${num(m.cached)} cached · ${m.tools} tools · ${dur(m.ms)}${cost}</div>
      ${limit}
    </div>`;
  }).join('');

  openSheet(`<h2>Usage</h2>
    <div class="row" style="margin-bottom:12px">
      ${d.windows.map((w) => `<button class="ghost win${w === d.window ? ' on' : ''}" data-win="${w}">${esc(WINDOW_LABEL[w] ?? w)}</button>`).join('')}
    </div>
    <h3>Account limits</h3>
    ${providerHtml}
    <h3>Measured by this app · ${esc(WINDOW_LABEL[d.window] ?? d.window)}</h3>
    ${rows}
    <p class="dim">Token counts are what the harness recorded across ${d.sessionCount} session(s). Add <span class="mono">limits</span> to a model in models.json to draw a ceiling.</p>
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
      ${state.session ? '<button class="ghost" id="f-proj">project folder</button>' : ''}
      <button class="primary" id="f-close">done</button>
    </div>`);

  $('f-close').onclick = closeSheet;
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

$('files').onclick = () => filesSheet();

// --------------------------------------------------------- laptop's screen

let screenTimer = null;

function screenSheet() {
  const stamp = () => `/api/screen?ts=${Date.now()}`;
  openSheet(`<h2>Laptop screen</h2>
    <img id="scr" alt="the laptop's screen"
         style="width:100%;border:1px solid var(--line);border-radius:10px;background:var(--bg-3)" />
    <p class="dim" id="scr-note">tap the image to refresh</p>
    <div class="actions">
      <button class="ghost" id="scr-auto">auto-refresh</button>
      <button class="primary" id="scr-close">done</button>
    </div>`);

  const refresh = async () => {
    // Ask first, so a 503 can explain itself instead of showing a broken image.
    try {
      const res = await fetch(stamp());
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        $('scr').removeAttribute('src');
        $('scr-note').textContent = body.detail ?? body.error ?? `capture failed (${res.status})`;
        return;
      }
      const blob = await res.blob();
      $('scr').src = URL.createObjectURL(blob);
      $('scr-note').textContent = 'tap the image to refresh';
    } catch (e) {
      $('scr-note').textContent = e.message;
    }
  };
  $('scr').onclick = refresh;
  refresh();

  $('scr-auto').onclick = () => {
    if (screenTimer) {
      clearInterval(screenTimer);
      screenTimer = null;
      $('scr-auto').textContent = 'auto-refresh';
    } else {
      screenTimer = setInterval(refresh, 2000);
      $('scr-auto').textContent = 'stop auto-refresh';
    }
  };
  $('scr-close').onclick = () => {
    clearInterval(screenTimer);
    screenTimer = null;
    closeSheet();
  };
}

$('screen').onclick = screenSheet;
$('menu').onclick = sessionsSheet;
$('gear').onclick = settingsSheet;
$('send').onclick = send;
$('stop').onclick = () => api(`/api/sessions/${cur().session.id}/stop`, { method: 'POST' });

$('sheet-back').onclick = (e) => {
  if (e.target.id !== 'sheet-back') return;
  clearInterval(screenTimer);
  screenTimer = null;
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
$('transcript').addEventListener('click', (e) => {
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
  } catch {
    // offline for the moment; the next tick will try again
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
