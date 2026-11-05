"""google.rpc.Status rendering and the FastAPI exception handlers (AIP-193)."""

from __future__ import annotations

import logging
from collections.abc import Mapping, Sequence
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from bomesh.errors import FieldViolation, ServiceError, StatusCode, error_details

HTTP_STATUS: Mapping[StatusCode, int] = {
    StatusCode.CANCELLED: 499,
    StatusCode.INVALID_ARGUMENT: 400,
    StatusCode.DEADLINE_EXCEEDED: 504,
    StatusCode.NOT_FOUND: 404,
    StatusCode.ALREADY_EXISTS: 409,
    StatusCode.PERMISSION_DENIED: 403,
    StatusCode.RESOURCE_EXHAUSTED: 429,
    StatusCode.FAILED_PRECONDITION: 400,
    StatusCode.ABORTED: 409,
    StatusCode.OUT_OF_RANGE: 400,
    StatusCode.UNIMPLEMENTED: 501,
    StatusCode.INTERNAL: 500,
    StatusCode.UNAVAILABLE: 503,
    StatusCode.UNAUTHENTICATED: 401,
}

# Status for HTTP errors raised by the framework itself (routing, middleware).
_CODE_FOR_HTTP: Mapping[int, StatusCode] = {
    400: StatusCode.INVALID_ARGUMENT,
    401: StatusCode.UNAUTHENTICATED,
    403: StatusCode.PERMISSION_DENIED,
    404: StatusCode.NOT_FOUND,
    405: StatusCode.UNIMPLEMENTED,
    409: StatusCode.ABORTED,
    413: StatusCode.OUT_OF_RANGE,
    429: StatusCode.RESOURCE_EXHAUSTED,
    499: StatusCode.CANCELLED,
    501: StatusCode.UNIMPLEMENTED,
    503: StatusCode.UNAVAILABLE,
    504: StatusCode.DEADLINE_EXCEEDED,
}

_INVALID_REQUEST_MESSAGE = "Request contains an invalid argument."
_INTERNAL_MESSAGE = "Internal error."
_REQUEST_LOCATIONS = frozenset({"body", "query", "path", "header", "cookie"})

_log = logging.getLogger(__name__)


def error_body(
    code: StatusCode,
    message: str,
    *,
    http_status: int | None = None,
    reason: str | None = None,
    metadata: Mapping[str, str] | None = None,
    field_violations: Sequence[FieldViolation] = (),
) -> dict[str, Any]:
    """The HTTP envelope ``{"error": {code, message, status, details}}``."""
    return {
        "error": {
            "code": http_status if http_status is not None else HTTP_STATUS[code],
            "message": message,
            "status": code.name,
            "details": error_details(
                reason=reason,
                metadata=metadata or {},
                field_violations=field_violations,
            ),
        }
    }


def error_response(error: ServiceError) -> JSONResponse:
    http_status = HTTP_STATUS[error.code]
    body = error_body(
        error.code,
        error.message,
        http_status=http_status,
        reason=error.reason,
        metadata=error.metadata,
        field_violations=error.field_violations,
    )
    return JSONResponse(body, status_code=http_status)


def validation_violations(errors: Sequence[Mapping[str, Any]]) -> list[FieldViolation]:
    """Pydantic/FastAPI errors as field violations with lowerCamelCase JSON paths."""
    return [
        FieldViolation(field=_field_path(error), description=str(error.get("msg", "")))
        for error in errors
    ]


def register_error_handlers(app: FastAPI) -> None:
    """Render every failure, including framework ones, as the contract's Error envelope."""
    app.add_exception_handler(ServiceError, _service_error_handler)
    app.add_exception_handler(RequestValidationError, _validation_error_handler)
    app.add_exception_handler(StarletteHTTPException, _http_exception_handler)
    app.add_exception_handler(Exception, _unhandled_error_handler)


async def _service_error_handler(_: Request, exc: Exception) -> JSONResponse:
    assert isinstance(exc, ServiceError)
    return error_response(exc)


async def _validation_error_handler(_: Request, exc: Exception) -> JSONResponse:
    assert isinstance(exc, RequestValidationError)
    body = error_body(
        StatusCode.INVALID_ARGUMENT,
        _INVALID_REQUEST_MESSAGE,
        field_violations=validation_violations(exc.errors()),
    )
    return JSONResponse(body, status_code=HTTP_STATUS[StatusCode.INVALID_ARGUMENT])


async def _http_exception_handler(_: Request, exc: Exception) -> JSONResponse:
    assert isinstance(exc, StarletteHTTPException)
    code = _CODE_FOR_HTTP.get(exc.status_code) or (
        StatusCode.INTERNAL
        if exc.status_code >= 500
        else StatusCode.FAILED_PRECONDITION
    )
    message = exc.detail if isinstance(exc.detail, str) else code.name
    body = error_body(code, message, http_status=exc.status_code)
    return JSONResponse(body, status_code=exc.status_code, headers=exc.headers)


async def _unhandled_error_handler(request: Request, exc: Exception) -> JSONResponse:
    _log.exception(
        "Unhandled error on %s %s", request.method, request.url.path, exc_info=exc
    )
    body = error_body(StatusCode.INTERNAL, _INTERNAL_MESSAGE)
    return JSONResponse(body, status_code=HTTP_STATUS[StatusCode.INTERNAL])


def _field_path(error: Mapping[str, Any]) -> str:
    parts = list(error.get("loc", ()))
    if error.get("type") == "json_invalid":
        # The location of a JSON syntax error is a character offset, not a field.
        return str(parts[0]) if parts else "body"
    if parts and parts[0] in _REQUEST_LOCATIONS and len(parts) > 1:
        parts = parts[1:]
    path = ""
    for part in parts:
        if isinstance(part, int):
            path += f"[{part}]"
        else:
            segment = _camel(str(part))
            path = f"{path}.{segment}" if path else segment
    return path


def _camel(name: str) -> str:
    if "_" not in name:
        return name
    head, *rest = name.split("_")
    return head + "".join(word[:1].upper() + word[1:] for word in rest)
