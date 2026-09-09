// Safeguards against blowing the context window - and against the cure being
// worse than the disease.
import { budgetOpenAI, compactToolOutput, renderForPrompt, toolResultEvent, userEvent, assistantEvent } from '../src/core/transcript.js';

const fail = [];
const check = (label, cond, extra = '') => {
  if (!cond) fail.push(label);
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? `  ${extra}` : ''}`);
};

// ---- the actual cause: base64 screenshots stored verbatim ----
const png = `{"type":"image","source":{"type":"base64","media_type":"image/png","data":"${'A1b'.repeat(200_000)}"}}`;
const ev = toolResultEvent({ callId: 'c', name: 'Read', ok: true, output: png });
check('an image payload never reaches the transcript', ev.output.length < 200, `${ev.output.length} chars`);
check('but the fact of it does', /image omitted/.test(ev.output) && /on disk/.test(ev.output));

check('ordinary output is untouched', toolResultEvent({ callId: 'c', name: 'Bash', ok: true, output: 'done' }).output === 'done');
check('a wall of repeated text is not mistaken for base64',
  compactToolOutput('x'.repeat(50_000)).includes('x'.repeat(1000)));

const big = compactToolOutput(`START${'y'.repeat(200_000)}END`);
check('long output keeps its head and its tail', big.startsWith('START') && big.endsWith('END'), `${big.length} chars`);
check('and says what was removed', /characters omitted/.test(big));

// ---- budgeting a long session ----
const events = [userEvent('build the thing')];
for (let i = 0; i < 60; i += 1) {
  events.push(assistantEvent({ model: 'opus', text: `step ${i}`, toolCalls: [{ id: `c${i}`, name: 'Bash', args: { command: `run ${i}` } }] }));
  events.push(toolResultEvent({ callId: `c${i}`, name: 'Bash', ok: true, output: 'z'.repeat(5000) }));
}
events.push(userEvent('now fix the failing test'));

const full = renderForPrompt(events);
const budgeted = renderForPrompt(events, { budgetChars: 40_000 });
check('an over-long transcript is brought under budget', budgeted.length <= 42_000,
  `${full.length} -> ${budgeted.length}`);
check('every user message survives',
  budgeted.includes('build the thing') && budgeted.includes('now fix the failing test'));
check('the most recent work is kept in full', budgeted.includes('step 59'));
check('older payloads are replaced by a summary, not deleted silently',
  /not shown/.test(budgeted) && /omitted to stay within the context limit|summarised to stay within/.test(budgeted));
check('the model is told the history is abridged', budgeted.includes('re-read'));

const small = renderForPrompt(events, { budgetChars: 4_000 });
check('even a brutal budget keeps the user intent',
  small.includes('build the thing') && small.includes('now fix the failing test'), `${small.length} chars`);
// There is a floor: every user message plus the newest tool result are never
// shed, so a budget below that cannot be met. It should collapse to about that
// floor and no more.
check('a brutal budget collapses to the irreducible floor', small.length <= 12_000, `${small.length} chars`);
check('the newest tool result survives even then', small.includes('z'.repeat(100)));

check('a short session is passed through unchanged',
  renderForPrompt([userEvent('hi')], { budgetChars: 40_000 }) === renderForPrompt([userEvent('hi')]));

// ---- budgeting an OpenAI message array (a priced-by-band provider) ----
const msgs = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'do the thing' }];
for (let i = 0; i < 60; i += 1) {
  msgs.push({ role: 'assistant', content: '', tool_calls: [{ id: `c${i}`, type: 'function', function: { name: 'bash', arguments: '{}' } }] });
  msgs.push({ role: 'tool', tool_call_id: `c${i}`, content: 'z'.repeat(8000) });
}
msgs.push({ role: 'user', content: 'now fix it' });

const trimmed = budgetOpenAI(msgs, 150_000);
check('an oversized request is brought under budget',
  JSON.stringify(trimmed).length <= 160_000,
  `${JSON.stringify(msgs).length} -> ${JSON.stringify(trimmed).length}`);
check('every tool message still answers its call — the API rejects orphans',
  trimmed.filter((m) => m.role === 'tool').length === 60);
check('user messages are never shed',
  trimmed.filter((m) => m.role === 'user').length === 2);
check('the system message survives', trimmed[0].role === 'system' && trimmed[0].content === 'sys');
check('what was removed is stated, not silently dropped',
  trimmed.some((m) => m.role === 'tool' && /omitted/.test(m.content)));
check('the newest tool output is kept whole',
  trimmed.filter((m) => m.role === 'tool').at(-1).content.length > 1000);
check('a request already under budget is untouched',
  JSON.stringify(budgetOpenAI(msgs.slice(0, 4), 150_000)) === JSON.stringify(msgs.slice(0, 4)));
check('no budget means no trimming', budgetOpenAI(msgs, Infinity).length === msgs.length);

// ---- the band guard is a choice, not a law ----
{
  const http = await import('node:http');
  const seen = [];
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      seen.push(JSON.parse(raw));
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const baseUrl = `http://127.0.0.1:${srv.address().port}/v1`;

  const { complete, makeClient } = await import('../src/core/providers/openai.js');
  // A transcript far larger than the soft band but inside the real window.
  const fat = [userEvent('go')];
  for (let i = 0; i < 40; i += 1) {
    fat.push(assistantEvent({ model: 'astra', text: '', toolCalls: [{ id: `c${i}`, name: 'bash', args: {} }] }));
    fat.push(toolResultEvent({ callId: `c${i}`, name: 'bash', ok: true, output: 'q'.repeat(20_000) }));
  }
  const spec = {
    alias: 'astra', provider: 'openai', model: 'gpt-6-astra', baseUrl,
    softLimitTokens: 20_000, contextTokens: 1_000_000,
  };
  const client = makeClient(spec);

  await complete({ client, spec, events: fat, system: 'sys' });
  const guarded = JSON.stringify(seen.at(-1).messages).length;

  await complete({ client, spec, events: fat, system: 'sys', longContext: true });
  const unguarded = JSON.stringify(seen.at(-1).messages).length;

  check('by default the transcript is held under the priced band',
    guarded < 20_000 * 3.5, `${guarded} chars`);
  check('allowing long context sends far more', unguarded > guarded * 3,
    `${guarded} -> ${unguarded}`);
  check('and both still pair every tool message to its call',
    seen.at(-1).messages.filter((m) => m.role === 'tool').length === 40);
  srv.close();
}

console.log(`\n${fail.length ? `${fail.length} FAILED` : 'all green'}`);
process.exit(fail.length ? 1 : 0);
