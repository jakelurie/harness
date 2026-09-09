/* Renderer. Talks to the main process only through window.harness (preload). */

const $ = (id) => document.getElementById(id);

const state = {
  models: {},
  defaultModel: null,
  configPath: '',
  sessions: [],
  session: null,     // full session object, or null
  running: false,
  streaming: null,   // { el, text } while a reply is arriving
};

// ------------------------------------------------------------------ helpers

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );

function relTime(ts) {
  const d = Math.max(0, Date.now() - ts) / 1000;
  if (d < 60) return 'just now';
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86400)}d ago`;
}

function fmtCost(n) {
  if (!n) return '$0';
  return n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

/** Stable colour per model, so two sessions are distinguishable at a glance. */
function modelColor(alias) {
  const palette = ['#7aa2f7', '#bb9af7', '#8bd49c', '#e0af68', '#7dcfff', '#f7768e'];
  let h = 0;
  for (const ch of String(alias)) h = (h + ch.charCodeAt(0)) % 997;
  return palette[h % palette.length];
}

/** Minimal markdown: fenced code blocks and inline code. */
function renderText(text) {
  const parts = String(text ?? '').split(/```/);
  return parts
    .map((part, i) => {
      if (i % 2 === 1) {
        const nl = part.indexOf('\n');
        const body = nl === -1 ? part : part.slice(nl + 1);
        return `<pre><code>${esc(body.replace(/\n$/, ''))}</code></pre>`;
      }
      return esc(part).replace(/`([^`\n]+)`/g, '<code>$1</code>');
    })
    .join('');
}

function describeCall(call) {
  const a = call.args ?? {};
  switch (call.name) {
    case 'bash': return a.command ?? '';
    case 'read_file':
    case 'list_dir': return a.path ?? '.';
    case 'write_file': return `${a.path ?? ''}`;
    case 'edit_file': return a.path ?? '';
    default: return JSON.stringify(a).slice(0, 140);
  }
}

// --------------------------------------------------------------- transcript

function scrollDown() {
  const t = $('transcript');
  t.scrollTop = t.scrollHeight;
}

function renderTranscript() {
  const t = $('transcript');
  t.innerHTML = '';

  if (!state.session) {
    t.innerHTML =
      '<div class="empty">no session open<br />press <b>+</b> to start one</div>';
    return;
  }
  if (!state.session.events.length) {
    t.innerHTML = `<div class="empty">${esc(state.session.name)}<br />${esc(
      state.session.projectDir,
    )}<br /><br />describe what you want built</div>`;
    return;
  }

  // Tool results are drawn inside the assistant turn that requested them.
  const resultsByCall = new Map();
  for (const e of state.session.events) {
    if (e.type === 'tool_result') resultsByCall.set(e.callId, e);
  }

  for (const e of state.session.events) {
    if (e.type === 'tool_result') continue;
    t.appendChild(renderEvent(e, resultsByCall));
  }
  scrollDown();
}

function renderEvent(e, resultsByCall) {
  const div = document.createElement('div');

  if (e.type === 'user') {
    div.className = 'turn user';
    div.innerHTML = `<div class="who">you</div><div class="bubble">${esc(e.text)}</div>`;
    return div;
  }

  if (e.type === 'note') {
    div.className = `note${/error|declined|not in models|failed/i.test(e.text) ? ' error' : ''}`;
    div.textContent = e.text;
    return div;
  }

  div.className = 'turn assistant';
  const color = modelColor(e.model);
  const parts = [
    `<div class="who"><span class="model-tag" style="color:${color}">${esc(e.model)}</span></div>`,
  ];
  if (e.thinking) {
    parts.push(`<div class="thinking">${esc(e.thinking)}</div>`);
  }
  if (e.text) parts.push(`<div class="body">${renderText(e.text)}</div>`);

  for (const call of e.toolCalls ?? []) {
    const res = resultsByCall?.get(call.id);
    const status = !res
      ? '<span class="tool-status pending">running</span>'
      : res.ok
        ? '<span class="tool-status ok">ok</span>'
        : '<span class="tool-status err">error</span>';
    const body = res ? `<div class="tool-body" hidden>${esc(res.output)}</div>` : '';
    parts.push(
      `<div class="tool">
         <div class="tool-head">
           <span class="tool-name">${esc(call.name)}</span>
           <span class="tool-arg">${esc(describeCall(call))}</span>
           ${status}
         </div>${body}
       </div>`,
    );
  }

  if (e.usage?.output) {
    const spec = state.models[e.model];
    const cost = spec
      ? ((e.usage.input || 0) * (spec.priceIn || 0) + (e.usage.output || 0) * (spec.priceOut || 0)) / 1e6
      : 0;
    const bits = [
      `${((e.usage.ms || 0) / 1000).toFixed(1)}s`,
      `in ${(e.usage.input || 0).toLocaleString()}`,
      `out ${(e.usage.output || 0).toLocaleString()}`,
    ];
    if (cost) bits.push(fmtCost(cost));
    parts.push(`<div class="usage">${bits.join('  ·  ')}</div>`);
  }

  div.innerHTML = parts.join('');
  for (const head of div.querySelectorAll('.tool-head')) {
    head.addEventListener('click', () => {
      const body = head.nextElementSibling;
      if (body?.classList.contains('tool-body')) body.hidden = !body.hidden;
    });
  }
  return div;
}

// ------------------------------------------------------------------ sidebar

function renderSessions() {
  const list = $('session-list');
  list.innerHTML = '';
  for (const s of state.sessions) {
    const el = document.createElement('div');
    el.className = `session${state.session?.id === s.id ? ' active' : ''}`;
    el.innerHTML = `
      <div class="s-name">${esc(s.name)}</div>
      <div class="s-meta">
        <span class="dot" style="background:${modelColor(s.model)}"></span>${esc(s.model)} ·
        ${s.turns} turns · ${relTime(s.updatedAt)}
      </div>`;
    el.addEventListener('click', () => openSession(s.id));
    el.addEventListener('contextmenu', async (ev) => {
      ev.preventDefault();
      if (confirm(`Delete session "${s.name}"? The project files are not touched.`)) {
        await window.harness.sessions.remove(s.id);
        if (state.session?.id === s.id) state.session = null;
        await refreshSessions();
        renderTranscript();
        renderHeader();
      }
    });
    list.appendChild(el);
  }
}

async function refreshSessions() {
  state.sessions = await window.harness.sessions.list();
  renderSessions();
}

// ------------------------------------------------------------------- header

function renderHeader() {
  const sel = $('model-select');
  sel.innerHTML = '';
  for (const [alias, spec] of Object.entries(state.models)) {
    const opt = document.createElement('option');
    opt.value = alias;
    opt.textContent = spec.hasKey ? alias : `${alias} (no key)`;
    sel.appendChild(opt);
  }

  const s = state.session;
  $('session-name').value = s?.name ?? '';
  $('session-name').disabled = !s;
  $('project-dir').textContent = s?.projectDir ?? '';
  if (s) sel.value = s.model;
  sel.disabled = !s;
  $('fork-btn').disabled = !s;
  $('stats-btn').disabled = !s;
  $('send').disabled = !s || state.running;
}

function setBanner(msg) {
  const b = $('banner');
  b.hidden = !msg;
  b.textContent = msg ?? '';
}

// -------------------------------------------------------------------- flows

async function loadModels() {
  const cfg = await window.harness.models.list();
  state.models = cfg.models ?? {};
  state.defaultModel = cfg.default;
  state.configPath = cfg.path;
  setBanner(cfg.error);
  renderHeader();
}

async function openSession(id) {
  state.session = await window.harness.sessions.open(id);
  renderHeader();
  renderTranscript();
  renderSessions();
}

async function newSessionDialog() {
  const home = (await window.harness.paths()).home;
  const dir = { value: `${home}/projects/untitled` };

  showModal(
    `<h2>New session</h2>
     <label>name</label>
     <input type="text" id="m-name" value="untitled" />
     <label>model</label>
     <select id="m-model">${Object.keys(state.models)
       .map((a) => `<option value="${esc(a)}"${a === state.defaultModel ? ' selected' : ''}>${esc(a)}</option>`)
       .join('')}</select>
     <label>project directory</label>
     <div class="row">
       <input type="text" id="m-dir" value="${esc(dir.value)}" />
       <button class="ghost-btn" id="m-browse" style="flex:0 0 auto">browse</button>
     </div>
     <div class="hint">created if it does not exist; all tool calls run here</div>
     <label>system prompt (optional)</label>
     <textarea id="m-system" placeholder="Project-specific instructions"></textarea>
     <div class="modal-actions">
       <button class="ghost-btn" id="m-cancel">cancel</button>
       <button class="send-btn" id="m-create">create</button>
     </div>`,
  );

  $('m-browse').addEventListener('click', async () => {
    const picked = await window.harness.chooseDir($('m-dir').value);
    if (picked) $('m-dir').value = picked;
  });
  $('m-cancel').addEventListener('click', closeModal);
  $('m-create').addEventListener('click', async () => {
    const session = await window.harness.sessions.create({
      name: $('m-name').value.trim() || 'untitled',
      model: $('m-model').value,
      projectDir: $('m-dir').value.trim(),
      system: $('m-system').value,
    });
    closeModal();
    state.session = session;
    await refreshSessions();
    renderHeader();
    renderTranscript();
    $('input').focus();
  });
}

async function forkDialog() {
  const s = state.session;
  showModal(
    `<h2>Fork session</h2>
     <div class="hint">Copies the full history onto another model, in its own
     directory. Run the same brief twice and compare the results.</div>
     <label>model</label>
     <select id="f-model">${Object.keys(state.models)
       .map((a) => `<option value="${esc(a)}"${a === s.model ? ' selected' : ''}>${esc(a)}</option>`)
       .join('')}</select>
     <label>name</label>
     <input type="text" id="f-name" value="${esc(s.name)} (fork)" />
     <label>project directory</label>
     <div class="row">
       <input type="text" id="f-dir" value="${esc(s.projectDir)}" />
       <button class="ghost-btn" id="f-browse" style="flex:0 0 auto">browse</button>
     </div>
     <div class="modal-actions">
       <button class="ghost-btn" id="f-cancel">cancel</button>
       <button class="send-btn" id="f-go">fork</button>
     </div>`,
  );
  $('f-browse').addEventListener('click', async () => {
    const picked = await window.harness.chooseDir($('f-dir').value);
    if (picked) $('f-dir').value = picked;
  });
  $('f-cancel').addEventListener('click', closeModal);
  $('f-go').addEventListener('click', async () => {
    const twin = await window.harness.sessions.fork({
      id: s.id,
      model: $('f-model').value,
      name: $('f-name').value.trim(),
      projectDir: $('f-dir').value.trim(),
    });
    closeModal();
    state.session = twin;
    await refreshSessions();
    renderHeader();
    renderTranscript();
  });
}

async function statsDialog() {
  const rows = await window.harness.sessions.stats(state.session.id);
  const entries = Object.entries(rows);
  const body = entries.length
    ? `<table class="stats">
         <tr><th>model</th><th>turns</th><th>tools</th><th>in</th><th>out</th><th>avg</th><th>cost</th></tr>
         ${entries
           .map(
             ([m, r]) => `<tr>
               <td style="color:${modelColor(m)}">${esc(m)}</td>
               <td>${r.turns}</td><td>${r.tools}</td>
               <td>${r.input.toLocaleString()}</td><td>${r.output.toLocaleString()}</td>
               <td>${(r.ms / r.turns / 1000).toFixed(1)}s</td>
               <td>${fmtCost(r.cost)}</td></tr>`,
           )
           .join('')}
       </table>`
    : '<div class="hint">no model turns yet</div>';

  showModal(
    `<h2>${esc(state.session.name)}</h2>${body}
     <div class="check">
       <input type="checkbox" id="s-confine" ${state.session.confineToProjectDir ? 'checked' : ''} />
       <label for="s-confine" style="margin:0">confine file tools to the project directory</label>
     </div>
     <div class="hint">Shell commands are never sandboxed - they run as you.</div>
     <label>system prompt</label>
     <textarea id="s-system">${esc(state.session.system ?? '')}</textarea>
     <div class="modal-actions">
       <button class="ghost-btn" id="s-reveal">open folder</button>
       <button class="send-btn" id="s-save">save</button>
     </div>`,
  );
  $('s-reveal').addEventListener('click', () => window.harness.reveal(state.session.projectDir));
  $('s-save').addEventListener('click', async () => {
    state.session = await window.harness.sessions.update(state.session.id, {
      confineToProjectDir: $('s-confine').checked,
      system: $('s-system').value,
    });
    closeModal();
  });
}

// --------------------------------------------------------------------- send

async function send() {
  const input = $('input');
  const text = input.value.trim();
  if (!text || !state.session || state.running) return;

  input.value = '';
  input.style.height = 'auto';
  state.running = true;
  $('send').hidden = true;
  $('stop').hidden = false;

  const res = await window.harness.turn.send(state.session.id, text);
  if (!res?.ok && res?.error) setBanner(res.error);
}

function beginStream() {
  if (state.streaming) return state.streaming;
  const el = document.createElement('div');
  el.className = 'turn assistant';
  el.innerHTML = `<div class="who"><span class="model-tag" style="color:${modelColor(
    state.session.model,
  )}">${esc(state.session.model)}</span></div><div class="body cursor"></div>`;
  $('transcript').appendChild(el);
  state.streaming = { el, body: el.querySelector('.body'), text: '' };
  return state.streaming;
}

function endStream() {
  state.streaming?.el.remove();
  state.streaming = null;
}

// --------------------------------------------------------------------- wire

function showModal(html) {
  $('modal').innerHTML = html;
  $('modal-back').hidden = false;
}
function closeModal() {
  $('modal-back').hidden = true;
  $('modal').innerHTML = '';
}

function autoGrow(el) {
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
}

window.addEventListener('DOMContentLoaded', async () => {
  await loadModels();
  await refreshSessions();
  renderHeader();
  renderTranscript();

  $('new-session').addEventListener('click', newSessionDialog);
  $('fork-btn').addEventListener('click', forkDialog);
  $('stats-btn').addEventListener('click', statsDialog);
  $('send').addEventListener('click', send);
  $('stop').addEventListener('click', () => window.harness.turn.stop(state.session.id));

  $('edit-models').addEventListener('click', () => window.harness.models.edit());
  $('reload-models').addEventListener('click', async () => {
    const cfg = await window.harness.models.reload();
    state.models = cfg.models ?? {};
    state.defaultModel = cfg.default;
    setBanner(cfg.error);
    renderHeader();
  });

  $('modal-back').addEventListener('click', (e) => {
    if (e.target.id === 'modal-back') closeModal();
  });

  $('input').addEventListener('input', (e) => autoGrow(e.target));
  $('input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });

  // Switching the model mid-session: the transcript is provider-neutral, so the
  // next turn re-renders the whole history into the new provider's format.
  $('model-select').addEventListener('change', async (e) => {
    if (!state.session) return;
    const to = e.target.value;
    const from = state.session.model;
    if (to === from) return;
    state.session = await window.harness.sessions.update(state.session.id, { model: to });
    state.session.events.push({
      id: `n_${Date.now()}`,
      ts: Date.now(),
      type: 'note',
      text: `model switched: ${from} → ${to}`,
    });
    state.session = await window.harness.sessions.update(state.session.id, {
      events: state.session.events,
    });
    renderTranscript();
    renderSessions();
  });

  $('session-name').addEventListener('change', async (e) => {
    if (!state.session) return;
    state.session = await window.harness.sessions.update(state.session.id, {
      name: e.target.value.trim() || 'untitled',
    });
    await refreshSessions();
  });

  $('project-dir').addEventListener('click', async () => {
    if (!state.session) return;
    const picked = await window.harness.chooseDir(state.session.projectDir);
    if (!picked) return;
    state.session = await window.harness.sessions.update(state.session.id, { projectDir: picked });
    renderHeader();
  });

  // ---- streaming from the main process

  window.harness.turn.onDelta(({ id, delta }) => {
    if (id !== state.session?.id) return;
    if (delta.kind === 'text') {
      const s = beginStream();
      s.text += delta.text;
      s.body.innerHTML = renderText(s.text);
      scrollDown();
    } else if (delta.kind === 'tool_start') {
      const s = beginStream();
      s.body.classList.remove('cursor');
      const el = document.createElement('div');
      el.className = 'tool';
      el.innerHTML = `<div class="tool-head">
          <span class="tool-name">${esc(delta.call.name)}</span>
          <span class="tool-arg">${esc(describeCall(delta.call))}</span>
          <span class="tool-status pending">running</span>
        </div>`;
      s.el.appendChild(el);
      scrollDown();
    }
  });

  window.harness.turn.onEvent(({ id, event }) => {
    if (id !== state.session?.id) return;
    endStream();
    state.session.events.push(event);
    renderTranscript();
  });

  window.harness.turn.onDone(({ id }) => {
    if (id !== state.session?.id) return;
    endStream();
    state.running = false;
    $('send').hidden = false;
    $('stop').hidden = true;
    $('send').disabled = false;
    renderTranscript();
    refreshSessions();
    $('input').focus();
  });
});
