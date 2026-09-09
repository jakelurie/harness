/**
 * The agent loop: send the transcript, run whatever tools come back, repeat
 * until the model stops asking for tools.
 *
 * The loop is provider-agnostic. It reads `session.model` fresh on every step,
 * so a model swapped in the middle of a session takes effect on the next step
 * with the whole history intact.
 */

import { toDataUrl } from './attachments.js';
import { clientFor, providerFor } from './providers/index.js';
import { runTool } from './tools.js';
import { assistantEvent, noteEvent, toolResultEvent, userEvent } from './transcript.js';

const MAX_STEPS = 40;

/**
 * Run a tool, but never wait on it forever.
 *
 * Some calls block in ways nothing here can cancel - a macOS consent dialog for
 * ~/Documents blocks readdir until somebody clicks it, and if the laptop lid is
 * shut nobody can. Without this the whole turn wedges and Stop does nothing,
 * because the loop only checks the abort signal between tools.
 *
 * The underlying operation cannot truly be cancelled; what changes is that the
 * harness stops waiting on it, reports why, and stays responsive.
 */
async function boundedTool(call, ctx, { signal, ms }) {
  let timer;
  let onAbort;
  try {
    return await Promise.race([
      runTool(call, ctx),
      new Promise((resolve) => {
        timer = setTimeout(
          () => resolve({ ok: false, output: `timed out after ${Math.round(ms / 1000)}s — the tool did not return. If it touched ~/Documents, ~/Downloads or ~/Desktop, macOS may be waiting on a permission dialog.` }),
          ms,
        );
      }),
      new Promise((resolve) => {
        if (signal?.aborted) return resolve({ ok: false, output: 'stopped by user' });
        onAbort = () => resolve({ ok: false, output: 'stopped by user' });
        signal?.addEventListener('abort', onAbort, { once: true });
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener('abort', onAbort);
  }
}

const BASE_SYSTEM = `You are a capable assistant working with the user. You have tools to list, read, write and edit files, and to run shell commands in a project directory. You are not limited to coding: answer whatever the user actually asks.

Answering:
- If you can answer from your own knowledge, just answer, in your message. Do not run a command to produce an answer, and never use the shell to speak to the user - echo is not how you reply.
- Reach for a tool when the task genuinely needs the machine: reading or changing files, running builds or tests, inspecting the system.
- After a tool runs, say what it means in your own words. The user usually has tool output collapsed, so a tool call with no explanation reads as no answer at all.
- If the request is a plain question, a plain answer is the whole job. Do not invent project work around it.

Working on the project:
- The project directory is the working directory for every tool call. Use paths relative to it.
- Look before you leap: list_dir and read_file before editing something you have not seen.
- Prefer edit_file over write_file when changing part of an existing file.
- After making changes, verify them - run the tests, the build, or the program itself.
- If a command fails, read the error and fix it rather than reporting the failure back verbatim.
- Do not narrate routine tool calls blow by blow, but always finish with the outcome.
- End every turn with the state of things, in the past tense: what is now true, what you changed, and whether the user can use it. Do not end mid-stride with what you are "now doing" - your turn is over when you stop, so a message written as though work continues tells the user the opposite of the truth. If something is genuinely unfinished, say what remains and that you have stopped.`;

const MONITORING = `Monitoring (the user watches this from their phone):
- If you start long-running or background work, redirect its output to a log file so it can be followed.
- The user can watch anything you register in their monitors file. To add one, read that JSON file (an array), append an object, and write it back. To stop watching something, remove its entry.
- Each entry is: { "id": "short-slug", "label": "Human name", "kind": ..., "refresh": 3000 } plus one field for the kind:
  - "kind":"command" with "command": any shell one-liner; its output is shown. Use this when nothing else fits - it covers containers, launchd, queues, database counts, anything.
  - "kind":"file"    with "path": a log file; its tail is shown.
  - "kind":"process" with "match": a string matched against the process list; shows whether it is running.
  - "kind":"http"    with "url": shows the status and body.
  - "kind":"panel"   with "command": a shell command that PRINTS HTML, which is rendered as the user's interface. This is how you build them a custom view: emit a table, a progress bar, a list, whatever suits what they asked to see. Keep it small and self-contained; inline any styles. The panel renders in a DARK interface, and any text colour you set is overridden so it stays legible - so do not set colours on text at all. For emphasis use class="ok" (green), class="warn" (amber), class="bad" (red) or class="muted" (grey). Backgrounds are left as you set them, so coloured bars, chips and fills work normally.
- Add "session": "<this session's id>" to show a monitor inside this session's own panel rather than in the global list. The session id is in the project context below. Prefer session-scoped monitors for work belonging to this session.
- Register a monitor whenever you start something the user would reasonably want to watch, and whenever they ask to monitor anything. Prefer a command monitor that prints a short, current summary over one that dumps a lot of text.`;

const MONITOR_ROLE = `You control the monitoring view the user is looking at right now. The panel above this chat renders whatever monitors exist for the session you are attached to, and the user is talking to you to change it.

What that means in practice:
- "Is this up to date?" - check the underlying source yourself (read the file, run the command, look at the process) and say whether the panel reflects it. Do not just repeat what the panel says.
- "Refresh this" - re-run the monitor's command and report what changed.
- "Change this" / "show it like that" - edit the monitor's entry in the monitors file. The panel picks the change up on its next refresh.
- "Add a monitor for X" - work out the cheapest way to sample X, then add it.
- Keep panel commands fast; they are re-run every few seconds. Precompute into a file if the work is heavy.
You have the same shell and file tools as any session, so you can inspect anything you need in order to answer.

Taking over the view. The panel shows a built-in default until you replace it. To own the whole surface, write a monitor with "role":"view" (kind "panel", scoped to the watched session) - when one exists it becomes the entire panel and the default is not drawn. Rules for it:
- The raw data behind the default view is one command away, so do not reimplement process discovery:
    ACTIVITY_CMD
  That returns JSON with: running (a turn is in flight), procs (pid, etime, cpu, rssMb, detached, command, cwd, log) and projectDir. Keep the raw=1 flag: without it the request would re-enter the sampler that is running your view and loop forever.
- Your HTML keeps working buttons if you use these attributes: data-log="/path/to/log" gives a tail-and-follow button, data-stop="<pid>" gives a stop button. Reuse them so the user does not lose those controls.
- Print the whole panel every time; it is replaced wholesale on each refresh.
- If the user asks for something the view does not cover, change the view rather than explaining why it cannot be shown.
- To hand the panel back to the default, delete the "role":"view" monitor.`;

const CHAT_SYSTEM = `You are a helpful assistant talking with the user. Answer what they ask, directly and accurately. You have no tools in this conversation, so do not offer to run commands or edit files - if something genuinely needs the machine, say so and suggest they switch this session to agent mode.`;

/** A session in chat mode carries none of the agent scaffolding. */
export const usesTools = (session) => session?.mode !== 'chat';

export function systemPromptFor(session, monitorsFile, activityCmd) {
  if (!usesTools(session)) {
    return session.system?.trim() ? `${CHAT_SYSTEM}\n\n${session.system.trim()}` : CHAT_SYSTEM;
  }

  const parts = [BASE_SYSTEM, `\nProject directory: ${session.projectDir}`];
  if (monitorsFile) {
    // A monitor companion scopes its monitors to the session it watches, not
    // to itself, or its panels would show up in the wrong place.
    const scope = session.monitorFor ?? session.id;

    if (session.monitorFor) {
      // The companion's whole job is the panel, so it gets the full manual.
      parts.push(`\n${MONITOR_ROLE.replace('ACTIVITY_CMD', activityCmd ?? '(activity command unavailable)')}`);
      parts.push(`\n${MONITORING}\nMonitors file: ${monitorsFile}\nThe session these monitors belong to: ${scope}`);
    } else {
      // An ordinary session only needs to know the facility exists. Spelling
      // out every monitor kind here cost ~580 tokens on every turn of every
      // session, including ones that will never register a monitor.
      parts.push(`\nIf you start long-running work the user should watch, redirect its output to a log file and add an entry to the monitors file at ${monitorsFile} (a JSON array; use {"id","label","kind":"file","path","session":"${scope}"}). Read that file first for the full set of monitor kinds.`);
    }
  }
  if (session.confineToProjectDir) {
    parts.push('File tools are confined to this directory; paths outside it are refused.');
    if (session.readableDirs?.length) {
      parts.push(`You may also READ from these folders, but not write to them:\n${
        session.readableDirs.map((d) => `- ${d}`).join('\n')}`);
    }
  }
  if (session.system?.trim()) {
    parts.push(`\nProject-specific instructions from the user:\n${session.system.trim()}`);
  }
  return parts.join('\n');
}

/**
 * Run one user turn to completion.
 *
 * @param onEvent  called with each event appended to the transcript (already saved)
 * @param onDelta  called with live streaming updates that are not persisted
 * @param save     persists the session; awaited after every appended event
 */
export async function runTurn({
  session, models, userText, attachments, onEvent, onDelta, save, signal, monitorsFile, activityCmd,
}) {
  const append = async (event) => {
    session.events.push(event);
    await save(session);
    onEvent?.(event);
    return event;
  };

  if (userText?.trim() || attachments?.length) {
    await append(userEvent(userText?.trim() ?? '', attachments ?? []));
  }

  for (let step = 0; step < MAX_STEPS; step += 1) {
    if (signal?.aborted) {
      await append(noteEvent('stopped by user'));
      return;
    }

    const spec = models[session.model];
    if (!spec) {
      await append(noteEvent(`model "${session.model}" is not in models.json`));
      return;
    }

    // Images are stored as files and only turned into base64 for the providers
    // that inline them — the CLI reads the file itself, which is far cheaper.
    let events = session.events;
    if (spec.provider !== 'claude-cli' && events.some((e) => e.attachments?.length)) {
      events = await Promise.all(events.map(async (e) => (
        e.attachments?.length
          ? { ...e, attachments: await Promise.all(e.attachments.map(async (a) => ({ ...a, dataUrl: await toDataUrl(a).catch(() => null) }))) }
          : e
      )));
    }

    let reply;
    let streamed = 0;
    const appendStep = async (st) => {
      streamed += 1;
      if (st.kind === 'tool_result') await append(toolResultEvent(st));
      else await append(assistantEvent({ ...st, model: spec.alias, provider: spec.provider }));
    };

    try {
      const provider = providerFor(spec);
      reply = await provider.complete({
        client: clientFor(spec),
        spec,
        events,
        system: systemPromptFor(session, monitorsFile, activityCmd),
        onText: (text) => onDelta?.({ kind: 'text', text }),
        onThinking: (text) => onDelta?.({ kind: 'thinking', text }),
        onToolStart: (call) => onDelta?.({ kind: 'tool_start', call }),
        onToolEnd: (result) => onDelta?.({ kind: 'tool_end', result }),
        onStep: appendStep,
        onRateLimit: (info) => onDelta?.({ kind: 'rate_limit', info }),
        useTools: usesTools(session),
        longContext: Boolean(session.allowLongContext),
        signal,
        cwd: session.projectDir,
      });
    } catch (e) {
      await append(noteEvent(`${spec.alias}: ${e?.message ?? String(e)}`));
      return;
    }

    // Some backends are whole agents (the `claude` CLI) and have already run
    // their own tools. They hand back an ordered list of what happened; the
    // harness records it and the turn is over.
    if (streamed || reply.steps?.length) {
      // Anything not already persisted as it streamed gets written now.
      if (!streamed) for (const st of reply.steps) await appendStep(st);

      // Per-message usage from a streaming agent is fragmentary - a few tokens
      // per chunk, and an input count that excludes everything served from
      // cache. The backend's end-of-turn totals are the real figure, so they
      // are attached to the turn's last message rather than discarded.
      if (reply.usage?.input || reply.usage?.output) {
        for (let i = session.events.length - 1; i >= 0; i -= 1) {
          if (session.events[i].type === 'assistant') {
            session.events[i].usage = { ...reply.usage, total: true };
            break;
          }
        }
        await save(session);
      }

      if (reply.error) await append(noteEvent(`${spec.alias}: ${reply.error}`));
      return;
    }

    const event = await append(assistantEvent(reply));

    if (reply.error) {
      await append(noteEvent(`${spec.alias}: ${reply.error}`));
      return;
    }
    if (!event.toolCalls.length) return; // the model is done talking

    for (const call of event.toolCalls) {
      if (signal?.aborted) {
        // Every tool call still needs a result or the transcript is invalid for
        // the next request, so record the cancellation as the result.
        await append(
          toolResultEvent({ callId: call.id, name: call.name, ok: false, output: 'stopped by user' }),
        );
        continue;
      }
      onDelta?.({ kind: 'tool_start', call });
      const result = await boundedTool(call, {
        projectDir: session.projectDir,
        allowOutside: !session.confineToProjectDir,
        readableDirs: session.readableDirs ?? [],
      }, { signal, ms: spec.toolTimeoutMs ?? 120_000 });
      await append(
        toolResultEvent({ callId: call.id, name: call.name, ok: result.ok, output: result.output }),
      );
    }
  }

  await append(noteEvent(`stopped after ${MAX_STEPS} steps - send another message to continue`));
}
