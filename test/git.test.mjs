// Committing a turn's file changes — and never the conversation.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { commitAndPush, connect, status } from '../src/core/git.js';

const fail = [];
const check = (label, cond, extra = '') => {
  if (!cond) fail.push(label);
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? `  ${extra}` : ''}`);
};

const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

const plain = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-git-plain-'));
check('a non-repo is reported as such, not crashed on', (await status(plain)).repo === false);
check('committing a non-repo is skipped cleanly',
  (await commitAndPush(plain)).skipped === 'not a git repository');

// a real repo, with a bare remote to push into
const remote = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-git-remote-'));
git(['init', '--bare', '-b', 'main'], remote);

const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-git-repo-'));
git(['init', '-b', 'main'], repo);
git(['config', 'user.email', 'test@example.com'], repo);
git(['config', 'user.name', 'Test'], repo);

check('no changes means no commit', (await commitAndPush(repo)).skipped === 'no changes');

await fs.writeFile(path.join(repo, 'a.txt'), 'one');
await fs.writeFile(path.join(repo, 'b.txt'), 'two');
const local = await commitAndPush(repo, { model: 'astra', servedModel: 'gpt-6-astra' });
check('changes are committed', local.ok && local.committed && local.files.length === 2, JSON.stringify(local.files));
check('without a remote it commits but says it did not push',
  local.pushed === false && /no remote/.test(local.reason), String(local.reason));

// the commit message must describe files, never the conversation
const msg = git(['log', '-1', '--format=%B'], repo);
check('the message names the files', msg.includes('a.txt') && msg.includes('b.txt'));
check('it records which model made the change', msg.includes('Model: astra') && msg.includes('Served: gpt-6-astra'));
check('it contains no prompt text', !/user|prompt|asked|question/i.test(msg), JSON.stringify(msg.slice(0, 120)));

// attach a remote and push for real
const conn = await connect(repo, remote);
check('a remote can be attached', conn.ok && conn.remote === remote);

await fs.writeFile(path.join(repo, 'c.txt'), 'three');
const pushed = await commitAndPush(repo, { model: 'opus' });
check('the next turn pushes', pushed.ok && pushed.pushed === true, String(pushed.reason));
check('the remote received it', git(['log', '--oneline'], remote).split('\n').length === 2,
  git(['log', '--oneline'], remote));

// gitignored files must stay out
await fs.writeFile(path.join(repo, '.gitignore'), 'secret.txt\n');
await fs.writeFile(path.join(repo, 'secret.txt'), 'do not commit');
const ignored = await commitAndPush(repo, { model: 'opus' });
check('ignored files are not committed', !ignored.files.includes('secret.txt'), JSON.stringify(ignored.files));

// status reflects reality
const st = await status(repo);
check('status reports branch, remote and last commit',
  st.branch === 'main' && st.remote === remote && Boolean(st.lastCommit), JSON.stringify(st));

// ---- push-every-turn defaults: auto-init and auto-create-private behavior
// A brand-new project with no repo: without auto-create it is skipped, exactly
// as before.
const fresh1 = await fs.mkdtemp(path.join(os.tmpdir(), 'fresh1-'));
await fs.writeFile(path.join(fresh1, 'a.txt'), 'hi');
const skipped = await commitAndPush(fresh1, {});
check('a non-repo is skipped when auto-create is off', skipped.skipped === 'not a git repository', JSON.stringify(skipped));

// With auto-create on, the same folder becomes a repo and the change is
// committed. A fake remote is pre-set so the test never contacts GitHub; that
// exercises init + commit without creating a real repo.
const fresh2 = await fs.mkdtemp(path.join(os.tmpdir(), 'fresh2-'));
await fs.writeFile(path.join(fresh2, 'a.txt'), 'hi');
git(['init', '-b', 'main'], fresh2);
git(['remote', 'add', 'origin', 'file:///nonexistent/repo.git'], fresh2);
const auto = await commitAndPush(fresh2, { model: 'opus', autoCreatePrivate: true });
check('auto-create commits the change', auto.committed === true && auto.files.includes('a.txt'), JSON.stringify(auto.files));
check('a real commit is recorded', git(['log', '--oneline'], fresh2).length > 0);
check('a failed push is reported, not thrown', auto.ok === true && auto.pushed === false);

for (const d of [fresh1, fresh2]) await fs.rm(d, { recursive: true, force: true });

for (const d of [plain, remote, repo]) await fs.rm(d, { recursive: true, force: true });
console.log(`\n${fail.length ? `${fail.length} FAILED` : 'all green'}`);
process.exit(fail.length ? 1 : 0);
