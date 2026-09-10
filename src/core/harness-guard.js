/**
 * The harness is infrastructure; the sessions it runs are guests.
 *
 * A session must never be able to modify the harness that is running it. This
 * is not the same rule as confining a session to its project directory: that
 * one is a per-session setting the user can relax, and monitor companions run
 * with it off entirely. This one is absolute and applies to every session
 * regardless of its settings, because a session that edits the harness can
 * break the process serving it — and since the harness is driven from a phone,
 * a harness that breaks itself cannot be recovered without walking to the
 * laptop, which is the situation it exists to avoid.
 *
 * Reading is allowed. A session may look at the harness to understand it; it
 * simply may not change it.
 */

import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The harness's own source tree — this file lives in src/core. */
export const HARNESS_ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

/** Where the harness keeps sessions, models, secrets and the usage ledger. */
export const HARNESS_DATA =
  process.env.HARNESS_DATA_DIR ||
  path.join(os.homedir(), 'Library', 'Application Support', 'harness');

/** Everything a session is forbidden to write to. */
export function protectedRoots() {
  return [HARNESS_ROOT, HARNESS_DATA];
}

function isInside(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Would writing here modify the harness? */
export function isProtected(target) {
  const abs = path.resolve(target);
  return protectedRoots().some((root) => isInside(root, abs));
}

/**
 * A project directory that would put a session on top of the harness.
 *
 * The home folder counts: it contains both protected roots, so a session
 * rooted there has the harness inside its own scope.
 */
export function refuseAsProjectDir(dir) {
  if (!dir) return null;
  const abs = path.resolve(dir);
  if (isProtected(abs)) {
    return `${abs} is inside the harness itself. A session cannot be rooted where it could modify the harness that runs it — pick a project folder outside ${HARNESS_ROOT}.`;
  }
  // The reverse containment: a directory that *contains* a protected root.
  if (protectedRoots().some((root) => isInside(abs, root))) {
    return `${abs} contains the harness. A session rooted here would have the harness in its own scope — pick a narrower project folder.`;
  }
  return null;
}

/**
 * A seatbelt profile denying writes to the harness.
 *
 * The shell tool cannot be policed by inspecting command strings: a path can
 * be built from variables, reached through a symlink, or written by a program
 * the command merely starts. `sandbox-exec` is deprecated by Apple but present
 * and enforced by the kernel, which is the only place this can be guaranteed.
 * Everything else stays permitted, so a session keeps full use of the shell
 * inside its own project.
 */
export function sandboxProfile(roots = protectedRoots()) {
  const subpaths = roots.map((r) => `(subpath ${JSON.stringify(r)})`).join(' ');
  return `(version 1)(allow default)(deny file-write* ${subpaths})`;
}
