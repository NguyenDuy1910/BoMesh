"""The google.rpc.Status envelope as a client sees it over HTTP (AIP-193)."""

from __future__ import annotations

import pytest
from fastapi import FastAPI, Query
from fastapi.testclient import TestClient

from api.aip.errors import register_error_handlers
from api.aip.messages import Int64, ProtoMessage
from bomesh.errors import (
    rpc_status,
    Aborted,
    AlreadyExists,
    FailedPrecondition,
    FieldViolation,
    InvalidArgument,
    NotFound,
    PermissionDenied,
    ResourceExhausted,
    ServiceError,
    Unauthenticated,
    Unavailable,
)

ERROR_INFO = "type.googleapis.com/google.rpc.ErrorInfo"
BAD_REQUEST = "type.googleapis.com/google.rpc.BadRequest"


class Collection(ProtoMessage):
    description: str
    max_depth: Int64 | None = None


class CreateItem(ProtoMessage):
    display_name: str
    collection: Collection | None = None
    tags: list[str] = []


def _app() -> FastAPI:
    app = FastAPI()
    register_error_handlers(app)

    @app.get("/raise/{kind}")
    def raise_error(kind: str) -> None:
        raise _ERRORS[kind]

    @app.post("/items")
    def create_item(
        item: CreateItem, page_size: int = Query(0, alias="pageSize")
    ) -> dict[str, str]:
        return {"displayName": item.display_name}

    @app.get("/crash")
    def crash() -> None:
        raise RuntimeError("password=hunter2 leaked from a driver")

    return app


_ERRORS: dict[str, ServiceError] = {
    "last-admin": FailedPrecondition(
        "Cannot remove the last workspace admin.",
        reason="LAST_ADMIN",
        metadata={"workspace": "workspaces/w1"},
    ),
    "not-found": NotFound("Item 'workspaces/w1/items/x' not found."),
    "denied": PermissionDenied(
        "Permission 'items.get' denied on resource 'workspaces/w1/items/x' (or it might not exist)."
    ),
    "exists": AlreadyExists("Item is not deleted."),
    "stale": Aborted("Stale etag.", reason="ETAG_MISMATCH"),
    "quota": ResourceExhausted("Too many requests."),
    "auth": Unauthenticated("Access token expired.", reason="ACCESS_TOKEN_EXPIRED"),
    "down": Unavailable("Search is unavailable."),
    "bad-field": InvalidArgument(
        "Request contains an invalid argument.",
        reason="REQUEST_ID_REUSED",
        field_violations=[
            FieldViolation("requestId", "requestId was used for a different request")
        ],
    ),
}


@pytest.fixture
def client() -> TestClient:
    return TestClient(_app(), raise_server_exceptions=False)


def test_service_error_renders_the_contract_envelope(client: TestClient) -> None:
    response = client.get("/raise/last-admin")

    assert response.status_code == 400
    assert response.json() == {
        "error": {
            "code": 400,
            "message": "Cannot remove the last workspace admin.",
            "status": "FAILED_PRECONDITION",
            "details": [
                {
                    "@type": ERROR_INFO,
                    "reason": "LAST_ADMIN",
                    "domain": "bomesh.app",
                    "metadata": {"workspace": "workspaces/w1"},
                }
            ],
        }
    }


@pytest.mark.parametrize(
    ("kind", "http_status", "status"),
    [
        ("not-found", 404, "NOT_FOUND"),
        ("denied", 403, "PERMISSION_DENIED"),
        ("exists", 409, "ALREADY_EXISTS"),
        ("stale", 409, "ABORTED"),
        ("quota", 429, "RESOURCE_EXHAUSTED"),
        ("auth", 401, "UNAUTHENTICATED"),
        ("down", 503, "UNAVAILABLE"),
    ],
)
def test_status_codes_follow_the_contract_map(
    client: TestClient, kind: str, http_status: int, status: str
) -> None:
    response = client.get(f"/raise/{kind}")

    body = response.json()["error"]
    assert response.status_code == http_status
    assert body["code"] == http_status
    assert body["status"] == status
    assert [detail["@type"] for detail in body["details"]] == [ERROR_INFO]
    assert body["details"][0]["domain"] == "bomesh.app"


def test_error_without_reason_still_carries_error_info(client: TestClient) -> None:
    detail = client.get("/raise/not-found").json()["error"]["details"][0]

    assert detail == {"@type": ERROR_INFO, "domain": "bomesh.app", "metadata": {}}


def test_invalid_argument_adds_bad_request_detail(client: TestClient) -> None:
    body = client.get("/raise/bad-field").json()["error"]

    assert body["status"] == "INVALID_ARGUMENT"
    assert body["details"][0]["reason"] == "REQUEST_ID_REUSED"
    assert body["details"][1] == {
        "@type": BAD_REQUEST,
        "fieldViolations": [
            {
                "field": "requestId",
                "description": "requestId was used for a different request",
            }
        ],
    }


def test_request_validation_reports_camel_case_field_paths(client: TestClient) -> None:
    response = client.post(
        "/items?pageSize=many",
        json={"collection": {"maxDepth": "1.5"}, "tags": ["ok", 7], "unknownField": 1},
    )

    body = response.json()["error"]
    assert response.status_code == 400
    assert body["status"] == "INVALID_ARGUMENT"
    assert body["details"][0]["@type"] == ERROR_INFO
    violations = {
        violation["field"] for violation in body["details"][1]["fieldViolations"]
    }
    assert violations == {
        "pageSize",
        "displayName",
        "collection.description",
        "collection.maxDepth",
        "tags[1]",
        "unknownField",
    }


def test_malformed_json_is_invalid_argument_on_body(client: TestClient) -> None:
    response = client.post(
        "/items",
        content=b'{"displayName": ',
        headers={"content-type": "application/json"},
    )

    body = response.json()["error"]
    assert response.status_code == 400
    assert [
        violation["field"] for violation in body["details"][1]["fieldViolations"]
    ] == ["body"]


def test_unknown_route_is_not_found(client: TestClient) -> None:
    response = client.get("/nowhere")

    body = response.json()["error"]
    assert response.status_code == 404
    assert body["status"] == "NOT_FOUND"
    assert body["details"][0]["@type"] == ERROR_INFO


def test_wrong_method_keeps_405_and_allow_header(client: TestClient) -> None:
    response = client.delete("/items")

    assert response.status_code == 405
    assert response.headers["allow"] == "POST"
    assert response.json()["error"]["code"] == 405
    assert response.json()["error"]["status"] == "UNIMPLEMENTED"


def test_unhandled_exception_is_internal_without_leaking_the_message(
    client: TestClient,
) -> None:
    response = client.get("/crash")

    body = response.json()["error"]
    assert response.status_code == 500
    assert body["status"] == "INTERNAL"
    assert "hunter2" not in response.text
    assert body["details"][0]["@type"] == ERROR_INFO


def test_rpc_status_uses_the_numeric_rpc_code_for_operations() -> None:
    status = rpc_status(Aborted("Stale etag.", reason="ETAG_MISMATCH"))

    assert status["code"] == 10
    assert status["details"][0]["reason"] == "ETAG_MISMATCH"
    assert "status" not in status


def test_reason_must_be_upper_snake_case() -> None:
    with pytest.raises(ValueError):
        NotFound("missing", reason="itemMissing")
