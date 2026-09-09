// The point of the harness: a session started on one provider must replay
// cleanly to the other, tool calls and all.
import { toAnthropic, toOpenAI, danglingToolCalls, userEvent, assistantEvent, toolResultEvent, noteEvent } from '../src/core/transcript.js';

const events = [
  userEvent('add a greeting file'),
  assistantEvent({ model: 'gpt', provider: 'openai', text: 'On it.', thinking: 'plan it',
    toolCalls: [{ id: 'call_a', name: 'write_file', args: { path: 'g.txt', content: 'hi' } }],
    usage: { input: 10, output: 5 } }),
  toolResultEvent({ callId: 'call_a', name: 'write_file', ok: true, output: 'wrote g.txt (1 lines)' }),
  noteEvent('user switched model to opus'),
  assistantEvent({ model: 'gpt', provider: 'openai', text: 'Done.', toolCalls: [], usage: { input: 20, output: 3 } }),
  userEvent('now read it back'),
];

const fail = [];
const check = (label, cond, extra = '') => {
  if (!cond) fail.push(label);
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? `  ${extra}` : ''}`);
};

// ---- OpenAI-authored history replayed to Anthropic ----
const a = toAnthropic(events);
const msgs = a.messages ?? a;
const flat = JSON.stringify(msgs);

const useIds = [];
const resIds = [];
for (const m of msgs) {
  for (const b of Array.isArray(m.content) ? m.content : []) {
    if (b.type === 'tool_use') useIds.push(b.id);
    if (b.type === 'tool_result') resIds.push(b.tool_use_id);
  }
}
check('anthropic form emits a tool_use block', useIds.length === 1, useIds.join(','));
check('anthropic tool_result id matches the tool_use id', useIds[0] === resIds[0], `${useIds[0]} vs ${resIds[0]}`);
check('the OpenAI-style call id survived untouched', useIds[0] === 'call_a');
check('notes are not sent to the model', !flat.includes('switched model'));
check('roles strictly alternate user/assistant', msgs.every((m, i) => m.role === (i % 2 ? 'assistant' : 'user')), msgs.map(m=>m.role).join(','));
check('no empty content blocks (Anthropic rejects them)',
  msgs.every((m) => (Array.isArray(m.content) ? m.content : [m.content]).every((b) => b && (typeof b === 'string' ? b.length : (b.text ?? b.content ?? b.id ?? '').length !== 0 || b.type === 'tool_result'))),
  flat.slice(0, 200));

// ---- and back the other way ----
const o = toOpenAI(events, 'SYS');
const asst = o.find((m) => m.role === 'assistant' && m.tool_calls?.length);
const tool = o.find((m) => m.role === 'tool');
check('openai form pairs tool_call with tool result', asst?.tool_calls?.[0]?.id === tool?.tool_call_id, `${asst?.tool_calls?.[0]?.id} vs ${tool?.tool_call_id}`);
check('openai tool args are a JSON string', typeof asst?.tool_calls?.[0]?.function?.arguments === 'string');
check('openai form carries the system prompt first', o[0]?.role === 'system' && o[0].content === 'SYS');

// ---- a turn interrupted mid-tool ----
const truncated = events.slice(0, 2); // assistant asked for a tool, no result yet
check('dangling tool calls are detected', danglingToolCalls(truncated).length === 1, JSON.stringify(danglingToolCalls(truncated)));
check('a complete transcript reports none dangling', danglingToolCalls(events).length === 0);

console.log(`\n${fail.length ? `${fail.length} FAILED` : 'all green'}`);
process.exit(fail.length ? 1 : 0);
