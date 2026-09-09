// The two backends added so the model list works without an API key:
// the text-tool-call fallback for small local models, and the `claude` CLI.
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

// ---------------------------------------------- local model, tool call as text

const sse = (res, o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
const base = { id: 'x', object: 'chat.completion.chunk', model: 'mock' };
let turn = 0;
const upstream = http.createServer((req, res) => {
  req.on('data', () => {});
  req.on('end', () => {
    turn += 1;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    // Exactly what qwen2.5-coder does: the call as prose JSON, no tool_calls.
    const text = turn === 1
      ? '{"name": "write_file", "arguments": {"path": "t.txt", "content": "local wrote this"}}'
      : 'Done.';
    for (const ch of text.match(/.{1,12}/g)) sse(res, { ...base, choices: [{ index: 0, delta: { content: ch } }] });
    sse(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    res.end('data: [DONE]\n\n');
  });
});
await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
const baseUrl = `http://127.0.0.1:${upstream.address().port}/v1`;

const projA = await fs.mkdtemp(path.join(os.tmpdir(), 'h-text-'));
const sessionA = { id: 'a', name: 'a', model: 'local', projectDir: projA, confineToProjectDir: true, system: '', events: [] };
await runTurn({
  session: sessionA,
  models: { local: { alias: 'local', provider: 'openai', model: 'q', baseUrl, parseTextToolCalls: true } },
  userText: 'make it', save: async () => {}, onEvent: () => {},
});
check('text-shaped tool call is executed', (await fs.readFile(path.join(projA, 't.txt'), 'utf8').catch(() => null)) === 'local wrote this');
check('salvaged call is recorded as a real tool call',
  sessionA.events.find((e) => e.type === 'assistant')?.toolCalls?.[0]?.name === 'write_file');
check('the raw JSON is not also left as assistant prose',
  !sessionA.events.find((e) => e.type === 'assistant')?.text?.includes('write_file'));

// Same server, fallback off: the JSON must stay plain text and run nothing.
turn = 0;
const projB = await fs.mkdtemp(path.join(os.tmpdir(), 'h-notext-'));
const sessionB = { id: 'b', name: 'b', model: 'strict', projectDir: projB, confineToProjectDir: true, system: '', events: [] };
await runTurn({
  session: sessionB,
  models: { strict: { alias: 'strict', provider: 'openai', model: 'q', baseUrl } },
  userText: 'make it', save: async () => {}, onEvent: () => {},
});
check('without the flag, prose is never mistaken for a call',
  (await fs.readdir(projB)).length === 0 && sessionB.events.at(-1).text.includes('write_file'));

upstream.close();

// ------------------------------------------------------- claude CLI backend

// A stand-in for `claude -p --output-format stream-json`, so the suite needs
// no network, no credentials and no quota.
const bin = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'h-bin-')), 'claude');
await fs.writeFile(bin, `#!/bin/sh
cat > /dev/null
echo '{"type":"system","subtype":"init","model":"claude-opus-5"}'
echo '{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"plan"},{"type":"tool_use","id":"tu_1","name":"Bash","input":{"command":"echo hi > out.txt"}}],"usage":{"input_tokens":5,"output_tokens":7,"cache_read_input_tokens":100}}}'
echo '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tu_1","content":"","is_error":false}]}}'
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"Wrote out.txt."}],"usage":{"input_tokens":9,"output_tokens":4}}}'
echo '{"type":"result","subtype":"success","result":"Wrote out.txt.","num_turns":2,"total_cost_usd":0.012,"usage":{"input_tokens":9,"output_tokens":4,"cache_read_input_tokens":100}}'
`, { mode: 0o755 });

const projC = await fs.mkdtemp(path.join(os.tmpdir(), 'h-cli-'));
const sessionC = { id: 'c', name: 'c', model: 'opus', projectDir: projC, confineToProjectDir: true, system: '', events: [] };
const deltas = [];
await runTurn({
  session: sessionC,
  models: { opus: { alias: 'opus', provider: 'claude-cli', model: 'opus', bin } },
  userText: 'write a file', save: async () => {}, onEvent: () => {},
  onDelta: (d) => deltas.push(d.kind),
});

const types = sessionC.events.map((e) => e.type);
check('claude-cli events land in transcript order', types.join(',') === 'user,assistant,tool_result,assistant', types.join(','));
check('its tool call is recorded', sessionC.events[1].toolCalls?.[0]?.name === 'Bash');
check('its tool result is recorded as already run', sessionC.events[2].ok === true && sessionC.events[2].name === 'Bash');
check('the harness did NOT re-run the tool', (await fs.readdir(projC)).length === 0, JSON.stringify(await fs.readdir(projC)));
check('final text captured', sessionC.events[3].text === 'Wrote out.txt.');
check('thinking streamed to the UI', deltas.includes('thinking'));
check('usage carried through', sessionC.events[1].usage.cached === 100);

// A long run must be visible while it runs and survive a crash, so steps are
// persisted as they arrive rather than in one batch at the end.
const saves = [];
const sessionE = { id: 'e', name: 'e', model: 'opus', projectDir: projC, confineToProjectDir: true, system: '', events: [] };
const liveKinds = [];
await runTurn({
  session: sessionE,
  models: { opus: { alias: 'opus', provider: 'claude-cli', model: 'opus', bin } },
  userText: 'go', onEvent: () => {},
  save: async (sess) => { saves.push(sess.events.length); },
  onDelta: (d) => liveKinds.push(d.kind),
});
check('tool activity streams while the turn runs', liveKinds.includes('tool_start') && liveKinds.includes('tool_end'), liveKinds.join(','));
check('steps are persisted incrementally, not in one batch',
  saves.length >= 4 && saves.join(',') === [...saves].sort((a, b) => a - b).join(','), saves.join(','));
check('a killed run would keep what it had done', saves.includes(2) && saves.includes(3), saves.join(','));

// Per-message usage from a streaming agent is fragmentary; the turn's real
// totals come from the backend's end-of-turn report and must not be lost.
const sessionU = { id: 'u', name: 'u', model: 'opus', projectDir: projC, confineToProjectDir: true, system: '', events: [] };
await runTurn({
  session: sessionU,
  models: { opus: { alias: 'opus', provider: 'claude-cli', model: 'opus', bin } },
  userText: 'go', save: async () => {}, onEvent: () => {},
});
const lastAssistant = [...sessionU.events].reverse().find((e) => e.type === 'assistant');
check('the turn total lands on the last message, not the per-chunk fragment',
  lastAssistant.usage.cached === 100 && lastAssistant.usage.output === 4,
  JSON.stringify(lastAssistant.usage));
check('and the fragment figures are replaced, not added to',
  lastAssistant.usage.input === 9, JSON.stringify(lastAssistant.usage));

// A failing CLI must surface as a note, not a silent stall.
const badBin = path.join(path.dirname(bin), 'claude-bad');
await fs.writeFile(badBin, '#!/bin/sh\necho "boom" >&2\nexit 3\n', { mode: 0o755 });
const sessionD = { id: 'd', name: 'd', model: 'opus', projectDir: projC, confineToProjectDir: true, system: '', events: [] };
await runTurn({
  session: sessionD,
  models: { opus: { alias: 'opus', provider: 'claude-cli', model: 'opus', bin: badBin } },
  userText: 'x', save: async () => {}, onEvent: () => {},
});
check('a CLI failure becomes a visible note',
  sessionD.events.at(-1).type === 'note' && /exited 3|boom/.test(sessionD.events.at(-1).text),
  JSON.stringify(sessionD.events.at(-1).text));

console.log(`\n${fail.length ? `${fail.length} FAILED` : 'all green'}`);
process.exit(fail.length ? 1 : 0);
