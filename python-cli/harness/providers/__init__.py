"""Provider registry.

To add a backend: write a Provider subclass, import it here, add it to REGISTRY.
That is the whole extension point.
"""

from __future__ import annotations

from .base import Message, Provider, Reply

REGISTRY: dict[str, type[Provider]] = {}


def register(cls: type[Provider]) -> type[Provider]:
    REGISTRY[cls.kind] = cls
    return cls


def get(kind: str) -> type[Provider]:
    if kind not in REGISTRY:
        known = ", ".join(sorted(REGISTRY)) or "(none)"
        raise KeyError(f"unknown provider {kind!r}; known providers: {known}")
    return REGISTRY[kind]


def _bootstrap() -> None:
    from .anthropic_provider import AnthropicProvider
    from .openai_provider import OpenAIProvider

    register(AnthropicProvider)
    register(OpenAIProvider)


_bootstrap()

__all__ = ["Message", "Provider", "Reply", "REGISTRY", "register", "get"]
