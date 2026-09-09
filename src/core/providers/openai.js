/**
 * OpenAI-compatible backend. Anything speaking POST /v1/chat/completions lands
 * here: Astra, OpenAI, OpenRouter, Together, vLLM, Ollama, LM Studio. They
 * differ only by baseUrl, apiKeyEnv and model in models.json.
 */

import OpenAI from 'openai';

import { budgetOpenAI, toOpenAI } from '../transcript.js';
import { toOpenAITools } from '../tools.js';

export const kind = 'openai';

export function makeClient(spec) {
  return new OpenAI({
    apiKey: spec.apiKey || 'no-key-needed', // local servers ignore it
    ...(spec.baseUrl ? { baseURL: spec.baseUrl } : {}),
    timeout: spec.timeoutMs ?? 600_000,
  });
}

export async function complete({
  client, spec, events, system, onText, onThinking, useTools = true, longContext = false, signal,
}) {
  // A provider that reprices the whole request past a threshold makes drifting
  // over that line expensive, so the transcript is held under it by default.
  // `longContext` lifts that guard deliberately, for work worth the higher rate:
  // the ceiling becomes the model's real context window instead.
  // The band guard is about price, not capability, so it applies only when a
  // session has explicitly asked to stay under it.
  const cap = spec.softLimitTokens && !longContext ? spec.softLimitTokens : spec.contextTokens;
  const messages = cap
    ? budgetOpenAI(toOpenAI(events, system), Math.floor(cap * 0.85 * 3.5))
    : toOpenAI(events, system);
  const body = {
    model: spec.model,
    messages,
    // A chat-mode session sends no tool definitions at all: on a small model
    // they are most of the prompt, and they invite tool use where none is wanted.
    ...(useTools ? { tools: toOpenAITools() } : {}),
    stream: true,
    stream_options: { include_usage: true },
    // Newer OpenAI models renamed this parameter and reject the old one
    // outright. Configurable, and self-correcting below if the guess is wrong.
    ...(spec.maxTokens ? { [spec.maxTokensParam ?? 'max_tokens']: spec.maxTokens } : {}),
    ...(spec.temperature != null ? { temperature: spec.temperature } : {}),
    ...(spec.reasoningEffort ? { reasoning_effort: spec.reasoningEffort } : {}),
    ...(spec.extraBody ?? {}),
  };

  const started = Date.now();
  const reply = {
    model: spec.alias,
    provider: kind,
    text: '',
    thinking: '',
    toolCalls: [],
    stopReason: null,
    usage: { input: 0, output: 0, cached: 0, ms: 0 },
  };

  // Tool calls arrive as deltas keyed by index, with the name in the first
  // fragment and the arguments dribbled in as partial JSON.
  const partial = new Map();

  try {
    let stream;
    try {
      stream = await client.chat.completions.create(body, signal ? { signal } : undefined);
    } catch (e) {
      // The API names the parameter it wants. Rather than fail and make the
      // user edit config, swap to it and try once more.
      const msg = e?.message ?? '';

      // Some models refuse tools and reasoning together on this endpoint and
      // say so. Honour the instruction rather than failing the turn.
      if (/reasoning_effort/.test(msg) && body.reasoning_effort !== 'none') {
        body.reasoning_effort = 'none';
        reply.retriedWith = "reasoning_effort='none'";
        stream = await client.chat.completions.create(body, signal ? { signal } : undefined);
      } else {
        const swap = /max_completion_tokens/.test(msg) ? 'max_completion_tokens'
          : /'max_tokens'/.test(msg) ? 'max_tokens'
            : null;
        const current = spec.maxTokensParam ?? 'max_tokens';
        if (!swap || swap === current) throw e;

        delete body[current];
        body[swap] = spec.maxTokens;
        reply.retriedWith = swap;
        stream = await client.chat.completions.create(body, signal ? { signal } : undefined);
      }
    }

    for await (const chunk of stream) {
      if (chunk.model) reply.servedModel = chunk.model;
      if (chunk.usage) {
        reply.usage.input = chunk.usage.prompt_tokens ?? 0;
        reply.usage.output = chunk.usage.completion_tokens ?? 0;
        reply.usage.cached = chunk.usage.prompt_tokens_details?.cached_tokens ?? 0;
        reply.usage.cacheWrite = chunk.usage.prompt_tokens_details?.cache_write_tokens ?? 0;
      }
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      if (choice.finish_reason) reply.stopReason = choice.finish_reason;

      const delta = choice.delta;
      if (!delta) continue;

      // Some servers put chain-of-thought on a side channel.
      const rc = delta.reasoning_content ?? delta.reasoning;
      if (rc) {
        reply.thinking += rc;
        onThinking?.(rc);
      }
      if (delta.content) {
        reply.text += delta.content;
        onText?.(delta.content);
      }
      for (const tc of delta.tool_calls ?? []) {
        const slot = partial.get(tc.index) ?? { id: '', name: '', args: '' };
        if (tc.id) slot.id = tc.id;
        if (tc.function?.name) slot.name += tc.function.name;
        if (tc.function?.arguments) slot.args += tc.function.arguments;
        partial.set(tc.index, slot);
      }
    }
  } catch (e) {
    reply.usage.ms = Date.now() - started;
    reply.error = `${e?.name ?? 'Error'}: ${e?.message ?? String(e)}`;
    return reply;
  }

  // Small local models often ignore the tool schema and emit the call as plain
  // text instead. Opt in per model with `parseTextToolCalls`, so a well-behaved
  // endpoint is never second-guessed.
  if (!partial.size && spec.parseTextToolCalls && reply.text.trim()) {
    const salvaged = toolCallFromText(reply.text);
    if (salvaged) {
      reply.toolCalls.push(salvaged);
      reply.text = '';
      reply.stopReason = 'tool_calls';
      reply.usage.ms = Date.now() - started;
      return reply;
    }
  }

  for (const [index, slot] of [...partial.entries()].sort((a, b) => a[0] - b[0])) {
    let args = {};
    if (slot.args.trim()) {
      try {
        args = JSON.parse(slot.args);
      } catch {
        // A model that streams malformed JSON should get a tool error back, not
        // crash the turn. Pass the raw text through so the failure is visible.
        args = { __unparsed: slot.args };
      }
    }
    reply.toolCalls.push({ id: slot.id || `call_${index}`, name: slot.name, args });
  }

  reply.usage.ms = Date.now() - started;
  return reply;
}

/**
 * Recover a tool call a model wrote as text. Accepts the two shapes these
 * models actually produce - {"name":..,"arguments":{..}} and
 * {"name":..,"parameters":{..}} - optionally inside a code fence. Returns null
 * on anything else, so ordinary prose is never mistaken for a call.
 */
function toolCallFromText(text) {
  const stripped = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
  const start = stripped.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let end = -1;
  for (let i = start; i < stripped.length; i += 1) {
    if (stripped[i] === '{') depth += 1;
    else if (stripped[i] === '}') { depth -= 1; if (!depth) { end = i; break; } }
  }
  if (end === -1) return null;

  let parsed;
  try {
    parsed = JSON.parse(stripped.slice(start, end + 1));
  } catch {
    return null;
  }

  const name = parsed.name ?? parsed.tool ?? parsed.function;
  if (typeof name !== 'string') return null;

  let args = parsed.arguments ?? parsed.parameters ?? parsed.args ?? {};
  if (typeof args === 'string') {
    try { args = JSON.parse(args); } catch { return null; }
  }
  if (!args || typeof args !== 'object') return null;

  return { id: `call_text_${Date.now().toString(36)}`, name, args };
}
