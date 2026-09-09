// Stop must work even when a tool will never return, and a tool that hangs must
// not hold a turn open forever. Both were real: a macOS consent dialog for
// ~/Documents blocks readdir indefinitely, and the loop only checked the abort
// signal between tools, so Stop did nothing.
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { runTurn } from '../src/core/agent.js';

const fail = [];
const check = (label, cond, extra = '') => {
  if (!cond) fail.push(label);
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? `  ${extra}` : ''}`);
};

// An endpoint that always asks for a long sleep — a tool that will not return.
const sse = (res, o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
const base = { id: 'x', object: 'chat.completion.chunk', model: 'mock' };
let asked = 0;
const srv = http.createServer((req, res) => {
  req.on('data', () => {});
  req.on('end', () => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    asked += 1;
    if (asked === 1) {
      // First step asks for a tool that will not return.
      sse(res, { ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'bash' } }] } }] });
      sse(res, { ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"command":"sleep 60"}' } }] } }] });
      sse(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
    } else {
      // Having seen the timeout, it gives up and answers - as a real model would.
      sse(res, { ...base, choices: [{ index: 0, delta: { content: 'could not read that folder' } }] });
      sse(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    }
    res.end('data: [DONE]\n\n');
  });
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const baseUrl = `http://127.0.0.1:${srv.address().port}/v1`;
const proj = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-hang-'));

// --- a tool that overruns is cut short ---
{
  const models = { x: { alias: 'x', provider: 'openai', model: 'm', baseUrl, toolTimeoutMs: 1500 } };
  const session = { id: 'a', model: 'x', projectDir: proj, confineToProjectDir: true, system: '', events: [] };
  const started = Date.now();
  await runTurn({ session, models, userText: 'go', save: async () => {}, onEvent: () => {} });
  const elapsed = Date.now() - started;

  const result = session.events.find((e) => e.type === 'tool_result');
  check('a hanging tool does not hold the turn open', elapsed < 10_000, `${elapsed}ms`);
  check('the turn continues afterwards instead of dying',
    session.events.at(-1).type === 'assistant', session.events.at(-1).type);
  check('it is recorded as failed, not silently dropped', result?.ok === false,
    JSON.stringify(session.events.map((e) => e.type)));
  check('and says why', /timed out/.test(result?.output ?? ''), String(result?.output).slice(0, 70));
  check('the message points at the likely macOS cause',
    /Documents|permission/.test(result?.output ?? ''));
}

// --- stop interrupts a tool already running ---
{
  const models = { x: { alias: 'x', provider: 'openai', model: 'm', baseUrl, toolTimeoutMs: 120_000 } };
  const session = { id: 'b', model: 'x', projectDir: proj, confineToProjectDir: true, system: '', events: [] };
  asked = 0;
  const controller = new AbortController();

  const started = Date.now();
  setTimeout(() => controller.abort(), 800);
  await runTurn({
    session, models, userText: 'go', signal: controller.signal,
    save: async () => {}, onEvent: () => {},
  });
  const elapsed = Date.now() - started;

  check('stop interrupts a tool already running', elapsed < 20_000, `${elapsed}ms`);
  check('and the transcript records the interruption',
    session.events.some((e) => /stopped by user/.test(e.output ?? e.text ?? '')),
    JSON.stringify(session.events.map((e) => e.type)));
}

srv.close();
await fs.rm(proj, { recursive: true, force: true });
console.log(`\n${fail.length ? `${fail.length} FAILED` : 'all green'}`);
process.exit(fail.length ? 1 : 0);
