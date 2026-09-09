"""Session store. A session is one project run: a directory, a model, a transcript.

Sessions are the A/B unit. Point two sessions at the same brief with different
models, then compare `/stats` and the files they produced.

State lives in ~/.harness/sessions/<id>.json and is rewritten atomically after
every turn, so a crash or a Ctrl-C never costs you more than the turn in flight.
"""

from __future__ import annotations

import json
import os
import re
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterator, Optional

from .config import HOME
from .providers.base import Message

SESSION_DIR = HOME / "sessions"
LAST_POINTER = HOME / "last-session"


def _slug(text: str, limit: int = 20) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return s[:limit] or "session"


@dataclass
class Session:
    id: str
    name: str
    model: str                                  # current model alias
    project_dir: str
    system: str = ""
    created: float = field(default_factory=time.time)
    updated: float = field(default_factory=time.time)
    messages: list[Message] = field(default_factory=list)
    events: list[dict] = field(default_factory=list)   # model switches, forks
    forked_from: Optional[str] = None

    # -- lifecycle ---------------------------------------------------------

    @classmethod
    def create(
        cls,
        name: str,
        model: str,
        project_dir: str | Path,
        system: str = "",
    ) -> "Session":
        stamp = time.strftime("%Y%m%d-%H%M%S")
        sid = f"{stamp}-{_slug(name)}"
        s = cls(
            id=sid,
            name=name,
            model=model,
            project_dir=str(Path(project_dir).expanduser().resolve()),
            system=system,
        )
        s.log_event("created", model=model, project_dir=s.project_dir)
        s.save()
        s.mark_last()
        return s

    def fork(self, model: str, name: Optional[str] = None,
             project_dir: Optional[str | Path] = None) -> "Session":
        """Clone this session's history onto a different model.

        This is the A/B move: run a brief on one model, fork at any point, and let
        a second model continue from the identical context in its own directory.
        """
        stamp = time.strftime("%Y%m%d-%H%M%S")
        name = name or f"{self.name} ({model})"
        twin = Session(
            id=f"{stamp}-{_slug(name)}",
            name=name,
            model=model,
            project_dir=str(Path(project_dir or self.project_dir).expanduser().resolve()),
            system=self.system,
            messages=[Message.from_dict(m.to_dict()) for m in self.messages],
            forked_from=self.id,
        )
        twin.log_event("forked", source=self.id, at_turn=len(self.messages), model=model)
        twin.save()
        return twin

    # -- persistence -------------------------------------------------------

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "model": self.model,
            "project_dir": self.project_dir,
            "system": self.system,
            "created": self.created,
            "updated": self.updated,
            "forked_from": self.forked_from,
            "events": self.events,
            "messages": [m.to_dict() for m in self.messages],
        }

    @classmethod
    def from_dict(cls, d: dict) -> "Session":
        d = dict(d)
        msgs = [Message.from_dict(m) for m in d.pop("messages", [])]
        known = {k: v for k, v in d.items() if k in cls.__dataclass_fields__}
        return cls(messages=msgs, **known)

    @property
    def path(self) -> Path:
        return SESSION_DIR / f"{self.id}.json"

    def save(self) -> None:
        SESSION_DIR.mkdir(parents=True, exist_ok=True)
        self.updated = time.time()
        tmp = self.path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(self.to_dict(), indent=2))
        os.replace(tmp, self.path)  # atomic: never a half-written transcript

    def mark_last(self) -> None:
        HOME.mkdir(parents=True, exist_ok=True)
        LAST_POINTER.write_text(self.id)

    @classmethod
    def load(cls, sid: str) -> "Session":
        path = SESSION_DIR / f"{sid}.json"
        if not path.exists():
            matches = [p for p in cls.list_paths() if p.stem.startswith(sid)]
            if len(matches) == 1:
                path = matches[0]
            elif not matches:
                raise FileNotFoundError(f"no session matching {sid!r}")
            else:
                names = ", ".join(p.stem for p in matches[:5])
                raise ValueError(f"{sid!r} is ambiguous: {names}")
        return cls.from_dict(json.loads(path.read_text()))

    @classmethod
    def list_paths(cls) -> list[Path]:
        if not SESSION_DIR.exists():
            return []
        return sorted(SESSION_DIR.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True)

    @classmethod
    def list_all(cls) -> Iterator["Session"]:
        for p in cls.list_paths():
            try:
                yield cls.from_dict(json.loads(p.read_text()))
            except (json.JSONDecodeError, TypeError):
                continue  # a corrupt file shouldn't hide the rest

    @classmethod
    def load_last(cls) -> Optional["Session"]:
        if not LAST_POINTER.exists():
            return None
        try:
            return cls.load(LAST_POINTER.read_text().strip())
        except (FileNotFoundError, ValueError):
            return None

    # -- transcript --------------------------------------------------------

    def log_event(self, kind: str, **payload) -> None:
        self.events.append({"ts": time.time(), "turn": len(self.messages),
                            "kind": kind, **payload})

    def add_user(self, text: str) -> Message:
        m = Message(role="user", content=text)
        self.messages.append(m)
        return m

    def add_assistant(self, reply) -> Message:
        m = Message(
            role="assistant",
            content=reply.text,
            model=reply.alias or reply.model,
            provider=reply.provider,
            usage=reply.usage_dict(),
            thinking=reply.thinking,
        )
        self.messages.append(m)
        return m

    def switch_model(self, alias: str) -> None:
        """Swap models mid-session. Recorded in the transcript so you can see
        exactly which turns each model is responsible for."""
        if alias == self.model:
            return
        self.log_event("model_switch", **{"from": self.model, "to": alias})
        self.model = alias

    def undo(self) -> int:
        """Drop the trailing assistant turn and the user turn that prompted it."""
        dropped = 0
        if self.messages and self.messages[-1].role == "assistant":
            self.messages.pop()
            dropped += 1
        if self.messages and self.messages[-1].role == "user":
            self.messages.pop()
            dropped += 1
        return dropped

    # -- reporting ---------------------------------------------------------

    def stats(self, cfg) -> dict:
        """Per-model tallies. The comparison payoff when A/B-ing two sessions."""
        by_model: dict[str, dict] = {}
        for m in self.messages:
            if m.role != "assistant":
                continue
            key = m.model or "unknown"
            row = by_model.setdefault(
                key, {"turns": 0, "input": 0, "output": 0, "ms": 0, "cost": 0.0}
            )
            row["turns"] += 1
            row["input"] += m.usage.get("input_tokens", 0)
            row["output"] += m.usage.get("output_tokens", 0)
            row["ms"] += m.usage.get("latency_ms", 0)
            spec = cfg.models.get(key)
            if spec:
                row["cost"] += spec.cost(
                    m.usage.get("input_tokens", 0), m.usage.get("output_tokens", 0)
                )
        return by_model
