/**
 * The tools the model can use, defined once in a neutral shape and translated
 * per provider. Everything runs in the session's project directory.
 *
 * Per the app's design these run without asking for approval, the way
 * `--dangerously-skip-permissions` does. The one guard kept is path scoping:
 * file tools refuse to touch anything outside the project directory unless the
 * session opts out. Shell commands are not sandboxed - a command can do
 * anything the user can do.
 */

import { exec } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

const MAX_OUTPUT = 30_000; // characters returned to the model per tool call
const BASH_TIMEOUT_MS = 120_000;

/**
 * A GUI app launched from Finder inherits launchd's minimal PATH, not the one
 * from your shell profile - so node, python, git and anything under
 * /opt/homebrew/bin are invisible. Resolve the real PATH once from a login
 * shell, the way editors do.
 */
let cachedPath = null;

export async function loginPath() {
  if (cachedPath) return cachedPath;
  const shell = process.env.SHELL || '/bin/zsh';
  try {
    const { stdout } = await execAsync(
      `${shell} -lic 'printf %s "$PATH"' 2>/dev/null`,
      { timeout: 5000 },
    );
    cachedPath = stdout.trim() || process.env.PATH;
  } catch {
    cachedPath = [process.env.PATH, '/opt/homebrew/bin', '/usr/local/bin']
      .filter(Boolean)
      .join(':');
  }
  return cachedPath;
}

function truncate(text) {
  const s = String(text ?? '');
  if (s.length <= MAX_OUTPUT) return s;
  return `${s.slice(0, MAX_OUTPUT)}\n\n[... ${s.length - MAX_OUTPUT} more characters truncated]`;
}

/** Resolve a model-supplied path inside the project, refusing escapes. */
/**
 * Resolve a path for a tool call.
 *
 * A session is normally confined to its own project folder. Beyond that it can
 * be granted specific folders it may READ but not write - the case being one
 * project that consumes another's output, where full write access would be
 * more than was asked for.
 *
 * @param write  true for tools that modify. Read-only grants do not cover these.
 */
function resolveIn(projectDir, p, allowOutside, readableDirs = [], write = false) {
  const target = path.resolve(projectDir, p ?? '.');
  if (allowOutside) return target;

  const within = (root) => {
    const rel = path.relative(root, target);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  };

  if (within(projectDir)) return target;
  if (!write && readableDirs.some(within)) return target;

  const grantedNote = readableDirs.length
    ? ` Readable: ${readableDirs.join(', ')}.${write ? ' Those are read-only.' : ''}`
    : '';
  throw new Error(
    `refused: ${p} is outside the project directory (${projectDir}).${grantedNote} ` +
      'Grant the folder in the session settings, or turn off "confine to project directory".',
  );
}

// ------------------------------------------------------------- definitions

export const TOOLS = [
  {
    name: 'list_dir',
    description:
      'List the contents of a directory in the project. Use this before guessing at file paths.',
    schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory, relative to the project root. Defaults to the root.' },
      },
      required: [],
    },
    async run({ path: p = '.' }, ctx) {
      const dir = resolveIn(ctx.projectDir, p, ctx.allowOutside, ctx.readableDirs);
      const entries = await fs.readdir(dir, { withFileTypes: true });
      if (!entries.length) return '(empty directory)';
      return entries
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
        .sort()
        .join('\n');
    },
  },
  {
    name: 'read_file',
    description: 'Read a UTF-8 text file from the project.',
    schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path, relative to the project root.' },
      },
      required: ['path'],
    },
    async run({ path: p }, ctx) {
      const file = resolveIn(ctx.projectDir, p, ctx.allowOutside, ctx.readableDirs);
      return await fs.readFile(file, 'utf8');
    },
  },
  {
    name: 'write_file',
    description:
      'Write a file, creating parent directories as needed. Overwrites an existing file completely.',
    schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path, relative to the project root.' },
        content: { type: 'string', description: 'Full file contents.' },
      },
      required: ['path', 'content'],
    },
    async run({ path: p, content }, ctx) {
      const file = resolveIn(ctx.projectDir, p, ctx.allowOutside, ctx.readableDirs, true);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, content ?? '', 'utf8');
      const lines = String(content ?? '').split('\n').length;
      return `wrote ${path.relative(ctx.projectDir, file) || p} (${lines} lines)`;
    },
  },
  {
    name: 'edit_file',
    description:
      'Replace an exact string in a file. The old string must appear exactly once. Prefer this over rewriting a whole file.',
    schema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        old_string: { type: 'string', description: 'Exact text to replace, including indentation.' },
        new_string: { type: 'string', description: 'Replacement text.' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
    async run({ path: p, old_string: oldStr, new_string: newStr }, ctx) {
      const file = resolveIn(ctx.projectDir, p, ctx.allowOutside, ctx.readableDirs, true);
      const before = await fs.readFile(file, 'utf8');
      const hits = before.split(oldStr).length - 1;
      if (hits === 0) throw new Error('old_string not found in the file');
      if (hits > 1) throw new Error(`old_string appears ${hits} times; make it unique`);
      await fs.writeFile(file, before.replace(oldStr, newStr), 'utf8');
      return `edited ${path.relative(ctx.projectDir, file) || p}`;
    },
  },
  {
    name: 'bash',
    description:
      'Run a shell command from the project directory. Use for builds, tests, git, package managers, and anything the file tools do not cover.',
    schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command line to run.' },
      },
      required: ['command'],
    },
    async run({ command }, ctx) {
      const PATH = await loginPath();
      try {
        const { stdout, stderr } = await execAsync(command, {
          cwd: ctx.projectDir,
          timeout: BASH_TIMEOUT_MS,
          maxBuffer: 8 * 1024 * 1024,
          env: { ...process.env, PATH },
        });
        const out = [stdout, stderr].filter(Boolean).join('\n').trim();
        return out || '(no output)';
      } catch (e) {
        // A non-zero exit is information for the model, not a crash. Hand back
        // the output and the code and let it decide what to do.
        const parts = [e.stdout, e.stderr].filter(Boolean).join('\n').trim();
        if (e.killed) throw new Error(`command timed out after ${BASH_TIMEOUT_MS / 1000}s\n${parts}`);
        throw new Error(`exit code ${e.code ?? '?'}\n${parts}`);
      }
    },
  },
];

const BY_NAME = Object.fromEntries(TOOLS.map((t) => [t.name, t]));

export function toAnthropicTools() {
  return TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: { ...t.schema, additionalProperties: false },
  }));
}

export function toOpenAITools() {
  return TOOLS.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: { ...t.schema, additionalProperties: false },
    },
  }));
}

/** Execute one tool call. Never throws - failures come back as ok:false. */
export async function runTool(call, ctx) {
  const tool = BY_NAME[call.name];
  if (!tool) return { ok: false, output: `unknown tool: ${call.name}` };
  try {
    const output = await tool.run(call.args ?? {}, ctx);
    return { ok: true, output: truncate(output) };
  } catch (e) {
    return { ok: false, output: truncate(e.message || String(e)) };
  }
}

/** Short one-line description of a call, for the transcript UI. */
export function describeCall(call) {
  const a = call.args ?? {};
  switch (call.name) {
    case 'bash': return a.command ?? '';
    case 'read_file':
    case 'list_dir': return a.path ?? '.';
    case 'write_file': return `${a.path ?? ''} (${String(a.content ?? '').split('\n').length} lines)`;
    case 'edit_file': return a.path ?? '';
    default: return JSON.stringify(a).slice(0, 120);
  }
}

/** Responses API shape: name and parameters sit at the top level. */
export function toResponsesTools() {
  return TOOLS.map((t) => ({
    type: 'function',
    name: t.name,
    description: t.description,
    parameters: t.schema,
    strict: false,
  }));
}
