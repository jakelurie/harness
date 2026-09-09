// End-to-end test of the turn loop against a mock OpenAI-compatible server.
// Exercises: openai provider streaming, tool-call assembly, tool execution,
// transcript translation on the follow-up request, and the loop's exit.
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { runTurn } from '../src/core/agent.js';
import { toOpenAI } from '../src/core/transcript.js';

const sse = (res, obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
const base = { id: 'x', object: 'chat.completion.chunk', model: 'mock' };

let calls = 0;
const seenBodies = [];

const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    seenBodies.push(JSON.parse(raw));
    calls += 1;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });

    if (calls === 1) {
      // Stream a tool call the way a real server does: name first, args in
      // fragments, split mid-JSON.
      sse(res, { ...base, choices: [{ index: 0, delta: { role: 'assistant' } }] });
      sse(res, { ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_a', function: { name: 'write_file' } }] } }] });
      for (const frag of ['{"path":"gre', 'eting.txt","con', 'tent":"hello from the harness\\n"}']) {
        sse(res, { ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: frag } }] } }] });
      }
      sse(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
      sse(res, { ...base, choices: [], usage: { prompt_tokens: 120, completion_tokens: 30 } });
    } else {
      sse(res, { ...base, choices: [{ index: 0, delta: { reasoning_content: 'checking the write landed' } }] });
      for (const frag of ['Wrote ', 'greeting.txt.']) {
        sse(res, { ...base, choices: [{ index: 0, delta: { content: frag } }] });
      }
      sse(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      sse(res, { ...base, choices: [], usage: { prompt_tokens: 200, completion_tokens: 12 } });
    }
    res.end('data: [DONE]\n\n');
  });
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-e2e-'));
const session = {
  id: 's1', name: 'e2e', model: 'mock', projectDir,
  confineToProjectDir: true, system: '', events: [],
};
const models = {
  mock: { alias: 'mock', provider: 'openai', model: 'mock-1', baseUrl: `http://127.0.0.1:${port}/v1`, maxTokens: 1024 },
};

const deltas = [];
await runTurn({
  session, models,
  userText: 'write a greeting file',
  save: async () => {},
  onEvent: () => {},
  onDelta: (d) => deltas.push(d.kind),
});

server.close();

// ---- assertions ----
const fail = [];
const check = (label, cond, extra = '') => {
  (cond ? console.log : (m) => { console.log(m); fail.push(label); })(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? `  ${extra}` : ''}`);
};

const kinds = session.events.map((e) => e.type);
check('two requests were made (tool call, then follow-up)', calls === 2, `calls=${calls}`);

const written = await fs.readFile(path.join(projectDir, 'greeting.txt'), 'utf8').catch(() => null);
check('tool actually wrote the file', written === 'hello from the harness\n', JSON.stringify(written));

const assistants = session.events.filter((e) => e.type === 'assistant');
check('first assistant event carries the assembled tool call',
  assistants[0]?.toolCalls?.[0]?.name === 'write_file'
  && assistants[0]?.toolCalls?.[0]?.args?.path === 'greeting.txt',
  JSON.stringify(assistants[0]?.toolCalls));

check('final assistant text streamed through', assistants[1]?.text === 'Wrote greeting.txt.', JSON.stringify(assistants[1]?.text));
check('thinking captured from reasoning_content', assistants[1]?.thinking === 'checking the write landed', JSON.stringify(assistants[1]?.thinking));
check('usage recorded', assistants[0]?.usage?.input === 120 && assistants[1]?.usage?.output === 12, JSON.stringify(assistants.map(a=>a.usage)));
check('loop stopped once the model stopped calling tools', session.events.at(-1).type === 'assistant', kinds.join(','));
check('deltas reached the UI', deltas.includes('text') && deltas.includes('tool_start') && deltas.includes('thinking'), deltas.join(','));

// The second request must replay the tool call AND its result, correctly paired.
const second = seenBodies[1].messages;
const asstWithTool = second.find((m) => m.role === 'assistant' && m.tool_calls?.length);
const toolMsg = second.find((m) => m.role === 'tool');
check('follow-up request replays the assistant tool_call', Boolean(asstWithTool), JSON.stringify(second.map(m=>m.role)));
check('follow-up request includes a matching tool result',
  toolMsg?.tool_call_id === asstWithTool?.tool_calls?.[0]?.id,
  `${toolMsg?.tool_call_id} vs ${asstWithTool?.tool_calls?.[0]?.id}`);
check('system prompt sent as a system message', second[0]?.role === 'system' && second[0].content.includes(projectDir));

console.log(`\n${fail.length ? `${fail.length} FAILED` : 'all green'}`);
process.exit(fail.length ? 1 : 0);
