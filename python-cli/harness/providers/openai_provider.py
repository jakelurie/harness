"""OpenAI-compatible backend, via the official `openai` SDK.

Anything that speaks `POST /v1/chat/completions` lands here: Astra, OpenAI proper,
OpenRouter, Together, vLLM, Ollama, LM Studio. They differ only by `base_url`,
`api_key_env`, and `model` in models.toml.
"""

from __future__ import annotations

import time
from typing import Optional

from .base import Message, Provider, Reply, TextSink


class OpenAIProvider(Provider):
    kind = "openai"

    def __init__(self, spec):
        super().__init__(spec)
        import openai  # lazy, same reasoning as the Anthropic provider

        self._sdk = openai
        self.client = openai.OpenAI(
            api_key=spec.api_key or "no-key-needed",  # local servers ignore it
            base_url=spec.base_url or None,
            timeout=spec.params.get("timeout", 600),
        )

    def complete(
        self,
        messages: list[Message],
        system: Optional[str] = None,
        on_text: TextSink = None,
        on_thinking: TextSink = None,
    ) -> Reply:
        p = self.spec.params
        reply = self._blank_reply()

        wire = []
        if system:
            wire.append({"role": p.get("system_role", "system"), "content": system})
        wire += [{"role": m.role, "content": m.content} for m in messages if m.content]

        req = {
            "model": self.spec.model,
            "messages": wire,
            "stream": True,
            "stream_options": {"include_usage": True},
        }
        if p.get("max_tokens"):
            req["max_tokens"] = p["max_tokens"]
        if p.get("temperature") is not None:
            req["temperature"] = p["temperature"]
        if p.get("reasoning_effort"):
            req["reasoning_effort"] = p["reasoning_effort"]
        # Escape hatch for vendor-specific fields (e.g. Astra extensions) without
        # needing a code change: [models.x.extra_body] in models.toml.
        if p.get("extra_body"):
            req["extra_body"] = p["extra_body"]

        start = time.monotonic()
        try:
            stream = self.client.chat.completions.create(**req)
            usage = None
            for chunk in stream:
                if getattr(chunk, "usage", None):
                    usage = chunk.usage
                if not chunk.choices:
                    continue
                choice = chunk.choices[0]
                delta = choice.delta
                if choice.finish_reason:
                    reply.stop_reason = choice.finish_reason
                if delta is None:
                    continue
                # Some servers expose chain-of-thought on a side channel.
                rc = getattr(delta, "reasoning_content", None) or getattr(delta, "reasoning", None)
                if rc:
                    reply.thinking += rc
                    if on_thinking:
                        on_thinking(rc)
                if delta.content:
                    reply.text += delta.content
                    if on_text:
                        on_text(delta.content)
        except Exception as e:  # noqa: BLE001
            reply.latency_ms = self._elapsed_ms(start)
            reply.error = f"{type(e).__name__}: {e}"
            return reply

        reply.latency_ms = self._elapsed_ms(start)
        if usage:
            reply.input_tokens = getattr(usage, "prompt_tokens", 0) or 0
            reply.output_tokens = getattr(usage, "completion_tokens", 0) or 0
            details = getattr(usage, "prompt_tokens_details", None)
            if details:
                reply.cached_tokens = getattr(details, "cached_tokens", 0) or 0
        return reply
