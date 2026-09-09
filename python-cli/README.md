# harness

A personal frontend for running projects against different models. Pick a model
when you start a session, switch it whenever you want, and keep everything on
disk so you can pick a project back up later.

A/B comparison works by running **two sessions**: same brief, different model,
then compare their stats and the files each one produced. `fork` clones a
session's history onto a second model so both arms start from identical context.

```
./setup.sh                                  # one-time
./harness.sh new "todo api" -m opus         # start a project
./harness.sh fork <session-id> -m astra     # same history, other model
./harness.sh ls                             # what have I got going
./harness.sh stats <session-id>             # turns, tokens, latency, cost
```

## Layout

```
harness/
  config.py                    models.toml -> ModelSpec
  session.py                   session state, persisted per turn
  cli.py                       argparse frontend + REPL
  ui.py                        ANSI formatting
  providers/
    base.py                    Message, Reply, Provider ABC
    anthropic_provider.py      Claude, via the anthropic SDK
    openai_provider.py         anything speaking /v1/chat/completions
    __init__.py                the registry
models.toml                    your model list (gitignored)
models.toml.example            template
```

Sessions live in `~/.harness/sessions/<id>.json` and are rewritten atomically
after every turn, so a crash costs you at most the turn in flight. Override the
location with `HARNESS_HOME`.

## Adding a model

Config edit, no code. Anything OpenAI-compatible — Astra, OpenAI, OpenRouter,
Together, vLLM, Ollama, LM Studio — is the same three lines with a different
`base_url`:

```toml
[models.astra]
provider    = "openai"
model       = "astra-1"
base_url    = "https://api.astra.example.com/v1"
api_key_env = "ASTRA_API_KEY"
```

Unrecognized keys in a model block are passed to the provider as parameters
(`temperature`, `max_tokens`, `reasoning_effort`, ...), and `[models.x.extra_body]`
passes vendor-specific fields straight through. `price_in` / `price_out` are only
used for the `/stats` cost tally.

**Astra is a placeholder** in `models.toml` until you fill in the real
`base_url` and model id.

## Adding a provider

Only needed for a backend that isn't OpenAI- or Anthropic-shaped. Subclass
`Provider`, implement `complete()`, add one line to `providers/__init__.py`.
Providers translate to and from the neutral `Message` type, which is why a
session recorded on one model replays cleanly on another.

## REPL commands

```
/model [alias]      show or switch the model - history carries over
/models             list configured models
/fork <alias> [nm]  clone this session onto another model
/new [name]         start a fresh session
/sessions           list recent sessions
/open <id>          resume another session (id prefixes work)
/system [text|-]    show / set / clear the system prompt
/dir [path]         show or set the project directory
/stats              per-model turns, tokens, latency, cost
/history            one-line-per-turn transcript
/retry [alias]      re-run the last message, optionally on another model
/undo               drop the last exchange
/thinking on|off    stream reasoning summaries
/path               path to this session's JSON
/quit
```

`"""` on its own line opens and closes a multi-line block, for pasting a whole
project brief without it firing on the first newline.

Model switches are recorded as events in the transcript, so `/stats` can show
you which model is responsible for which turns.

## Credentials

`ASTRA_API_KEY` (or whatever `api_key_env` names) for OpenAI-compatible models.
For Claude, the SDK resolves `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, or an
`ant auth login` profile on its own — no config needed. `./harness.sh models`
flags any model whose key env var is unset.

## What this does not do yet

The model can talk about your project but cannot touch it. There is no tool
loop — no file reads, writes, or shell commands — so "kick off a project" today
means the model plans and writes code into the transcript, not onto disk. The
provider interface was shaped with that next step in mind: `complete()` returns
a `Reply` that can carry tool calls, and `Message` already records which model
produced each turn.

## Environment notes

This machine's Homebrew `python@3.14` is broken: its `pyexpat` is linked against
a `libexpat` newer than macOS 26.1 ships, so `import pyexpat` fails with
`Symbol not found: _XML_SetAllocTrackerActivationThreshold`. That cascades —
`plistlib` fails, `platform.mac_ver()` returns `''`, pip's vendored `truststore`
crashes on import, and `ensurepip` dies with it, so a plain `python3 -m venv`
cannot create a working venv.

`setup.sh` works around it (bootstraps pip 25.2 by hand, installs a
`platform.mac_ver` shim into the venv, and stubs `pyexpat` for the duration of
the pip run). The workaround is confined to the venv and the install step; the
harness itself never needs `pyexpat`.

The durable fix is to stop using that interpreter — `uv` ships its own Python
builds and sidesteps it entirely:

```sh
brew install uv && uv venv && uv pip install -r requirements.txt
```
