// The harness is infrastructure and the sessions it runs are guests: a session
// may read the harness but must never be able to change it, whatever its own
// settings say.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { HARNESS_ROOT, HARNESS_DATA, isProtected, refuseAsProjectDir, sandboxProfile } from '../src/core/harness-guard.js';
import { runTool } from '../src/core/tools.js';

const fail = [];
const check = (label, cond, extra = '') => {
  if (!cond) fail.push(label);
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? `  ${extra}` : ''}`);
};

check('the harness source tree is protected', isProtected(path.join(HARNESS_ROOT, 'server/index.js')));
check('so is its user data', isProtected(path.join(HARNESS_DATA, 'models.json')));
check('an ordinary project is not', !isProtected('/tmp/some-project/main.js'));
check('a path that merely starts with the same letters is not',
  !isProtected(`${HARNESS_ROOT}-other/file.js`));

// ---- a session cannot be rooted where it would sit on top of the harness
check('the harness directory is refused as a project dir', Boolean(refuseAsProjectDir(HARNESS_ROOT)));
check('a folder inside it is refused', Boolean(refuseAsProjectDir(path.join(HARNESS_ROOT, 'src'))));
check('the home folder is refused, because it contains the harness',
  Boolean(refuseAsProjectDir(os.homedir())));
check('an ordinary folder is allowed', refuseAsProjectDir('/tmp/a-real-project') === null);
check('no project dir at all is not an error', refuseAsProjectDir(null) === null);

// ---- the tools themselves, run the way a monitor companion runs: unconfined
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'guard-'));
const ctx = { projectDir: dir, allowOutside: true, readableDirs: [], sessionId: 'test' };
const run = async (name, args) => {
  try { return { ok: true, out: String((await runTool({ id: 'x', name, args }, ctx)).output ?? '') }; }
  catch (e) { return { ok: false, out: e.message }; }
};

const target = path.join(HARNESS_ROOT, 'GUARD_TEST_SHOULD_NOT_EXIST.txt');
const w = await run('write_file', { path: target, content: 'x' });
check('write_file into the harness is refused even unconfined', /refused/.test(w.out), w.out.slice(0, 60));

const d = await run('write_file', { path: path.join(HARNESS_DATA, 'GUARD_TEST.json'), content: 'x' });
check('and into its user data', /refused/.test(d.out), d.out.slice(0, 60));

// The shell is the path that string-checking cannot police, so it is worth
// proving the kernel actually refuses it.
const b = await run('bash', { command: `echo pwned > ${JSON.stringify(target)}; echo code=$?` });
check('bash cannot write into the harness', /code=1|not permitted/i.test(b.out), b.out.slice(0, 70));

// A variable-built path would defeat any inspection of the command text.
const sneaky = await run('bash', {
  command: `P=${JSON.stringify(HARNESS_ROOT)}; echo pwned > "$P/GUARD_TEST_SNEAKY.txt"; echo code=$?`,
});
check('including one assembled from a variable', /code=1|not permitted/i.test(sneaky.out), sneaky.out.slice(0, 70));

check('nothing actually landed in the harness',
  !(await fs.readdir(HARNESS_ROOT)).some((n) => n.startsWith('GUARD_TEST')));

// ---- what must keep working
const r = await run('read_file', { path: path.join(HARNESS_ROOT, 'package.json') });
check('reading the harness is still allowed', r.ok && r.out.includes('"name"'));
const ok = await run('bash', { command: 'echo fine > mine.txt && cat mine.txt' });
check('a session can still write in its own project', ok.out.includes('fine'), ok.out.slice(0, 40));

check('the sandbox profile names both roots',
  sandboxProfile().includes(HARNESS_ROOT) && sandboxProfile().includes(HARNESS_DATA));

await fs.rm(dir, { recursive: true, force: true });
// ---- the Harness app: a scoped, deliberate exception
// One built-in app may edit the harness SOURCE, but never its DATA directory.
import { HARNESS_APP_ID, protectedFromHarnessEditor } from '../src/core/harness-guard.js';
const src = path.join(HARNESS_ROOT, 'server/index.js');
const dataFile = path.join(HARNESS_DATA, 'secrets.json');

check('a normal session cannot write the harness source', isProtected(src) === true);
check('a normal session cannot write the harness data', isProtected(dataFile) === true);
check('a harness-app session CAN write the harness source', isProtected(src, { allowHarnessSource: true }) === false);
check('but a harness-app session still cannot write the harness data', isProtected(dataFile, { allowHarnessSource: true }) === true);
check('rooting the Harness app at the source is allowed', refuseAsProjectDir(HARNESS_ROOT, { allowHarnessSource: true }) === null);
check('but not at the data directory', Boolean(refuseAsProjectDir(HARNESS_DATA, { allowHarnessSource: true })));
check('the editor sandbox opens the source', !sandboxProfile({ allowHarnessSource: true }).includes(HARNESS_ROOT));
check('the editor sandbox still seals the data', sandboxProfile({ allowHarnessSource: true }).includes(HARNESS_DATA));
check('data is what stays protected from the editor', protectedFromHarnessEditor().includes(HARNESS_DATA));

// The tool layer honours it: a harness-app write to source succeeds, to data fails.
const hctx = { projectDir: HARNESS_ROOT, allowOutside: true, allowHarnessSource: true };
const probe = path.join(HARNESS_ROOT, '__guard_probe.txt');
const w1 = await runTool({ id: 'a', name: 'write_file', args: { path: probe, content: 'ok' } }, hctx);
check('harness-app write to source lands', /wrote/.test(String(w1.output)), String(w1.output).slice(0, 40));
await fs.rm(probe, { force: true });
const w2 = await runTool({ id: 'b', name: 'write_file', args: { path: path.join(HARNESS_DATA, '__nope.txt'), content: 'x' } }, hctx);
check('harness-app write to data is refused', /refused/.test(String(w2.output)), String(w2.output).slice(0, 50));

// No session's shell may READ the data directory (secrets, token, other
// projects' transcripts) — cat-ing the secrets file was possible before.
const secretsProbe = path.join(HARNESS_DATA, 'secrets.json');
const rNormal = await runTool({ id: 'r1', name: 'bash', args: { command: `cat ${JSON.stringify(secretsProbe)}` } }, { projectDir: os.tmpdir(), allowOutside: true });
check('a normal shell cannot read the harness data dir', /not permitted|no such|denied/i.test(String(rNormal.output)), String(rNormal.output).slice(0, 50));
const rEditor = await runTool({ id: 'r2', name: 'bash', args: { command: `cat ${JSON.stringify(secretsProbe)}` } }, hctx);
check('a harness-editor shell cannot read the data dir either', /not permitted|no such|denied/i.test(String(rEditor.output)), String(rEditor.output).slice(0, 50));
const rSrc = await runTool({ id: 'r3', name: 'bash', args: { command: `head -1 ${JSON.stringify(path.join(HARNESS_ROOT, 'package.json'))}` } }, hctx);
check('but the harness-editor shell still reads source', /"name"|\{/.test(String(rSrc.output)), String(rSrc.output).slice(0, 30));

console.log(fail.length ? `\nFAILED: ${fail.join(', ')}` : '\nall green');
process.exit(fail.length ? 1 : 0);
