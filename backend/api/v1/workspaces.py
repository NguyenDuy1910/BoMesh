"""Workspaces interface — Workspaces slice: Workspaces, settings, assistant settings, members, groups and memberships, custom and predefined roles, permissions, workspace IAM, audit events, knowledge gaps, overview and the platform workspace methods.

Routes are mounted under ``/api/v1``; ``name`` is the contract ``operationId``.
"""

from __future__ import annotations

from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends, Query

from api.aip import fieldmask
from api.dto.operations import OperationMessage, operation_message
from api.dto.workspaces.audit import (
    AUDIT_ORDER,
    WORKSPACE_AUDIT_FILTERS,
    AuditEventMessage,
    ExportAuditEventsRequest,
    ListAuditEventsResponse,
    SummarizeAuditEventsResponse,
    audit_bucket_message,
    audit_event_message,
)
from api.dto.workspaces.gaps import (
    KNOWLEDGE_GAP_FILTERS,
    KNOWLEDGE_GAP_ORDER,
    KnowledgeGapMessage,
    KnowledgeGapTransitionRequest,
    ListKnowledgeGapsResponse,
    knowledge_gap_message,
)
from api.dto.workspaces.iam import (
    AnalyzeWorkspaceIamPolicyResponse,
    GetIamPolicyRequest,
    PolicyMessage,
    SetIamPolicyRequest,
    TestIamPermissionsRequest,
    TestIamPermissionsResponse,
    analysis_message,
    bindings_of,
    policy_message,
)
from api.dto.workspaces.people import (
    GROUP_FIELDS,
    GROUP_FILTERS,
    GROUP_ORDER,
    MEMBER_FILTERS,
    MEMBER_ORDER,
    MEMBERSHIP_FILTERS,
    MEMBERSHIP_ORDER,
    PERMISSION_FILTERS,
    PERMISSION_ORDER,
    PREDEFINED_ROLE_FILTERS,
    PREDEFINED_ROLE_ORDER,
    ROLE_FIELDS,
    ROLE_FILTERS,
    ROLE_ORDER,
    GroupMessage,
    ListGroupsResponse,
    ListMembershipsResponse,
    ListMembersResponse,
    ListPermissionsResponse,
    ListRolesResponse,
    MemberMessage,
    MembershipMessage,
    MemberStateRequest,
    PermissionMessage,
    RoleMessage,
    UndeleteRoleRequest,
    group_message,
    member_message,
    membership_message,
    permission_message,
    predefined_role_message,
    role_message,
)
from api.dto.workspaces.workspace import (
    ASSISTANT_FIELDS,
    SETTINGS_FIELDS,
    WORKSPACE_FIELDS,
    WORKSPACE_FILTERS,
    WORKSPACE_ORDER,
    ArchiveWorkspaceRequest,
    ExportWorkspaceUsageRequest,
    ListWorkspacesResponse,
    SummarizeWorkspaceUsageResponse,
    UsageWindow,
    WorkspaceAssistantMessage,
    WorkspaceMessage,
    WorkspaceOverviewMessage,
    WorkspaceSettingsMessage,
    WorkspaceStateRequest,
    assistant_changes,
    assistant_message,
    overview_message,
    settings_changes,
    settings_message,
    usage_message,
    workspace_message,
)
from api.v1.deps import Context, CurrentPrincipal, service
from api.v1.listing import ListParams, list_query
from bomesh.errors import InvalidArgument
from bomesh.services.kernel.workspaces import parse_workspace_name
from bomesh.services.operations.operations import OperationService
from bomesh.services.workspaces.audit import WILDCARD, AuditEventService
from bomesh.services.workspaces.groups import GroupService
from bomesh.services.workspaces.iam import WorkspaceIamService
from bomesh.services.workspaces.insights import InsightService
from bomesh.services.workspaces.knowledge_gaps import KnowledgeGapService
from bomesh.services.workspaces.members import MemberService
from bomesh.services.workspaces.roles import CatalogService, RoleService
from bomesh.services.workspaces.settings import SettingsService
from bomesh.services.workspaces.workspaces import NewWorkspace, WorkspaceService

router = APIRouter(tags=["Workspaces"])

Workspaces = Annotated[WorkspaceService, Depends(service(WorkspaceService.from_runtime))]
Settings = Annotated[SettingsService, Depends(service(SettingsService.from_runtime))]
Members = Annotated[MemberService, Depends(service(MemberService.from_runtime))]
Groups = Annotated[GroupService, Depends(service(GroupService.from_runtime))]
Roles = Annotated[RoleService, Depends(service(RoleService.from_runtime))]
Catalog = Annotated[CatalogService, Depends(service(CatalogService.from_runtime))]
Iam = Annotated[WorkspaceIamService, Depends(service(WorkspaceIamService.from_runtime))]
AuditEvents = Annotated[AuditEventService, Depends(service(AuditEventService.from_runtime))]
Gaps = Annotated[KnowledgeGapService, Depends(service(KnowledgeGapService.from_runtime))]
Insights = Annotated[InsightService, Depends(service(InsightService.from_runtime))]
Operations = Annotated[OperationService, Depends(service(OperationService.from_runtime))]
Listing = Annotated[ListParams, Depends()]

RequestId = Annotated[UUID | None, Query(alias="requestId")]
ValidateOnly = Annotated[bool, Query(alias="validateOnly")]
UpdateMask = Annotated[str | None, Query(alias="updateMask")]
Etag = Annotated[str | None, Query()]
Window = Annotated[UsageWindow | None, Query()]
TimeZone = Annotated[str | None, Query(alias="timeZone")]


def _workspace_or_wildcard(workspace: str) -> UUID | str:
    if workspace == WILDCARD:
        return WILDCARD
    return parse_workspace_name(f"workspaces/{workspace}")


def _changes(
    fields: fieldmask.MutableFields, update_mask: str | None, body: Any
) -> dict[str, Any]:
    return fieldmask.apply(fields.parse(update_mask, body), body)


# -- Permissions and predefined roles -------------------------------------------


@router.get("/permissions", name="ListPermissions")
async def list_permissions(
    params: Listing, _: CurrentPrincipal, catalog: Catalog
) -> ListPermissionsResponse:
    query, paging = list_query(
        params, parent="", filters=PERMISSION_FILTERS, order=PERMISSION_ORDER
    )
    page = paging.page(await catalog.list_permissions(query))
    return ListPermissionsResponse(
        permissions=[permission_message(p) for p in page.items],
        next_page_token=page.next_page_token or None,
    )


@router.get("/permissions/{permission:id}", name="GetPermission")
async def get_permission(
    permission: str, _: CurrentPrincipal, catalog: Catalog
) -> PermissionMessage:
    return permission_message(catalog.get_permission(permission))


@router.get("/roles", name="ListPredefinedRoles")
async def list_predefined_roles(
    params: Listing, _: CurrentPrincipal, catalog: Catalog
) -> ListRolesResponse:
    query, paging = list_query(
        params, parent="", filters=PREDEFINED_ROLE_FILTERS, order=PREDEFINED_ROLE_ORDER
    )
    page = paging.page(await catalog.list_predefined_roles(query))
    return ListRolesResponse(
        roles=[predefined_role_message(role) for role in page.items],
        next_page_token=page.next_page_token or None,
    )


@router.get("/roles/{role:id}", name="GetPredefinedRole")
async def get_predefined_role(role: str, _: CurrentPrincipal, catalog: Catalog) -> RoleMessage:
    return predefined_role_message(catalog.get_predefined_role(role))


# -- Workspaces -----------------------------------------------------------------


@router.post("/workspaces", name="CreateWorkspace")
async def create_workspace(
    body: WorkspaceMessage,
    ctx: Context,
    workspaces: Workspaces,
    operations: Operations,
    request_id: RequestId = None,
) -> OperationMessage:
    spec = NewWorkspace(
        display_name=body.display_name or "",
        code=body.code or "",
        initial_admin_email=body.initial_admin_email or "",
        template=(body.template or "ENTERPRISE").lower(),
        demo=bool(body.demo),
    )
    operation = await workspaces.create(ctx, spec, request_id=request_id)
    return operation_message(await operations.describe(operation))


@router.get("/workspaces", name="ListWorkspaces")
async def list_workspaces(
    params: Listing, ctx: Context, workspaces: Workspaces
) -> ListWorkspacesResponse:
    query, paging = list_query(
        params, parent="", filters=WORKSPACE_FILTERS, order=WORKSPACE_ORDER
    )
    page = paging.page(await workspaces.list(ctx, query))
    return ListWorkspacesResponse(
        workspaces=[workspace_message(record) for record in page.items],
        next_page_token=page.next_page_token or None,
    )


@router.get("/workspaces/{workspace:id}", name="GetWorkspace")
async def get_workspace(workspace: UUID, ctx: Context, workspaces: Workspaces) -> WorkspaceMessage:
    return workspace_message(await workspaces.get(ctx, workspace))


@router.patch("/workspaces/{workspace:id}", name="UpdateWorkspace")
async def update_workspace(
    workspace: UUID,
    body: WorkspaceMessage,
    ctx: Context,
    workspaces: Workspaces,
    update_mask: UpdateMask = None,
) -> WorkspaceMessage:
    changes = _changes(WORKSPACE_FIELDS, update_mask, body)
    record = await workspaces.update(ctx, workspace, changes, expected_etag=body.etag)
    return workspace_message(record)


@router.post("/workspaces/{workspace:id}:archive", name="ArchiveWorkspace")
async def archive_workspace(
    workspace: UUID, body: ArchiveWorkspaceRequest, ctx: Context, workspaces: Workspaces
) -> WorkspaceMessage:
    record = await workspaces.archive(
        ctx, workspace, confirmation_code=body.confirmation_code, expected_etag=body.etag
    )
    return workspace_message(record)


@router.post("/workspaces/{workspace:id}:suspend", name="SuspendWorkspace")
async def suspend_workspace(
    workspace: UUID, body: WorkspaceStateRequest, ctx: Context, workspaces: Workspaces
) -> WorkspaceMessage:
    return workspace_message(await workspaces.suspend(ctx, workspace, expected_etag=body.etag))


@router.post("/workspaces/{workspace:id}:activate", name="ActivateWorkspace")
async def activate_workspace(
    workspace: UUID, body: WorkspaceStateRequest, ctx: Context, workspaces: Workspaces
) -> WorkspaceMessage:
    return workspace_message(await workspaces.activate(ctx, workspace, expected_etag=body.etag))


@router.post("/workspaces/{workspace:id}:pauseIngestion", name="PauseWorkspaceIngestion")
async def pause_workspace_ingestion(
    workspace: UUID, body: WorkspaceStateRequest, ctx: Context, workspaces: Workspaces
) -> WorkspaceMessage:
    record = await workspaces.pause_ingestion(ctx, workspace, expected_etag=body.etag)
    return workspace_message(record)


@router.post("/workspaces/{workspace:id}:resumeIngestion", name="ResumeWorkspaceIngestion")
async def resume_workspace_ingestion(
    workspace: UUID, body: WorkspaceStateRequest, ctx: Context, workspaces: Workspaces
) -> WorkspaceMessage:
    record = await workspaces.resume_ingestion(ctx, workspace, expected_etag=body.etag)
    return workspace_message(record)


@router.get("/workspaces:summarizeUsage", name="SummarizeWorkspaceUsage")
async def summarize_workspace_usage(
    ctx: Context, insights: Insights, window: Window = None
) -> SummarizeWorkspaceUsageResponse:
    usage = await insights.summarize_usage(ctx, window=window)
    return SummarizeWorkspaceUsageResponse(
        window=window or "P7D", workspace_usages=[usage_message(entry) for entry in usage]
    )


@router.post("/workspaces:exportUsage", name="ExportWorkspaceUsage")
async def export_workspace_usage(
    body: ExportWorkspaceUsageRequest,
    ctx: Context,
    insights: Insights,
    operations: Operations,
    request_id: RequestId = None,
) -> OperationMessage:
    operation = await insights.export_usage(ctx, window=body.window, request_id=request_id)
    return operation_message(await operations.describe(operation))


# -- Settings and assistant -----------------------------------------------------


@router.get("/workspaces/{workspace:id}/settings", name="GetWorkspaceSettings")
async def get_workspace_settings(
    workspace: UUID, ctx: Context, settings: Settings
) -> WorkspaceSettingsMessage:
    return settings_message(await settings.get_settings(ctx, workspace))


@router.patch("/workspaces/{workspace:id}/settings", name="UpdateWorkspaceSettings")
async def update_workspace_settings(
    workspace: UUID,
    body: WorkspaceSettingsMessage,
    ctx: Context,
    settings: Settings,
    update_mask: UpdateMask = None,
) -> WorkspaceSettingsMessage:
    changes = settings_changes(_changes(SETTINGS_FIELDS, update_mask, body))
    record = await settings.update_settings(ctx, workspace, changes, expected_etag=body.etag)
    return settings_message(record)


@router.get("/workspaces/{workspace:id}/assistant", name="GetWorkspaceAssistant")
async def get_workspace_assistant(
    workspace: UUID, ctx: Context, settings: Settings
) -> WorkspaceAssistantMessage:
    return assistant_message(await settings.get_assistant(ctx, workspace))


@router.patch("/workspaces/{workspace:id}/assistant", name="UpdateWorkspaceAssistant")
async def update_workspace_assistant(
    workspace: UUID,
    body: WorkspaceAssistantMessage,
    ctx: Context,
    settings: Settings,
    update_mask: UpdateMask = None,
) -> WorkspaceAssistantMessage:
    changes = assistant_changes(_changes(ASSISTANT_FIELDS, update_mask, body))
    record = await settings.update_assistant(ctx, workspace, changes, expected_etag=body.etag)
    return assistant_message(record)


@router.get("/workspaces/{workspace:id}/overview", name="GetWorkspaceOverview")
async def get_workspace_overview(
    workspace: UUID,
    ctx: Context,
    insights: Insights,
    window: Window = None,
    time_zone: TimeZone = None,
) -> WorkspaceOverviewMessage:
    overview = await insights.overview(ctx, workspace, window=window, zone=time_zone)
    return overview_message(overview)


# -- IAM ------------------------------------------------------------------------


@router.post("/workspaces/{workspace:id}:getIamPolicy", name="GetWorkspaceIamPolicy")
async def get_workspace_iam_policy(
    workspace: UUID, body: GetIamPolicyRequest, ctx: Context, iam: Iam
) -> PolicyMessage:
    return policy_message(await iam.get_policy(ctx, workspace))


@router.post("/workspaces/{workspace:id}:setIamPolicy", name="SetWorkspaceIamPolicy")
async def set_workspace_iam_policy(
    workspace: UUID, body: SetIamPolicyRequest, ctx: Context, iam: Iam
) -> PolicyMessage:
    policy = await iam.set_policy(
        ctx, workspace, bindings_of(body.policy), expected_etag=body.policy.etag
    )
    return policy_message(policy)


@router.post("/workspaces/{workspace:id}:testIamPermissions", name="TestWorkspaceIamPermissions")
async def test_workspace_iam_permissions(
    workspace: UUID, body: TestIamPermissionsRequest, ctx: Context, iam: Iam
) -> TestIamPermissionsResponse:
    held = await iam.test_permissions(ctx, workspace, body.permissions)
    return TestIamPermissionsResponse(permissions=held)


@router.get("/workspaces/{workspace:id}:analyzeIamPolicy", name="AnalyzeWorkspaceIamPolicy")
async def analyze_workspace_iam_policy(
    workspace: UUID,
    principal: Annotated[str, Query()],
    ctx: Context,
    iam: Iam,
) -> AnalyzeWorkspaceIamPolicyResponse:
    return analysis_message(principal, await iam.analyze(ctx, workspace, principal))


# -- Members --------------------------------------------------------------------


@router.post("/workspaces/{workspace:id}/members", name="CreateMember")
async def create_member(
    workspace: UUID,
    body: MemberMessage,
    ctx: Context,
    members: Members,
    request_id: RequestId = None,
    validate_only: ValidateOnly = False,
) -> MemberMessage:
    if not body.user:
        raise InvalidArgument.for_field("user", "user is required.")
    record = await members.create(
        ctx,
        workspace,
        body.user,
        body.roles or (),
        validate_only=validate_only,
        request_id=request_id,
    )
    return member_message(record)


@router.get("/workspaces/{workspace:id}/members", name="ListMembers")
async def list_members(
    workspace: UUID, params: Listing, ctx: Context, members: Members
) -> ListMembersResponse:
    query, paging = list_query(
        params, parent=f"workspaces/{workspace}", filters=MEMBER_FILTERS, order=MEMBER_ORDER
    )
    page = paging.page(await members.list(ctx, workspace, query))
    return ListMembersResponse(
        members=[member_message(record) for record in page.items],
        next_page_token=page.next_page_token or None,
    )


@router.get("/workspaces/{workspace:id}/members/{member:id}", name="GetMember")
async def get_member(
    workspace: UUID, member: str, ctx: Context, members: Members
) -> MemberMessage:
    return member_message(await members.get(ctx, workspace, member))


@router.delete("/workspaces/{workspace:id}/members/{member:id}", name="DeleteMember")
async def delete_member(
    workspace: UUID, member: str, ctx: Context, members: Members
) -> dict[str, object]:
    await members.delete(ctx, workspace, member)
    return {}


@router.post("/workspaces/{workspace:id}/members/{member:id}:suspend", name="SuspendMember")
async def suspend_member(
    workspace: UUID, member: str, body: MemberStateRequest, ctx: Context, members: Members
) -> MemberMessage:
    return member_message(await members.suspend(ctx, workspace, member))


@router.post("/workspaces/{workspace:id}/members/{member:id}:activate", name="ActivateMember")
async def activate_member(
    workspace: UUID, member: str, body: MemberStateRequest, ctx: Context, members: Members
) -> MemberMessage:
    return member_message(await members.activate(ctx, workspace, member))


# -- Groups and memberships -----------------------------------------------------


@router.post("/workspaces/{workspace:id}/groups", name="CreateGroup")
async def create_group(
    workspace: UUID,
    body: GroupMessage,
    ctx: Context,
    groups: Groups,
    group_id: Annotated[str | None, Query(alias="groupId")] = None,
    request_id: RequestId = None,
) -> GroupMessage:
    record = await groups.create(
        ctx,
        workspace,
        group_id=group_id,
        display_name=body.display_name or "",
        description=body.description,
        request_id=request_id,
    )
    return group_message(record)


@router.get("/workspaces/{workspace:id}/groups", name="ListGroups")
async def list_groups(
    workspace: UUID, params: Listing, ctx: Context, groups: Groups
) -> ListGroupsResponse:
    query, paging = list_query(
        params, parent=f"workspaces/{workspace}", filters=GROUP_FILTERS, order=GROUP_ORDER
    )
    page = paging.page(await groups.list(ctx, workspace, query))
    return ListGroupsResponse(
        groups=[group_message(record) for record in page.items],
        next_page_token=page.next_page_token or None,
    )


@router.get("/workspaces/{workspace:id}/groups/{group:id}", name="GetGroup")
async def get_group(workspace: UUID, group: str, ctx: Context, groups: Groups) -> GroupMessage:
    return group_message(await groups.get(ctx, workspace, group))


@router.patch("/workspaces/{workspace:id}/groups/{group:id}", name="UpdateGroup")
async def update_group(
    workspace: UUID,
    group: str,
    body: GroupMessage,
    ctx: Context,
    groups: Groups,
    update_mask: UpdateMask = None,
) -> GroupMessage:
    changes = _changes(GROUP_FIELDS, update_mask, body)
    record = await groups.update(ctx, workspace, group, changes, expected_etag=body.etag)
    return group_message(record)


@router.delete("/workspaces/{workspace:id}/groups/{group:id}", name="DeleteGroup")
async def delete_group(
    workspace: UUID, group: str, ctx: Context, groups: Groups, etag: Etag = None
) -> dict[str, object]:
    await groups.delete(ctx, workspace, group, expected_etag=etag)
    return {}


@router.post("/workspaces/{workspace:id}/groups/{group:id}/memberships", name="CreateMembership")
async def create_membership(
    workspace: UUID,
    group: str,
    body: MembershipMessage,
    ctx: Context,
    groups: Groups,
    request_id: RequestId = None,
) -> MembershipMessage:
    record = await groups.add_member(ctx, workspace, group, body.member, request_id=request_id)
    return membership_message(record)


@router.get("/workspaces/{workspace:id}/groups/{group:id}/memberships", name="ListMemberships")
async def list_memberships(
    workspace: UUID, group: str, params: Listing, ctx: Context, groups: Groups
) -> ListMembershipsResponse:
    query, paging = list_query(
        params,
        parent=f"workspaces/{workspace}/groups/{group}",
        filters=MEMBERSHIP_FILTERS,
        order=MEMBERSHIP_ORDER,
    )
    page = paging.page(await groups.list_memberships(ctx, workspace, group, query))
    return ListMembershipsResponse(
        memberships=[membership_message(record) for record in page.items],
        next_page_token=page.next_page_token or None,
    )


@router.get(
    "/workspaces/{workspace:id}/groups/{group:id}/memberships/{membership:id}",
    name="GetMembership",
)
async def get_membership(
    workspace: UUID, group: str, membership: UUID, ctx: Context, groups: Groups
) -> MembershipMessage:
    return membership_message(await groups.get_membership(ctx, workspace, group, membership))


@router.delete(
    "/workspaces/{workspace:id}/groups/{group:id}/memberships/{membership:id}",
    name="DeleteMembership",
)
async def delete_membership(
    workspace: UUID, group: str, membership: UUID, ctx: Context, groups: Groups
) -> dict[str, object]:
    await groups.remove_member(ctx, workspace, group, membership)
    return {}


# -- Custom roles ---------------------------------------------------------------


@router.post("/workspaces/{workspace:id}/roles", name="CreateRole")
async def create_role(
    workspace: UUID,
    body: RoleMessage,
    ctx: Context,
    roles: Roles,
    role_id: Annotated[str | None, Query(alias="roleId")] = None,
    request_id: RequestId = None,
    validate_only: ValidateOnly = False,
) -> RoleMessage:
    record = await roles.create(
        ctx,
        workspace,
        role_id=role_id,
        display_name=body.display_name or "",
        description=body.description,
        permissions=body.included_permissions or (),
        validate_only=validate_only,
        request_id=request_id,
    )
    return role_message(record)


@router.get("/workspaces/{workspace:id}/roles", name="ListRoles")
async def list_roles(
    workspace: UUID, params: Listing, ctx: Context, roles: Roles
) -> ListRolesResponse:
    query, paging = list_query(
        params, parent=f"workspaces/{workspace}", filters=ROLE_FILTERS, order=ROLE_ORDER
    )
    page = paging.page(await roles.list(ctx, workspace, query))
    return ListRolesResponse(
        roles=[role_message(record) for record in page.items],
        next_page_token=page.next_page_token or None,
    )


@router.get("/workspaces/{workspace:id}/roles/{role:id}", name="GetRole")
async def get_role(workspace: UUID, role: str, ctx: Context, roles: Roles) -> RoleMessage:
    return role_message(await roles.get(ctx, workspace, role))


@router.patch("/workspaces/{workspace:id}/roles/{role:id}", name="UpdateRole")
async def update_role(
    workspace: UUID,
    role: str,
    body: RoleMessage,
    ctx: Context,
    roles: Roles,
    update_mask: UpdateMask = None,
) -> RoleMessage:
    changes = _changes(ROLE_FIELDS, update_mask, body)
    record = await roles.update(ctx, workspace, role, changes, expected_etag=body.etag)
    return role_message(record)


@router.delete("/workspaces/{workspace:id}/roles/{role:id}", name="DeleteRole")
async def delete_role(
    workspace: UUID, role: str, ctx: Context, roles: Roles, etag: Etag = None
) -> RoleMessage:
    return role_message(await roles.delete(ctx, workspace, role, expected_etag=etag))


@router.post("/workspaces/{workspace:id}/roles/{role:id}:undelete", name="UndeleteRole")
async def undelete_role(
    workspace: UUID, role: str, body: UndeleteRoleRequest, ctx: Context, roles: Roles
) -> RoleMessage:
    return role_message(await roles.undelete(ctx, workspace, role, expected_etag=body.etag))


# -- Audit events ---------------------------------------------------------------


@router.get("/workspaces/{workspace:id}/auditEvents", name="ListAuditEvents")
async def list_audit_events(
    workspace: str, params: Listing, ctx: Context, audit: AuditEvents
) -> ListAuditEventsResponse:
    scope = _workspace_or_wildcard(workspace)
    query, paging = list_query(
        params,
        parent=f"workspaces/{workspace}",
        filters=WORKSPACE_AUDIT_FILTERS,
        order=AUDIT_ORDER,
    )
    result = await audit.list(ctx, scope, query)
    page = paging.page(result.events)
    return ListAuditEventsResponse(
        audit_events=[
            audit_event_message(
                event,
                name=f"workspaces/{event.tenant_id}/auditEvents/{event.id}",
                metadata_only=result.metadata_only,
            )
            for event in page.items
        ],
        next_page_token=page.next_page_token or None,
    )


@router.get("/workspaces/{workspace:id}/auditEvents/{auditEvent:id}", name="GetAuditEvent")
async def get_audit_event(
    workspace: UUID,
    auditEvent: UUID,  # noqa: N803 - path name
    ctx: Context,
    audit: AuditEvents,
) -> AuditEventMessage:
    result = await audit.get(ctx, workspace, auditEvent)
    event = result.events[0]
    return audit_event_message(
        event,
        name=f"workspaces/{workspace}/auditEvents/{event.id}",
        metadata_only=result.metadata_only,
    )


@router.post("/workspaces/{workspace:id}/auditEvents:export", name="ExportAuditEvents")
async def export_audit_events(
    workspace: str,
    body: ExportAuditEventsRequest,
    ctx: Context,
    audit: AuditEvents,
    operations: Operations,
    request_id: RequestId = None,
) -> OperationMessage:
    scope = _workspace_or_wildcard(workspace)
    where = WORKSPACE_AUDIT_FILTERS.compile(body.filter)
    operation = await audit.export(
        ctx, scope, where=where, filter_text=body.filter or "", request_id=request_id
    )
    return operation_message(await operations.describe(operation))


@router.get("/workspaces/{workspace:id}/auditEvents:summarize", name="SummarizeAuditEvents")
async def summarize_audit_events(
    workspace: str,
    ctx: Context,
    audit: AuditEvents,
    window: Window = None,
    time_zone: TimeZone = None,
    filter: Annotated[str | None, Query()] = None,
) -> SummarizeAuditEventsResponse:
    scope = _workspace_or_wildcard(workspace)
    buckets = await audit.summarize(
        ctx,
        scope,
        where=WORKSPACE_AUDIT_FILTERS.compile(filter),
        window=window,
        zone=time_zone,
    )
    return SummarizeAuditEventsResponse(buckets=[audit_bucket_message(b) for b in buckets])


# -- Knowledge gaps -------------------------------------------------------------


@router.get("/workspaces/{workspace:id}/knowledgeGaps", name="ListKnowledgeGaps")
async def list_knowledge_gaps(
    workspace: UUID, params: Listing, ctx: Context, gaps: Gaps
) -> ListKnowledgeGapsResponse:
    query, paging = list_query(
        params,
        parent=f"workspaces/{workspace}",
        filters=KNOWLEDGE_GAP_FILTERS,
        order=KNOWLEDGE_GAP_ORDER,
    )
    page = paging.page(await gaps.list(ctx, workspace, query))
    return ListKnowledgeGapsResponse(
        knowledge_gaps=[knowledge_gap_message(record) for record in page.items],
        next_page_token=page.next_page_token or None,
    )


@router.get("/workspaces/{workspace:id}/knowledgeGaps/{knowledgeGap:id}", name="GetKnowledgeGap")
async def get_knowledge_gap(
    workspace: UUID, knowledgeGap: str, ctx: Context, gaps: Gaps  # noqa: N803 - path name
) -> KnowledgeGapMessage:
    return knowledge_gap_message(await gaps.get(ctx, workspace, knowledgeGap))


@router.post(
    "/workspaces/{workspace:id}/knowledgeGaps/{knowledgeGap:id}:dismiss",
    name="DismissKnowledgeGap",
)
async def dismiss_knowledge_gap(
    workspace: UUID,
    knowledgeGap: str,  # noqa: N803 - path name
    body: KnowledgeGapTransitionRequest,
    ctx: Context,
    gaps: Gaps,
) -> KnowledgeGapMessage:
    return knowledge_gap_message(await gaps.dismiss(ctx, workspace, knowledgeGap))


@router.post(
    "/workspaces/{workspace:id}/knowledgeGaps/{knowledgeGap:id}:reopen",
    name="ReopenKnowledgeGap",
)
async def reopen_knowledge_gap(
    workspace: UUID,
    knowledgeGap: str,  # noqa: N803 - path name
    body: KnowledgeGapTransitionRequest,
    ctx: Context,
    gaps: Gaps,
) -> KnowledgeGapMessage:
    return knowledge_gap_message(await gaps.reopen(ctx, workspace, knowledgeGap))
