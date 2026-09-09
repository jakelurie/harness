"""Claude backend, via the official `anthropic` SDK."""

from __future__ import annotations

import time
from typing import Optional

from .base import Message, Provider, Reply, TextSink


class AnthropicProvider(Provider):
    kind = "anthropic"

    def __init__(self, spec):
        super().__init__(spec)
        import anthropic  # imported lazily so the other provider works without it

        self._sdk = anthropic
        kwargs = {}
        if spec.api_key:
            kwargs["api_key"] = spec.api_key
        if spec.base_url:
            kwargs["base_url"] = spec.base_url
        # No api_key kwarg -> the SDK resolves ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN,
        # or an `ant auth login` profile on its own.
        self.client = anthropic.Anthropic(**kwargs)

    def complete(
        self,
        messages: list[Message],
        system: Optional[str] = None,
        on_text: TextSink = None,
        on_thinking: TextSink = None,
    ) -> Reply:
        p = self.spec.params
        reply = self._blank_reply()

        wire = [{"role": m.role, "content": m.content} for m in messages if m.content]
        req = {
            "model": self.spec.model,
            "max_tokens": p.get("max_tokens", 32000),
            "messages": wire,
        }
        if system:
            req["system"] = system
        if p.get("thinking", True):
            req["thinking"] = {
                "type": "adaptive",
                # Default is "omitted" on current models, which streams empty
                # thinking blocks. We ask for a summary so /thinking can show it.
                "display": "summarized" if p.get("show_thinking", True) else "omitted",
            }
        if p.get("effort"):
            req["output_config"] = {"effort": p["effort"]}
        if p.get("temperature") is not None:
            req["temperature"] = p["temperature"]

        # Server-side fallbacks: if a safety classifier declines the request, the
        # server reroutes by category instead of handing back a dead turn.
        use_fallbacks = p.get("fallbacks", True)

        start = time.monotonic()
        try:
            msg = self._stream(req, use_fallbacks, on_text, on_thinking)
        except Exception as e:  # noqa: BLE001 - surfaced to the user, not swallowed
            if use_fallbacks and self._is_fallback_rejection(e):
                try:
                    msg = self._stream(req, False, on_text, on_thinking)
                except Exception as e2:  # noqa: BLE001
                    return self._as_error(reply, e2, start)
            else:
                return self._as_error(reply, e, start)

        reply.latency_ms = self._elapsed_ms(start)
        reply.stop_reason = getattr(msg, "stop_reason", None)

        for block in msg.content:
            if block.type == "text":
                reply.text += block.text
            elif block.type == "thinking":
                reply.thinking += getattr(block, "thinking", "") or ""

        if reply.stop_reason == "refusal":
            details = getattr(msg, "stop_details", None)
            cat = getattr(details, "category", None) if details else None
            reply.error = f"declined by safety classifier (category: {cat})"

        u = getattr(msg, "usage", None)
        if u:
            reply.input_tokens = getattr(u, "input_tokens", 0) or 0
            reply.output_tokens = getattr(u, "output_tokens", 0) or 0
            reply.cached_tokens = getattr(u, "cache_read_input_tokens", 0) or 0

        return reply

    # -- internals ---------------------------------------------------------

    def _stream(self, req: dict, use_fallbacks: bool, on_text, on_thinking):
        if use_fallbacks:
            api = self.client.beta.messages
            req = dict(req, betas=["server-side-fallback-2026-07-01"], fallbacks="default")
        else:
            api = self.client.messages

        with api.stream(**req) as stream:
            for event in stream:
                if event.type != "content_block_delta":
                    continue
                d = event.delta
                if d.type == "text_delta" and on_text:
                    on_text(d.text)
                elif d.type == "thinking_delta" and on_thinking:
                    on_thinking(d.thinking)
            return stream.get_final_message()

    def _is_fallback_rejection(self, e: Exception) -> bool:
        """The beta flag may not be enabled on this account. Degrade, don't die."""
        if not isinstance(e, self._sdk.BadRequestError):
            return False
        blob = str(e).lower()
        return "fallback" in blob or "beta" in blob

    def _as_error(self, reply: Reply, e: Exception, start: float) -> Reply:
        reply.latency_ms = self._elapsed_ms(start)
        reply.error = f"{type(e).__name__}: {e}"
        return reply
