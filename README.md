# Harness

Run a project against swappable models — Claude, GPT, or a local one — and
switch between them mid-session with the conversation intact. Drive it from a
desktop app or from your phone.

Built to answer one question honestly: *given the same project and the same
history, what do different models actually do?*

## What it is

- **Two frontends, one core.** An Electron desktop app and a LAN web app share
  the same agent loop, session store and providers, against the same data
  directory. A session started on your phone opens on the laptop.
- **Mid-session model switching.** The transcript is provider-neutral, so a
  session can move from Claude to GPT to a local model and keep its history.
  Tool-call ids are preserved across the switch, which is the part that usually
  breaks.
- **Per-session monitoring.** A second tab per session with a live panel of the
  processes that session started, plus a chat whose whole job is that panel —
  it can rewrite what the panel shows on request.
- **Usage accounting.** Token and cost totals per model over any window, kept
  in an incrementally-updated ledger rather than recomputed from transcripts.

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
npm start          # desktop app
npm run serve      # LAN web app, for phones
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
