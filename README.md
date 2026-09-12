# Harness

Run a project against swappable models — Claude, GPT, or a local one — and
switch between them mid-session with the conversation intact. Drive it from a
desktop app or from your phone.

Built to answer one question honestly: *given the same project and the same
history, what do different models actually do?*

## What it is

- **Apps are the durable thing; sessions are workers.** An app owns a folder, a
  repository, a port and a start command, and survives reboots — you relaunch it
  from the dashboard. Sessions attach to an app, several at once, each free to
  run a different model. That is how you compare agents: one app, two sessions.
- **One harness, two screens.** The desktop app is a window onto the same server
  the phone uses, so both show the same thing and every feature exists in one
  place. Opening it on a cold laptop starts the server.
- **Mid-session model switching.** The transcript is provider-neutral, so a
  session can move from Claude to GPT to a local model and keep its history.
  Tool-call ids are preserved across the switch, which is the part that usually
  breaks.
- **Per-session monitoring.** A second tab per session with a live panel of the
  processes that session started, plus a chat whose whole job is that panel —
  it can rewrite what the panel shows on request.
- **Usage accounting.** Token and cost totals per model over any window, kept
  in an incrementally-updated ledger rather than recomputed from transcripts.
  Subscription CLIs report their real plan limits, read back from what each CLI
  records on disk.
- **Supervision that assumes things go wrong.** Every turn keeps a liveness
  beacon; a watcher outside the model raises an alarm when one stops making
  progress, because a stalled agent cannot be the thing that notices. A turn
  that ends without saying anything gets one bounded call to write its summary,
  and a turn interrupted by a shutdown records that in its own transcript.
- **Sessions cannot modify the harness.** File tools refuse writes into it above
  every per-session setting, and the shell runs under a kernel sandbox
  (`sandbox-exec`) so a path assembled at runtime is refused too. Reading is
  allowed; a session can study the harness, it just cannot change it.

## Requirements

- Node 20+
- For Claude without an API key: the [`claude` CLI](https://claude.com/claude-code),
  logged in. The harness shells out to it, so it borrows your existing session.
- For OpenAI models: an API key from platform.openai.com. **A ChatGPT Plus
  subscription does not include API access** — they are separate products.
- For local models: [Ollama](https://ollama.com) or anything else serving
  `POST /v1/chat/completions`.

## Setup

```bash
npm install
npm run serve      # the harness; open the printed URL on any device
npm start          # the same thing in a desktop window
npm test           # the suite
```

On first run a `models.json` is written to your OS application-support
directory (`~/Library/Application Support/harness` on macOS). Copy
`models.json.example` over it as a starting point and edit, or configure
everything from the app's settings screen.

**Keys are never stored in this repo.** They live in `secrets.json` next to
`models.json`, mode 0600, or come from environment variables. Add them through
the UI rather than editing files.

## Using it from a phone

`npm run serve` binds to your LAN and prints a URL. Set `HARNESS_TOKEN=auto` to
require an access token that persists across restarts; leave it unset and the
server is open to anyone on the network.

**The agent runs shell commands on the machine hosting it.** Treat the URL as a
credential. To reach it away from home, put both devices on a private network —
[Tailscale](https://tailscale.com) works well and needs no ports opened — rather
than exposing it publicly.

## Providers

### Voice dictation from a phone

After updating, restart the harness server and refresh the phone page. Open
**Settings → Voice setup** and save an OpenAI API key (API billing is separate
from ChatGPT/Codex subscriptions). The server stores it with the other secrets;
`OPENAI_API_KEY` is also supported as a fallback.

Open the chat using its HTTPS Tailscale URL, tap **🎙**, allow microphone access,
and tap **■** when finished. The server sends the recording to OpenAI's
`gpt-transcribe` model and inserts the transcript into your draft for review.
Nothing is sent to the chat until you press **send**. Recordings stop after five
minutes; failed uploads can be retried while the page stays open. Cancel,
switching sessions or tabs, and leaving the page discard the pending recording.
Audio is processed in memory and is not saved by the harness.

See [OpenAI transcription documentation](https://developers.openai.com/api/docs/guides/speech-to-text)
for supported API behavior and [model pricing](https://developers.openai.com/api/docs/models/gpt-transcribe).

| `provider` | for | key |
| --- | --- | --- |
| `claude-cli` | Claude via the local CLI | none — it holds your login |
| `openai` | anything speaking `/v1/chat/completions` | only if the endpoint wants one |
| `openai-responses` | OpenAI models that need `/v1/responses` | yes |
| `anthropic` | the Anthropic API directly | `ANTHROPIC_API_KEY` |

Some notes learned the hard way, encoded in `models.json.example`:

- `gpt-6-astra` will not do function tools on `/v1/chat/completions` at all —
  it needs `openai-responses`.
- Newer OpenAI models renamed `max_tokens` to `max_completion_tokens`. The
  provider retries with whichever the API asks for.
- Small quantised local models often emit tool calls as plain text rather than
  using the tool schema. `parseTextToolCalls: true` recovers those.
- Models that reprice above a token threshold take `softLimitTokens`, and the
  transcript is trimmed to stay under it unless a session opts out.

## Sessions

Each session has a project directory, a model, and a mode:

- **agent** — tools, project rules, works in the directory.
- **chat** — no tools, minimal prompt. Roughly 85 input tokens instead of 1,300,
  which matters on small models where a large tool-oriented prompt causes bad
  behaviour.

A session is confined to its project directory. It can be granted other folders
as **read-only**, for one project that consumes another's output.

Turn on **push after each turn** and the file changes a turn produced are
committed and pushed. Commit messages describe the files and which model changed
them — never what you typed.

## Layout

```
src/core/        agent loop, transcript, tools, providers, usage, git
electron/        desktop shell
server/          LAN server and phone UI
test/            suites, run with `npm test`
python-cli/      the original CLI prototype, archived
```

## Licence

MIT.
