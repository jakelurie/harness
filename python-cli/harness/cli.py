"""The frontend: start a project, pick a model, switch it whenever you like."""

from __future__ import annotations

import argparse
import atexit
import readline
import sys
import time
from pathlib import Path
from typing import Optional

from . import config as cfgmod
from . import providers, ui
from .config import Config, ModelSpec
from .session import Session

HISTORY_FILE = cfgmod.HOME / "repl-history"


# ---------------------------------------------------------------- provider cache

_CLIENTS: dict[str, providers.Provider] = {}


def client_for(spec: ModelSpec) -> providers.Provider:
    """Providers are built once per alias and reused for the whole process."""
    if spec.alias not in _CLIENTS:
        _CLIENTS[spec.alias] = providers.get(spec.provider)(spec)
    return _CLIENTS[spec.alias]


# ---------------------------------------------------------------------- the REPL


class Repl:
    def __init__(self, session: Session, cfg: Config):
        self.s = session
        self.cfg = cfg
        self.show_thinking = False
        self.running = True

    # -- turn execution ----------------------------------------------------

    def send(self, text: str, model_alias: Optional[str] = None) -> None:
        alias = model_alias or self.s.model
        try:
            spec = self.cfg.get(alias)
            provider = client_for(spec)
        except Exception as e:  # noqa: BLE001 - config error or missing SDK
            print(ui.err(f"  {e}"))
            return

        self.s.add_user(text)
        color = ui.model_color(alias)
        print(f"\n{color}{ui.BOLD}{spec.display}{ui.RESET}")

        state = {"thinking_open": False, "started": False}

        def on_thinking(chunk: str) -> None:
            if not self.show_thinking:
                return
            if not state["thinking_open"]:
                print(ui.dim("  [thinking] "), end="", flush=True)
                state["thinking_open"] = True
            print(ui.dim(chunk), end="", flush=True)

        def on_text(chunk: str) -> None:
            if state["thinking_open"]:
                print("\n")
                state["thinking_open"] = False
            state["started"] = True
            print(chunk, end="", flush=True)

        try:
            reply = provider.complete(
                self.s.messages,
                system=self.s.system or None,
                on_text=on_text,
                on_thinking=on_thinking,
            )
        except KeyboardInterrupt:
            print(ui.warn("\n  interrupted - turn discarded"))
            self.s.messages.pop()  # don't persist a user turn with no answer
            return

        if state["started"]:
            print()

        if not reply.ok:
            print(ui.err(f"  {reply.error}"))
            self.s.messages.pop()  # keep the transcript clean; /retry re-sends
            return

        if not state["started"] and reply.text:
            print(reply.text)

        self.s.add_assistant(reply)
        self.s.save()
        self._print_meta(spec, reply)

    def _print_meta(self, spec: ModelSpec, reply) -> None:
        cost = spec.cost(reply.input_tokens, reply.output_tokens)
        bits = [
            f"{reply.latency_ms / 1000:.1f}s",
            f"in {reply.input_tokens:,}",
            f"out {reply.output_tokens:,}",
        ]
        if reply.cached_tokens:
            bits.append(f"cached {reply.cached_tokens:,}")
        if cost:
            bits.append(ui.fmt_cost(cost))
        print(ui.dim("  " + " · ".join(bits)))

    # -- slash commands ----------------------------------------------------

    def dispatch(self, line: str) -> None:
        parts = line[1:].split(None, 1)
        cmd = parts[0].lower() if parts else ""
        arg = parts[1].strip() if len(parts) > 1 else ""
        handler = getattr(self, f"cmd_{cmd}", None)
        if handler is None:
            print(ui.err(f"  unknown command /{cmd} - try /help"))
            return
        handler(arg)

    def cmd_help(self, arg: str) -> None:
        print(HELP)

    def cmd_quit(self, arg: str) -> None:
        self.running = False

    cmd_q = cmd_exit = cmd_quit

    def cmd_model(self, arg: str) -> None:
        """Switch models mid-session. History carries over untouched."""
        if not arg:
            spec = self.cfg.get(self.s.model)
            print(f"  {ui.bold(spec.display)}  {ui.dim(f'{spec.provider}:{spec.model}')}")
            return
        try:
            spec = self.cfg.get(arg)
        except KeyError as e:
            print(ui.err(f"  {e}"))
            return
        prev = self.s.model
        self.s.switch_model(arg)
        self.s.save()
        print(ui.ok(f"  {prev} -> {arg}") + ui.dim(f"  ({len(self.s.messages)} turns carried over)"))

    def cmd_models(self, arg: str) -> None:
        print_models(self.cfg, current=self.s.model)

    def cmd_fork(self, arg: str) -> None:
        """/fork <model> [name] - clone this session onto another model."""
        if not arg:
            print(ui.err("  usage: /fork <model> [name]"))
            return
        bits = arg.split(None, 1)
        alias, name = bits[0], (bits[1] if len(bits) > 1 else None)
        try:
            self.cfg.get(alias)
        except KeyError as e:
            print(ui.err(f"  {e}"))
            return
        twin = self.s.fork(alias, name=name)
        print(ui.ok(f"  forked -> {twin.id}"))
        print(ui.dim(f"  {len(twin.messages)} turns copied · continue it with: harness open {twin.id}"))

    def cmd_new(self, arg: str) -> None:
        name = arg or "untitled"
        self.s.save()
        self.s = Session.create(name, self.s.model, Path.cwd())
        self.s.mark_last()
        print(ui.ok(f"  new session {self.s.id}"))

    def cmd_sessions(self, arg: str) -> None:
        print_sessions(self.cfg, limit=15)

    cmd_ls = cmd_sessions

    def cmd_open(self, arg: str) -> None:
        if not arg:
            print(ui.err("  usage: /open <session-id-prefix>"))
            return
        try:
            other = Session.load(arg)
        except (FileNotFoundError, ValueError) as e:
            print(ui.err(f"  {e}"))
            return
        self.s.save()
        self.s = other
        self.s.mark_last()
        print(ui.ok(f"  opened {other.id}") + ui.dim(f"  ({len(other.messages)} turns, model {other.model})"))

    def cmd_system(self, arg: str) -> None:
        if not arg:
            print(f"  {self.s.system or ui.dim('(none)')}")
            return
        self.s.system = "" if arg == "-" else arg
        self.s.save()
        print(ui.ok("  system prompt " + ("cleared" if arg == "-" else "set")))

    def cmd_dir(self, arg: str) -> None:
        if not arg:
            print(f"  {self.s.project_dir}")
            return
        p = Path(arg).expanduser()
        p.mkdir(parents=True, exist_ok=True)
        self.s.project_dir = str(p.resolve())
        self.s.save()
        print(ui.ok(f"  project dir -> {self.s.project_dir}"))

    def cmd_stats(self, arg: str) -> None:
        print_stats(self.s, self.cfg)

    def cmd_undo(self, arg: str) -> None:
        n = self.s.undo()
        self.s.save()
        print(ui.ok(f"  dropped {n} message(s)") if n else ui.dim("  nothing to undo"))

    def cmd_retry(self, arg: str) -> None:
        """/retry [model] - re-run the last user message, optionally elsewhere."""
        last_user = next((m for m in reversed(self.s.messages) if m.role == "user"), None)
        if last_user is None:
            print(ui.dim("  nothing to retry"))
            return
        self.s.undo()
        self.send(last_user.content, model_alias=arg or None)

    def cmd_thinking(self, arg: str) -> None:
        self.show_thinking = arg.lower() not in ("off", "0", "false")
        print(ui.dim(f"  thinking display: {'on' if self.show_thinking else 'off'}"))

    def cmd_path(self, arg: str) -> None:
        print(f"  {self.s.path}")

    def cmd_history(self, arg: str) -> None:
        for m in self.s.messages:
            who = "you" if m.role == "user" else (m.model or "assistant")
            color = "" if m.role == "user" else ui.model_color(who)
            head = m.content.strip().replace("\n", " ")
            print(f"  {color}{who:>12}{ui.RESET}  {head[:100]}")

    # -- loop --------------------------------------------------------------

    def prompt(self) -> str:
        alias = self.s.model
        color = ui.model_color(alias)
        return f"{color}{alias}{ui.RESET} {ui.dim('>')} "

    def run(self) -> None:
        print_banner(self.s, self.cfg)
        buffer: list[str] = []
        multiline = False

        while self.running:
            try:
                line = input(ui.dim("... ") if multiline else self.prompt())
            except EOFError:
                print()
                break
            except KeyboardInterrupt:
                print(ui.dim("  ^C (/quit to exit)"))
                buffer, multiline = [], False
                continue

            # Triple-quote block: paste a whole project brief without it firing early.
            if line.strip() == '"""':
                multiline = not multiline
                if not multiline and buffer:
                    self.send("\n".join(buffer))
                    buffer = []
                continue
            if multiline:
                buffer.append(line)
                continue

            text = line.strip()
            if not text:
                continue
            if text.startswith("/"):
                self.dispatch(text)
                continue
            self.send(text)

        self.s.save()
        print(ui.dim(f"  saved {self.s.id}"))


# ------------------------------------------------------------------- printing

HELP = """
  /model [alias]      show or switch the model - history carries over
  /models             list configured models
  /fork <alias> [nm]  clone this session onto another model (the A/B move)
  /new [name]         start a fresh session
  /sessions           list recent sessions
  /open <id>          resume another session
  /system [text|-]    show / set / clear the system prompt
  /dir [path]         show or set the project directory
  /stats              per-model turns, tokens, cost for this session
  /history            one-line-per-turn transcript
  /retry [alias]      re-run the last message, optionally on another model
  /undo               drop the last exchange
  /thinking on|off    stream reasoning summaries
  /path               path to this session's JSON
  /quit               exit

  \"\"\" on its own line opens and closes a multi-line block.
"""


def print_banner(s: Session, cfg: Config) -> None:
    spec = cfg.models.get(s.model)
    label = spec.display if spec else ui.err(f"{s.model} (not configured)")
    print()
    print(f"  {ui.bold(s.name)}  {ui.dim(s.id)}")
    print(f"  {ui.dim('model')}  {ui.model_color(s.model)}{label}{ui.RESET}")
    print(f"  {ui.dim('dir')}    {ui.dim(s.project_dir)}")
    if s.forked_from:
        print(f"  {ui.dim('forked')} {ui.dim(s.forked_from)}")
    print(f"  {ui.dim(f'{len(s.messages)} turns · /help for commands')}")
    print()


def print_models(cfg: Config, current: Optional[str] = None) -> None:
    print()
    for alias, spec in cfg.models.items():
        mark = ui.ok(" *") if alias == current else "  "
        key_state = ""
        if spec.api_key_env and not spec.api_key:
            key_state = ui.warn(f"  [{spec.api_key_env} unset]")
        print(f"{mark} {ui.model_color(alias)}{alias:<12}{ui.RESET}"
              f"{ui.dim(f'{spec.provider}:{spec.model}')}{key_state}")
    print(ui.dim(f"\n  from {cfg.source}\n"))


def print_sessions(cfg: Config, limit: int = 20) -> None:
    rows = list(Session.list_all())[:limit]
    if not rows:
        print(ui.dim("  no sessions yet - harness new <name>"))
        return
    print()
    now = time.time()
    for s in rows:
        turns = sum(1 for m in s.messages if m.role == "assistant")
        seen = sorted({m.model for m in s.messages if m.role == "assistant" and m.model})
        # "on X" is where the next turn goes; the rest is who wrote the history.
        tag = f"on {s.model}"
        past = [m for m in seen if m != s.model]
        if past:
            tag += f" (was {'+'.join(past)})"
        sid = s.id if len(s.id) <= 36 else s.id[:35] + "\u2026"
        print(f"  {ui.model_color(s.model)}{sid:<38}{ui.RESET}"
              f"{s.name[:26]:<28}{ui.dim(f'{turns} turns · {tag} · {ui.rel_time(now - s.updated)}')}")
    print()


def print_stats(s: Session, cfg: Config) -> None:
    rows = s.stats(cfg)
    if not rows:
        print(ui.dim("  no assistant turns yet"))
        return
    print()
    print(f"  {ui.bold(s.name)}  {ui.dim(s.id)}")
    print(f"  {'model':<14}{'turns':>6}{'in':>10}{'out':>10}{'avg':>8}{'cost':>10}")
    total = 0.0
    for model, r in sorted(rows.items()):
        avg = r["ms"] / r["turns"] / 1000 if r["turns"] else 0
        total += r["cost"]
        print(f"  {ui.model_color(model)}{model:<14}{ui.RESET}{r['turns']:>6}"
              f"{r['input']:>10,}{r['output']:>10,}{avg:>7.1f}s{ui.fmt_cost(r['cost']):>10}")
    if len(rows) > 1:
        print(ui.dim(f"  {'total':<14}{'':>6}{'':>10}{'':>10}{'':>8}{ui.fmt_cost(total):>10}"))
    switches = [e for e in s.events if e["kind"] == "model_switch"]
    for e in switches:
        print(ui.dim(f"  switched {e['from']} -> {e['to']} at turn {e['turn']}"))
    print()


# ----------------------------------------------------------------- entrypoint


def setup_readline() -> None:
    cfgmod.HOME.mkdir(parents=True, exist_ok=True)
    try:
        readline.read_history_file(HISTORY_FILE)
    except (FileNotFoundError, OSError):
        pass
    readline.set_history_length(2000)
    atexit.register(lambda: readline.write_history_file(HISTORY_FILE))


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="harness", description="Multi-model project frontend")
    sub = p.add_subparsers(dest="cmd")

    new = sub.add_parser("new", help="start a new project session")
    new.add_argument("name", nargs="*", help="session name")
    new.add_argument("-m", "--model", help="model alias to start on")
    new.add_argument("-d", "--dir", help="project directory (default: cwd)")
    new.add_argument("-s", "--system", help="system prompt")

    op = sub.add_parser("open", help="resume a session")
    op.add_argument("id")

    fk = sub.add_parser("fork", help="clone a session onto another model")
    fk.add_argument("id")
    fk.add_argument("-m", "--model", required=True)
    fk.add_argument("-n", "--name")
    fk.add_argument("-d", "--dir", help="project directory for the twin")

    st = sub.add_parser("stats", help="show session stats")
    st.add_argument("id", nargs="?")

    sub.add_parser("ls", help="list sessions")
    sub.add_parser("models", help="list configured models")
    return p


def main(argv: Optional[list[str]] = None) -> int:
    args = build_parser().parse_args(argv)

    try:
        cfg = cfgmod.load()
    except (FileNotFoundError, ValueError) as e:
        print(ui.err(f"config error: {e}"), file=sys.stderr)
        return 1

    if args.cmd == "models":
        print_models(cfg)
        return 0
    if args.cmd == "ls":
        print_sessions(cfg)
        return 0
    if args.cmd == "stats":
        s = Session.load(args.id) if args.id else Session.load_last()
        if s is None:
            print(ui.err("no session"), file=sys.stderr)
            return 1
        print_stats(s, cfg)
        return 0

    if args.cmd == "new":
        model = args.model or cfg.default_model
        try:
            cfg.get(model)
        except KeyError as e:
            print(ui.err(str(e)), file=sys.stderr)
            return 1
        name = " ".join(args.name) or "untitled"
        session = Session.create(name, model, args.dir or Path.cwd(), args.system or "")
    elif args.cmd == "open":
        try:
            session = Session.load(args.id)
        except (FileNotFoundError, ValueError) as e:
            print(ui.err(str(e)), file=sys.stderr)
            return 1
        session.mark_last()
    elif args.cmd == "fork":
        try:
            src = Session.load(args.id)
            cfg.get(args.model)
        except (FileNotFoundError, ValueError, KeyError) as e:
            print(ui.err(str(e)), file=sys.stderr)
            return 1
        session = src.fork(args.model, name=args.name, project_dir=args.dir)
        session.mark_last()
    else:
        session = Session.load_last()
        if session is None:
            print(ui.dim("no previous session - starting a new one"))
            session = Session.create("untitled", cfg.default_model, Path.cwd())

    setup_readline()
    try:
        Repl(session, cfg).run()
    except KeyboardInterrupt:
        print()
    return 0
