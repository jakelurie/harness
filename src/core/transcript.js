/**
 * The canonical transcript, and its translation to each provider's wire format.
 *
 * This is the piece that makes swapping models mid-session work. Nothing in the
 * app ever stores an Anthropic message or an OpenAI message; it stores neutral
 * events. When a turn runs, the events are rendered into whatever shape the
 * currently selected provider expects. Switch from Claude to Astra halfway
 * through a project and the whole history - including tool calls and their
 * results - re-renders into the other format.
 *
 * Event shapes:
 *   { id, ts, type: 'user',        text }
 *   { id, ts, type: 'assistant',   model, provider, text, thinking, toolCalls[], usage }
 *   { id, ts, type: 'tool_result', callId, name, ok, output }
 *   { id, ts, type: 'note',        text }        // UI only, never sent to a model
 *
 * toolCalls entries are { id, name, args } with args already parsed to an object.
 */

let counter = 0;

export function newId(prefix = 'e') {
  counter += 1;
  return `${prefix}_${Date.now().toString(36)}_${counter.toString(36)}`;
}

export function userEvent(text, attachments = []) {
  return {
    id: newId('u'), ts: Date.now(), type: 'user', text,
    ...(attachments.length ? { attachments } : {}),
  };
}

export function assistantEvent(reply) {
  return {
    id: newId('a'),
    ts: Date.now(),
    type: 'assistant',
    model: reply.model || '',
    servedModel: reply.servedModel || '',
    provider: reply.provider || '',
    text: reply.text || '',
    thinking: reply.thinking || '',
    toolCalls: reply.toolCalls || [],
    usage: reply.usage || {},
  };
}

/**
 * The transcript is re-sent in full on every turn, so anything stored here is
 * paid for again on each one. Two things get compacted before they land:
 *
 *  - Image blocks. Reading a screenshot returns a base64 payload that can be
 *    hundreds of kilobytes, is meaningless as text, and is re-tokenised as an
 *    attachment every turn. The file is still on disk, so a reference is kept
 *    and the payload is dropped.
 *  - Very long output. The head and tail are kept - what ran, and how it ended,
 *    which is where the information usually is - and the middle is marked as
 *    omitted rather than silently cut.
 *
 * Nothing irrecoverable is lost: a tool result can always be produced again by
 * re-running the command or re-reading the file, and the note says so.
 *
 * Note that `budgetChars` has a floor. Every user message and the newest tool
 * result are never shed, so a budget smaller than those cannot be met - the
 * alternative would be discarding what was asked for, which is the one thing
 * that cannot be recovered.
 */
// Generous on purpose: truncating a tool result costs the model information,
// and information is worth more than tokens here.
export const MAX_TOOL_OUTPUT = 200_000;

const IMAGE_BLOCK = /\{"type":"image","source":\{[^{}]*"data":"[A-Za-z0-9+/=\s]{200,}"[^{}]*\}[^{}]*\}/g;
const LONE_BASE64 = /[A-Za-z0-9+/]{1500,}={0,2}/g;

export function compactToolOutput(output, { max = MAX_TOOL_OUTPUT } = {}) {
  let text = String(output ?? '');

  text = text.replace(IMAGE_BLOCK, (m) =>
    `[image omitted — ${m.length.toLocaleString()} bytes of base64; the file is on disk, read it again to view it]`);
  // A long unbroken run is only treated as base64 if it actually looks like it:
  // mixed case plus digits. Otherwise a wall of repeated characters in ordinary
  // output would be mistaken for a payload and thrown away.
  text = text.replace(LONE_BASE64, (m) => (
    /[A-Z]/.test(m) && /[a-z]/.test(m) && /[0-9]/.test(m)
      ? `[${m.length.toLocaleString()} bytes of base64 omitted]`
      : m));

  if (text.length > max) {
    const head = text.slice(0, Math.floor(max * 0.7));
    const tail = text.slice(-Math.floor(max * 0.25));
    const cut = text.length - head.length - tail.length;
    text = `${head}\n\n… ${cut.toLocaleString()} characters omitted — re-run the command or read the file for the rest …\n\n${tail}`;
  }
  return text;
}

export function toolResultEvent({ callId, name, ok, output }) {
  return {
    id: newId('t'), ts: Date.now(), type: 'tool_result', callId, name, ok,
    output: compactToolOutput(output),
  };
}

export function noteEvent(text) {
  return { id: newId('n'), ts: Date.now(), type: 'note', text };
}

/** Events the models actually see. Notes are bookkeeping for the UI. */
function sendable(events) {
  // Notes and file listings are bookkeeping for the UI; the model already knows
  // what it wrote, and re-sending the list every turn would only cost context.
  return events.filter((e) => e.type !== 'note' && e.type !== 'files');
}

/**
 * Tool-call ids have to survive a provider switch, because a tool_result
 * recorded under an Anthropic `toolu_...` id may be replayed to an OpenAI
 * endpoint and vice versa. Both accept opaque strings, so we pass them through
 * untouched - but we do guarantee an id exists, since a missing one breaks the
 * pairing rule on both sides.
 */
function callId(tc, index) {
  return tc.id || `call_${index}`;
}

// --------------------------------------------------------------- Anthropic

export function toAnthropic(events) {
  const messages = [];
  let pendingResults = [];

  const flush = () => {
    if (!pendingResults.length) return;
    messages.push({ role: 'user', content: pendingResults });
    pendingResults = [];
  };

  for (const e of sendable(events)) {
    if (e.type === 'tool_result') {
      // Anthropic requires every tool_result for one assistant turn to arrive
      // together in a single user message, immediately after it.
      pendingResults.push({
        type: 'tool_result',
        tool_use_id: e.callId,
        content: String(e.output ?? ''),
        ...(e.ok ? {} : { is_error: true }),
      });
      continue;
    }

    flush();

    if (e.type === 'user') {
      const imgs = (e.attachments ?? []).filter((a) => a.dataUrl);
      if (!e.text && !imgs.length) continue;
      messages.push({
        role: 'user',
        content: [
          ...imgs.map((a) => ({
            type: 'image',
            source: { type: 'base64', media_type: a.mime, data: a.dataUrl.split(',')[1] },
          })),
          ...(e.text ? [{ type: 'text', text: e.text }] : []),
        ],
      });
    } else if (e.type === 'assistant') {
      const content = [];
      if (e.text) content.push({ type: 'text', text: e.text });
      for (const [i, tc] of (e.toolCalls || []).entries()) {
        content.push({
          type: 'tool_use',
          id: callId(tc, i),
          name: tc.name,
          input: tc.args ?? {},
        });
      }
      // Thinking blocks are deliberately not replayed: they are bound to the
      // model that produced them, and this transcript may be re-sent to another.
      if (content.length) messages.push({ role: 'assistant', content });
    }
  }

  flush();
  return messages;
}

// ------------------------------------------------------------------ OpenAI

/** A user message with images becomes a content array rather than a string. */
function openAIUserContent(e, images) {
  if (!images?.length) return e.text;
  return [
    ...(e.text ? [{ type: 'text', text: e.text }] : []),
    ...images.map((url) => ({ type: 'image_url', image_url: { url } })),
  ];
}

export function toOpenAI(events, system) {
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });

  for (const e of sendable(events)) {
    if (e.type === 'user') {
      const imgs = (e.attachments ?? []).filter((a) => a.dataUrl).map((a) => a.dataUrl);
      if (e.text || imgs.length) {
        messages.push({ role: 'user', content: openAIUserContent(e, imgs) });
      }
    } else if (e.type === 'assistant') {
      const msg = { role: 'assistant', content: e.text || null };
      if (e.toolCalls?.length) {
        msg.tool_calls = e.toolCalls.map((tc, i) => ({
          id: callId(tc, i),
          type: 'function',
          function: { name: tc.name, arguments: JSON.stringify(tc.args ?? {}) },
        }));
      }
      // A message with neither content nor tool calls is rejected by most
      // OpenAI-compatible servers.
      if (msg.content || msg.tool_calls) messages.push(msg);
    } else if (e.type === 'tool_result') {
      messages.push({
        role: 'tool',
        tool_call_id: e.callId,
        content: String(e.output ?? ''),
      });
    }
  }

  return messages;
}

/**
 * True when the transcript ends with tool calls that were never answered.
 * Both APIs reject that, and it is the one state a mid-turn crash can leave
 * behind, so the store repairs it on load rather than letting the next send fail.
 */
export function danglingToolCalls(events) {
  const answered = new Set(
    events.filter((e) => e.type === 'tool_result').map((e) => e.callId),
  );
  const dangling = [];
  for (const e of events) {
    if (e.type !== 'assistant') continue;
    for (const [i, tc] of (e.toolCalls || []).entries()) {
      const id = callId(tc, i);
      if (!answered.has(id)) dangling.push({ id, name: tc.name });
    }
  }
  return dangling;
}

/** Rough per-model tallies, for the session list and the stats panel. */
export function tally(events, models) {
  const rows = {};
  for (const e of events) {
    if (e.type !== 'assistant') continue;
    const key = e.model || 'unknown';
    const row = (rows[key] ||= { turns: 0, input: 0, output: 0, ms: 0, cost: 0, tools: 0 });
    row.turns += 1;
    row.input += e.usage?.input || 0;
    row.output += e.usage?.output || 0;
    row.ms += e.usage?.ms || 0;
    row.tools += (e.toolCalls || []).length;
    const spec = models?.[key];
    if (spec) {
      row.cost +=
        ((e.usage?.input || 0) * (spec.priceIn || 0) +
          (e.usage?.output || 0) * (spec.priceOut || 0)) / 1e6;
    }
  }
  return rows;
}

/**
 * The transcript as one plain-text prompt.
 *
 * For backends that accept a prompt rather than a message array - the `claude`
 * CLI, for one. Re-sending the whole history each turn is what lets a session
 * change provider without losing what came before.
 */
export function renderForPrompt(events, { budgetChars = Infinity, keepRecent = 12 } = {}) {
  const blocks = [];
  for (const e of sendable(events)) {
    if (e.type === 'user') {
      // The CLI has its own file tools, so a path is more useful (and far
      // cheaper) than inlining the image.
      const files = (e.attachments ?? []).map((a) => `[attached image: ${a.path}]`).join('\n');
      blocks.push({ kind: 'user', text: `## User\n${[e.text, files].filter(Boolean).join('\n')}` });
    } else if (e.type === 'assistant') {
      const bits = [];
      if (e.text) bits.push(e.text);
      for (const c of e.toolCalls ?? []) bits.push(`[called ${c.name} with ${JSON.stringify(c.args)}]`);
      if (bits.length) blocks.push({ kind: 'assistant', text: `## Assistant (${e.model})\n${bits.join('\n')}` });
    } else if (e.type === 'tool_result') {
      blocks.push({
        kind: 'tool_result',
        text: `## Result of ${e.name} (${e.ok ? 'ok' : 'failed'})\n${e.output}`,
        // What this collapses to when the budget bites: enough to know it
        // happened and how it went, without the payload.
        stub: `## Result of ${e.name} (${e.ok ? 'ok' : 'failed'}) — ${String(e.output ?? '').length.toLocaleString()} chars, not shown`,
      });
    }
  }

  const size = () => blocks.reduce((n, b) => n + b.text.length + 2, 0);
  if (size() <= budgetChars) return blocks.map((b) => b.text).join('\n\n');

  // Over budget. Shed in order of what is recoverable elsewhere.
  //
  // Tool output can always be produced again - the files are on disk and the
  // commands can be re-run - so it goes first, oldest first, and the recent
  // turns are left intact because that is the work in progress. What the user
  // asked for cannot be reconstructed from anywhere, so user messages are never
  // touched.
  const lastKeep = blocks.length - keepRecent;
  for (let i = 0; i < lastKeep && size() > budgetChars; i += 1) {
    if (blocks[i].kind === 'tool_result') blocks[i].text = blocks[i].stub;
  }

  // Still over: drop the assistant's older narration, keeping its tool calls
  // implicit in the results that remain.
  for (let i = 0; i < lastKeep && size() > budgetChars; i += 1) {
    if (blocks[i].kind === 'assistant' && blocks[i].text.length > 400) {
      blocks[i].text = `${blocks[i].text.slice(0, 400)}\n… (trimmed)`;
    }
  }

  // Still over: drop the oldest non-user blocks outright, and say so, so the
  // model knows the early history is abridged rather than believing it is whole.
  let dropped = 0;
  for (let i = 0; i < lastKeep && size() > budgetChars; i += 1) {
    if (blocks[i].kind !== 'user' && blocks[i].text) {
      blocks[i].text = '';
      dropped += 1;
    }
  }

  // Last resort: the recent window is normally protected, but a budget small
  // enough to be violated by it has to win, or the request simply fails. Even
  // here the newest result is left whole and user messages are untouched.
  if (size() > budgetChars) {
    // The newest result is what the next step is usually reasoning about, so
    // it is the one thing held back from this pass.
    const newest = blocks.map((b) => b.kind).lastIndexOf('tool_result');
    for (let i = 0; i < blocks.length && size() > budgetChars; i += 1) {
      if (i === newest) continue;
      if (blocks[i].kind === 'tool_result' && blocks[i].text !== blocks[i].stub) {
        blocks[i].text = blocks[i].stub;
      }
    }
  }

  const kept = blocks.filter((b) => b.text);
  const preface = dropped
    ? `[Earlier tool output in this session has been omitted to stay within the context limit. ${dropped} step(s) are summarised or dropped; the files and commands they refer to are unchanged on disk, so re-read anything you need.]\n\n`
    : '[Earlier tool output in this session has been summarised to stay within the context limit, so re-read any file you need.]\n\n';

  return preface + kept.map((b) => b.text).join('\n\n');
}

/**
 * Trim an OpenAI message array to a character budget.
 *
 * Same principle as renderForPrompt: tool output is recoverable - the files are
 * on disk, the commands can be re-run - so it is shed first, oldest first, and
 * the user's own messages are never touched. This exists because some providers
 * price by band: GPT-6 Astra reprices the entire request once the input passes
 * 272K tokens, so drifting over that line silently doubles the bill rather than
 * charging more for the excess.
 */
export function budgetOpenAI(messages, budgetChars) {
  if (!Number.isFinite(budgetChars)) return messages;

  const out = messages.map((m) => ({ ...m }));
  const size = () => out.reduce((n, m) => n + JSON.stringify(m).length, 0);
  if (size() <= budgetChars) return out;

  // Oldest tool results first; keep the last few exchanges intact.
  const keepFrom = Math.max(0, out.length - 8);
  for (let i = 0; i < keepFrom && size() > budgetChars; i += 1) {
    if (out[i].role === 'tool' && typeof out[i].content === 'string' && out[i].content.length > 120) {
      out[i].content = `[${out[i].content.length.toLocaleString()} chars of output omitted to stay within the context budget - re-run or re-read if needed]`;
    }
  }

  // Then older assistant narration.
  for (let i = 0; i < keepFrom && size() > budgetChars; i += 1) {
    if (out[i].role === 'assistant' && typeof out[i].content === 'string' && out[i].content.length > 400) {
      out[i].content = `${out[i].content.slice(0, 400)}\n… (trimmed)`;
    }
  }

  // Last resort: recent tool output too, newest result excepted.
  if (size() > budgetChars) {
    const newest = out.map((m) => m.role).lastIndexOf('tool');
    for (let i = 0; i < out.length && size() > budgetChars; i += 1) {
      if (i === newest) continue;
      if (out[i].role === 'tool' && typeof out[i].content === 'string' && out[i].content.length > 120) {
        out[i].content = `[${out[i].content.length.toLocaleString()} chars omitted]`;
      }
    }
  }
  return out;
}

/**
 * The transcript as OpenAI Responses API input items.
 *
 * Different in kind from the chat-completions form: a tool call and its result
 * are top-level items keyed by call_id rather than a message with a nested
 * tool_calls array followed by a role:"tool" message.
 */
export function toResponses(events) {
  const input = [];
  for (const e of sendable(events)) {
    if (e.type === 'user') {
      const imgs = (e.attachments ?? []).filter((a) => a.dataUrl);
      input.push(imgs.length
        ? {
          role: 'user',
          content: [
            ...(e.text ? [{ type: 'input_text', text: e.text }] : []),
            ...imgs.map((a) => ({ type: 'input_image', image_url: a.dataUrl })),
          ],
        }
        : { role: 'user', content: e.text });
    } else if (e.type === 'assistant') {
      if (e.text) input.push({ role: 'assistant', content: e.text });
      for (const [i, c] of (e.toolCalls ?? []).entries()) {
        input.push({
          type: 'function_call',
          call_id: callId(c, i),
          name: c.name,
          arguments: JSON.stringify(c.args ?? {}),
        });
      }
    } else if (e.type === 'tool_result') {
      input.push({
        type: 'function_call_output',
        call_id: e.callId,
        output: String(e.output ?? ''),
      });
    }
  }
  return input;
}
