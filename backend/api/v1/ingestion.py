"""Ingestion interface — Ingestion slice: Connectors, ingestion policies, connections (OAuth), sources, syncs, ingestion runs and their tasks.

Routes are mounted under ``/api/v1``; ``name`` is the contract ``operationId``.
``oauth_router`` holds the OAuth provider redirect target ``GET /oauth/callback``,
a protocol endpoint outside the resource API mounted at the application root.
"""

from __future__ import annotations

import json
from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends, Query
from fastapi.responses import HTMLResponse

from api.aip import fieldmask
from api.aip.errors import HTTP_STATUS
from api.aip.paging import PageRequest, query_fingerprint
from api.dto.ingestion.connections import (
    CONNECTION_FIELDS,
    CONNECTION_FILTERS,
    CONNECTION_ORDER,
    BrowseConnectionResourcesResponse,
    ConnectionMessage,
    ListConnectionsResponse,
    ReauthorizeConnectionRequest,
    TestConnectionRequest,
    TestConnectionResponse,
    connection_message,
    connection_test_response,
    parse_connector,
    parse_owner,
    resource_message,
)
from api.dto.ingestion.connectors import (
    CONNECTOR_FIELDS,
    INGESTION_POLICY_FIELDS,
    ConnectorMessage,
    DisableConnectorRequest,
    EnableConnectorRequest,
    IngestionPolicyMessage,
    ListConnectorsResponse,
    ListIngestionPoliciesResponse,
    connector_filters,
    connector_message,
    connector_order,
    ingestion_policy_message,
    parse_duration,
)
from api.dto.ingestion.runs import (
    RUN_FILTERS,
    RUN_ORDER,
    TASK_FILTERS,
    TASK_ORDER,
    CancelIngestionRunRequest,
    IngestionRunMessage,
    IngestionTaskMessage,
    ListIngestionRunsResponse,
    ListIngestionTasksResponse,
    RetryIngestionRunRequest,
    SummarizeIngestionRunsResponse,
    ingestion_run_message,
    ingestion_task_message,
    run_selector,
    summary_window,
    workspace_summary_message,
)
from api.dto.ingestion.sources import (
    SOURCE_ORDER,
    SYNC_ORDER,
    ListSourcesResponse,
    ListSyncsResponse,
    PauseSourceRequest,
    ResumeSourceRequest,
    SourceMessage,
    SyncMessage,
    source_changes,
    source_draft,
    source_filters,
    source_message,
    sync_filters,
    sync_message,
)
from api.v1.deps import Context, service
from api.v1.listing import ListParams, list_query
from bomesh.errors import ServiceError
from bomesh.services.ingestion.common import (
    WILDCARD,
    parse_uuid,
    parse_workspace_id,
    parse_workspace_scope,
)
from bomesh.services.ingestion.connections import ConnectionService, NewConnection
from bomesh.services.ingestion.connectors import ConnectorService
from bomesh.services.ingestion.ingestion_policies import IngestionPolicyService
from bomesh.services.ingestion.names import connection_name
from bomesh.services.ingestion.runs import IngestionRuns
from bomesh.services.ingestion.sources import SourceService
from bomesh.services.ingestion.tasks import IngestionTasks

router = APIRouter(tags=["Ingestion"])
oauth_router = APIRouter()


# -- Connectors and ingestion policies -------------------------------------------

Connectors = Annotated[ConnectorService, Depends(service(ConnectorService.from_runtime))]
Policies = Annotated[
    IngestionPolicyService, Depends(service(IngestionPolicyService.from_runtime))
]
UpdateMask = Annotated[str | None, Query(alias="updateMask")]
PageSize = Annotated[int | None, Query(alias="pageSize")]
PageToken = Annotated[str | None, Query(alias="pageToken")]


@router.get("/connectors", name="ListConnectors")
async def list_connectors(
    params: Annotated[ListParams, Depends()], ctx: Context, connectors: Connectors
) -> ListConnectorsResponse:
    table = connectors.catalog_table()
    query, paging = list_query(
        params,
        parent="connectors",
        filters=connector_filters(table),
        order=connector_order(table),
    )
    records, total = await connectors.list(ctx, query, table)
    page = paging.page(records)
    return ListConnectorsResponse(
        connectors=[connector_message(record) for record in page.items],
        next_page_token=page.next_page_token or None,
        total_size=total,
    )


@router.get("/connectors/{connector:id}", name="GetConnector")
async def get_connector(connector: str, ctx: Context, connectors: Connectors) -> ConnectorMessage:
    return connector_message(await connectors.get(ctx, connector))


@router.patch("/connectors/{connector:id}", name="UpdateConnector")
async def update_connector(
    connector: str,
    body: ConnectorMessage,
    ctx: Context,
    connectors: Connectors,
    update_mask: UpdateMask = None,
) -> ConnectorMessage:
    changes = fieldmask.apply(CONNECTOR_FIELDS.parse(update_mask, body), body)
    return connector_message(await connectors.update(ctx, connector, changes, etag=body.etag))


@router.post("/connectors/{connector:id}:enable", name="EnableConnector")
async def enable_connector(
    connector: str, body: EnableConnectorRequest, ctx: Context, connectors: Connectors
) -> ConnectorMessage:
    return connector_message(await connectors.enable(ctx, connector, etag=body.etag))


@router.post("/connectors/{connector:id}:disable", name="DisableConnector")
async def disable_connector(
    connector: str, body: DisableConnectorRequest, ctx: Context, connectors: Connectors
) -> ConnectorMessage:
    return connector_message(await connectors.disable(ctx, connector, etag=body.etag))


@router.get("/ingestionPolicies", name="ListIngestionPolicies")
async def list_ingestion_policies(
    ctx: Context, policies: Policies, page_size: PageSize = None, page_token: PageToken = None
) -> ListIngestionPoliciesResponse:
    paging = PageRequest.from_params(
        page_size, page_token, query_fingerprint(parent="ingestionPolicies")
    )
    records = await policies.list(ctx)
    page = paging.page(records[paging.offset : paging.offset + paging.fetch_limit])
    return ListIngestionPoliciesResponse(
        ingestion_policies=[ingestion_policy_message(record) for record in page.items],
        next_page_token=page.next_page_token or None,
        total_size=len(records),
    )


@router.get("/ingestionPolicies/{ingestionPolicy:id}", name="GetIngestionPolicy")
async def get_ingestion_policy(
    ingestionPolicy: str,  # noqa: N803 - the contract's path variable
    ctx: Context,
    policies: Policies,
) -> IngestionPolicyMessage:
    return ingestion_policy_message(await policies.get(ctx, ingestionPolicy))


@router.patch("/ingestionPolicies/{ingestionPolicy:id}", name="UpdateIngestionPolicy")
async def update_ingestion_policy(
    ingestionPolicy: str,  # noqa: N803 - the contract's path variable
    body: IngestionPolicyMessage,
    ctx: Context,
    policies: Policies,
    update_mask: UpdateMask = None,
) -> IngestionPolicyMessage:
    changes = fieldmask.apply(INGESTION_POLICY_FIELDS.parse(update_mask, body), body)
    if "rejectedRetentionDuration" in changes:
        changes["rejectedRetentionDuration"] = parse_duration(
            changes["rejectedRetentionDuration"], field="rejectedRetentionDuration"
        )
    record = await policies.update(ctx, ingestionPolicy, changes, etag=body.etag)
    return ingestion_policy_message(record)


# -- Connections and the OAuth callback ------------------------------------------

Connections = Annotated[ConnectionService, Depends(service(ConnectionService.from_runtime))]


@router.post("/workspaces/{workspace:id}/connections", name="CreateConnection")
async def create_connection(
    workspace: str,
    body: ConnectionMessage,
    ctx: Context,
    connections: Connections,
    connection_id: Annotated[str | None, Query(alias="connectionId")] = None,
    request_id: Annotated[UUID | None, Query(alias="requestId")] = None,
    validate_only: Annotated[bool, Query(alias="validateOnly")] = False,
) -> ConnectionMessage:
    workspace_id = parse_workspace_id(workspace)
    new = NewConnection(
        connector_key=parse_connector(body.connector),
        display_name=body.display_name,
        owner_user_id=parse_owner(body.owner, workspace_id=workspace_id),
        api_token=body.api_token,
        config=body.config or {},
    )
    view = await connections.create(
        ctx,
        workspace_id,
        new,
        connection_id=connection_id,
        request_id=request_id,
        validate_only=validate_only,
    )
    return connection_message(view)


@router.get("/workspaces/{workspace:id}/connections", name="ListConnections")
async def list_connections(
    workspace: str,
    params: Annotated[ListParams, Depends()],
    ctx: Context,
    connections: Connections,
) -> ListConnectionsResponse:
    workspace_id = parse_workspace_id(workspace)
    query, paging = list_query(
        params,
        parent=f"workspaces/{workspace_id}/connections",
        filters=CONNECTION_FILTERS,
        order=CONNECTION_ORDER,
    )
    views, total = await connections.list(ctx, workspace_id, query)
    page = paging.page(views)
    return ListConnectionsResponse(
        connections=[connection_message(view) for view in page.items],
        next_page_token=page.next_page_token or None,
        total_size=total,
    )


@router.get("/workspaces/{workspace:id}/connections/{connection:id}", name="GetConnection")
async def get_connection(
    workspace: str, connection: str, ctx: Context, connections: Connections
) -> ConnectionMessage:
    view = await connections.get(ctx, parse_workspace_id(workspace), connection)
    return connection_message(view)


@router.patch("/workspaces/{workspace:id}/connections/{connection:id}", name="UpdateConnection")
async def update_connection(
    workspace: str,
    connection: str,
    body: ConnectionMessage,
    ctx: Context,
    connections: Connections,
    update_mask: UpdateMask = None,
) -> ConnectionMessage:
    mask = CONNECTION_FIELDS.parse(update_mask, body)
    view = await connections.update(
        ctx,
        parse_workspace_id(workspace),
        connection,
        display_name=(body.display_name or "") if "displayName" in mask.paths else None,
        etag=body.etag,
    )
    return connection_message(view)


@router.delete("/workspaces/{workspace:id}/connections/{connection:id}", name="DeleteConnection")
async def delete_connection(
    workspace: str,
    connection: str,
    ctx: Context,
    connections: Connections,
    etag: Annotated[str | None, Query()] = None,
) -> dict[str, object]:
    await connections.delete(ctx, parse_workspace_id(workspace), connection, etag=etag)
    return {}


@router.get(
    "/workspaces/{workspace:id}/connections/{connection:id}:browseResources",
    name="BrowseConnectionResources",
)
async def browse_connection_resources(
    workspace: str,
    connection: str,
    ctx: Context,
    connections: Connections,
    path: Annotated[str | None, Query()] = None,
    page_size: PageSize = None,
    page_token: PageToken = None,
) -> BrowseConnectionResourcesResponse:
    workspace_id = parse_workspace_id(workspace)
    paging = PageRequest.from_params(
        page_size,
        page_token,
        query_fingerprint(
            parent=f"workspaces/{workspace_id}/connections/{connection}", path=path or ""
        ),
    )
    resources = await connections.browse(ctx, workspace_id, connection, path=path)
    page = paging.page(resources[paging.offset : paging.offset + paging.fetch_limit])
    return BrowseConnectionResourcesResponse(
        resources=[resource_message(resource) for resource in page.items],
        next_page_token=page.next_page_token or None,
    )


@router.post(
    "/workspaces/{workspace:id}/connections/{connection:id}:reauthorize",
    name="ReauthorizeConnection",
)
async def reauthorize_connection(
    workspace: str,
    connection: str,
    body: ReauthorizeConnectionRequest,
    ctx: Context,
    connections: Connections,
) -> ConnectionMessage:
    view = await connections.reauthorize(
        ctx, parse_workspace_id(workspace), connection, etag=body.etag
    )
    return connection_message(view)


@router.post(
    "/workspaces/{workspace:id}/connections/{connection:id}:test", name="TestConnection"
)
async def test_connection(
    workspace: str,
    connection: str,
    body: TestConnectionRequest,
    ctx: Context,
    connections: Connections,
) -> TestConnectionResponse:
    result = await connections.test(ctx, parse_workspace_id(workspace), connection)
    return connection_test_response(result)


@oauth_router.get(
    "/oauth/callback", name="CompleteConnectionAuthorization", include_in_schema=False
)
async def complete_connection_authorization(
    connections: Connections,
    state: Annotated[str, Query(max_length=4_096)] = "",
    code: Annotated[str | None, Query(max_length=4_096)] = None,
    error: Annotated[str | None, Query(max_length=512)] = None,
    error_description: Annotated[str | None, Query(max_length=1_024)] = None,
) -> HTMLResponse:
    """The OAuth provider redirect target: a page posting the outcome to the opener.

    No bearer token: the sealed ``state`` is the authority.
    """
    origin = connections.client_origin
    nonce = ""
    try:
        nonce = connections.authorization_nonce(state)
        if error or not code:
            return _completion_page(
                origin,
                {
                    "status": "error",
                    "nonce": nonce,
                    "message": _provider_error(error, error_description),
                },
            )
        completed = await connections.complete_authorization(state, code)
    except ServiceError as exc:
        return _completion_page(
            origin,
            {"status": "error", "nonce": nonce, "message": exc.message},
            status_code=HTTP_STATUS[exc.code],
        )
    return _completion_page(
        origin,
        {
            "status": "connected",
            "nonce": nonce,
            "connection": connection_name(completed.tenant_id, completed.code),
        },
    )


def _script_literal(value: Any) -> str:
    return (
        json.dumps(value)
        .replace("<", "\\u003c")
        .replace(">", "\\u003e")
        .replace("&", "\\u0026")
        .replace("\u2028", "\\u2028")
        .replace("\u2029", "\\u2029")
    )


def _provider_error(error: str | None, description: str | None) -> str:
    if error == "access_denied":
        return "The account owner declined this authorization."
    detail = (description or "").strip() or (error or "").strip()
    if not detail:
        return "The provider did not complete the authorization."
    return f"{detail[:400]} (reported by the provider)"


def _completion_page(
    origin: str, payload: dict[str, Any], *, status_code: int = 200
) -> HTMLResponse:
    message = _script_literal({"source": "bomesh.connection", **payload})
    target = _script_literal(origin)
    return HTMLResponse(
        status_code=status_code,
        headers={
            "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'",
            "Cache-Control": "no-store",
            "Referrer-Policy": "no-referrer",
        },
        content=(
            '<!doctype html><meta charset="utf-8">'
            "<title>Finishing up...</title>"
            "<p>You can close this window.</p>"
            "<script>"
            f"var message = {message}; var target = {target};"
            "if (window.opener) { window.opener.postMessage(message, target); }"
            "window.close();"
            "</script>"
        ),
    )


# -- Sources and syncs -----------------------------------------------------------

Sources = Annotated[SourceService, Depends(service(SourceService.from_runtime))]


@router.post("/workspaces/{workspace:id}/sources", name="CreateSource")
async def create_source(
    workspace: str,
    body: SourceMessage,
    ctx: Context,
    sources: Sources,
    source_id: Annotated[str | None, Query(alias="sourceId")] = None,
    request_id: Annotated[UUID | None, Query(alias="requestId")] = None,
    validate_only: Annotated[bool, Query(alias="validateOnly")] = False,
) -> SourceMessage:
    record = await sources.create(
        ctx,
        parse_workspace_id(workspace),
        source_draft(body),
        source_id=source_id,
        request_id=request_id,
        validate_only=validate_only,
    )
    return source_message(record)


@router.get("/workspaces/{workspace:id}/sources", name="ListSources")
async def list_sources(
    workspace: str,
    params: Annotated[ListParams, Depends()],
    ctx: Context,
    sources: Sources,
) -> ListSourcesResponse:
    workspace_id = parse_workspace_id(workspace)
    query, paging = list_query(
        params,
        parent=f"workspaces/{workspace_id}/sources",
        filters=source_filters(workspace_id),
        order=SOURCE_ORDER,
    )
    records, total = await sources.list(ctx, workspace_id, query)
    page = paging.page(records)
    return ListSourcesResponse(
        sources=[source_message(record) for record in page.items],
        next_page_token=page.next_page_token or None,
        total_size=total,
    )


@router.get("/workspaces/{workspace:id}/sources/{source:id}", name="GetSource")
async def get_source(workspace: str, source: str, ctx: Context, sources: Sources) -> SourceMessage:
    return source_message(await sources.get(ctx, parse_workspace_id(workspace), source))


@router.patch("/workspaces/{workspace:id}/sources/{source:id}", name="UpdateSource")
async def update_source(
    workspace: str,
    source: str,
    body: SourceMessage,
    ctx: Context,
    sources: Sources,
    update_mask: UpdateMask = None,
) -> SourceMessage:
    record = await sources.update(
        ctx,
        parse_workspace_id(workspace),
        source,
        source_changes(body, update_mask),
        etag=body.etag,
    )
    return source_message(record)


@router.delete("/workspaces/{workspace:id}/sources/{source:id}", name="DeleteSource")
async def delete_source(
    workspace: str,
    source: str,
    ctx: Context,
    sources: Sources,
    etag: Annotated[str | None, Query()] = None,
) -> dict[str, object]:
    await sources.delete(ctx, parse_workspace_id(workspace), source, etag=etag)
    return {}


@router.post("/workspaces/{workspace:id}/sources/{source:id}:pause", name="PauseSource")
async def pause_source(
    workspace: str, source: str, body: PauseSourceRequest, ctx: Context, sources: Sources
) -> SourceMessage:
    record = await sources.pause(ctx, parse_workspace_id(workspace), source, etag=body.etag)
    return source_message(record)


@router.post("/workspaces/{workspace:id}/sources/{source:id}:resume", name="ResumeSource")
async def resume_source(
    workspace: str, source: str, body: ResumeSourceRequest, ctx: Context, sources: Sources
) -> SourceMessage:
    record = await sources.resume(ctx, parse_workspace_id(workspace), source, etag=body.etag)
    return source_message(record)


@router.post("/workspaces/{workspace:id}/sources/{source:id}/syncs", name="CreateSync")
async def create_sync(
    workspace: str,
    source: str,
    body: SyncMessage,
    ctx: Context,
    sources: Sources,
    request_id: Annotated[UUID | None, Query(alias="requestId")] = None,
) -> SyncMessage:
    record = await sources.create_sync(
        ctx, parse_workspace_id(workspace), source, request_id=request_id
    )
    return sync_message(record)


@router.get("/workspaces/{workspace:id}/sources/{source:id}/syncs", name="ListSyncs")
async def list_syncs(
    workspace: str,
    source: str,
    params: Annotated[ListParams, Depends()],
    ctx: Context,
    sources: Sources,
) -> ListSyncsResponse:
    workspace_id = parse_workspace_id(workspace)
    query, paging = list_query(
        params,
        parent=f"workspaces/{workspace_id}/sources/{source}/syncs",
        filters=sync_filters(workspace_id),
        order=SYNC_ORDER,
    )
    records, total = await sources.list_syncs(
        ctx, workspace_id, None if source == WILDCARD else source, query
    )
    page = paging.page(records)
    return ListSyncsResponse(
        syncs=[sync_message(record) for record in page.items],
        next_page_token=page.next_page_token or None,
        total_size=total,
    )


@router.get("/workspaces/{workspace:id}/sources/{source:id}/syncs/{sync:id}", name="GetSync")
async def get_sync(
    workspace: str, source: str, sync: str, ctx: Context, sources: Sources
) -> SyncMessage:
    record = await sources.get_sync(
        ctx, parse_workspace_id(workspace), source, parse_uuid(sync, field="sync")
    )
    return sync_message(record)


# -- Ingestion runs and tasks ----------------------------------------------------

Runs = Annotated[IngestionRuns, Depends(service(IngestionRuns.from_runtime))]
Tasks = Annotated[IngestionTasks, Depends(service(IngestionTasks.from_runtime))]


@router.post("/workspaces/{workspace:id}/ingestionRuns", name="CreateIngestionRun")
async def create_ingestion_run(
    workspace: str,
    body: IngestionRunMessage,
    ctx: Context,
    runs: Runs,
    request_id: Annotated[UUID | None, Query(alias="requestId")] = None,
    validate_only: Annotated[bool, Query(alias="validateOnly")] = False,
) -> IngestionRunMessage:
    workspace_id = parse_workspace_id(workspace)
    record = await runs.create(
        ctx,
        workspace_id,
        run_selector(body.selector, workspace_id=workspace_id),
        trigger=body.trigger or "MANUAL",
        request_id=request_id,
        validate_only=validate_only,
    )
    return ingestion_run_message(record)


@router.get("/workspaces/{workspace:id}/ingestionRuns", name="ListIngestionRuns")
async def list_ingestion_runs(
    workspace: str, params: Annotated[ListParams, Depends()], ctx: Context, runs: Runs
) -> ListIngestionRunsResponse:
    workspace_id = parse_workspace_scope(workspace)
    query, paging = list_query(
        params, parent=f"workspaces/{workspace}", filters=RUN_FILTERS, order=RUN_ORDER
    )
    page = paging.page(await runs.list(ctx, workspace_id, query))
    return ListIngestionRunsResponse(
        ingestion_runs=[ingestion_run_message(record) for record in page.items],
        next_page_token=page.next_page_token or None,
    )


@router.get("/workspaces/{workspace:id}/ingestionRuns:summarize", name="SummarizeIngestionRuns")
async def summarize_ingestion_runs(
    workspace: str,
    ctx: Context,
    runs: Runs,
    filter: Annotated[str | None, Query()] = None,
) -> SummarizeIngestionRunsResponse:
    where, since = summary_window(filter)
    summaries = await runs.summarize(
        ctx, parse_workspace_scope(workspace), where=where, since=since
    )
    return SummarizeIngestionRunsResponse(
        workspace_summaries=[workspace_summary_message(summary) for summary in summaries]
    )


@router.get(
    "/workspaces/{workspace:id}/ingestionRuns/{ingestionRun:id}", name="GetIngestionRun"
)
async def get_ingestion_run(
    workspace: str, ingestionRun: str, ctx: Context, runs: Runs
) -> IngestionRunMessage:
    record = await runs.get(
        ctx, parse_workspace_id(workspace), parse_uuid(ingestionRun, field="ingestionRun")
    )
    return ingestion_run_message(record)


@router.post(
    "/workspaces/{workspace:id}/ingestionRuns/{ingestionRun:id}:cancel",
    name="CancelIngestionRun",
)
async def cancel_ingestion_run(
    workspace: str,
    ingestionRun: str,
    body: CancelIngestionRunRequest,
    ctx: Context,
    runs: Runs,
) -> IngestionRunMessage:
    record = await runs.cancel(
        ctx, parse_workspace_id(workspace), parse_uuid(ingestionRun, field="ingestionRun")
    )
    return ingestion_run_message(record)


@router.post(
    "/workspaces/{workspace:id}/ingestionRuns/{ingestionRun:id}:retry",
    name="RetryIngestionRun",
)
async def retry_ingestion_run(
    workspace: str,
    ingestionRun: str,
    body: RetryIngestionRunRequest,
    ctx: Context,
    runs: Runs,
    request_id: Annotated[UUID | None, Query(alias="requestId")] = None,
) -> IngestionRunMessage:
    record = await runs.retry(
        ctx,
        parse_workspace_id(workspace),
        parse_uuid(ingestionRun, field="ingestionRun"),
        request_id=request_id,
    )
    return ingestion_run_message(record)


@router.get(
    "/workspaces/{workspace:id}/ingestionRuns/{ingestionRun:id}/tasks",
    name="ListIngestionTasks",
)
async def list_ingestion_tasks(
    workspace: str,
    ingestionRun: str,
    params: Annotated[ListParams, Depends()],
    ctx: Context,
    tasks: Tasks,
) -> ListIngestionTasksResponse:
    run_id = (
        None if ingestionRun == WILDCARD else parse_uuid(ingestionRun, field="ingestionRun")
    )
    query, paging = list_query(
        params,
        parent=f"workspaces/{workspace}/ingestionRuns/{ingestionRun}",
        filters=TASK_FILTERS,
        order=TASK_ORDER,
    )
    page = paging.page(await tasks.list(ctx, parse_workspace_scope(workspace), run_id, query))
    return ListIngestionTasksResponse(
        tasks=[ingestion_task_message(record) for record in page.items],
        next_page_token=page.next_page_token or None,
    )


@router.get(
    "/workspaces/{workspace:id}/ingestionRuns/{ingestionRun:id}/tasks/{task:id}",
    name="GetIngestionTask",
)
async def get_ingestion_task(
    workspace: str, ingestionRun: str, task: str, ctx: Context, tasks: Tasks
) -> IngestionTaskMessage:
    record = await tasks.get(
        ctx,
        parse_workspace_id(workspace),
        parse_uuid(ingestionRun, field="ingestionRun"),
        parse_uuid(task, field="task"),
    )
    return ingestion_task_message(record)
