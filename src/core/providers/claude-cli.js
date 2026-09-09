/**
 * Claude through the local `claude` CLI in print mode.
 *
 * This is the backend to use when you have a Claude subscription but no
 * ANTHROPIC_API_KEY: the CLI already holds your credentials, so the harness
 * borrows nothing and stores nothing. It is the supported headless interface,
 * not a scrape of the keychain.
 *
 * One thing to be clear about, because it changes what a comparison means:
 * Claude Code is a whole agent, not a bare model. It runs its own loop with its
 * own tools, so this backend reports what it *did* rather than asking the
 * harness to run tools on its behalf. Measured against a model driven by the
 * harness's own tools, you are comparing two agents, not two models.
 */

import { spawn } from 'node:child_process';

import { renderForPrompt } from '../transcript.js';

export const kind = 'claude-cli';

export function makeClient(spec) {
  return { bin: spec.bin || 'claude' };
}

/**
 * Claude Code inherits a parent session's environment when the harness itself
 * is launched from one. Stripping those keeps the child a clean, independent
 * session instead of a confused child of ours.
 */
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
  onRateLimit, useTools = true, signal, cwd,
}) {
  const reply = {
    model: spec.alias,
    provider: kind,
    text: '',
    thinking: '',
    toolCalls: [],
    steps: [],          // ordered events; this backend ran its own tools
    stopReason: null,
    usage: { input: 0, output: 0, cached: 0, ms: 0 },
  };

  const args = [
    '--print',
    '--output-format', 'stream-json',
    '--verbose',
    '--permission-mode', spec.permissionMode || 'bypassPermissions',
    ...(spec.model ? ['--model', spec.model] : []),
    ...(spec.effort ? ['--effort', spec.effort] : []),
    ...(spec.maxTurns ? ['--max-turns', String(spec.maxTurns)] : []),
    ...(system ? ['--append-system-prompt', system] : []),
    ...(useTools ? [] : ['--tools', '']),   // chat mode: no tools at all
  ];

  const started = Date.now();
  const child = spawn(client.bin, args, { cwd, env: childEnv(), stdio: ['pipe', 'pipe', 'pipe'] });

  const abort = () => child.kill('SIGTERM');
  signal?.addEventListener('abort', abort, { once: true });

  // The whole transcript goes in as one prompt. Re-sending it each turn is what
  // lets a session move between providers with its history intact.
  // Leave room for what the harness does not control: Claude Code's own system
  // prompt, its tool definitions, and the reply itself. Roughly 3.5 characters
  // per token, and only a share of the window is ours to fill.
  const contextTokens = spec.contextTokens ?? 1_000_000;
  const share = spec.contextShare ?? 0.45;
  child.stdin.end(renderForPrompt(events, { budgetChars: Math.floor(contextTokens * share * 3.5) }));

  const names = new Map(); // tool_use id -> name, to label the results
  let stderr = '';
  let buf = '';

  const handle = (line) => {
    let d;
    try { d = JSON.parse(line); } catch { return; }

    if (d.type === 'system' && d.model) reply.servedModel = d.model;

    if (d.type === 'assistant' && d.message) {
      const step = { kind: 'assistant', text: '', thinking: '', toolCalls: [], usage: {} };
      for (const b of d.message.content ?? []) {
        if (b.type === 'text') { step.text += b.text; reply.text += b.text; onText?.(b.text); }
        else if (b.type === 'thinking') { step.thinking += b.thinking ?? ''; onThinking?.(b.thinking ?? ''); }
        else if (b.type === 'tool_use') {
          names.set(b.id, b.name);
          const call = { id: b.id, name: b.name, args: b.input ?? {} };
          step.toolCalls.push(call);
          // This backend runs long and is mostly tool calls. Without this the
          // UI shows a spinner over an empty turn for minutes at a time.
          onToolStart?.(call);
        }
      }
      const u = d.message.usage ?? {};
      step.usage = {
        input: u.input_tokens ?? 0,
        output: u.output_tokens ?? 0,
        cached: u.cache_read_input_tokens ?? 0,
      };
      if (step.text || step.thinking || step.toolCalls.length) {
        reply.steps.push(step);
        onStep?.(step);   // persist now: a long run must survive a restart
      }
      return;
    }

    if (d.type === 'user' && d.message) {
      for (const b of d.message.content ?? []) {
        if (b.type !== 'tool_result') continue;
        const output = typeof b.content === 'string'
          ? b.content
          : (b.content ?? []).map((c) => c.text ?? JSON.stringify(c)).join('\n');
        const result = {
          kind: 'tool_result',
          callId: b.tool_use_id,
          name: names.get(b.tool_use_id) ?? 'tool',
          ok: !b.is_error,
          output,
        };
        reply.steps.push(result);
        onStep?.(result);
        onToolEnd?.(result);
      }
      return;
    }

    // The subscription's own rolling-window utilisation. This counts every
    // session on the account, not just the harness's, so it is reported apart
    // from the harness's own token tallies rather than mixed into them.
    if (d.type === 'rate_limit_event' && d.rate_limit_info) {
      reply.rateLimit = d.rate_limit_info;
      onRateLimit?.(d.rate_limit_info);
      return;
    }

    if (d.type === 'result') {
      reply.stopReason = d.stop_reason ?? d.subtype ?? null;
      const u = d.usage ?? {};
      reply.usage.input = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
      reply.usage.output = u.output_tokens ?? 0;
      reply.usage.cached = u.cache_read_input_tokens ?? 0;
      reply.cost = d.total_cost_usd ?? null;
      reply.turns = d.num_turns ?? null;
      if (d.is_error) reply.error = String(d.result ?? 'claude reported an error');
      // The CLI's own summary is authoritative when no text block carried it.
      if (!reply.text && typeof d.result === 'string') {
        reply.text = d.result;
        const step = { kind: 'assistant', text: d.result, thinking: '', toolCalls: [], usage: {} };
        reply.steps.push(step);
        onStep?.(step);
      }
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
      : `claude exited ${code}${stderr.trim() ? `: ${stderr.trim().slice(0, 400)}` : ''}`;
  }
  return reply;
}
