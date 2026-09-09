"""Provider-neutral types and the Provider interface.

Everything in the harness speaks `Message` and `Reply`. A provider's only job is
to translate those to and from its own wire format, so a session recorded against
one model replays cleanly against another.
"""

from __future__ import annotations

import time
from abc import ABC, abstractmethod
from dataclasses import dataclass, field, asdict
from typing import Any, Callable, Optional


@dataclass
class Message:
    """One canonical turn. Provider-neutral on purpose."""

    role: str  # "user" | "assistant"
    content: str
    model: Optional[str] = None      # which model produced it (assistant turns)
    provider: Optional[str] = None
    ts: float = field(default_factory=time.time)
    usage: dict = field(default_factory=dict)
    thinking: str = ""

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict) -> "Message":
        known = {k: v for k, v in d.items() if k in cls.__dataclass_fields__}
        return cls(**known)


@dataclass
class Reply:
    """What a provider hands back for one completion."""

    text: str = ""
    thinking: str = ""
    alias: str = ""
    model: str = ""
    provider: str = ""
    input_tokens: int = 0
    output_tokens: int = 0
    cached_tokens: int = 0
    latency_ms: int = 0
    stop_reason: Optional[str] = None
    error: Optional[str] = None

    @property
    def ok(self) -> bool:
        return self.error is None

    def usage_dict(self) -> dict:
        return {
            "input_tokens": self.input_tokens,
            "output_tokens": self.output_tokens,
            "cached_tokens": self.cached_tokens,
            "latency_ms": self.latency_ms,
            "stop_reason": self.stop_reason,
        }


# Called with each token as it arrives. Compare mode passes None (no streaming).
TextSink = Optional[Callable[[str], None]]


class Provider(ABC):
    """Base class for a backend. Subclass, register, done.

    Adding a new backend is: implement `complete`, add one line to
    providers/__init__.py, add a block to models.toml. No CLI changes.
    """

    #: short id used as `provider = "..."` in models.toml
    kind: str = "base"

    def __init__(self, spec: Any):
        self.spec = spec

    @abstractmethod
    def complete(
        self,
        messages: list[Message],
        system: Optional[str] = None,
        on_text: TextSink = None,
        on_thinking: TextSink = None,
    ) -> Reply:
        """Run one completion over the given history."""

    # -- helpers shared by subclasses -------------------------------------

    def _blank_reply(self) -> Reply:
        return Reply(
            alias=self.spec.alias,
            model=self.spec.model,
            provider=self.kind,
        )

    @staticmethod
    def _elapsed_ms(start: float) -> int:
        return int((time.monotonic() - start) * 1000)
