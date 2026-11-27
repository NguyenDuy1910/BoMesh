"""A classification suite: ``eval/classification/<suite>/labels.jsonl``, one labeled sample per line.

Each line::

    {"id": "qd-123", "title": "…", "text": "…" | "path": "files/qd-123.pdf",
     "collection": "<collection item id>",                     (optional)
     "labels": {"<scheme code>": ["<notation>", …]},          judged schemes and their gold labels
     "primary": {"<scheme code>": "<notation>"},              (optional) gold primary per scheme
     "empty": ["<scheme code>", …],                           schemes judged with no label
     "metadata": {"number", "issue_date", "effective_date",   (optional) gold metadata; dates YYYY-MM-DD,
                  "issuer", "level", "units", "programs",      issuer/units/programs as notations,
                  "cohorts"}}                                   cohorts as years

A scheme is judged on a sample only when it appears in ``labels`` or ``empty``.
``path`` is relative to the suite folder and parsed like an upload.
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

CLASSIFICATION_ROOT = Path(__file__).resolve().parent
LABELS_FILE = "labels.jsonl"
METADATA_FIELDS = (
    "number",
    "issue_date",
    "effective_date",
    "issuer",
    "level",
    "units",
    "programs",
    "cohorts",
)
_LIST_FIELDS = frozenset({"units", "programs", "cohorts"})


@dataclass(frozen=True, slots=True)
class LabeledSample:
    id: str
    title: str
    text: str | None = None
    path: Path | None = None
    collection: str | None = None
    labels: Mapping[str, frozenset[str]] = field(default_factory=dict)
    primary: Mapping[str, str] = field(default_factory=dict)
    empty: frozenset[str] = frozenset()
    metadata: Mapping[str, Any] = field(default_factory=dict)

    @property
    def schemes(self) -> frozenset[str]:
        """The schemes this sample is judged on."""

        return frozenset(self.labels) | self.empty


def suite_directory(name: str) -> Path:
    return CLASSIFICATION_ROOT / name


def load_labels(path: Path) -> list[LabeledSample]:
    """Every sample of a ``labels.jsonl``; a malformed line names its line number."""

    samples: list[LabeledSample] = []
    seen: set[str] = set()
    with path.open(encoding="utf-8") as handle:
        for number, line in enumerate(handle, start=1):
            if not line.strip():
                continue
            try:
                sample = parse_sample(json.loads(line), base=path.parent)
            except (ValueError, TypeError, KeyError) as exc:
                raise ValueError(f"{path}:{number}: {exc}") from exc
            if sample.id in seen:
                raise ValueError(f"{path}:{number}: duplicate id {sample.id!r}")
            seen.add(sample.id)
            samples.append(sample)
    return samples


def parse_sample(record: Mapping[str, Any], *, base: Path) -> LabeledSample:
    sample_id = _text(record.get("id"), "id")
    title = _text(record.get("title"), "title")
    text = record.get("text")
    path = record.get("path")
    if (text is None) == (path is None):
        raise ValueError("exactly one of text and path is required")
    if text is not None and (not isinstance(text, str) or not text.strip()):
        raise ValueError("text must be a non-empty string")
    labels = {
        _text(scheme, "labels scheme"): frozenset(_text(value, "label") for value in _list(values, "labels"))
        for scheme, values in dict(record.get("labels") or {}).items()
    }
    primary = {
        _text(scheme, "primary scheme"): _text(value, "primary")
        for scheme, value in dict(record.get("primary") or {}).items()
    }
    for scheme, notation in primary.items():
        if notation not in labels.get(scheme, frozenset()):
            raise ValueError(f"primary {scheme}={notation} is not one of its labels")
    empty = frozenset(_text(scheme, "empty") for scheme in _list(record.get("empty") or [], "empty"))
    if overlap := empty & {scheme for scheme, values in labels.items() if values}:
        raise ValueError(f"schemes both labeled and empty: {', '.join(sorted(overlap))}")
    metadata = dict(record.get("metadata") or {})
    if unknown := set(metadata) - set(METADATA_FIELDS):
        raise ValueError(f"unknown metadata fields: {', '.join(sorted(unknown))}")
    return LabeledSample(
        id=sample_id,
        title=title,
        text=text,
        path=(base / _text(path, "path")) if path is not None else None,
        collection=record.get("collection") or None,
        labels=labels,
        primary=primary,
        empty=empty,
        metadata={key: _metadata_value(key, value) for key, value in metadata.items() if value not in (None, "", [])},
    )


def _metadata_value(key: str, value: Any) -> Any:
    if key in _LIST_FIELDS:
        items = _list(value, key)
        return tuple(int(item) for item in items) if key == "cohorts" else tuple(_text(item, key) for item in items)
    return _text(value, key)


def _text(value: Any, name: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{name} must be a non-empty string")
    return value.strip()


def _list(value: Any, name: str) -> list[Any]:
    if not isinstance(value, list):
        raise ValueError(f"{name} must be a list")
    return value


__all__ = [
    "CLASSIFICATION_ROOT",
    "LABELS_FILE",
    "METADATA_FIELDS",
    "LabeledSample",
    "load_labels",
    "parse_sample",
    "suite_directory",
]
