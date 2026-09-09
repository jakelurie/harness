/**
 * OpenAI Responses API backend.
 *
 * Needed because some models will not do function tools on
 * /v1/chat/completions at all. GPT-6 Astra is one: that endpoint rejects tools
 * alongside reasoning, and rejects the reasoning_effort value it suggests as a
 * workaround. The Responses API is where tools and reasoning coexist, so an
 * agent session on such a model has to come through here.
 */

import OpenAI from 'openai';

import { budgetOpenAI, toResponses } from '../transcript.js';
import { toResponsesTools } from '../tools.js';

export const kind = 'openai-responses';

export function makeClient(spec) {
  return new OpenAI({
    apiKey: spec.apiKey || 'no-key-needed',
    ...(spec.baseUrl ? { baseURL: spec.baseUrl } : {}),
    timeout: spec.timeoutMs ?? 600_000,
  });
}

export async function complete({
  client, spec, events, system, onText, onThinking, useTools = true, longContext = false, signal,
}) {
  const cap = longContext ? spec.contextTokens : (spec.softLimitTokens ?? spec.contextTokens);
  const items = toResponses(events);
  const input = cap ? budgetOpenAI(items, Math.floor(cap * 0.85 * 3.5)) : items;

  const body = {
    model: spec.model,
    input,
    stream: true,
    ...(system ? { instructions: system } : {}),
    ...(useTools ? { tools: toResponsesTools() } : {}),
    ...(spec.maxTokens ? { max_output_tokens: spec.maxTokens } : {}),
    ...(spec.reasoningEffort ? { reasoning: { effort: spec.reasoningEffort } } : {}),
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

  // Tool calls arrive as an item, then their arguments dribble in by item id.
  const pending = new Map();

  try {
    const stream = await client.responses.create(body, signal ? { signal } : undefined);

    for await (const event of stream) {
      switch (event.type) {
        case 'response.output_text.delta':
          reply.text += event.delta ?? '';
          onText?.(event.delta ?? '');
          break;

        case 'response.reasoning_text.delta':
        case 'response.reasoning_summary_text.delta':
          reply.thinking += event.delta ?? '';
          onThinking?.(event.delta ?? '');
          break;

        case 'response.output_item.added':
          if (event.item?.type === 'function_call') {
            pending.set(event.item.id ?? event.item.call_id, {
              callId: event.item.call_id,
              name: event.item.name,
              args: '',
            });
          }
          break;

        case 'response.function_call_arguments.delta': {
          const slot = pending.get(event.item_id);
          if (slot) slot.args += event.delta ?? '';
          break;
        }

        case 'response.function_call_arguments.done': {
          const slot = pending.get(event.item_id);
          if (slot && event.arguments) slot.args = event.arguments;
          break;
        }

        case 'response.completed':
        case 'response.incomplete':
        case 'response.failed': {
          // The endpoint names the model it actually used. Recording it means
          // "is this really the model I picked" is answerable from evidence
          // rather than by asking the model, which often cannot say.
          if (event.response?.model) reply.servedModel = event.response.model;
          const u = event.response?.usage ?? {};
          reply.usage.input = u.input_tokens ?? 0;
          reply.usage.output = u.output_tokens ?? 0;
          reply.usage.cached = u.input_tokens_details?.cached_tokens ?? 0;
          reply.stopReason = event.response?.status ?? null;
          if (event.type === 'response.failed') {
            reply.error = event.response?.error?.message ?? 'the response failed';
          }
          break;
        }

        default:
          break;
      }
    }
  } catch (e) {
    reply.usage.ms = Date.now() - started;
    reply.error = `${e?.name ?? 'Error'}: ${e?.message ?? String(e)}`;
    return reply;
  }

  for (const slot of pending.values()) {
    let args = {};
    if (slot.args.trim()) {
      try {
        args = JSON.parse(slot.args);
      } catch {
        // Malformed arguments should reach the tool as an error, not crash the turn.
        args = { __unparsed: slot.args };
      }
    }
    reply.toolCalls.push({ id: slot.callId, name: slot.name, args });
  }

  reply.usage.ms = Date.now() - started;
  return reply;
}
