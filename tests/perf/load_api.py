"""Load and performance harness for every operation of ``openapi.yaml``.

Run from ``backend/`` (``uv run python ../tests/perf/load_api.py <command>``):

- ``setup``     create the isolated ``bomesh_perf`` database (models + IAM catalog),
                seed it (``seed.py``), store a few real revision objects and create
                the ``bomesh_perf`` Qdrant collection; writes the dataset JSON.
- ``run``       start ``uvicorn`` on ``--port`` against ``bomesh_perf`` and run the
                passes: ``count`` (in-process ASGI app, SQL statements per request),
                ``latency`` (N sequential calls per case against uvicorn) and
                ``concurrency`` (virtual users mixing the read cases); writes the report.
- ``teardown``  drop ``bomesh_perf``, the Qdrant collection and the stored objects.

No model is ever called: model-backed operations are excluded (``EXCLUDED``) and the
model base URLs point at a closed local port, so an accidental call fails at once.
The ingestion worker is never started.
"""

from __future__ import annotations

import argparse
import asyncio
import io
import json
import os
import random
import re
import subprocess
import sys
import tempfile
import time
import traceback
from collections import Counter, defaultdict
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
BACKEND = ROOT / "backend"
sys.path[:0] = [str(BACKEND), str(HERE)]

import httpx  # noqa: E402
import yaml  # noqa: E402
from dotenv import dotenv_values  # noqa: E402

PERF_DB = "bomesh_perf"
PERF_COLLECTION = "bomesh_perf"
ADMIN_DB_URL = "postgresql+asyncpg://bomesh:bomesh@127.0.0.1:5432/bomesh"
PERF_DB_URL = f"postgresql+asyncpg://bomesh:bomesh@127.0.0.1:5432/{PERF_DB}"
#: Generated files (dataset, server log, raw results) stay out of the repository.
WORK = Path(os.environ.get("BOMESH_PERF_DIR", tempfile.gettempdir())) / "bomesh-perf"
DATASET = WORK / "dataset.json"
#: A port nothing listens on: any model call fails immediately instead of reaching a model.
DEAD_MODEL_URL = "http://127.0.0.1:9/v1"
PAGE_SIZES = (20, 100, 200)

#: Operations never called, with the reason.
EXCLUDED = {
    "ConverseConversation": "runs the agent loop (chat model)",
    "TestTopicClassification": "classifies with the chat model",
    "CreateArtifact": "starts artifact generation with the chat model",
    "ReviseArtifact": "regenerates the artifact with the chat model",
}


def perf_environment() -> dict[str, str]:
    """The root ``.env`` with the isolation and no-model overrides."""
    env = {k: v for k, v in dotenv_values(ROOT / ".env").items() if v is not None}
    env.update(
        DATABASE_URL=PERF_DB_URL,
        QDRANT_COLLECTION=PERF_COLLECTION,
        BOMESH_SANDBOX_ENABLED="false",
        BOMESH_CONTEXTUALIZATION_ENABLED="false",
        BOMESH_AUTH_JWT_EXPIRES_IN_SECONDS="14400",
        OPEN_ROUTER_BASE_URL=DEAD_MODEL_URL,
        OPENAI_BASE_URL=DEAD_MODEL_URL,
        LANGFUSE_PUBLIC_KEY="",
        LANGFUSE_SECRET_KEY="",
        BOMESH_LOG_LEVEL="WARNING",
    )
    return env


os.environ.update(perf_environment())

from sqlalchemy import event, text  # noqa: E402
from sqlalchemy.engine import Engine  # noqa: E402
from sqlalchemy.pool import Pool  # noqa: E402
from sqlalchemy.ext.asyncio import create_async_engine  # noqa: E402

from seed import Dataset, Scale, seed  # noqa: E402

# -- Contract ---------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class Operation:
    op_id: str
    method: str
    path: str  # template, e.g. /api/v1/workspaces/{workspace}/items
    tag: str
    query: tuple[str, ...]

    @property
    def params(self) -> list[str]:
        return re.findall(r"{(\w+)}", self.path)


def catalog() -> list[Operation]:
    spec = yaml.safe_load((BACKEND / "docs_design" / "openapi.yaml").read_text())
    components = spec["components"]

    def deref(node: dict[str, Any]) -> dict[str, Any]:
        while "$ref" in node:
            _, _, section, name = node["$ref"].split("/")
            node = components[section][name]
        return node

    operations = []
    for path, methods in spec["paths"].items():
        for method, body in methods.items():
            if method not in {"get", "post", "patch", "delete"}:
                continue
            query = tuple(
                deref(p)["name"] for p in body.get("parameters", []) if deref(p).get("in") == "query"
            )
            operations.append(
                Operation(body["operationId"], method.upper(), path, (body.get("tags") or ["-"])[0], query)
            )
    return operations


# -- Requests -----------------------------------------------------------------------


@dataclass(slots=True)
class Call:
    method: str
    path: str
    params: dict[str, Any] | None = None
    json: Any = None
    files: dict[str, Any] | None = None
    data: dict[str, Any] | None = None
    actor: str | None = None  # user ID; None = the admin
    token: str | None = None  # explicit bearer (overrides actor)
    expect: tuple[int, ...] = ()  # expected non-2xx statuses (a documented 4xx)


Builder = Callable[["Ctx", int], Awaitable[Call]]


@dataclass(slots=True)
class Case:
    op: Operation
    label: str
    build: Builder
    read: bool
    page_size: int | None = None


class SetupError(RuntimeError):
    pass


class Ctx:
    """The dataset, an HTTP client and the token minter shared by builders."""

    def __init__(self, ds: Dataset, http: httpx.AsyncClient, minter: Minter) -> None:
        self.ds = ds
        self.http = http
        self.minter = minter
        self.ws = f"/api/v1/workspaces/{ds.workspace}"
        self.wsn = f"workspaces/{ds.workspace}"
        self._serial = int(time.time()) % 100000 * 1000
        self.resolved: dict[tuple[str, str], str] = {}
        self.shared: dict[str, Any] = {}

    def n(self) -> int:
        self._serial += 1
        return self._serial

    async def once(self, key: str, factory: Callable[[], Awaitable[Any]]) -> Any:
        """``shared[key]``, created by ``factory`` on first use only."""
        if key not in self.shared:
            self.shared[key] = await factory()
        return self.shared[key]

    def item(self, item_id: str) -> str:
        return f"{self.wsn}/items/{item_id}"

    def member(self, user_id: str) -> str:
        return f"{self.wsn}/members/{user_id}"

    async def headers(self, call: Call) -> dict[str, str]:
        if call.token == "-":  # anonymous
            return {}
        token = call.token or await self.minter.token(call.actor or self.ds.admin)
        return {"Authorization": f"Bearer {token}"}

    async def send(self, call: Call) -> httpx.Response:
        return await self.http.request(
            call.method, call.path, params=call.params, json=call.json, files=call.files,
            data=call.data, headers=await self.headers(call),
        )

    async def ok(self, method: str, path: str, *, json: Any = None, params: dict[str, Any] | None = None,
                 actor: str | None = None, files: dict[str, Any] | None = None,
                 data: dict[str, Any] | None = None, allow: tuple[int, ...] = ()) -> dict[str, Any]:
        """A setup call (never measured); raises unless 2xx or in ``allow``."""
        response = await self.send(Call(method, path, params, json, files, data, actor))
        if response.status_code >= 300 and response.status_code not in allow:
            raise SetupError(f"{method} {path} -> {response.status_code}: {response.text[:400]}")
        try:
            return response.json() if response.content else {}
        except ValueError:
            return {}

    async def first(self, list_path: str, params: dict[str, Any] | None = None) -> dict[str, Any] | None:
        body = await self.ok("GET", list_path, params={"pageSize": 5, **(params or {})})
        for value in body.values():
            if isinstance(value, list) and value and isinstance(value[0], dict) and "name" in value[0]:
                return value[0]
        return None

    async def etag(self, path: str, actor: str | None = None) -> str | None:
        return (await self.ok("GET", path, actor=actor)).get("etag")

    async def wait_operation(self, operation: dict[str, Any], seconds: float = 20.0) -> dict[str, Any]:
        deadline = time.monotonic() + seconds
        while not operation.get("done") and time.monotonic() < deadline:
            await asyncio.sleep(0.2)
            operation = await self.ok("GET", f"/api/v1/{operation['name']}")
        return operation


def last(name: str) -> str:
    return name.rsplit("/", 1)[-1]


class Minter:
    """Real ACTIVE access sessions minted through the application's own service."""

    def __init__(self, runtime: Any) -> None:
        self._runtime = runtime
        self._tokens: dict[str, str] = {}

    async def token(self, user_id: str) -> str:
        if user_id not in self._tokens:
            from bomesh.db.engine import transaction_scope

            async with transaction_scope(self._runtime.sessions()) as session:
                issued = await self._runtime.access_session_service(session).create(
                    UUID(user_id), authentication_method="password"
                )
            self._tokens[user_id] = issued.access_token
        return self._tokens[user_id]


# -- Path resolution ----------------------------------------------------------------


def preset(x: Ctx, op: Operation, param: str, prefix: str) -> str | None:
    ds = x.ds
    if param == "workspace":
        return ds.workspace
    if param == "user":
        return ds.admin
    if param == "member" and prefix.endswith(f"/workspaces/{ds.workspace}/members"):
        # Self-scoped collections (home, notifications, saved/recent items) are the caller's.
        rest = op.path.split("{member}", 1)[1]
        return ds.admin if rest.startswith("/") else ds.member
    if param == "item":
        if op.op_id == "GetItemPreview":
            return ds.stored_documents[0] if ds.stored_documents else ds.published_documents[0]
        if "revisions" in op.path:
            return ds.multi_revision_documents[0]
        if "/shortcuts" in op.path:
            return ds.item_shortcuts[0][0]
        return ds.published_documents[0]
    if param == "ingestionRun":
        return ds.big_run
    simple = {
        "source": ds.sources[0], "connection": ds.connections[0], "space": ds.spaces[0],
        "conversation": ds.conversations[0], "request": ds.requests[0],
        "topic": ds.topics[0], "artifact": ds.artifacts[0],
        "notification": ds.notifications[0], "topicCorrection": ds.topic_corrections[0],
    }
    if param in simple and prefix.startswith("/api/v1/workspaces/"):
        return simple[param]
    if param == "contribution":
        return ds.contributions["approved"][0]
    return None


async def resolve(x: Ctx, op: Operation, overrides: dict[str, str] | None = None) -> str:
    """Fill the path template: overrides, presets, then the first resource of the parent list."""
    path = op.path
    for param in op.params:
        prefix = path.split("{" + param + "}", 1)[0].rstrip("/")
        key = (op.op_id, param)
        if overrides and param in overrides:
            value = overrides[param]
        elif key in x.resolved:
            value = x.resolved[key]
        else:
            value = preset(x, op, param, prefix)
            if value is None:
                found = await x.first(prefix)
                value = last(found["name"]) if found else str(uuid4())
            x.resolved[key] = value
        path = path.replace("{" + param + "}", value, 1)
    return path


# -- Case registry ----------------------------------------------------------------------

BUILDERS: dict[str, Builder] = {}
READS: set[str] = set()  # POST operations that only read (part of the concurrency mix)
VARIANTS: dict[str, list[tuple[str, dict[str, Any]]]] = {}


def spec(op_id: str, *, read: bool = False) -> Callable[[Builder], Builder]:
    def register(builder: Builder) -> Builder:
        BUILDERS[op_id] = builder
        if read:
            READS.add(op_id)
        return builder

    return register


def variants(op_id: str, *pairs: tuple[str, dict[str, Any]]) -> None:
    VARIANTS[op_id] = list(pairs)


variants("ListItems",
         ("documents", {"filter": 'itemKind = "DOCUMENT"', "pageSize": 100}),
         ("roots", {"filter": "parentItem = \"\"", "pageSize": 100}),
         ("failed index", {"filter": 'document.indexingState = "FAILED"', "pageSize": 100}),
         ("by update", {"orderBy": "updateTime desc", "pageSize": 100}),
         ("FULL ps=20", {"view": "FULL", "pageSize": 20}),
         ("FULL ps=200", {"view": "FULL", "pageSize": 200}),
         ("locked+deleted", {"showLocked": "true", "showDeleted": "true", "pageSize": 200}))
variants("ListContributions",
         ("in review", {"filter": 'state = "IN_REVIEW"', "pageSize": 100}),
         ("FULL", {"view": "FULL", "pageSize": 100}))
variants("ListMembers",
         ("active by name", {"filter": 'state = "ACTIVE"', "orderBy": "displayName", "pageSize": 100}))
variants("ListIngestionTasks",
         ("failed", {"filter": 'state = "FAILED"', "pageSize": 100}),
         ("by start", {"orderBy": "startTime desc", "pageSize": 100}))
variants("ListIngestionRuns", ("succeeded", {"filter": 'state = "SUCCEEDED"', "pageSize": 100}))
variants("ListSources", ("badge", {"filter": 'state = "FAILED" OR state = "REAUTHORIZATION_REQUIRED"', "pageSize": 1}))
variants("ListConnections", ("badge", {"filter": 'state = "FAILED" OR state = "REAUTHORIZATION_REQUIRED"', "pageSize": 1}))
variants("ListNotifications", ("deleted", {"showDeleted": "true", "pageSize": 100}))
variants("GetItem", ("FULL", {"view": "FULL"}))
variants("GetContribution", ("FULL", {"view": "FULL"}))
variants("ListArtifacts", ("FULL", {"view": "FULL", "pageSize": 100}))


def _search(label: str, body: dict[str, Any]) -> None:
    async def build(x: Ctx, i: int) -> Call:
        return Call("POST", f"{x.ws}/items:search", json=body)

    SEARCHES.append((label, build))


SEARCHES: list[tuple[str, Builder]] = []
for _size in PAGE_SIZES:
    _search(f"browse ps={_size}", {"pageSize": _size})
_search("facets ps=20", {"pageSize": 20, "facetSpecs": [
    {"field": field} for field in ("document.topics", "itemType", "ancestors",
                                   "document.origin.source", "document.verification.state")]})
_search("filter+order ps=100", {"pageSize": 100, "filter": "itemType = PDF",
                                "orderBy": "updateTime desc"})


def build_cases(operations: list[Operation]) -> tuple[list[Case], dict[str, str]]:
    """Every operation's cases; ``skipped`` maps an operation to why it has none."""
    cases: list[Case] = []
    skipped: dict[str, str] = {}
    for op in operations:
        if op.op_id in EXCLUDED:
            skipped[op.op_id] = EXCLUDED[op.op_id]
            continue
        if op.op_id == "SearchItems":
            cases += [Case(op, f"SearchItems {label}", build, True,
                           int(m.group(1)) if (m := re.search(r"ps=(\d+)", label)) else None)
                      for label, build in SEARCHES]
            continue
        if op.op_id in BUILDERS:
            cases.append(Case(op, op.op_id, BUILDERS[op.op_id], op.op_id in READS))
            continue
        if op.method != "GET":
            skipped[op.op_id] = "no builder"
            continue
        if "pageSize" in op.query:
            for size in PAGE_SIZES:
                cases.append(Case(op, f"{op.op_id} ps={size}", _get(op, {"pageSize": size}), True, size))
        else:
            cases.append(Case(op, op.op_id, _get(op, {}), True))
        for label, params in VARIANTS.get(op.op_id, []):
            cases.append(Case(op, f"{op.op_id} {label}", _get(op, params), True, params.get("pageSize")))
    return cases, skipped


def _get(op: Operation, params: dict[str, Any]) -> Builder:
    async def build(x: Ctx, i: int) -> Call:
        query = dict(params)
        if query.get("filter") == 'parentItem = ""':
            query["filter"] = 'NOT parentItem:*'
        query.update(GET_QUERY.get(op.op_id, lambda _x: {})(x))
        return Call("GET", await resolve(x, op), query or None, expect=GET_EXPECT.get(op.op_id, ()))

    return build


GET_QUERY: dict[str, Callable[[Ctx], dict[str, Any]]] = {
    "LookupUser": lambda x: {"email": x.shared["member_email"]},
    "AnalyzeWorkspaceIamPolicy": lambda x: {"principal": f"user:{x.ds.member}"},
    "ExportArtifact": lambda x: {"mimeType": "text/markdown"},
    "SummarizeWorkspaceUsage": lambda x: {"window": "P7D"},
    "SummarizeAuditEvents": lambda x: {"window": "P7D"},
    "GetWorkspaceOverview": lambda x: {"window": "P7D"},
}
#: Documented 4xx a read may answer on this dataset (no index points, no provider credentials).
GET_EXPECT: dict[str, tuple[int, ...]] = {
    "GetPassage": (404,),
    "GetIncident": (404,),
    "BrowseConnectionResources": (400, 409, 412, 502, 503),
}

# -- Write builders (each makes its own throwaway resources, never measured) --------------

ROLE_PERMS = ["items.get", "items.list"]


PASSWORD = "Perf-harness-password-1"


async def _user(x: Ctx) -> dict[str, Any]:
    return await x.ok("POST", "/api/v1/users", json={
        "email": f"perf-{x.n()}@perf.example", "displayName": "Perf throwaway", "password": PASSWORD})


async def _member(x: Ctx) -> str:
    user = await _user(x)
    await x.ok("POST", f"{x.ws}/members", json={"user": user["name"], "roles": ["roles/workspaceMember"]})
    return last(user["name"])


async def _collection(x: Ctx, parent: str | None = None, actor: str | None = None) -> dict[str, Any]:
    body: dict[str, Any] = {"itemKind": "COLLECTION", "displayName": f"Perf collection {x.n()}"}
    body["parentItem"] = x.item(parent or x.ds.leaf_collections[0])
    return await x.ok("POST", f"{x.ws}/items", json=body, actor=actor)


async def _upload(x: Ctx, parent: str, actor: str | None = None) -> dict[str, Any]:
    metadata = {"itemKind": "DOCUMENT", "displayName": f"Perf upload {x.n()}", "parentItem": x.item(parent),
                "document": {"fileName": "perf.txt", "mimeType": "text/plain"}}
    files = {"metadata": (None, json.dumps(metadata), "application/json"),
             "file": (f"perf-{x.n()}.txt", b"Perf harness upload. " * 20, "text/plain")}
    return await x.ok("POST", f"/upload{x.ws}/items", files=files, actor=actor)


def _jpeg() -> bytes:
    from PIL import Image

    buffer = io.BytesIO()
    Image.new("RGB", (64, 48), (30, 90, 160)).save(buffer, format="JPEG")
    return buffer.getvalue()


@spec("CreateSession")
async def _(x: Ctx, i: int) -> Call:
    if "signin" not in x.shared:
        user = await _user(x)
        x.shared["signin"] = user["email"]
    return Call("POST", "/api/v1/sessions",
                json={"credential": {"password": {"email": x.shared["signin"], "password": PASSWORD}}},
                token="-")


@spec("DeleteSession")
async def _(x: Ctx, i: int) -> Call:
    created = await BUILDERS["CreateSession"](x, i)
    response = await x.http.request("POST", created.path, json=created.json)
    body = response.json()
    token = body.get("accessToken") or body.get("token") or ""
    return Call("DELETE", f"/api/v1/{body['name']}", token=token)


@spec("CreateUser")
async def _(x: Ctx, i: int) -> Call:
    return Call("POST", "/api/v1/users",
                json={"email": f"perf-{x.n()}@perf.example", "displayName": "Perf", "password": PASSWORD})


async def _throwaway_user(x: Ctx) -> str:
    if "user" not in x.shared:
        x.shared["user"] = last((await _user(x))["name"])
    return x.shared["user"]


@spec("UpdateUser")
async def _(x: Ctx, i: int) -> Call:
    return Call("PATCH", f"/api/v1/users/{x.ds.admin}", params={"updateMask": "displayName"},
                json={"email": "ignored@perf.example", "displayName": f"Perf Admin {i % 2}"})


@spec("UpdateUserPreferences")
async def _(x: Ctx, i: int) -> Call:
    return Call("PATCH", f"/api/v1/users/{x.ds.admin}/preferences", params={"updateMask": "languageCode"},
                json={"languageCode": "en" if i % 2 else "vi"})


@spec("SuspendUser")
async def _(x: Ctx, i: int) -> Call:
    user = await _throwaway_user(x)
    await x.ok("POST", f"/api/v1/users/{user}:activate", json={}, allow=(400, 409, 412))
    return Call("POST", f"/api/v1/users/{user}:suspend", json={})


@spec("ActivateUser")
async def _(x: Ctx, i: int) -> Call:
    user = await _throwaway_user(x)
    await x.ok("POST", f"/api/v1/users/{user}:suspend", json={}, allow=(400, 409, 412))
    return Call("POST", f"/api/v1/users/{user}:activate", json={})


@spec("ResetPassword")
async def _(x: Ctx, i: int) -> Call:
    return Call("POST", "/api/v1/users:resetPassword", json={"resetToken": "not-a-token", "newPassword": "Perf-new-password-1"},
                token="-", expect=(400, 404, 412))


@spec("SendPasswordReset")
async def _(x: Ctx, i: int) -> Call:
    return Call("POST", "/api/v1/users:sendPasswordReset", json={"email": x.shared["member_email"]}, token="-")


async def _workspace(x: Ctx) -> dict[str, Any]:
    code = f"perf-tmp-{x.n()}"
    operation = await x.ok("POST", "/api/v1/workspaces", json={
        "displayName": f"Perf tmp {code}", "code": code, "initialAdminEmail": x.shared["admin_email"]})
    operation = await x.wait_operation(operation)
    name = (operation.get("response") or {}).get("name") or operation.get("metadata", {}).get("target") or ""
    if not name:
        found = await x.first("/api/v1/workspaces", {"filter": f'code = "{code}"'})
        name = found["name"] if found else ""
    return {"name": name, "code": code}


@spec("CreateWorkspace")
async def _(x: Ctx, i: int) -> Call:
    code = f"perf-new-{x.n()}"
    return Call("POST", "/api/v1/workspaces", json={"displayName": f"Perf {code}", "code": code,
                                                    "initialAdminEmail": x.shared["admin_email"]})


@spec("UpdateWorkspace")
async def _(x: Ctx, i: int) -> Call:
    return Call("PATCH", x.ws, params={"updateMask": "displayName"},
                json={"displayName": f"Perf Workspace {i % 2}", "code": "ignored"})


@spec("UpdateWorkspaceAssistant")
async def _(x: Ctx, i: int) -> Call:
    return Call("PATCH", f"{x.ws}/assistant", params={"updateMask": "welcomeMessage"},
                json={"welcomeMessage": f"Hello {i}"})


@spec("ExportAuditEvents")
async def _(x: Ctx, i: int) -> Call:
    return Call("POST", f"{x.ws}/auditEvents:export", json={})


@spec("ExportPlatformAuditEvents")
async def _(x: Ctx, i: int) -> Call:
    return Call("POST", "/api/v1/auditEvents:export", json={})


@spec("ExportWorkspaceUsage")
async def _(x: Ctx, i: int) -> Call:
    return Call("POST", "/api/v1/workspaces:exportUsage", json={"window": "P7D"})


@spec("CreateGroup")
async def _(x: Ctx, i: int) -> Call:
    return Call("POST", f"{x.ws}/groups", params={"groupId": f"perf-group-{x.n()}"},
                json={"displayName": f"Perf group {i}"})


async def _group(x: Ctx) -> str:
    return last((await x.ok("POST", f"{x.ws}/groups", params={"groupId": f"perf-g-{x.n()}"},
                            json={"displayName": "Perf throwaway group"}))["name"])


@spec("UpdateGroup")
async def _(x: Ctx, i: int) -> Call:
    await x.once("group", lambda: _group(x))
    return Call("PATCH", f"{x.ws}/groups/{x.shared['group']}", params={"updateMask": "description"},
                json={"displayName": "Perf throwaway group", "description": f"v{i}"})


@spec("DeleteGroup")
async def _(x: Ctx, i: int) -> Call:
    return Call("DELETE", f"{x.ws}/groups/{await _group(x)}")


@spec("CreateMembership")
async def _(x: Ctx, i: int) -> Call:
    group = await _group(x)
    return Call("POST", f"{x.ws}/groups/{group}/memberships", json={"member": x.member(x.ds.members[i % 50])})


@spec("DeleteMembership")
async def _(x: Ctx, i: int) -> Call:
    group = await _group(x)
    created = await x.ok("POST", f"{x.ws}/groups/{group}/memberships", json={"member": x.member(x.ds.members[1])})
    return Call("DELETE", f"/api/v1/{created['name']}")


async def _gap(x: Ctx) -> str:
    if "gap" not in x.shared:
        found = await x.first(f"{x.ws}/knowledgeGaps")
        x.shared["gap"] = last(found["name"]) if found else str(uuid4())
    return x.shared["gap"]


@spec("DismissKnowledgeGap")
async def _(x: Ctx, i: int) -> Call:
    gap = await _gap(x)
    await x.ok("POST", f"{x.ws}/knowledgeGaps/{gap}:reopen", json={}, allow=(400, 404, 409, 412))
    return Call("POST", f"{x.ws}/knowledgeGaps/{gap}:dismiss", json={})


@spec("ReopenKnowledgeGap")
async def _(x: Ctx, i: int) -> Call:
    gap = await _gap(x)
    await x.ok("POST", f"{x.ws}/knowledgeGaps/{gap}:dismiss", json={}, allow=(400, 404, 409, 412))
    return Call("POST", f"{x.ws}/knowledgeGaps/{gap}:reopen", json={})


@spec("CreateMember")
async def _(x: Ctx, i: int) -> Call:
    user = await _user(x)
    return Call("POST", f"{x.ws}/members", json={"user": user["name"], "roles": ["roles/workspaceMember"]})


@spec("DeleteMember")
async def _(x: Ctx, i: int) -> Call:
    return Call("DELETE", f"{x.ws}/members/{await _member(x)}")


def _document_share(x: Ctx, i: int) -> dict[str, Any]:
    return {"kind": "SHARE", "target": x.item(x.ds.published_documents[i % 500])}


@spec("CreateShare")
async def _(x: Ctx, i: int) -> Call:
    return Call("POST", f"{x.ws}/shares", json=_document_share(x, i))


@spec("DeleteShare")
async def _(x: Ctx, i: int) -> Call:
    share = await x.ok("POST", f"{x.ws}/shares", json=_document_share(x, i))
    return Call("DELETE", f"/api/v1/{share['name']}")


@spec("ResolveShare", read=True)
async def _(x: Ctx, i: int) -> Call:
    share = await x.ok("POST", f"{x.ws}/shares", json=_document_share(x, i))
    return Call("POST", "/api/v1/shares:resolve", json={"token": last(share["name"])})


@spec("AcceptShare")
async def _(x: Ctx, i: int) -> Call:
    invite = await x.ok("POST", f"{x.ws}/shares",
                        json={"kind": "INVITE", "target": x.wsn, "role": "roles/workspaceMember"})
    return Call("POST", "/api/v1/shares:accept", json={"token": invite["uri"].rsplit("/", 1)[-1]})



async def _shared_member(x: Ctx) -> str:
    if "member" not in x.shared:
        x.shared["member"] = await _member(x)
    return x.shared["member"]


@spec("SuspendMember")
async def _(x: Ctx, i: int) -> Call:
    member = await _shared_member(x)
    await x.ok("POST", f"{x.ws}/members/{member}:activate", json={}, allow=(400, 409, 412))
    return Call("POST", f"{x.ws}/members/{member}:suspend", json={})


@spec("ActivateMember")
async def _(x: Ctx, i: int) -> Call:
    member = await _shared_member(x)
    await x.ok("POST", f"{x.ws}/members/{member}:suspend", json={}, allow=(400, 409, 412))
    return Call("POST", f"{x.ws}/members/{member}:activate", json={})


async def _role(x: Ctx) -> str:
    created = await x.ok("POST", f"{x.ws}/roles", params={"roleId": f"perfRole{x.n()}"},
                         json={"displayName": "Perf role", "includedPermissions": ROLE_PERMS})
    return last(created["name"])


@spec("CreateRole")
async def _(x: Ctx, i: int) -> Call:
    return Call("POST", f"{x.ws}/roles", params={"roleId": f"perfRole{x.n()}"},
                json={"displayName": "Perf role", "includedPermissions": ROLE_PERMS})


@spec("UpdateRole")
async def _(x: Ctx, i: int) -> Call:
    await x.once("role", lambda: _role(x))
    return Call("PATCH", f"{x.ws}/roles/{x.shared['role']}", params={"updateMask": "description"},
                json={"displayName": "Perf role", "description": f"v{i}", "includedPermissions": ROLE_PERMS})


@spec("DeleteRole")
async def _(x: Ctx, i: int) -> Call:
    return Call("DELETE", f"{x.ws}/roles/{await _role(x)}")


@spec("UndeleteRole")
async def _(x: Ctx, i: int) -> Call:
    role = await _role(x)
    await x.ok("DELETE", f"{x.ws}/roles/{role}")
    return Call("POST", f"{x.ws}/roles/{role}:undelete", json={})


@spec("UpdateWorkspaceSettings")
async def _(x: Ctx, i: int) -> Call:
    return Call("PATCH", f"{x.ws}/settings", params={"updateMask": "defaultPublishingPolicy"},
                json={"defaultPublishingPolicy": "REVIEW_FIRST" if i % 2 else "AUTO_PUBLISH"})


@spec("UploadMapBackground")
async def _(x: Ctx, i: int) -> Call:
    return Call("POST", f"{x.ws}/settings:uploadMapBackground",
                files={"file": ("map.jpg", x.shared["jpeg"], "image/jpeg")})


@spec("UploadWorkspaceLogo")
async def _(x: Ctx, i: int) -> Call:
    return Call("POST", f"{x.ws}/settings:uploadLogo",
                files={"file": ("logo.jpg", x.shared["jpeg"], "image/jpeg")})


@spec("PauseWorkspaceIngestion")
async def _(x: Ctx, i: int) -> Call:
    await x.ok("POST", f"{x.ws}:resumeIngestion", json={}, allow=(400, 409, 412))
    return Call("POST", f"{x.ws}:pauseIngestion", json={})


@spec("ResumeWorkspaceIngestion")
async def _(x: Ctx, i: int) -> Call:
    await x.ok("POST", f"{x.ws}:pauseIngestion", json={}, allow=(400, 409, 412))
    return Call("POST", f"{x.ws}:resumeIngestion", json={})


async def _tmp_workspace(x: Ctx) -> dict[str, Any]:
    if "tmp_ws" not in x.shared:
        x.shared["tmp_ws"] = await _workspace(x)
    return x.shared["tmp_ws"]


@spec("SuspendWorkspace")
async def _(x: Ctx, i: int) -> Call:
    ws = await _tmp_workspace(x)
    await x.ok("POST", f"/api/v1/{ws['name']}:activate", json={}, allow=(400, 409, 412))
    return Call("POST", f"/api/v1/{ws['name']}:suspend", json={})


@spec("ActivateWorkspace")
async def _(x: Ctx, i: int) -> Call:
    ws = await _tmp_workspace(x)
    await x.ok("POST", f"/api/v1/{ws['name']}:suspend", json={}, allow=(400, 409, 412))
    return Call("POST", f"/api/v1/{ws['name']}:activate", json={})


@spec("ArchiveWorkspace")
async def _(x: Ctx, i: int) -> Call:
    ws = await _workspace(x)
    await x.ok("POST", f"/api/v1/{ws['name']}:suspend", json={}, allow=(400, 409, 412))
    return Call("POST", f"/api/v1/{ws['name']}:archive", json={"confirmationCode": ws["code"]})


def _policy_ops(kind: str, path: Callable[[Ctx], Awaitable[str]], permissions: list[str]) -> None:
    @spec(f"Get{kind}IamPolicy", read=True)
    async def get(x: Ctx, i: int) -> Call:
        return Call("POST", f"{await path(x)}:getIamPolicy", json={})

    @spec(f"Test{kind}IamPermissions", read=True)
    async def test(x: Ctx, i: int) -> Call:
        return Call("POST", f"{await path(x)}:testIamPermissions", json={"permissions": permissions})

    @spec(f"Set{kind}IamPolicy")
    async def set_(x: Ctx, i: int) -> Call:
        target = await path(x)
        policy = await x.ok("POST", f"{target}:getIamPolicy", json={})
        return Call("POST", f"{target}:setIamPolicy", json={"policy": policy})


async def _ws_path(x: Ctx) -> str:
    return x.ws


async def _item_policy_path(x: Ctx) -> str:
    return f"{x.ws}/items/{x.ds.roots[1]}"


async def _space_path(x: Ctx) -> str:
    return f"{x.ws}/spaces/{x.ds.spaces[0]}"


_policy_ops("Workspace", _ws_path, ["items.list", "members.list", "workspaces.update"])
_policy_ops("Item", _item_policy_path, ["items.get", "items.update", "items.delete"])
_policy_ops("Space", _space_path, ["spaces.get", "spaces.update"])


@spec("UpdateNotification")
async def _(x: Ctx, i: int) -> Call:
    return Call("PATCH", f"{x.ws}/members/{x.ds.admin}/notifications/{x.ds.notifications[i % 50]}",
                params={"updateMask": "read"}, json={"read": True})


@spec("DeleteNotification")
async def _(x: Ctx, i: int) -> Call:
    return Call("DELETE", f"{x.ws}/members/{x.ds.admin}/notifications/{x.ds.notifications[100 + i % 100]}")


@spec("UndeleteNotification")
async def _(x: Ctx, i: int) -> Call:
    path = f"{x.ws}/members/{x.ds.admin}/notifications/{x.ds.notifications[300 + i % 50]}"
    await x.ok("DELETE", path, allow=(404, 409, 412))
    return Call("POST", f"{path}:undelete", json={})


@spec("MarkNotificationsRead")
async def _(x: Ctx, i: int) -> Call:
    return Call("POST", f"{x.ws}/members/{x.ds.admin}/notifications:markRead", json={})


@spec("UpdateRecentItem")
async def _(x: Ctx, i: int) -> Call:
    item = x.ds.published_documents[200 + i % 200]
    return Call("PATCH", f"{x.ws}/members/{x.ds.admin}/recentItems/{item}", params={"allowMissing": "true"},
                json={"item": x.item(item)})


@spec("DeleteRecentItem")
async def _(x: Ctx, i: int) -> Call:
    item = x.ds.published_documents[500 + i % 200]
    path = f"{x.ws}/members/{x.ds.admin}/recentItems/{item}"
    await x.ok("PATCH", path, params={"allowMissing": "true"}, json={"item": x.item(item)})
    return Call("DELETE", path)


@spec("ClearRecentItems")
async def _(x: Ctx, i: int) -> Call:
    member = x.ds.member
    for item in x.ds.published_documents[:5]:
        await x.ok("PATCH", f"{x.ws}/members/{member}/recentItems/{item}", params={"allowMissing": "true"},
                   json={"item": x.item(item)}, actor=member, allow=(403, 404))
    return Call("POST", f"{x.ws}/members/{member}/recentItems:clear", json={}, actor=member)


@spec("CreateSavedItem")
async def _(x: Ctx, i: int) -> Call:
    item = x.ds.published_documents[800 + x.n() % 2000]
    path = f"{x.ws}/members/{x.ds.admin}/savedItems"
    await x.ok("DELETE", f"{path}/{item}", allow=(404,))
    return Call("POST", path, params={"savedItemId": item}, json={"item": x.item(item)})


@spec("DeleteSavedItem")
async def _(x: Ctx, i: int) -> Call:
    item = x.ds.published_documents[3000 + x.n() % 500]
    path = f"{x.ws}/members/{x.ds.admin}/savedItems"
    await x.ok("POST", path, params={"savedItemId": item}, json={"item": x.item(item)}, allow=(409,))
    return Call("DELETE", f"{path}/{item}")


async def _saved_search(x: Ctx) -> str:
    created = await x.ok("POST", f"{x.ws}/members/{x.ds.admin}/savedSearches",
                         json={"displayName": f"Perf search {x.n()}", "filter": 'itemKind = "DOCUMENT"'})
    return created["name"]


@spec("CreateSavedSearch")
async def _(x: Ctx, i: int) -> Call:
    return Call("POST", f"{x.ws}/members/{x.ds.admin}/savedSearches",
                json={"displayName": f"Perf search {x.n()}", "query": "handbook", "layout": "TABLE"})


@spec("UpdateSavedSearch")
async def _(x: Ctx, i: int) -> Call:
    await x.once("saved_search", lambda: _saved_search(x))
    return Call("PATCH", f"/api/v1/{x.shared['saved_search']}", params={"updateMask": "displayName"},
                json={"displayName": f"Perf search v{i}"})


@spec("DeleteSavedSearch")
async def _(x: Ctx, i: int) -> Call:
    return Call("DELETE", f"/api/v1/{await _saved_search(x)}")


# -- Curation ---------------------------------------------------------------------------


def _contributor(x: Ctx) -> str:
    """An ordinary member who owns a personal collection (seeded contributors)."""
    return x.ds.member


async def _candidate(x: Ctx) -> tuple[str, str]:
    """(contributor, item id) of a fresh upload in the contributor's personal collection."""
    member = _contributor(x)
    if "member_personal" not in x.shared:
        listed = await x.ok("GET", f"{x.ws}/items", params={"filter": 'NOT parentItem:*', "pageSize": 200}, actor=member)
        personal = [i for i in listed.get("items", []) if (i.get("collection") or {}).get("kind") == "PERSONAL"]
        if not personal:
            raise SetupError("member has no personal collection")
        x.shared["member_personal"] = last(personal[0]["name"])
    uploaded = await _upload(x, x.shared["member_personal"], actor=member)
    return member, last(uploaded["name"])


async def _contribution(x: Ctx) -> tuple[str, str]:
    member, item = await _candidate(x)
    target = x.ds.roots[0]  # accepts contributions; the member owns it
    created = await x.ok("POST", f"{x.ws}/contributions", actor=member,
                         json={"kind": "NEW_DOCUMENT", "item": x.item(item), "targetCollection": x.item(target),
                               "note": "Perf"})
    return member, created["name"]


@spec("CreateContribution")
async def _(x: Ctx, i: int) -> Call:
    member, item = await _candidate(x)
    return Call("POST", f"{x.ws}/contributions", actor=member,
                json={"kind": "NEW_DOCUMENT", "item": x.item(item), "targetCollection": x.item(x.ds.roots[0])})


@spec("DeleteContribution")
async def _(x: Ctx, i: int) -> Call:
    member, name = await _contribution(x)
    await x.ok("POST", f"/api/v1/{name}:withdraw", json={}, actor=member)
    return Call("DELETE", f"/api/v1/{name}", actor=member)


@spec("WithdrawContribution")
async def _(x: Ctx, i: int) -> Call:
    member, name = await _contribution(x)
    return Call("POST", f"/api/v1/{name}:withdraw", json={}, actor=member)


def _seeded_contribution(x: Ctx, state: str, offset: int) -> str:
    pool = x.ds.contributions[state]
    index = (offset + x.n()) % len(pool)
    return f"{x.ws}/contributions/{pool[index]}"


@spec("ApproveContribution")
async def _(x: Ctx, i: int) -> Call:
    path = _seeded_contribution(x, "in_review", 0)
    return Call("POST", f"{path}:approve", json={"etag": await x.etag(path)}, expect=(400, 409, 412))


@spec("RejectContribution")
async def _(x: Ctx, i: int) -> Call:
    member, name = await _contribution(x)
    path = f"/api/v1/{name}"
    return Call("POST", f"{path}:reject", json={"message": "Not now", "etag": await x.etag(path)})


@spec("RequestContributionChanges")
async def _(x: Ctx, i: int) -> Call:
    member, name = await _contribution(x)
    path = f"/api/v1/{name}"
    return Call("POST", f"{path}:requestChanges", json={"message": "Please fix", "etag": await x.etag(path)})


@spec("ResubmitContribution")
async def _(x: Ctx, i: int) -> Call:
    member, name = await _contribution(x)
    path = f"/api/v1/{name}"
    await x.ok("POST", f"{path}:requestChanges", json={"message": "Please fix", "etag": await x.etag(path)})
    return Call("POST", f"{path}:resubmit", json={"changeSummary": "Fixed", "etag": await x.etag(path, member)},
                actor=member)


# -- Items --------------------------------------------------------------------------------


@spec("CreateItem")
async def _(x: Ctx, i: int) -> Call:
    return Call("POST", f"{x.ws}/items", json={"itemKind": "COLLECTION", "displayName": f"Perf {x.n()}",
                                               "parentItem": x.item(x.ds.leaf_collections[1])})


@spec("CreateItemMedia")
async def _(x: Ctx, i: int) -> Call:
    metadata = {"itemKind": "DOCUMENT", "displayName": f"Perf upload {x.n()}",
                "parentItem": x.item(x.ds.leaf_collections[2]),
                "document": {"fileName": "perf.txt", "mimeType": "text/plain"}}
    return Call("POST", f"/upload{x.ws}/items",
                files={"metadata": (None, json.dumps(metadata), "application/json"),
                       "file": ("perf.txt", b"Perf harness upload. " * 20, "text/plain")})


async def _collection_id(x: Ctx) -> str:
    return last((await _collection(x))["name"])


@spec("UpdateItem")
async def _(x: Ctx, i: int) -> Call:
    await x.once("collection", lambda: _collection_id(x))
    return Call("PATCH", f"{x.ws}/items/{x.shared['collection']}", params={"updateMask": "displayName"},
                json={"displayName": f"Perf renamed {i}"})


@spec("DeleteItem")
async def _(x: Ctx, i: int) -> Call:
    return Call("DELETE", f"{x.ws}/items/{last((await _collection(x))['name'])}")


@spec("UndeleteItem")
async def _(x: Ctx, i: int) -> Call:
    item = last((await _collection(x))["name"])
    await x.ok("DELETE", f"{x.ws}/items/{item}")
    return Call("POST", f"{x.ws}/items/{item}:undelete", json={})


@spec("MoveItem")
async def _(x: Ctx, i: int) -> Call:
    item = last((await _collection(x))["name"])
    return Call("POST", f"{x.ws}/items/{item}:move",
                json={"destinationParent": x.item(x.ds.leaf_collections[3])})


@spec("CreateItemShortcut")
async def _(x: Ctx, i: int) -> Call:
    collection = last((await _collection(x))["name"])
    return Call("POST", f"{x.ws}/items/{collection}/shortcuts", json={"targetItem": x.item(x.ds.published_documents[i % 500])})


@spec("DeleteItemShortcut")
async def _(x: Ctx, i: int) -> Call:
    collection = last((await _collection(x))["name"])
    link = await x.ok("POST", f"{x.ws}/items/{collection}/shortcuts",
                      json={"targetItem": x.item(x.ds.published_documents[i % 500])})
    return Call("DELETE", f"/api/v1/{link['name']}")


@spec("RollbackItem")
async def _(x: Ctx, i: int) -> Call:
    item = x.ds.multi_revision_documents[1 + i % 20]
    return Call("POST", f"{x.ws}/items/{item}/revisions/1:rollback", json={})


@spec("CompleteItemUpload")
async def _(x: Ctx, i: int) -> Call:
    created = await x.ok("POST", f"{x.ws}/items", json={
        "itemKind": "DOCUMENT", "displayName": f"Perf direct {x.n()}", "parentItem": x.item(x.ds.leaf_collections[4]),
        "document": {"fileName": "perf.txt", "mimeType": "text/plain", "sizeBytes": "420"}})
    uri = (created.get("document") or {}).get("uploadUri")
    if uri:
        async with httpx.AsyncClient() as raw:
            await raw.put(uri, content=b"Perf direct upload. " * 21, headers={"Content-Type": "text/plain"})
    return Call("POST", f"/api/v1/{created['name']}:completeUpload", json={})


async def _doc(x: Ctx) -> str:
    return last((await _upload(x, x.ds.leaf_collections[5]))["name"])


@spec("MergeItem")
async def _(x: Ctx, i: int) -> Call:
    source, target = await _doc(x), await _doc(x)
    return Call("POST", f"{x.ws}/items/{source}:merge", json={"targetItem": x.item(target)})


@spec("PublishItem")
async def _(x: Ctx, i: int) -> Call:
    item = x.ds.published_documents[1500 + i % 100]
    await x.ok("POST", f"{x.ws}/items/{item}:unpublish", json={}, allow=(400, 409, 412))
    return Call("POST", f"{x.ws}/items/{item}:publish", json={})


@spec("UnpublishItem")
async def _(x: Ctx, i: int) -> Call:
    item = x.ds.published_documents[1700 + i % 100]
    await x.ok("POST", f"{x.ws}/items/{item}:publish", json={}, allow=(400, 409, 412))
    return Call("POST", f"{x.ws}/items/{item}:unpublish", json={})


@spec("VerifyItem")
async def _(x: Ctx, i: int) -> Call:
    return Call("POST", f"{x.ws}/items/{x.ds.published_documents[1900 + i % 100]}:verify", json={})


# -- Topics -------------------------------------------------------------------------------


def _topic_name(x: Ctx, topic: str) -> str:
    return f"{x.wsn}/topics/{topic}"


async def _topic(x: Ctx) -> str:
    created = await x.ok("POST", f"{x.ws}/topics", params={"topicId": f"perf-topic-{x.n()}"},
                         json={"displayName": f"Perf topic {x.n()}", "kind": "TOPIC",
                               "parentTopic": _topic_name(x, x.ds.domains[0]), "keywords": ["perf"]})
    return last(created["name"])


@spec("CreateTopic")
async def _(x: Ctx, i: int) -> Call:
    return Call("POST", f"{x.ws}/topics", params={"topicId": f"perf-topic-{x.n()}"},
                json={"displayName": f"Perf topic {x.n()}", "kind": "TOPIC",
                      "parentTopic": _topic_name(x, x.ds.domains[1]), "keywords": ["perf", "load"]})


@spec("UpdateTopic")
async def _(x: Ctx, i: int) -> Call:
    await x.once("topic", lambda: _topic(x))
    return Call("PATCH", f"{x.ws}/topics/{x.shared['topic']}", params={"updateMask": "description"},
                json={"description": f"v{i}"})


@spec("DeleteTopic")
async def _(x: Ctx, i: int) -> Call:
    return Call("DELETE", f"{x.ws}/topics/{await _topic(x)}")


@spec("UndeleteTopic")
async def _(x: Ctx, i: int) -> Call:
    topic = await _topic(x)
    await x.ok("DELETE", f"{x.ws}/topics/{topic}")
    return Call("POST", f"{x.ws}/topics/{topic}:undelete", json={})


@spec("MergeTopic")
async def _(x: Ctx, i: int) -> Call:
    source, target = await _topic(x), await _topic(x)
    return Call("POST", f"{x.ws}/topics/{source}:merge", json={"targetTopic": _topic_name(x, target)})


@spec("AcceptTopic")
async def _(x: Ctx, i: int) -> Call:
    topic = x.ds.proposed_topics[x.n() % 8]
    return Call("POST", f"{x.ws}/topics/{topic}:accept", json={}, expect=(400, 409, 412))


@spec("RejectTopic")
async def _(x: Ctx, i: int) -> Call:
    topic = x.ds.proposed_topics[8 + x.n() % 8]
    return Call("POST", f"{x.ws}/topics/{topic}:reject", json={}, expect=(400, 409, 412))


@spec("ConfirmTopicAssignments")
async def _(x: Ctx, i: int) -> Call:
    return Call("POST", f"{x.ws}/topics/{x.ds.topics[i % 10]}:confirmAssignments", json={})


@spec("ImportTopics")
async def _(x: Ctx, i: int) -> Call:
    rows = [{"domain": f"Import domain {d}"} for d in range(10)]
    rows += [{"domain": f"Import domain {d}", "topic": f"Import topic {d}.{t}",
              "keywords": ["a", "b"]} for d in range(10) for t in range(20)]
    return Call("POST", f"{x.ws}/topics:import", json={"rows": rows, "mode": "MERGE", "validateOnly": True})


@spec("DismissTopicCorrection")
async def _(x: Ctx, i: int) -> Call:
    return Call("POST", f"{x.ws}/topicCorrections/{x.ds.topic_corrections[x.n() % 40]}:dismiss", json={},
                expect=(400, 409, 412))


# -- Ingestion ----------------------------------------------------------------------------


@spec("UpdateConnector")
async def _(x: Ctx, i: int) -> Call:
    return Call("PATCH", "/api/v1/connectors/confluence", params={"updateMask": "description"},
                json={"description": f"Perf v{i}"})


@spec("DisableConnector")
async def _(x: Ctx, i: int) -> Call:
    await x.ok("POST", "/api/v1/connectors/google_drive:enable", json={}, allow=(400, 409, 412))
    return Call("POST", "/api/v1/connectors/google_drive:disable", json={})


@spec("EnableConnector")
async def _(x: Ctx, i: int) -> Call:
    await x.ok("POST", "/api/v1/connectors/google_drive:disable", json={}, allow=(400, 409, 412))
    return Call("POST", "/api/v1/connectors/google_drive:enable", json={})


@spec("UpdateIngestionPolicy")
async def _(x: Ctx, i: int) -> Call:
    return Call("PATCH", "/api/v1/ingestionPolicies/default", params={"updateMask": "maxFileSizeBytes"},
                json={"maxFileSizeBytes": str(100_000_000 + i)})


@spec("CreateConnection")
async def _(x: Ctx, i: int) -> Call:
    return Call("POST", f"{x.ws}/connections", params={"validateOnly": "true"},
                json={"connector": "connectors/confluence", "displayName": f"Perf conn {x.n()}"},
                expect=(400, 412))


@spec("UpdateConnection")
async def _(x: Ctx, i: int) -> Call:
    return Call("PATCH", f"{x.ws}/connections/{x.ds.connections[0]}", params={"updateMask": "displayName"},
                json={"connector": "connectors/confluence", "displayName": f"Connection 0 v{i % 2}"})


@spec("DeleteConnection")
async def _(x: Ctx, i: int) -> Call:
    created = await x.ok("POST", f"{x.ws}/connections",
                         json={"connector": "connectors/confluence", "displayName": f"Perf conn {x.n()}"})
    name = created.get("name") or (created.get("response") or {}).get("name") or ""
    return Call("DELETE", f"/api/v1/{name}")


@spec("ReauthorizeConnection")
async def _(x: Ctx, i: int) -> Call:
    return Call("POST", f"{x.ws}/connections/{x.ds.connections[2]}:reauthorize", json={},
                expect=(400, 409, 412))


@spec("TestConnection")
async def _(x: Ctx, i: int) -> Call:
    return Call("POST", f"{x.ws}/connections/{x.ds.connections[0]}:test", json={},
                expect=(400, 409, 412, 502, 503))


_SELECT_ALL = 'itemKind = "DOCUMENT"'


@spec("CreateIngestionRun")
async def _(x: Ctx, i: int) -> Call:
    """``selector.filter`` over every document (~5,000), validateOnly."""
    return Call("POST", f"{x.ws}/ingestionRuns", params={"validateOnly": "true"}, json={"selector": {
        "filter": 'document.publicationState = "PUBLISHED" OR document.publicationState = "UNPUBLISHED"'}})


@spec("CancelIngestionRun")
async def _(x: Ctx, i: int) -> Call:
    """A real run over the PENDING documents (stays QUEUED: no worker), then cancelled."""
    created = await x.ok("POST", f"{x.ws}/ingestionRuns",
                         json={"selector": {"filter": 'document.indexingState = "PENDING"'}})
    name = created.get("name") or (created.get("response") or {}).get("name")
    return Call("POST", f"/api/v1/{name}:cancel", json={})


@spec("RetryIngestionRun")
async def _(x: Ctx, i: int) -> Call:
    """Retry of a seeded FAILED run (a new QUEUED run each time)."""
    return Call("POST", f"{x.ws}/ingestionRuns/{x.ds.runs[1]}:retry", json={})


@spec("CreateSource")
async def _(x: Ctx, i: int) -> Call:
    return Call("POST", f"{x.ws}/sources", params={"validateOnly": "true"},
                json={"connection": f"{x.wsn}/connections/{x.ds.connections[0]}",
                      "targetCollection": x.item(x.ds.roots[2]),
                      "externalResource": {"type": "space", "resourceId": f"PERF{x.n()}", "displayName": "Perf"}},
                expect=(400, 412, 502, 503))


@spec("UpdateSource")
async def _(x: Ctx, i: int) -> Call:
    return Call("PATCH", f"{x.ws}/sources/{x.ds.sources[0]}", params={"updateMask": "displayName"},
                json={"displayName": f"Source v{i % 2}"})


@spec("DeleteSource")
async def _(x: Ctx, i: int) -> Call:
    return Call("DELETE", f"{x.ws}/sources/{x.ds.sources[-1 - (x.n() % 3)]}", expect=(404,))


@spec("CreateSync")
async def _(x: Ctx, i: int) -> Call:
    return Call("POST", f"{x.ws}/sources/{x.ds.sources[1]}/syncs", json={}, expect=(400, 409, 412))


@spec("PauseSource")
async def _(x: Ctx, i: int) -> Call:
    path = f"{x.ws}/sources/{x.ds.sources[3]}"
    await x.ok("POST", f"{path}:resume", json={}, allow=(400, 409, 412))
    return Call("POST", f"{path}:pause", json={})


@spec("ResumeSource")
async def _(x: Ctx, i: int) -> Call:
    path = f"{x.ws}/sources/{x.ds.sources[4]}"
    await x.ok("POST", f"{path}:pause", json={}, allow=(400, 409, 412))
    return Call("POST", f"{path}:resume", json={})


# -- Artifacts ----------------------------------------------------------------------------


def _artifact(x: Ctx, offset: int) -> str:
    return f"{x.ws}/artifacts/{x.ds.artifacts[offset]}"


@spec("UpdateArtifact")
async def _(x: Ctx, i: int) -> Call:
    return Call("PATCH", _artifact(x, 1), params={"updateMask": "displayName"}, json={"displayName": f"Artifact v{i}"})


@spec("DeleteArtifact")
async def _(x: Ctx, i: int) -> Call:
    path = _artifact(x, 2)
    await x.ok("POST", f"{path}:undelete", json={}, allow=(400, 409, 412))
    return Call("DELETE", path)


@spec("UndeleteArtifact")
async def _(x: Ctx, i: int) -> Call:
    path = _artifact(x, 3)
    await x.ok("DELETE", path, allow=(400, 404, 409, 412))
    return Call("POST", f"{path}:undelete", json={})


@spec("CommitArtifact")
async def _(x: Ctx, i: int) -> Call:
    return Call("POST", f"{_artifact(x, 4)}:commit", json={"text": f"# Perf\n\nRevision {x.n()}", "changeSummary": "perf"})


@spec("DeleteArtifactRevision")
async def _(x: Ctx, i: int) -> Call:
    path = _artifact(x, 5)
    await x.ok("POST", f"{path}:commit", json={"text": f"# Perf {x.n()}"})
    revisions = await x.ok("GET", f"{path}/revisions", params={"pageSize": 200})
    newest = max((r["name"] for r in revisions.get("revisions", [])), key=lambda n: int(last(n)))
    return Call("DELETE", f"/api/v1/{newest}")


@spec("RollbackArtifact")
async def _(x: Ctx, i: int) -> Call:
    path = _artifact(x, 6)
    await x.ok("POST", f"{path}:commit", json={"text": f"# Perf {x.n()}"})
    revisions = await x.ok("GET", f"{path}/revisions", params={"pageSize": 50})
    oldest = [r["name"] for r in revisions.get("revisions", [])][-1]
    return Call("POST", f"/api/v1/{oldest}:rollback", json={})


@spec("PublishArtifact")
async def _(x: Ctx, i: int) -> Call:
    return Call("POST", f"{_artifact(x, 7 + i % 10)}:publish", json={"collection": x.item(x.ds.leaf_collections[6])})


# -- Conversations ----------------------------------------------------------------------


async def _conversation(x: Ctx) -> str:
    return (await x.ok("POST", f"{x.ws}/conversations", json={"displayName": f"Perf {x.n()}"}))["name"]


@spec("CreateConversation")
async def _(x: Ctx, i: int) -> Call:
    return Call("POST", f"{x.ws}/conversations", json={"displayName": f"Perf {x.n()}",
                                                       "scope": {"collections": [x.item(x.ds.roots[0])]}})


@spec("UpdateConversation")
async def _(x: Ctx, i: int) -> Call:
    return Call("PATCH", f"{x.ws}/conversations/{x.ds.conversations[1]}", params={"updateMask": "pinned"},
                json={"pinned": bool(i % 2)})


@spec("DeleteConversation")
async def _(x: Ctx, i: int) -> Call:
    return Call("DELETE", f"/api/v1/{await _conversation(x)}")


@spec("UndeleteConversation")
async def _(x: Ctx, i: int) -> Call:
    name = await _conversation(x)
    await x.ok("DELETE", f"/api/v1/{name}")
    return Call("POST", f"/api/v1/{name}:undelete", json={})


@spec("SubmitMessageFeedback")
async def _(x: Ctx, i: int) -> Call:
    conversation, message = x.ds.messages[x.n() % len(x.ds.messages)]
    return Call("POST", f"{x.ws}/conversations/{conversation}/messages/{message}:submitFeedback",
                json={"rating": "HELPFUL"})


# -- Collaboration ------------------------------------------------------------------------


def _space(x: Ctx, index: int = 0) -> str:
    return f"{x.wsn}/spaces/{x.ds.spaces[index]}"


async def _question(x: Ctx, actor: str | None = None) -> str:
    created = await x.ok("POST", f"{x.ws}/requests", actor=actor,
                         json={"kind": "QUESTION", "space": _space(x), "question": f"Perf question {x.n()}?",
                               "title": "Perf question"})
    return created["name"]


async def _access_request(x: Ctx) -> str:
    serial = x.n()
    member = x.ds.members[30 + serial % 60]
    discoverable = x.ds.roots[3::3]  # seeded discoverable roots a member may ask for
    collection = discoverable[serial % len(discoverable)]
    created = await x.ok("POST", f"{x.ws}/requests", actor=member,
                         json={"kind": "COLLECTION_ACCESS", "collection": x.item(collection),
                               "requestedRole": "roles/collectionViewer", "title": "Access please"},
                         allow=(409,))
    if not created.get("name"):
        found = await x.first(f"{x.ws}/requests", {"filter": 'state = "OPEN" AND kind = "COLLECTION_ACCESS"'})
        if not found:
            raise SetupError("no open access request")
        return found["name"]
    return created["name"]


@spec("CreateRequest")
async def _(x: Ctx, i: int) -> Call:
    return Call("POST", f"{x.ws}/requests", json={"kind": "QUESTION", "space": _space(x),
                                                  "question": f"Perf question {x.n()}?", "title": "Perf"})


@spec("UpdateRequest")
async def _(x: Ctx, i: int) -> Call:
    await x.once("question", lambda: _question(x))
    return Call("PATCH", f"/api/v1/{x.shared['question']}", params={"updateMask": "title"},
                json={"kind": "QUESTION", "title": f"Perf v{i}"})


@spec("CreateRequestMessage")
async def _(x: Ctx, i: int) -> Call:
    await x.once("question", lambda: _question(x))
    return Call("POST", f"/api/v1/{x.shared['question']}/messages", json={"text": f"Perf message {i}"})


@spec("AnswerRequest")
async def _(x: Ctx, i: int) -> Call:
    name = await _question(x, actor=x.ds.member)
    return Call("POST", f"/api/v1/{name}:answer", json={"answer": "See the handbook."})


@spec("SendBackRequest")
async def _(x: Ctx, i: int) -> Call:
    name = await _question(x, actor=x.ds.member)
    return Call("POST", f"/api/v1/{name}:sendBack", json={"message": "More detail please"})


@spec("CloseRequest")
async def _(x: Ctx, i: int) -> Call:
    name = await _question(x, actor=x.ds.member)
    await x.ok("POST", f"/api/v1/{name}:answer", json={"answer": "Done."}, allow=(400, 409, 412))
    return Call("POST", f"/api/v1/{name}:close", json={}, expect=(400, 409, 412))


@spec("WithdrawRequest")
async def _(x: Ctx, i: int) -> Call:
    name = await _question(x, actor=x.ds.member)
    return Call("POST", f"/api/v1/{name}:withdraw", json={}, actor=x.ds.member)


@spec("ApproveRequest")
async def _(x: Ctx, i: int) -> Call:
    name = await _access_request(x)
    return Call("POST", f"/api/v1/{name}:approve", json={"message": "OK"})


@spec("DenyRequest")
async def _(x: Ctx, i: int) -> Call:
    name = await _access_request(x)
    return Call("POST", f"/api/v1/{name}:deny", json={"message": "No"})


async def _new_space(x: Ctx, join_policy: str = "INVITE") -> str:
    created = await x.ok("POST", f"{x.ws}/spaces", params={"spaceId": f"perf-space-{x.n()}"},
                         json={"displayName": f"Perf space {x.n()}", "joinPolicy": join_policy})
    return created["name"]


@spec("CreateSpace")
async def _(x: Ctx, i: int) -> Call:
    return Call("POST", f"{x.ws}/spaces", params={"spaceId": f"perf-space-{x.n()}"},
                json={"displayName": f"Perf space {x.n()}"})


@spec("UpdateSpace")
async def _(x: Ctx, i: int) -> Call:
    return Call("PATCH", f"{x.ws}/spaces/{x.ds.spaces[1]}", params={"updateMask": "description"},
                json={"displayName": "Space 1", "description": f"v{i}"})


@spec("DeleteSpace")
async def _(x: Ctx, i: int) -> Call:
    return Call("DELETE", f"/api/v1/{await _new_space(x)}")


@spec("UndeleteSpace")
async def _(x: Ctx, i: int) -> Call:
    name = await _new_space(x)
    await x.ok("DELETE", f"/api/v1/{name}")
    return Call("POST", f"/api/v1/{name}:undelete", json={})


async def _open_space(x: Ctx) -> str:
    if "open_space" not in x.shared:
        x.shared["open_space"] = await _new_space(x, "OPEN")
    return x.shared["open_space"]


@spec("JoinSpace")
async def _(x: Ctx, i: int) -> Call:
    space = await _open_space(x)
    member = x.ds.members[5]
    await x.ok("POST", f"/api/v1/{space}:leave", json={}, actor=member, allow=(400, 403, 404, 409, 412))
    return Call("POST", f"/api/v1/{space}:join", json={}, actor=member)


@spec("LeaveSpace")
async def _(x: Ctx, i: int) -> Call:
    space = await _open_space(x)
    member = x.ds.members[6]
    await x.ok("POST", f"/api/v1/{space}:join", json={}, actor=member, allow=(400, 409, 412))
    return Call("POST", f"/api/v1/{space}:leave", json={}, actor=member)


def _space_children(kind: str, op_title: str, body: Callable[[Ctx], dict[str, Any]], mask: str,
                    patch: dict[str, Any]) -> None:
    async def create_one(x: Ctx) -> str:
        return (await x.ok("POST", f"{x.ws}/spaces/{x.ds.spaces[2]}/{kind}", json=body(x)))["name"]

    @spec(f"Create{op_title}")
    async def create(x: Ctx, i: int) -> Call:
        return Call("POST", f"{x.ws}/spaces/{x.ds.spaces[2]}/{kind}", json=body(x))

    @spec(f"Update{op_title}")
    async def update(x: Ctx, i: int) -> Call:
        name = await x.once(f"space_{kind}", lambda: create_one(x))
        return Call("PATCH", f"/api/v1/{name}", params={"updateMask": mask}, json={**body(x), **patch})

    @spec(f"Delete{op_title}")
    async def delete(x: Ctx, i: int) -> Call:
        return Call("DELETE", f"/api/v1/{await create_one(x)}")


_space_children("announcements", "Announcement", lambda x: {"title": f"Perf announcement {x.n()}", "body": "Body"},
                "pinned", {"pinned": True})
_space_children("events", "SpaceEvent", lambda x: {"title": f"Perf event {x.n()}",
                "startTime": (datetime.now(UTC) + timedelta(days=3)).isoformat()}, "location", {"location": "Room 1"})
_space_children("requestTypes", "RequestType", lambda x: {"displayName": f"Perf type {x.n()}"},
                "description", {"description": "v"})


@spec("UndeleteRequestType")
async def _(x: Ctx, i: int) -> Call:
    created = await x.ok("POST", f"{x.ws}/spaces/{x.ds.spaces[2]}/requestTypes", json={"displayName": f"Perf type {x.n()}"})
    await x.ok("DELETE", f"/api/v1/{created['name']}")
    return Call("POST", f"/api/v1/{created['name']}:undelete", json={})


@spec("CreateMaterial")
async def _(x: Ctx, i: int) -> Call:
    space = await _new_space(x)
    return Call("POST", f"/api/v1/{space}/materials", json={"item": x.item(x.ds.published_documents[i % 100])})


@spec("DeleteMaterial")
async def _(x: Ctx, i: int) -> Call:
    space = await _new_space(x)
    material = await x.ok("POST", f"/api/v1/{space}/materials", json={"item": x.item(x.ds.published_documents[3])})
    return Call("DELETE", f"/api/v1/{material['name']}")


@spec("CreateSpaceMember")
async def _(x: Ctx, i: int) -> Call:
    space = await _new_space(x)
    return Call("POST", f"/api/v1/{space}/members", json={"member": x.member(x.ds.members[10])})


@spec("DeleteSpaceMember")
async def _(x: Ctx, i: int) -> Call:
    space = await _new_space(x)
    member = await x.ok("POST", f"/api/v1/{space}/members", json={"member": x.member(x.ds.members[11])})
    return Call("DELETE", f"/api/v1/{member['name']}")


@spec("CancelOperation")
async def _(x: Ctx, i: int) -> Call:
    operation = await x.ok("POST", f"{x.ws}/auditEvents:export", json={})
    return Call("POST", f"/api/v1/{operation['name']}:cancel", json={}, expect=(400, 409, 412))


# -- Statement capture ----------------------------------------------------------------------


@dataclass(slots=True)
class Statement:
    sql: str
    params: Any
    seconds: float


@dataclass(slots=True)
class Capture:
    active: bool = False
    statements: list[Statement] = field(default_factory=list)
    checkouts: int = 0


CAPTURE = Capture()
_STARTED = "_perf_started"


@event.listens_for(Engine, "before_cursor_execute")
def _before(conn, cursor, statement, parameters, context, executemany) -> None:  # noqa: ANN001
    if CAPTURE.active and context is not None:
        setattr(context, _STARTED, time.perf_counter())


@event.listens_for(Engine, "after_cursor_execute")
def _after(conn, cursor, statement, parameters, context, executemany) -> None:  # noqa: ANN001
    started = getattr(context, _STARTED, None) if context is not None else None
    if CAPTURE.active and started is not None:
        CAPTURE.statements.append(Statement(statement, parameters, time.perf_counter() - started))


@event.listens_for(Pool, "checkout")
def _checkout(dbapi_connection, connection_record, connection_proxy) -> None:  # noqa: ANN001
    if CAPTURE.active:
        CAPTURE.checkouts += 1


def shape(sql: str) -> str:
    """A statement's shape: literals and parameter lists folded, whitespace collapsed."""
    sql = re.sub(r"\$\d+(::\w+(\[\])?)?", "?", sql)
    sql = re.sub(r"\(\?(, \?)+\)", "(?...)", sql)
    sql = re.sub(r"'[^']*'", "'?'", sql)
    return re.sub(r"\s+", " ", sql).strip()


# -- Results -----------------------------------------------------------------------------


@dataclass(slots=True)
class Sample:
    status: int
    ms: float
    app_ms: float | None
    db_ms: float | None


@dataclass(slots=True)
class Result:
    case: Case
    samples: list[Sample] = field(default_factory=list)
    concurrent: list[Sample] = field(default_factory=list)
    statements: int | None = None
    statement_ms: float | None = None
    repeated: list[tuple[int, str]] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)
    setup_error: str | None = None
    expected: tuple[int, ...] = ()
    count_status: int | None = None
    checkouts: int | None = None
    expected_body: str | None = None


def server_timing(response: httpx.Response) -> tuple[float | None, float | None]:
    values = dict(re.findall(r"(\w+);dur=([\d.]+)", response.headers.get("server-timing", "")))
    app, db = values.get("app"), values.get("db")
    return (float(app) if app else None, float(db) if db else None)


def unexpected(status: int, expected: tuple[int, ...]) -> bool:
    return status >= 300 and status not in expected


async def measure(x: Ctx, result: Result, call: Call, into: list[Sample]) -> httpx.Response | None:
    started = time.perf_counter()
    try:
        response = await x.send(call)
    except Exception:  # noqa: BLE001 - an app exception in-process is the 500 we report
        into.append(Sample(500, (time.perf_counter() - started) * 1000, None, None))
        result.errors.append(f"500 (in-process exception)\n{traceback.format_exc(limit=12)}")
        return None
    elapsed = (time.perf_counter() - started) * 1000
    app, db = server_timing(response)
    into.append(Sample(response.status_code, elapsed, app, db))
    if unexpected(response.status_code, call.expect) and len(result.errors) < 3:
        result.errors.append(f"{response.status_code} {call.method} {call.path} {call.params or ''}\n{response.text[:800]}")
    elif response.status_code >= 300 and result.expected_body is None:
        result.expected_body = f"{response.status_code} {response.text[:400]}"
    return response


async def build(x: Ctx, case: Case, result: Result, i: int) -> Call | None:
    try:
        call = await case.build(x, i)
    except Exception as exc:  # noqa: BLE001 - recorded, the case is reported as not measured
        result.setup_error = f"{type(exc).__name__}: {exc}"[:600]
        return None
    result.expected = call.expect
    return call


# -- Passes ---------------------------------------------------------------------------------


async def count_pass(x: Ctx, cases: list[Case], results: dict[str, Result], capture_top: list[tuple[float, str, Statement]]) -> None:
    """In-process: one warm call, then one counted call per case."""
    for case in cases:
        result = results[case.label]
        for attempt in range(2):
            call = await build(x, case, result, attempt)
            if call is None:
                break
            CAPTURE.statements.clear()
            CAPTURE.checkouts = 0
            CAPTURE.active = attempt == 1
            response = await measure(x, result, call, [])
            CAPTURE.active = False
            if attempt == 1:
                statements = list(CAPTURE.statements)
                result.statements = len(statements)
                result.count_status = response.status_code if response is not None else 500
                result.checkouts = CAPTURE.checkouts
                result.statement_ms = sum(s.seconds for s in statements) * 1000
                shapes = Counter(shape(s.sql) for s in statements)
                result.repeated = [(n, sql[:220]) for sql, n in shapes.most_common(4) if n > 2]
                for statement in statements:
                    capture_top.append((statement.seconds, case.label, statement))
                capture_top.sort(key=lambda entry: -entry[0])
                del capture_top[40:]
        print(f"count {case.label}: {result.statements} stmts", file=sys.stderr, flush=True)


async def latency_pass(x: Ctx, cases: list[Case], results: dict[str, Result], iterations: int) -> None:
    for case in cases:
        result = results[case.label]
        for i in range(iterations):
            call = await build(x, case, result, i)
            if call is None:
                break
            await measure(x, result, call, result.samples)


async def concurrency_pass(x: Ctx, cases: list[Case], results: dict[str, Result], users: int, seconds: float) -> dict[str, Any]:
    reads = [case for case in cases if case.read and results[case.label].setup_error is None]
    calls = {}
    for case in reads:
        call = await build(x, case, results[case.label], 0)
        if call is not None:
            calls[case.label] = call
    labels = sorted(calls)
    deadline = time.monotonic() + seconds
    total = Counter()

    async def user(seed_value: int) -> None:
        rng = random.Random(seed_value)
        while time.monotonic() < deadline:
            label = rng.choice(labels)
            response = await measure(x, results[label], calls[label], results[label].concurrent)
            total["requests"] += 1
            if response is None or unexpected(response.status_code, calls[label].expect):
                total["errors"] += 1

    started = time.monotonic()
    await asyncio.gather(*(user(n) for n in range(users)))
    elapsed = time.monotonic() - started
    return {"users": users, "seconds": elapsed, "requests": total["requests"], "errors": total["errors"],
            "rps": total["requests"] / elapsed, "cases": len(labels)}


# -- Report ------------------------------------------------------------------------------------


def pct(values: list[float], q: float) -> float:
    if not values:
        return float("nan")
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, max(0, round(q * (len(ordered) - 1))))]


def fmt(value: float | None, digits: int = 1) -> str:
    return "–" if value is None or value != value else f"{value:.{digits}f}"


def statuses(samples: list[Sample]) -> str:
    return " ".join(f"{code}×{n}" for code, n in sorted(Counter(s.status for s in samples).items()))


def db_share(samples: list[Sample]) -> float | None:
    pairs = [(s.app_ms, s.db_ms) for s in samples if s.app_ms and s.db_ms is not None]
    if not pairs:
        return None
    return 100 * sum(db for _, db in pairs) / sum(app for app, _ in pairs)


def write_report(path: Path, meta: dict[str, Any], results: dict[str, Result], skipped: dict[str, str],
                 concurrency: dict[str, Any] | None, explains: list[tuple[str, float, str, str]],
                 server_errors: list[str]) -> None:
    lines = [f"# BoMesh API load test — raw results ({meta['when']})", ""]
    lines += ["## Environment", ""] + [f"- {k}: {v}" for k, v in meta["environment"].items()] + [""]
    lines += ["## Dataset", "", ", ".join(f"{k}={v}" for k, v in meta["counts"].items()), ""]
    lines += ["## Per-case results", "",
              "Latency: sequential calls against uvicorn (client-side ms). `db%` = Σ Server-Timing db / Σ app. "
              "`stmts` = SQL statements of one in-process call (warm), `cnt` its status, `conn` its pool checkouts. "
              "`status` = status codes of the latency pass.", "",
              "| case | method | path | status | p50 | p95 | p99 | max | db% | stmts | cnt | conn | stmt ms |",
              "| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |"]
    for label, r in results.items():
        ms = [s.ms for s in r.samples]
        status = statuses(r.samples) if r.samples else (f"setup failed: {r.setup_error[:80]}" if r.setup_error else "–")
        lines.append(f"| {label} | {r.case.op.method} | `{r.case.op.path}` | {status} | {fmt(pct(ms, .5))} | "
                     f"{fmt(pct(ms, .95))} | {fmt(pct(ms, .99))} | {fmt(max(ms) if ms else None)} | "
                     f"{fmt(db_share(r.samples), 0)} | {r.statements if r.statements is not None else '–'} | "
                     f"{r.count_status or '–'} | {r.checkouts if r.checkouts is not None else '–'} | "
                     f"{fmt(r.statement_ms)} |")
    lines += ["", "## Statements vs page size", "", "| operation | ps=20 | ps=100 | ps=200 | growth |", "| --- | ---: | ---: | ---: | ---: |"]
    by_op: dict[str, dict[int, int]] = defaultdict(dict)
    for r in results.values():
        if r.case.page_size in PAGE_SIZES and r.statements is not None and re.search(r" ps=\d+$", r.case.label):
            by_op[r.case.label.rsplit(" ", 1)[0]][r.case.page_size] = r.statements
    for op, sizes in sorted(by_op.items(), key=lambda kv: -(kv[1].get(200, 0) - kv[1].get(20, 0))):
        growth = sizes.get(200, 0) - sizes.get(20, 0)
        lines.append(f"| {op} | {sizes.get(20, '–')} | {sizes.get(100, '–')} | {sizes.get(200, '–')} | {growth:+d} |")
    lines += ["", "## Repeated statement shapes (>2 per request)", ""]
    for label, r in results.items():
        if r.repeated:
            lines.append(f"- **{label}** ({r.statements} stmts): " + "; ".join(f"×{n} `{sql}`" for n, sql in r.repeated))
    if concurrency:
        lines += ["", "## Concurrency", "",
                  f"{concurrency['users']} virtual users, {concurrency['seconds']:.0f} s, {concurrency['cases']} read cases mixed uniformly: "
                  f"**{concurrency['requests']} requests, {concurrency['rps']:.1f} req/s, {concurrency['errors']} unexpected errors "
                  f"({100 * concurrency['errors'] / max(1, concurrency['requests']):.2f}%)**.", "",
                  "| case (slowest p95 first) | n | status | p50 | p95 | p99 | max | db% |", "| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: |"]
        ranked = sorted((r for r in results.values() if r.concurrent), key=lambda r: -pct([s.ms for s in r.concurrent], .95))
        for r in ranked:
            ms = [s.ms for s in r.concurrent]
            lines.append(f"| {r.case.label} | {len(ms)} | {statuses(r.concurrent)} | {fmt(pct(ms, .5))} | {fmt(pct(ms, .95))} | "
                         f"{fmt(pct(ms, .99))} | {fmt(max(ms))} | {fmt(db_share(r.concurrent), 0)} |")
    lines += ["", "## Unexpected responses (non-2xx outside the documented 4xx of the case)", ""]
    for label, r in results.items():
        if r.errors:
            lines.append(f"### {label}\n\n```\n" + "\n---\n".join(r.errors[:2]) + "\n```\n")
    lines += ["## Documented 4xx answers (first body per case)", ""]
    lines += [f"- {label}: `{r.expected_body}`" for label, r in results.items() if r.expected_body]
    lines += ["", "## Not measured", ""]
    lines += [f"- {op}: {why}" for op, why in sorted(skipped.items())]
    lines += [f"- {label}: setup failed — {r.setup_error}" for label, r in results.items() if r.setup_error and not r.samples]
    lines += ["", "## Slowest captured statements with EXPLAIN (ANALYZE, BUFFERS)", ""]
    for label, seconds, sql, plan in explains:
        lines += [f"### {seconds * 1000:.1f} ms — {label}", "", "```sql", sql[:2500], "```", "", "```", plan, "```", ""]
    lines += ["## Server tracebacks (uvicorn log)", ""]
    lines += ["```\n" + tb[:3000] + "\n```" for tb in server_errors[:15]] or ["none"]
    path.write_text("\n".join(lines) + "\n")


async def explain(top: list[tuple[float, str, Statement]], limit: int) -> list[tuple[str, float, str, str]]:
    import asyncpg

    seen: set[str] = set()
    out: list[tuple[str, float, str, str]] = []
    connection = await asyncpg.connect(PERF_DB_URL.replace("+asyncpg", ""))
    try:
        for seconds, label, statement in top:
            key = shape(statement.sql)
            if key in seen or not statement.sql.lstrip().upper().startswith(("SELECT", "WITH")):
                continue
            seen.add(key)
            params = statement.params if isinstance(statement.params, (list, tuple)) else ()
            transaction = connection.transaction()
            await transaction.start()
            try:
                rows = await connection.fetch("EXPLAIN (ANALYZE, BUFFERS) " + statement.sql, *params)
                plan = "\n".join(row[0] for row in rows)
            except Exception as exc:  # noqa: BLE001 - reported instead of the plan
                plan = f"EXPLAIN failed: {exc}"
            finally:
                await transaction.rollback()
            out.append((label, seconds, statement.sql, plan))
            if len(out) >= limit:
                break
    finally:
        await connection.close()
    return out


# -- Commands --------------------------------------------------------------------------------


def _runtime() -> Any:
    from bomesh.runtime import AppRuntime
    from config import get_config, reset_config

    reset_config()
    return AppRuntime(get_config())


async def cmd_setup(args: argparse.Namespace) -> None:
    from bomesh.db.models import Base
    from bomesh.iam.sync import sync_catalog
    from sqlalchemy.ext.asyncio import async_sessionmaker

    admin = create_async_engine(ADMIN_DB_URL, isolation_level="AUTOCOMMIT")
    async with admin.connect() as connection:
        exists = await connection.scalar(text("SELECT 1 FROM pg_database WHERE datname = :n"), {"n": PERF_DB})
        if exists and not args.recreate:
            raise SystemExit(f"{PERF_DB} exists; pass --recreate to rebuild it")
        if exists:
            await connection.execute(text(f'DROP DATABASE "{PERF_DB}" WITH (FORCE)'))
        await connection.execute(text(f'CREATE DATABASE "{PERF_DB}"'))
    await admin.dispose()
    engine = create_async_engine(PERF_DB_URL)
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    async with async_sessionmaker(engine).begin() as session:
        await sync_catalog(session)
    started = time.perf_counter()
    dataset = await seed(engine, Scale())
    print(f"seeded in {time.perf_counter() - started:.1f}s: {dataset.counts}", file=sys.stderr)
    await engine.dispose()
    runtime = _runtime()
    storage = runtime.object_storage()
    from bomesh.storage.keys import content_key

    pdf = (b"%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj "
           b"3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n")
    engine = create_async_engine(PERF_DB_URL)
    async with engine.connect() as connection:
        rows = (await connection.execute(text(
            "SELECT i.id, array_agg(r.content_id) FROM items i JOIN item_revisions r ON r.item_id = i.id "
            "WHERE i.tenant_id = :ws AND i.item_kind = 'document' AND i.deleted_at IS NULL "
            "AND i.current_revision_id IS NOT NULL "
            "AND i.is_published = true AND r.deleted_at IS NULL GROUP BY i.id HAVING count(*) >= 2 "
            "ORDER BY i.id LIMIT 20"),
            {"ws": dataset.workspace})).all()
        artifact_contents = (await connection.execute(text(
            "SELECT r.content_id FROM item_revisions r WHERE r.item_id = ANY(CAST(:ids AS uuid[]))"),
            {"ids": dataset.artifacts})).scalars().all()
    await engine.dispose()
    workspace = UUID(dataset.workspace)
    for item_id, contents in rows:
        for content_id in contents:
            storage.put_bytes(pdf, content_key(workspace, content_id), content_type="application/pdf")
        dataset.stored_documents.append(str(item_id))
    for content_id in artifact_contents:
        storage.put_bytes(
            b"# Artifact\n\nSeeded by the perf harness.\n",
            content_key(workspace, content_id),
            content_type="text/markdown",
        )
    await runtime.aclose()
    qdrant = os.environ.get("QDRANT_URL", "http://127.0.0.1:6333").rstrip("/")
    async with httpx.AsyncClient() as client:
        await client.delete(f"{qdrant}/collections/{PERF_COLLECTION}")
        response = await client.put(f"{qdrant}/collections/{PERF_COLLECTION}", json={
            "vectors": {"content": {"size": 1536, "distance": "Cosine"}},
            "sparse_vectors": {"content_bm25": {"modifier": "idf"}}})
        response.raise_for_status()
    WORK.mkdir(parents=True, exist_ok=True)
    DATASET.write_text(dataset.to_json())
    print(f"dataset written to {DATASET}", file=sys.stderr)


async def cmd_teardown(args: argparse.Namespace) -> None:
    from bomesh.storage.keys import export_key, tenant_prefixes

    runtime = _runtime()
    storage = runtime.object_storage()
    engine = create_async_engine(PERF_DB_URL)
    prefixes: list[str] = []
    keys: set[str] = set()
    try:
        async with engine.connect() as connection:
            prefixes = [
                prefix
                for row in await connection.execute(text("SELECT id FROM tenants"))
                for prefix in tenant_prefixes(row[0])
            ]
            keys = {
                export_key(row[1], row[0])
                for row in await connection.execute(text(
                    "SELECT id, tenant_id FROM operations"
                    " WHERE result_name IS NULL AND result_expires_at IS NOT NULL"))
            }
    except Exception as exc:  # noqa: BLE001 - the database may already be gone
        print(f"cannot read {PERF_DB}: {exc}", file=sys.stderr)
    await engine.dispose()
    deleted = 0
    for prefix in prefixes:
        deleted += await storage.delete_prefix(prefix)
    for key in keys:
        await storage.delete(key)
    print(f"deleted {deleted + len(keys)} stored objects", file=sys.stderr)
    await runtime.aclose()
    qdrant = os.environ.get("QDRANT_URL", "http://127.0.0.1:6333").rstrip("/")
    async with httpx.AsyncClient() as client_http:
        await client_http.delete(f"{qdrant}/collections/{PERF_COLLECTION}")
    admin = create_async_engine(ADMIN_DB_URL, isolation_level="AUTOCOMMIT")
    async with admin.connect() as connection:
        await connection.execute(text(f'DROP DATABASE IF EXISTS "{PERF_DB}" WITH (FORCE)'))
    await admin.dispose()
    DATASET.unlink(missing_ok=True)
    print(f"dropped {PERF_DB} and Qdrant collection {PERF_COLLECTION}", file=sys.stderr)


def start_server(port: int, log: Path) -> subprocess.Popen[bytes]:
    handle = log.open("wb")
    process = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "api.app:create_app", "--factory", "--host", "127.0.0.1",
         "--port", str(port), "--no-access-log", "--log-level", "warning"],
        cwd=BACKEND, env={**os.environ}, stdout=handle, stderr=subprocess.STDOUT,
    )
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        try:
            if httpx.get(f"http://127.0.0.1:{port}/health", timeout=1).status_code == 200:
                return process
        except httpx.HTTPError:
            pass
        if process.poll() is not None:
            raise SystemExit(f"uvicorn exited: {log.read_text()[-2000:]}")
        time.sleep(0.5)
    process.terminate()
    raise SystemExit("uvicorn did not become healthy")


def server_tracebacks(log: Path) -> list[str]:
    text_ = log.read_text(errors="replace") if log.exists() else ""
    blocks = re.split(r"\n(?=\S.*(?:ERROR|Exception in ASGI application))", text_)
    return [block.strip() for block in blocks if "Traceback" in block]


async def cmd_run(args: argparse.Namespace) -> None:
    from api.app import create_app

    ds = Dataset.from_json(DATASET.read_text())
    operations = catalog()
    cases, skipped = build_cases(operations)
    if args.only:
        cases = [c for c in cases if re.search(args.only, c.label)]
    results = {case.label: Result(case) for case in cases}
    runtime = _runtime()
    minter = Minter(runtime)
    shared: dict[str, Any] = {"jpeg": _jpeg()}
    async with runtime.sessions()() as session:
        for key, user in (("member_email", ds.member), ("admin_email", ds.admin)):
            shared[key] = await session.scalar(text("SELECT email FROM users WHERE id = :id"), {"id": user})
    meta = {
        "when": datetime.now(UTC).isoformat(timespec="seconds"),
        "environment": {
            "host": f"{os.uname().sysname} {os.uname().machine}, load average {os.getloadavg()[0]:.2f}",
            "database": f"{PERF_DB} on the compose PostgreSQL (127.0.0.1:5432)",
            "server": f"uvicorn api.app:create_app --factory, 1 process, 127.0.0.1:{args.port}",
            "operations in contract": len(operations), "cases": len(cases),
            "iterations": args.iterations, "concurrency": f"{args.users} users × {args.seconds}s",
        },
        "counts": ds.counts,
    }
    top: list[tuple[float, str, Statement]] = []
    passes = set(args.passes.split(","))
    if "count" in passes:
        app = create_app(runtime)
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://perf", timeout=120) as http:
            x = Ctx(ds, http, minter)
            x.shared.update(shared)
            await count_pass(x, cases, results, top)
    log = WORK / "uvicorn.log"
    server = start_server(args.port, log) if passes & {"latency", "concurrency"} else None
    concurrency = None
    try:
        limits = httpx.Limits(max_connections=args.users + 5, max_keepalive_connections=args.users + 5)
        async with httpx.AsyncClient(base_url=f"http://127.0.0.1:{args.port}", timeout=120, limits=limits) as http:
            x = Ctx(ds, http, minter)
            x.shared.update(shared)
            if "latency" in passes:
                await latency_pass(x, cases, results, args.iterations)
            if "concurrency" in passes:
                concurrency = await concurrency_pass(x, cases, results, args.users, args.seconds)
    finally:
        if server is not None:
            server.terminate()
            server.wait(timeout=30)
    explains = await explain(top, 5) if top else []
    await runtime.aclose()
    write_report(Path(args.out), meta, results, skipped, concurrency, explains, server_tracebacks(log))
    print(f"report written to {args.out}", file=sys.stderr)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest="command", required=True)
    setup = commands.add_parser("setup")
    setup.add_argument("--recreate", action="store_true")
    commands.add_parser("teardown")
    run = commands.add_parser("run")
    run.add_argument("--passes", default="count,latency,concurrency")
    run.add_argument("--iterations", type=int, default=10)
    run.add_argument("--users", type=int, default=20)
    run.add_argument("--seconds", type=float, default=60)
    run.add_argument("--port", type=int, default=8100)
    run.add_argument("--only", help="regex over case labels")
    run.add_argument("--out", default=str(WORK / "perf-results.md"))
    args = parser.parse_args()
    command = {"setup": cmd_setup, "teardown": cmd_teardown, "run": cmd_run}[args.command]
    asyncio.run(command(args))


if __name__ == "__main__":
    main()
