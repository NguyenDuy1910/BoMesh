"""Resource-name patterns (AIP-122): parse names into IDs and format IDs into names."""

from __future__ import annotations

import re
from collections.abc import Iterable, Mapping
from uuid import UUID

from bomesh.errors import InvalidArgument

WILDCARD = "-"

_VARIABLE = re.compile(r"^\{([a-z][A-Za-z0-9]*)\}$")
_COLLECTION = re.compile(r"^[a-z][A-Za-z0-9]*$")


class ResourcePattern:
    """A pattern such as ``workspaces/{workspace}/items/{item}``.

    ``uuid`` lists the variables whose IDs must be UUIDs. ``wildcard`` lists the
    variables that accept ``-`` (AIP-159 reads across parents). ``aliases``
    maps a variable to the alias IDs it accepts, e.g. ``{"member": {"me"}}``.
    Wildcards and aliases are returned as-is; callers resolve them.
    """

    def __init__(
        self,
        template: str,
        *,
        uuid: Iterable[str] = (),
        wildcard: Iterable[str] = (),
        aliases: Mapping[str, Iterable[str]] | None = None,
    ) -> None:
        self.template = template
        self._segments: tuple[tuple[str, bool], ...] = tuple(_compile(template))
        self.variables: tuple[str, ...] = tuple(
            text for text, is_var in self._segments if is_var
        )
        self._uuid = frozenset(uuid)
        self._wildcard = frozenset(wildcard)
        self._aliases = {
            variable: frozenset(values) for variable, values in (aliases or {}).items()
        }
        unknown = (self._uuid | self._wildcard | self._aliases.keys()) - set(
            self.variables
        )
        if unknown:
            raise ValueError(f"{template!r} has no variables {sorted(unknown)}")

    def parse(self, name: str, *, field: str = "name") -> dict[str, str]:
        """IDs keyed by variable; INVALID_ARGUMENT on ``field`` when ``name`` does not match."""
        parts = name.split("/")
        if len(parts) != len(self._segments):
            raise self._mismatch(name, field)
        ids: dict[str, str] = {}
        for part, (text, is_var) in zip(parts, self._segments, strict=True):
            if not is_var:
                if part != text:
                    raise self._mismatch(name, field)
                continue
            ids[text] = self._parse_id(text, part, name, field)
        return ids

    def matches(self, name: str) -> bool:
        try:
            self.parse(name)
        except InvalidArgument:
            return False
        return True

    def format(self, **ids: object) -> str:
        """The resource name for ``ids``; every variable is required."""
        missing = set(self.variables) - ids.keys()
        extra = ids.keys() - set(self.variables)
        if missing or extra:
            raise ValueError(
                f"{self.template!r} needs {list(self.variables)}, got {sorted(ids)}"
            )
        parts: list[str] = []
        for text, is_var in self._segments:
            if not is_var:
                parts.append(text)
                continue
            value = str(ids[text])
            if not value or "/" in value:
                raise ValueError(f"invalid {text} ID {value!r}")
            parts.append(value)
        return "/".join(parts)

    def _parse_id(self, variable: str, value: str, name: str, field: str) -> str:
        if not value:
            raise self._mismatch(name, field)
        if value == WILDCARD:
            if variable in self._wildcard:
                return value
            raise InvalidArgument.for_field(
                field, f"{field} does not accept '-' for {variable}: {name!r}"
            )
        if value in self._aliases.get(variable, ()):
            return value
        if variable in self._uuid:
            try:
                return str(UUID(value))
            except ValueError:
                raise InvalidArgument.for_field(
                    field,
                    f"{field} has an invalid {variable} ID {value!r}: expected a UUID",
                ) from None
        return value

    def _mismatch(self, name: str, field: str) -> InvalidArgument:
        return InvalidArgument.for_field(
            field, f"{field} {name!r} does not match {self.template!r}"
        )

    def __repr__(self) -> str:
        return f"ResourcePattern({self.template!r})"


def _compile(template: str) -> Iterable[tuple[str, bool]]:
    parts = template.split("/")
    for index, part in enumerate(parts):
        variable = _VARIABLE.match(part)
        if variable:
            yield variable.group(1), True
        elif _COLLECTION.match(part):
            yield part, False
        else:
            raise ValueError(f"invalid segment {part!r} at {index} in {template!r}")
