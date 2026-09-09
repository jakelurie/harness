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
export async function commitAndPush(dir, { model, servedModel, push = true } = {}) {
  const st = await status(dir);
  if (!st.repo) return { ok: false, skipped: 'not a git repository' };

  const before = await run(['status', '--porcelain'], st.root);
  const files = pathsFrom(before.out);
  if (!files.length) return { ok: true, skipped: 'no changes' };

  const add = await run(['add', '-A'], st.root);
  if (!add.ok) return { ok: false, error: add.err || 'git add failed' };

  // Nothing about the prompt goes in here - only what changed, and by which model.
  const subject = `harness: ${files.length} file${files.length === 1 ? '' : 's'} changed`;
  const body = files.slice(0, 40).map((f) => `- ${f}`).join('\n')
    + (files.length > 40 ? `\n…and ${files.length - 40} more` : '');
  const trailer = [model ? `Model: ${model}` : '', servedModel && servedModel !== model ? `Served: ${servedModel}` : '']
    .filter(Boolean).join('\n');

  const message = `${subject}\n\n${body}${trailer ? `\n\n${trailer}` : ''}`;
  const commit = await run(['commit', '-m', message], st.root);
  if (!commit.ok) {
    return { ok: false, error: commit.err || commit.out || 'git commit failed', files };
  }

  const sha = (await run(['rev-parse', '--short', 'HEAD'], st.root)).out;
  if (!push) return { ok: true, committed: true, sha, files, pushed: false, reason: 'push disabled' };
  if (!st.remote) {
    return { ok: true, committed: true, sha, files, pushed: false, reason: 'no remote configured' };
  }

  const branch = st.branch || 'main';
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

/** Point a repo at a remote, creating the repo locally if needed. */
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

  const res = await new Promise((resolve) => {
    execFile('gh', ['repo', 'view', '--json', 'nameWithOwner,visibility,url'],
      { cwd: st.root, timeout: 20_000 },
      (err, stdout, stderr) => resolve({ ok: !err, out: stdout ?? '', err: stderr ?? '' }));
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

  const res = await new Promise((resolve) => {
    execFile('gh', ['repo', 'edit', `--visibility=${want}`, '--accept-visibility-change-consequences'],
      { cwd: st.root, timeout: 30_000 },
      (err, stdout, stderr) => resolve({ ok: !err, out: stdout ?? '', err: stderr ?? '' }));
  });
  return res.ok ? { ok: true, visibility: want } : { ok: false, reason: res.err.trim() || 'gh failed' };
}
