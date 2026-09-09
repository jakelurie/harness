// A session should not have to carry agent scaffolding to answer a question.
import { systemPromptFor, usesTools } from '../src/core/agent.js';

const fail = [];
const check = (label, cond, extra = '') => {
  if (!cond) fail.push(label);
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? `  ${extra}` : ''}`);
};

const base = { id: 's1', projectDir: '/Users/jake/Projects/x', system: '' };
const agent = systemPromptFor(base, '/data/monitors.json');
const chat = systemPromptFor({ ...base, mode: 'chat' }, '/data/monitors.json');

check('agent mode is the default', usesTools(base) && usesTools({ ...base, mode: 'agent' }));
check('chat mode reports no tools', !usesTools({ ...base, mode: 'chat' }));

check('chat drops the project rules', !chat.includes('Project directory'));
check('chat drops the monitoring instructions', !/monitors file/i.test(chat));
check('chat says plainly it has no tools', /no tools/i.test(chat));
check('chat is a fraction of the agent prompt', chat.length < agent.length / 4,
  `${chat.length} vs ${agent.length}`);

// the monitoring manual is for the companion, not for everyone
const companion = systemPromptFor({ ...base, id: 's1--monitor', monitorFor: 's1' }, '/data/monitors.json', 'CMD');
check('the companion still gets the full monitor manual',
  companion.includes('"kind":"panel"') && companion.includes('"role":"view"'));
check('an ordinary session gets only a pointer, not the manual',
  agent.includes('monitors file') && !agent.includes('"role":"view"'));
check('and that pointer is far cheaper than the manual',
  (agent.length - systemPromptFor(base).length) < 400,
  `${agent.length - systemPromptFor(base).length} chars`);

// a user's own instructions survive in chat mode
const custom = systemPromptFor({ ...base, mode: 'chat', system: 'Call me Quinn.' }, '/data/monitors.json');
check('chat mode keeps the session-specific instructions', custom.includes('Call me Quinn.'));

console.log(`\n${fail.length ? `${fail.length} FAILED` : 'all green'}`);
process.exit(fail.length ? 1 : 0);
