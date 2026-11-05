"""Domain errors with google.rpc status semantics.

Services raise these; the API boundary renders them as ``google.rpc.Status``.
Nothing here knows about HTTP.
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from enum import IntEnum
from typing import Any, ClassVar

_REASON = re.compile(r"^[A-Z][A-Z0-9_]+[A-Z0-9]$")

ERROR_DOMAIN = "bomesh.app"
ERROR_INFO_TYPE = "type.googleapis.com/google.rpc.ErrorInfo"
BAD_REQUEST_TYPE = "type.googleapis.com/google.rpc.BadRequest"


class StatusCode(IntEnum):
    """``google.rpc.Code``: the member name is the wire status, the value the numeric code."""

    CANCELLED = 1
    INVALID_ARGUMENT = 3
    DEADLINE_EXCEEDED = 4
    NOT_FOUND = 5
    ALREADY_EXISTS = 6
    PERMISSION_DENIED = 7
    RESOURCE_EXHAUSTED = 8
    FAILED_PRECONDITION = 9
    ABORTED = 10
    OUT_OF_RANGE = 11
    UNIMPLEMENTED = 12
    INTERNAL = 13
    UNAVAILABLE = 14
    UNAUTHENTICATED = 16


@dataclass(frozen=True, slots=True)
class FieldViolation:
    """One bad request field (``google.rpc.BadRequest.FieldViolation``).

    ``field`` is the lowerCamelCase JSON path of the offending field.
    """

    field: str
    description: str
    reason: str | None = None


class ServiceError(Exception):
    """A failure the caller may see, carrying its status code and ErrorInfo reason."""

    code: ClassVar[StatusCode] = StatusCode.INTERNAL

    def __init__(
        self,
        message: str,
        *,
        reason: str | None = None,
        metadata: Mapping[str, str] | None = None,
    ) -> None:
        if reason is not None and not _REASON.match(reason):
            raise ValueError(f"error reason must be UPPER_SNAKE_CASE, got {reason!r}")
        super().__init__(message)
        self.message = message
        self.reason = reason
        self.metadata: dict[str, str] = dict(metadata or {})
        self.field_violations: tuple[FieldViolation, ...] = ()


class InvalidArgument(ServiceError):
    code = StatusCode.INVALID_ARGUMENT

    def __init__(
        self,
        message: str,
        *,
        reason: str | None = None,
        metadata: Mapping[str, str] | None = None,
        field_violations: Iterable[FieldViolation] = (),
    ) -> None:
        super().__init__(message, reason=reason, metadata=metadata)
        self.field_violations = tuple(field_violations)

    @classmethod
    def for_field(
        cls, field: str, description: str, *, reason: str | None = None
    ) -> InvalidArgument:
        """A single-field violation whose message is the field description."""
        return cls(
            description,
            reason=reason,
            field_violations=(FieldViolation(field, description),),
        )


class FailedPrecondition(ServiceError):
    code = StatusCode.FAILED_PRECONDITION


class OutOfRange(ServiceError):
    code = StatusCode.OUT_OF_RANGE


class Unauthenticated(ServiceError):
    code = StatusCode.UNAUTHENTICATED


class PermissionDenied(ServiceError):
    code = StatusCode.PERMISSION_DENIED


class NotFound(ServiceError):
    code = StatusCode.NOT_FOUND


class AlreadyExists(ServiceError):
    code = StatusCode.ALREADY_EXISTS


class Aborted(ServiceError):
    code = StatusCode.ABORTED


class ResourceExhausted(ServiceError):
    code = StatusCode.RESOURCE_EXHAUSTED


class Cancelled(ServiceError):
    code = StatusCode.CANCELLED


class DeadlineExceeded(ServiceError):
    code = StatusCode.DEADLINE_EXCEEDED


class Unimplemented(ServiceError):
    code = StatusCode.UNIMPLEMENTED


class Internal(ServiceError):
    code = StatusCode.INTERNAL


class Unavailable(ServiceError):
    code = StatusCode.UNAVAILABLE


def error_details(
    *,
    reason: str | None,
    metadata: Mapping[str, str],
    field_violations: Sequence[FieldViolation] = (),
) -> list[dict[str, Any]]:
    """The ``details`` array: always one ErrorInfo, plus BadRequest for field violations."""
    info: dict[str, Any] = {"@type": ERROR_INFO_TYPE}
    if reason is not None:
        info["reason"] = reason
    info["domain"] = ERROR_DOMAIN
    info["metadata"] = dict(metadata)
    details = [info]
    if field_violations:
        details.append(
            {
                "@type": BAD_REQUEST_TYPE,
                "fieldViolations": [_violation(v) for v in field_violations],
            }
        )
    return details


def rpc_status(error: ServiceError) -> dict[str, Any]:
    """``google.rpc.Status`` with the numeric rpc code, as stored in ``Operation.error``."""
    return {
        "code": int(error.code),
        "message": error.message,
        "details": error_details(
            reason=error.reason,
            metadata=error.metadata,
            field_violations=error.field_violations,
        ),
    }


def _violation(violation: FieldViolation) -> dict[str, str]:
    rendered = {"field": violation.field, "description": violation.description}
    if violation.reason is not None:
        rendered["reason"] = violation.reason
    return rendered
