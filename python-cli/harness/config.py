"""Model registry, loaded from models.toml.

Adding a model is a config edit, never a code edit. Lookup order:
  1. $HARNESS_MODELS
  2. ./models.toml            (per-project overrides)
  3. ~/.harness/models.toml   (your personal registry)
"""

from __future__ import annotations

import os
import tomllib
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

HOME = Path(os.environ.get("HARNESS_HOME", Path.home() / ".harness"))


@dataclass
class ModelSpec:
    alias: str                      # what you type: /model astra
    provider: str                   # which Provider class handles it
    model: str                      # the wire model id
    base_url: Optional[str] = None
    api_key_env: Optional[str] = None
    label: str = ""                 # display name in the prompt line
    price_in: float = 0.0           # $ per 1M input tokens, for the cost tally
    price_out: float = 0.0
    params: dict = field(default_factory=dict)

    @property
    def api_key(self) -> Optional[str]:
        return os.environ.get(self.api_key_env) if self.api_key_env else None

    @property
    def display(self) -> str:
        return self.label or self.alias

    def cost(self, input_tokens: int, output_tokens: int) -> float:
        return (input_tokens * self.price_in + output_tokens * self.price_out) / 1_000_000


@dataclass
class Config:
    models: dict[str, ModelSpec]
    default_model: str
    source: Path

    def get(self, alias: str) -> ModelSpec:
        if alias not in self.models:
            known = ", ".join(sorted(self.models))
            raise KeyError(f"unknown model {alias!r}. Configured: {known}")
        return self.models[alias]


def config_path() -> Optional[Path]:
    override = os.environ.get("HARNESS_MODELS")
    if override:
        return Path(override).expanduser()
    for cand in (Path.cwd() / "models.toml", HOME / "models.toml"):
        if cand.exists():
            return cand
    return None


def load() -> Config:
    path = config_path()
    if path is None:
        raise FileNotFoundError(
            "No models.toml found. Looked in ./models.toml and ~/.harness/models.toml.\n"
            "Copy models.toml.example to get started."
        )
    with path.open("rb") as f:
        raw = tomllib.load(f)

    models: dict[str, ModelSpec] = {}
    for alias, block in (raw.get("models") or {}).items():
        block = dict(block)
        params = block.pop("params", {}) or {}
        # Anything not a known ModelSpec field is a provider param. Keeps the
        # config terse: `temperature = 0.7` at the top level of a model block works.
        known = set(ModelSpec.__dataclass_fields__) - {"alias", "params"}
        extra = {k: v for k, v in block.items() if k not in known}
        core = {k: v for k, v in block.items() if k in known}
        models[alias] = ModelSpec(alias=alias, params={**extra, **params}, **core)

    if not models:
        raise ValueError(f"{path} defines no [models.*] blocks")

    default = raw.get("default") or next(iter(models))
    if default not in models:
        raise ValueError(f"default = {default!r} in {path} is not a configured model")

    return Config(models=models, default_model=default, source=path)
