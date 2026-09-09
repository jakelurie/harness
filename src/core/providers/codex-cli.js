/**
 * OpenAI models through the local `codex` CLI.
 *
 * The reason this exists is billing, not capability. Codex borrows whichever
 * credential it was signed in with: sign in with a ChatGPT plan and usage is
 * charged against that plan; sign in with an API key and it is metered
 * per-token like any API call. So routing Astra through a Codex session signed
 * in with ChatGPT avoids per-token API charges entirely — the same trick as
 * `claude-cli`, in the other ecosystem.
 *
 * The trade is rate limits instead of a meter, and, as with Claude Code, Codex
 * brings its own agent loop and tools. What comes back is a record of what it
 * did rather than a request for the harness to run tools.
 */

import { spawn } from 'node:child_process';

import { renderForPrompt } from '../transcript.js';

export const kind = 'codex-cli';

export function makeClient(spec) {
  return { bin: spec.bin || 'codex' };
}

/** Codex inherits a parent agent's environment; strip it so it runs clean. */
function childEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (k.startsWith('CLAUDE_CODE_') || k === 'CLAUDECODE' || k === 'CLAUDE_PID' || k === 'CLAUDE_EFFORT') {
      delete env[k];
    }
  }
  return env;
}

export async function complete({
  client, spec, events, system, onText, onThinking, onToolStart, onToolEnd, onStep,
  signal, cwd,
}) {
  const reply = {
    model: spec.alias,
    provider: kind,
    text: '',
    thinking: '',
    toolCalls: [],
    steps: [],          // this backend runs its own tools
    stopReason: null,
    usage: { input: 0, output: 0, cached: 0, cacheWrite: 0, ms: 0 },
  };

  const args = [
    'exec',
    '--json',
    '--skip-git-repo-check',
    ...(spec.model ? ['--model', spec.model] : []),
    ...(spec.reasoningEffort ? ['-c', `model_reasoning_effort="${spec.reasoningEffort}"`] : []),
    // The harness already decides what a session may touch; Codex's own
    // sandbox would refuse writes the user has asked for.
    ...(spec.sandbox === false ? ['--dangerously-bypass-approvals-and-sandbox'] : []),
    // The prompt argument is the agent's instructions; piped stdin is appended
    // as a <stdin> block. So the harness's system prompt goes here and the
    // transcript goes down the pipe. Without this the session ran on Codex's
    // own defaults and never received any of the harness's instructions —
    // including the one telling it to finish with a clear outcome.
    ...(system ? [system] : []),
  ];

  const started = Date.now();
  const child = spawn(client.bin, args, { cwd, env: childEnv(), stdio: ['pipe', 'pipe', 'pipe'] });

  const abort = () => child.kill('SIGTERM');
  signal?.addEventListener('abort', abort, { once: true });

  // Whole transcript as one prompt, so a session can move between providers.
  //
  // Codex rejects stdin longer than 1,048,576 CHARACTERS — a hard limit on the
  // input itself, not on tokens. Deriving a character budget from the context
  // window overshot it and the turn was refused outright, so the character
  // ceiling is applied directly and wins over any token-derived figure.
  const CODEX_MAX_CHARS = 1_048_576;
  const headroom = spec.maxInputChars ?? CODEX_MAX_CHARS - 16_384;
  const fromTokens = spec.contextTokens ? Math.floor(spec.contextTokens * 0.9 * 3.5) : Infinity;

  child.stdin.end(renderForPrompt(events, {
    budgetChars: Math.min(headroom, fromTokens),
  }));

  const pending = new Map();   // call id -> name, to label results
  let stderr = '';
  let buf = '';

  const handle = (line) => {
    let d;
    try { d = JSON.parse(line); } catch { return; }

    switch (d.type) {
      case 'thread.started':
        reply.threadId = d.thread_id;
        break;

      case 'item.started':
      case 'item.updated':
      case 'item.completed': {
        const item = d.item ?? {};
        if (item.type === 'agent_message' && d.type === 'item.completed') {
          const text = item.text ?? '';
          if (text) {
            reply.text += text;
            onText?.(text);
            const step = { kind: 'assistant', text, thinking: '', toolCalls: [], usage: {} };
            reply.steps.push(step);
            onStep?.(step);
          }
        } else if (item.type === 'reasoning' && d.type === 'item.completed') {
          const t = item.text ?? item.summary ?? '';
          if (t) { reply.thinking += t; onThinking?.(t); }
        } else if (item.type === 'command_execution' || item.type === 'file_change') {
          const id = item.id ?? `${item.type}-${pending.size}`;
          const name = item.type === 'file_change' ? 'edit' : 'shell';
          const arg = item.command ?? (item.changes ? Object.keys(item.changes).join(', ') : '');

          if (d.type === 'item.started') {
            pending.set(id, name);
            const call = { id, name, args: { command: arg } };
            reply.steps.push({ kind: 'assistant', text: '', thinking: '', toolCalls: [call], usage: {} });
            onStep?.(reply.steps.at(-1));
            onToolStart?.(call);
          } else if (d.type === 'item.completed') {
            const result = {
              kind: 'tool_result',
              callId: id,
              name: pending.get(id) ?? name,
              ok: (item.exit_code ?? 0) === 0 && item.status !== 'failed',
              output: String(item.aggregated_output ?? item.output ?? '').slice(0, 24_000),
            };
            reply.steps.push(result);
            onStep?.(result);
            onToolEnd?.(result);
          }
        }
        break;
      }

      case 'turn.completed': {
        const u = d.usage ?? {};
        reply.usage.input = u.input_tokens ?? 0;
        reply.usage.cached = u.cached_input_tokens ?? u.input_tokens_details?.cached_tokens ?? 0;
        reply.usage.output = u.output_tokens ?? 0;
        reply.stopReason = 'completed';
        break;
      }

      case 'turn.failed':
      case 'error':
        reply.error = d.error?.message ?? d.message ?? 'codex reported an error';
        break;

      default:
        break;
    }
  };

  child.stdout.on('data', (chunk) => {
    buf += chunk;
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const l of lines) if (l.trim()) handle(l);
  });
  child.stderr.on('data', (c) => { stderr += c; });

  const code = await new Promise((resolve) => {
    child.on('error', (e) => { reply.error = `could not run "${client.bin}": ${e.message}`; resolve(-1); });
    child.on('close', resolve);
  });

  signal?.removeEventListener('abort', abort);
  if (buf.trim()) handle(buf);

  reply.usage.ms = Date.now() - started;
  if (code !== 0 && !reply.error) {
    reply.error = signal?.aborted
      ? 'stopped by user'
      : `codex exited ${code}${stderr.trim() ? `: ${stderr.trim().slice(0, 400)}` : ''}`;
  }
  return reply;
}
