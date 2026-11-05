"""Request/response message base and proto3 JSON scalar types (AIP-140/141/142)."""

from __future__ import annotations

import re
from datetime import UTC, datetime
from typing import Annotated, Any

from pydantic import (
    AfterValidator,
    BaseModel,
    BeforeValidator,
    ConfigDict,
    PlainSerializer,
    SerializerFunctionWrapHandler,
    WithJsonSchema,
    model_serializer,
)
from pydantic.alias_generators import to_camel

INT64_MIN = -(2**63)
INT64_MAX = 2**63 - 1

_INTEGER = re.compile(r"^-?\d+$")
_FIELD_PATH = re.compile(r"^[a-z][A-Za-z0-9]*(\.[a-z][A-Za-z0-9]*)*$")


class ProtoMessage(BaseModel):
    """A message in the proto3 JSON mapping.

    Fields are snake_case in Python and lowerCamelCase on the wire; both names
    are accepted on input. Unknown fields are rejected. ``None`` fields are
    omitted from the output, like unset proto3 fields.
    """

    model_config = ConfigDict(
        alias_generator=to_camel,
        validate_by_name=True,
        validate_by_alias=True,
        serialize_by_alias=True,
        extra="forbid",
    )

    # No return annotation: pydantic then keeps the per-field JSON schema.
    @model_serializer(mode="wrap")
    def _omit_unset(self, handler: SerializerFunctionWrapHandler):
        data = handler(self)
        return {key: value for key, value in data.items() if value is not None}


def _parse_int64(value: Any) -> int:
    if isinstance(value, bool):
        raise ValueError("expected an int64 as a string or integer")
    if isinstance(value, str):
        if not _INTEGER.match(value):
            raise ValueError("expected a decimal int64 string")
        value = int(value)
    if not isinstance(value, int):
        raise ValueError("expected an int64 as a string or integer")
    if not INT64_MIN <= value <= INT64_MAX:
        raise ValueError("value is out of the int64 range")
    return value


def _parse_timestamp(value: Any) -> datetime:
    if isinstance(value, str):
        try:
            value = datetime.fromisoformat(value)
        except ValueError as exc:
            raise ValueError("expected an RFC 3339 timestamp") from exc
    if not isinstance(value, datetime):
        raise ValueError("expected an RFC 3339 timestamp")
    if value.tzinfo is None:
        raise ValueError("timestamp must carry a UTC offset")
    return value.astimezone(UTC)


def format_timestamp(value: datetime) -> str:
    """RFC 3339 in UTC with a ``Z`` suffix; naive values are taken as UTC."""
    utc = value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)
    return utc.replace(tzinfo=None).isoformat() + "Z"


def field_mask_paths(value: str) -> list[str]:
    """The paths of a FieldMask string (``*`` stays as one path); ``ValueError`` on bad syntax."""
    if value.strip() == "*":
        return ["*"]
    paths = [path.strip() for path in value.split(",")] if value.strip() else []
    for path in paths:
        if not _FIELD_PATH.match(path):
            raise ValueError(f"invalid field mask path {path!r}")
    return paths


def _check_field_mask(value: str) -> str:
    return ",".join(field_mask_paths(value))


Int64 = Annotated[
    int,
    BeforeValidator(_parse_int64),
    PlainSerializer(str, return_type=str, when_used="json"),
    WithJsonSchema({"type": "string", "format": "int64"}),
]
"""``int64``: accepts a JSON string or number, emits a JSON string."""

Timestamp = Annotated[
    datetime,
    BeforeValidator(_parse_timestamp),
    PlainSerializer(format_timestamp, return_type=str, when_used="json"),
    WithJsonSchema({"type": "string", "format": "date-time"}),
]
"""``google.protobuf.Timestamp``: RFC 3339, normalized to UTC."""

FieldMaskStr = Annotated[
    str,
    AfterValidator(_check_field_mask),
    WithJsonSchema(
        {"type": "string", "description": "Comma-separated lowerCamelCase field paths."}
    ),
]
"""``google.protobuf.FieldMask`` JSON form: syntax-checked, whitespace removed."""
