"""``updateMask`` (AIP-134, AIP-161): which fields an Update changes, and to what."""

from __future__ import annotations

from collections.abc import Iterable, Iterator
from dataclasses import dataclass
from typing import Any

from pydantic import BaseModel

from bomesh.errors import InvalidArgument

from .messages import field_mask_paths

FULL_REPLACEMENT = "*"


@dataclass(frozen=True, slots=True)
class FieldMask:
    """Resolved mask: mutable lowerCamelCase paths, in the resource's declared order."""

    paths: tuple[str, ...]
    full_replacement: bool = False


class MutableFields:
    """The paths an Update method may change, e.g. ``("displayName", "collection.description")``.

    A path that names a sub-message (``collection``) selects every mutable path
    below it.
    """

    def __init__(self, paths: Iterable[str], *, field: str = "updateMask") -> None:
        self.paths = tuple(paths)
        self.field = field
        field_mask_paths(",".join(self.paths))

    def parse(self, update_mask: str | None, message: BaseModel) -> FieldMask:
        """Resolve ``update_mask`` for ``message``.

        Omitted: every mutable field populated in ``message``. ``*``: every
        mutable field, so unset ones are cleared. Otherwise each path must be
        mutable; immutable, output-only and unknown paths are INVALID_ARGUMENT.
        """
        if update_mask is None or not update_mask.strip():
            populated = set(_populated_paths(message))
            return FieldMask(tuple(path for path in self.paths if path in populated))
        try:
            requested = field_mask_paths(update_mask)
        except ValueError as exc:
            raise InvalidArgument.for_field(self.field, str(exc)) from None
        if requested == [FULL_REPLACEMENT]:
            return FieldMask(self.paths, full_replacement=True)
        selected: set[str] = set()
        for path in requested:
            covered = [
                mutable
                for mutable in self.paths
                if mutable == path or mutable.startswith(f"{path}.")
            ]
            if not covered:
                raise InvalidArgument.for_field(
                    self.field,
                    f"{path!r} cannot be updated; mutable fields: {', '.join(self.paths) or 'none'}",
                )
            selected.update(covered)
        return FieldMask(tuple(path for path in self.paths if path in selected))


def apply(mask: FieldMask, message: BaseModel) -> dict[str, Any]:
    """Changes keyed by mask path; a path unset in ``message`` maps to ``None`` (clear)."""
    return {path: _value_at(message, path) for path in mask.paths}


def _value_at(message: BaseModel, path: str) -> Any:
    value: Any = message
    for segment in path.split("."):
        if not isinstance(value, BaseModel):
            return None
        attribute = _attribute(type(value), segment)
        if attribute is None:
            raise ValueError(f"{type(message).__name__} has no field {path!r}")
        value = getattr(value, attribute)
    return value


def _populated_paths(message: BaseModel, prefix: str = "") -> Iterator[str]:
    fields = type(message).model_fields
    for attribute in message.model_fields_set:
        path = f"{prefix}{fields[attribute].alias or attribute}"
        yield path
        value = getattr(message, attribute)
        if isinstance(value, BaseModel):
            yield from _populated_paths(value, f"{path}.")


def _attribute(model: type[BaseModel], json_name: str) -> str | None:
    for attribute, info in model.model_fields.items():
        if json_name in {attribute, info.alias}:
            return attribute
    return None
