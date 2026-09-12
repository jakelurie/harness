/**
 * Git integration: the file changes a turn produced, committed and pushed.
 *
 * What is deliberately NOT recorded: anything the user typed. Commit messages
 * describe the files that changed and which model changed them, nothing else.
 * The transcript is the harness's business; the repository's history should
 * read as a record of the work, not of the conversation.
 */

import { execFile } from 'node:child_process';
import path from 'node:path';

import { loginPath } from './tools.js';

const run = (args, cwd, opts = {}) =>
  new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: 120_000, maxBuffer: 8e6, ...opts }, (err, stdout, stderr) =>
      resolve({ ok: !err, out: (stdout ?? '').trim(), err: (stderr ?? '').trim() }));
  });

export async function status(dir) {
  if (!dir) return { repo: false };
  const top = await run(['rev-parse', '--show-toplevel'], dir);
  if (!top.ok) return { repo: false };

  const root = top.out;
  const [branch, remote, dirty, head] = await Promise.all([
    run(['branch', '--show-current'], root),
    run(['remote', 'get-url', 'origin'], root),
    run(['status', '--porcelain'], root),
    run(['log', '-1', '--format=%h %s'], root),
  ]);

  const changed = dirty.out ? dirty.out.split('\n').length : 0;
  return {
    repo: true,
    root,
    branch: branch.out || null,
    remote: remote.ok ? remote.out : null,
    changed,
    lastCommit: head.ok ? head.out : null,
  };
}

/** Turn `git status --porcelain` into a plain list of paths. */
function pathsFrom(porcelain) {
  return porcelain
    .split('\n')
    .filter(Boolean)
    .map((line) => line.slice(3).trim())
    .map((p) => (p.includes(' -> ') ? p.split(' -> ')[1] : p));
}

/**
 * Commit whatever changed and push if there is a remote.
 *
 * @param model  recorded as a trailer, so the history shows which model made a
 *               change - the point of a harness that compares them.
 */
export async function commitAndPush(dir, { model, servedModel, push = true, autoCreatePrivate = false } = {}) {
  let st = await status(dir);
  if (!st.repo) {
    // With auto-create on, a brand-new project becomes a repo rather than being
    // skipped — the whole point of "push every turn by default".
    if (!autoCreatePrivate) return { ok: false, skipped: 'not a git repository' };
    const init = await run(['init', '-b', 'main'], dir);
    if (!init.ok) return { ok: false, error: init.err || 'git init failed' };
    st = await status(dir);
    if (!st.repo) return { ok: false, error: 'could not initialise a git repository' };
  }

  const before = await run(['status', '--porcelain'], st.root);
  const files = pathsFrom(before.out);
  if (!files.length) return { ok: true, skipped: 'no changes' };

  const add = await run(['add', '-A'], st.root);
  if (!add.ok) return { ok: false, error: add.err || 'git add failed' };

  // Nothing about the prompt or the model goes in here — only what changed. The
  // commits are the user's own; they carry no AI-authorship bookkeeping.
  const subject = `harness: ${files.length} file${files.length === 1 ? '' : 's'} changed`;
  const body = files.slice(0, 40).map((f) => `- ${f}`).join('\n')
    + (files.length > 40 ? `\n…and ${files.length - 40} more` : '');

  const message = `${subject}\n\n${body}`;
  const commit = await run(['commit', '-m', message], st.root);
  if (!commit.ok) {
    return { ok: false, error: commit.err || commit.out || 'git commit failed', files };
  }

  const sha = (await run(['rev-parse', '--short', 'HEAD'], st.root)).out;
  if (!push) return { ok: true, committed: true, sha, files, pushed: false, reason: 'push disabled' };
  const branch = st.branch || 'main';

  if (!st.remote) {
    if (!autoCreatePrivate) {
      return { ok: true, committed: true, sha, files, pushed: false, reason: 'no remote configured' };
    }
    // No GitHub repo yet: create one, private by default, and push this commit.
    // Uses the gh login (found via the real PATH, since the server runs with a
    // minimal one). A failure leaves the commit safely on disk.
    const created = await createPrivateRepo(st.root, branch);
    return {
      ok: true, committed: true, sha, files,
      pushed: created.ok,
      created: created.ok ? created.repo : undefined,
      reason: created.ok ? null : created.reason,
    };
  }

  const pushed = await run(['push', '-u', 'origin', branch], st.root, { timeout: 180_000 });
  return {
    ok: true,
    committed: true,
    sha,
    files,
    pushed: pushed.ok,
    reason: pushed.ok ? null : (pushed.err || 'push failed'),
  };
}

/**
 * Create a private GitHub repo for a folder and push its current branch.
 *
 * Named after the folder. Private is deliberate and non-negotiable here: a new
 * project should never become public by accident — making it public is a
 * separate, explicit step in the app's settings.
 */
async function createPrivateRepo(root, branch) {
  const name = path.basename(root);
  const PATH = await loginPath();
  const res = await new Promise((resolve) => {
    execFile('gh', ['repo', 'create', name, '--private', '--source', root, '--remote', 'origin', '--push'],
      { cwd: root, timeout: 120_000, env: { ...process.env, PATH } },
      (err, stdout, stderr) => resolve({ ok: !err, out: stdout ?? '', err: (stderr || err?.message) ?? '' }));
  });
  if (res.ok) return { ok: true, repo: name };
  // Most likely: gh not signed in, or a repo of that name already exists.
  return { ok: false, reason: (res.err.trim() || 'gh could not create the repo').split('\n')[0].slice(0, 160) };
}

/** Point a repo at a remote, creating the repo locally if needed. *//** Point a repo at a remote, creating the repo locally if needed. */
export async function connect(dir, remoteUrl) {
  const top = await run(['rev-parse', '--show-toplevel'], dir);
  const root = top.ok ? top.out : dir;
  if (!top.ok) {
    const init = await run(['init', '-b', 'main'], root);
    if (!init.ok) return { ok: false, error: init.err };
  }
  const existing = await run(['remote', 'get-url', 'origin'], root);
  const args = existing.ok ? ['remote', 'set-url', 'origin', remoteUrl] : ['remote', 'add', 'origin', remoteUrl];
  const res = await run(args, root);
  return res.ok ? { ok: true, root, remote: remoteUrl } : { ok: false, error: res.err };
}

export const repoName = (dir) => path.basename(dir || '');

/**
 * Repository visibility, via the GitHub CLI.
 *
 * Kept behind `gh` rather than raw API calls so it uses whatever login the user
 * already has, and returns a plain reason when it cannot rather than throwing.
 */
export async function visibility(dir) {
  const st = await status(dir);
  if (!st.repo || !st.remote) return { ok: false, reason: 'no remote' };

  const PATH = await loginPath();
  const res = await new Promise((resolve) => {
    execFile('gh', ['repo', 'view', '--json', 'nameWithOwner,visibility,url'],
      { cwd: st.root, timeout: 20_000, env: { ...process.env, PATH } },
      (err, stdout, stderr) => resolve({ ok: !err, out: stdout ?? '', err: (stderr || err?.message) ?? '' }));
  });
  if (!res.ok) return { ok: false, reason: res.err.trim() || 'gh not available' };

  try {
    const j = JSON.parse(res.out);
    return { ok: true, repo: j.nameWithOwner, visibility: (j.visibility ?? '').toLowerCase(), url: j.url };
  } catch {
    return { ok: false, reason: 'could not read repository info' };
  }
}

export async function setVisibility(dir, want) {
  const st = await status(dir);
  if (!st.repo) return { ok: false, reason: 'not a git repository' };
  if (!['public', 'private'].includes(want)) return { ok: false, reason: 'bad visibility' };

  const PATH = await loginPath();
  const res = await new Promise((resolve) => {
    execFile('gh', ['repo', 'edit', `--visibility=${want}`, '--accept-visibility-change-consequences'],
      { cwd: st.root, timeout: 30_000, env: { ...process.env, PATH } },
      (err, stdout, stderr) => resolve({ ok: !err, out: stdout ?? '', err: (stderr || err?.message) ?? '' }));
  });
  return res.ok ? { ok: true, visibility: want } : { ok: false, reason: res.err.trim() || 'gh failed' };
}
