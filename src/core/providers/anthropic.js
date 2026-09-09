/** Claude backend, via @anthropic-ai/sdk. */

import Anthropic from '@anthropic-ai/sdk';

import { toAnthropic } from '../transcript.js';
import { toAnthropicTools } from '../tools.js';

export const kind = 'anthropic';

export function makeClient(spec) {
  return new Anthropic({
    ...(spec.apiKey ? { apiKey: spec.apiKey } : {}),
    ...(spec.baseUrl ? { baseURL: spec.baseUrl } : {}),
  });
}

/**
 * One completion. Returns the neutral reply shape the agent loop expects:
 * { text, thinking, toolCalls, usage, stopReason, error }.
 */
export async function complete({ client, spec, events, system, onText, onThinking, signal }) {
  const messages = toAnthropic(events);
  const params = {
    model: spec.model,
    max_tokens: spec.maxTokens ?? 32000,
    messages,
    tools: toAnthropicTools(),
    ...(system ? { system } : {}),
    thinking: { type: 'adaptive', display: 'summarized' },
    ...(spec.effort ? { output_config: { effort: spec.effort } } : {}),
  };

  const started = Date.now();
  let final;
  try {
    final = await runStream(client, params, spec, onText, onThinking, signal, true);
  } catch (e) {
    if (isBetaRejection(e)) {
      // The server-side fallback beta is not enabled for this account. Degrade
      // to the plain endpoint rather than failing the turn.
      try {
        final = await runStream(client, params, spec, onText, onThinking, signal, false);
      } catch (e2) {
        return errorReply(spec, e2, started);
      }
    } else {
      return errorReply(spec, e, started);
    }
  }

  const reply = {
    model: spec.alias,
    provider: kind,
    text: '',
    thinking: '',
    toolCalls: [],
    stopReason: final.stop_reason ?? null,
    usage: {
      input: final.usage?.input_tokens ?? 0,
      output: final.usage?.output_tokens ?? 0,
      cached: final.usage?.cache_read_input_tokens ?? 0,
      ms: Date.now() - started,
    },
  };

  for (const block of final.content ?? []) {
    if (block.type === 'text') reply.text += block.text;
    else if (block.type === 'thinking') reply.thinking += block.thinking ?? '';
    else if (block.type === 'tool_use') {
      reply.toolCalls.push({ id: block.id, name: block.name, args: block.input ?? {} });
    }
  }

  if (final.stop_reason === 'refusal') {
    reply.error = `declined by safety classifier (${final.stop_details?.category ?? 'unknown'})`;
  }
  return reply;
}

async function runStream(client, params, spec, onText, onThinking, signal, withFallbacks) {
  // Server-side fallbacks reroute a classifier refusal instead of handing back
  // a dead turn. Only the beta endpoint accepts it.
  const api = withFallbacks && spec.fallbacks !== false ? client.beta.messages : client.messages;
  const body =
    withFallbacks && spec.fallbacks !== false
      ? { ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }
      : params;

  const stream = api.stream(body, signal ? { signal } : undefined);
  stream.on('text', (t) => onText?.(t));
  stream.on('thinking', (t) => onThinking?.(t));
  return await stream.finalMessage();
}

function isBetaRejection(e) {
  if (e?.status !== 400 && e?.status !== 404) return false;
  const blob = String(e?.message ?? '').toLowerCase();
  return blob.includes('fallback') || blob.includes('beta');
}

function errorReply(spec, e, started) {
  return {
    model: spec.alias,
    provider: kind,
    text: '',
    thinking: '',
    toolCalls: [],
    usage: { input: 0, output: 0, cached: 0, ms: Date.now() - started },
    error: `${e?.name ?? 'Error'}: ${e?.message ?? String(e)}`,
  };
}
