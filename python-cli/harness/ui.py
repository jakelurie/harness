"""Terminal formatting. No dependencies - just ANSI."""

from __future__ import annotations

import os
import sys

_NO_COLOR = bool(os.environ.get("NO_COLOR")) or not sys.stdout.isatty()


def _c(code: str) -> str:
    return "" if _NO_COLOR else code


DIM = _c("\033[2m")
BOLD = _c("\033[1m")
RESET = _c("\033[0m")
RED = _c("\033[31m")
GREEN = _c("\033[32m")
YELLOW = _c("\033[33m")
BLUE = _c("\033[34m")
MAGENTA = _c("\033[35m")
CYAN = _c("\033[36m")

# Stable per-model color so two sessions are visually distinguishable at a glance.
_PALETTE = [CYAN, MAGENTA, GREEN, YELLOW, BLUE]


def model_color(alias: str) -> str:
    if _NO_COLOR:
        return ""
    return _PALETTE[sum(alias.encode()) % len(_PALETTE)]


def dim(text: str) -> str:
    return f"{DIM}{text}{RESET}"


def bold(text: str) -> str:
    return f"{BOLD}{text}{RESET}"


def err(text: str) -> str:
    return f"{RED}{text}{RESET}"


def warn(text: str) -> str:
    return f"{YELLOW}{text}{RESET}"


def ok(text: str) -> str:
    return f"{GREEN}{text}{RESET}"


def rel_time(delta: float) -> str:
    delta = max(0, int(delta))
    for unit, size in (("d", 86400), ("h", 3600), ("m", 60)):
        if delta >= size:
            return f"{delta // size}{unit} ago"
    return "just now"


def fmt_cost(dollars: float) -> str:
    if dollars == 0:
        return "$0"
    if dollars < 0.01:
        return f"${dollars:.4f}"
    return f"${dollars:.2f}"
