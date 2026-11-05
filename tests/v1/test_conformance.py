"""Every ``openapi.yaml`` operation is routed exactly, and nothing else lives under ``/api/v1``.

One test per operation, its ID ``<Tag>-<operationId>``: the method and path
must reach a route (first full match, in routing order) whose ``name`` is the
operationId, and the generated OpenAPI ``operationId`` must equal it. Slices
run ``-k <Tag>``. This fails until every slice has landed.
"""

from __future__ import annotations

import re
from functools import cache
from pathlib import Path
from typing import Any

import pytest
import yaml
from fastapi import FastAPI
from fastapi.routing import APIRoute
from starlette.routing import Match

from api.app import API_PREFIX, UPLOAD_PREFIX, create_app
from bomesh.runtime import AppRuntime
from config.env_config import AppConfig

OPENAPI = Path(__file__).resolve().parents[2] / "backend" / "docs_design" / "openapi.yaml"
HTTP_METHODS = ("get", "post", "patch", "delete", "put")
_SAMPLE_ID = "0b6f2f0e-3c1a-4c8e-9a51-4e0f6b2f7a10"


@cache
def _contract() -> tuple[tuple[str, str, str, str], ...]:
    """``(tag, operationId, METHOD, path)`` of every contract operation."""
    spec = yaml.safe_load(OPENAPI.read_text())
    return tuple(
        (operation["tags"][0], operation["operationId"], method.upper(), path)
        for path, item in spec["paths"].items()
        for method, operation in item.items()
        if method in HTTP_METHODS
    )


@cache
def _app() -> FastAPI:
    return create_app(AppRuntime(AppConfig()))


@cache
def _routes() -> tuple[tuple[str, APIRoute], ...]:
    """``(prefix, route)`` of every API route, in routing order.

    FastAPI wraps each included router; walk into it so the routes the app
    actually dispatches to are checked, with the prefix they are mounted under.
    """
    flat: list[tuple[str, APIRoute]] = []

    def walk(routes: list[Any], prefix: str) -> None:
        for route in routes:
            if isinstance(route, APIRoute):
                flat.append((prefix, route))
            elif hasattr(route, "original_router"):
                walk(route.original_router.routes, prefix + route.include_context.prefix)

    walk(_app().router.routes, "")
    return tuple(flat)


def _match(method: str, path: str) -> tuple[str, APIRoute] | None:
    for prefix, route in _routes():
        if path.startswith(prefix) and route.matches(_scope(method, path[len(prefix) :]))[0] is Match.FULL:
            return prefix, route
    return None


def _concrete(path: str) -> str:
    return re.sub(r"\{[^}]+\}", _SAMPLE_ID, path)


def _scope(method: str, path: str) -> dict[str, Any]:
    return {"type": "http", "method": method, "path": path, "root_path": ""}


@pytest.mark.parametrize(
    ("tag", "operation_id", "method", "path"),
    _contract(),
    ids=[f"{tag}-{operation_id}" for tag, operation_id, _, _ in _contract()],
)
def test_operation_is_routed(tag: str, operation_id: str, method: str, path: str) -> None:
    found = _match(method, _concrete(path))
    assert found is not None, f"{method} {path} is not routed"
    prefix, matched = found
    assert matched.name == operation_id, (
        f"{method} {path} reaches {matched.name!r}, expected {operation_id!r}"
    )
    assert prefix + matched.path_format == path
    assert tag in (matched.tags or [])
    generated = _app().openapi()["paths"][path][method.lower()]
    assert generated["operationId"] == operation_id


def test_no_route_outside_the_contract() -> None:
    contract = {(method, path) for _, _, method, path in _contract()}
    extra = sorted(
        f"{method} {prefix}{route.path_format}"
        for prefix, route in _routes()
        if (prefix + route.path_format).startswith((f"{API_PREFIX}/", f"{UPLOAD_PREFIX}/"))
        for method in route.methods
        if (method, prefix + route.path_format) not in contract
    )
    assert extra == []
