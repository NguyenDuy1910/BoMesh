"""JSON-answering model calls for question generation and judging.

Calls go through the runtime's OpenRouter transport with no model override,
so they always use the configured ``OPENROUTER_MODEL``.
"""

from __future__ import annotations

import asyncio
import json
from hashlib import sha256
from pathlib import Path
from string import Template
from typing import Any

from bomesh import ModelResponseClient

PROMPTS_ROOT = Path(__file__).resolve().parent / "prompts"


def render(prompt_name: str, **values: object) -> str:
    """Fill ``prompts/<name>.md``; non-string values are embedded as JSON."""

    template = Template((PROMPTS_ROOT / f"{prompt_name}.md").read_text("utf-8"))
    return template.substitute(
        {
            key: value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
            for key, value in values.items()
        }
    )


class JsonCache:
    """Append-only on-disk cache of model answers, keyed by request digest."""

    def __init__(self, path: Path) -> None:
        self._path = path
        self._entries: dict[str, dict[str, Any]] = {}
        self._lock = asyncio.Lock()
        if path.exists():
            with path.open(encoding="utf-8") as handle:
                for line in handle:
                    if line.strip():
                        record = json.loads(line)
                        self._entries[record["key"]] = record["value"]

    def get(self, key: str) -> dict[str, Any] | None:
        return self._entries.get(key)

    async def put(self, key: str, value: dict[str, Any]) -> None:
        async with self._lock:
            self._entries[key] = value
            self._path.parent.mkdir(parents=True, exist_ok=True)
            with self._path.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps({"key": key, "value": value}, ensure_ascii=False) + "\n")


class JsonModel:
    """Ask the configured model for one JSON object."""

    def __init__(
        self,
        transport: ModelResponseClient,
        *,
        model_name: str | None,
        cache: JsonCache | None = None,
        max_output_tokens: int = 4_096,
        attempts: int = 2,
    ) -> None:
        if attempts < 1:
            raise ValueError("attempts must be at least one")
        self._transport = transport
        self.model_name = model_name
        self._cache = cache
        self._max_output_tokens = max_output_tokens
        self._attempts = attempts

    async def ask(self, prompt: str) -> dict[str, Any]:
        key = sha256(f"{self.model_name}\0{prompt}".encode()).hexdigest()
        if self._cache is not None and (cached := self._cache.get(key)) is not None:
            return cached
        last_error: Exception | None = None
        for _ in range(self._attempts):
            response = await self._transport.responses(
                input=prompt,
                max_output_tokens=self._max_output_tokens,
                temperature=0,
            )
            raw_text = getattr(response, "output_text", None)
            try:
                if not isinstance(raw_text, str) or not raw_text.strip():
                    raise ValueError(
                        f"model returned no text (status={getattr(response, 'status', '?')})"
                    )
                value = json.loads(json_object_text(raw_text))
            except ValueError as exc:
                last_error = exc
                continue
            if self._cache is not None:
                await self._cache.put(key, value)
            return value
        raise ValueError(f"no valid JSON answer after {self._attempts} attempts: {last_error}")


def json_object_text(raw_text: str) -> str:
    """The outermost ``{...}`` a model wrote, ignoring fences and prose."""

    start = raw_text.find("{")
    end = raw_text.rfind("}")
    if start < 0 or end <= start:
        raise ValueError("answer contains no JSON object")
    return raw_text[start : end + 1]


__all__ = ["JsonCache", "JsonModel", "json_object_text", "render"]
