"""Collaboration interface — Collaboration slice: Spaces with members, materials, announcements, events and request types; requests and their messages. Gated by workspace modules.

Routes are mounted under ``/api/v1``; ``name`` is the contract ``operationId``.
"""

from __future__ import annotations

from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends, Path, Query

from api.aip import fieldmask, filtering
from api.dto.collaboration.requests import (
    REQUEST_FIELDS,
    REQUEST_MESSAGE_ORDER,
    REQUEST_ORDER,
    AnswerRequestRequest,
    ApproveRequestRequest,
    CloseRequestRequest,
    DenyRequestRequest,
    ListRequestMessagesResponse,
    ListRequestsResponse,
    RequestMessageMessage,
    RequestResource,
    SendBackRequestRequest,
    WithdrawRequestRequest,
    new_request,
    request_filters,
    request_message,
    request_message_filters,
    request_message_message,
)
from api.dto.collaboration.spaces import (
    ANNOUNCEMENT_FIELDS,
    ANNOUNCEMENT_FILTERS,
    ANNOUNCEMENT_ORDER,
    EVENT_FIELDS,
    EVENT_FILTERS,
    EVENT_ORDER,
    MATERIAL_FILTERS,
    MATERIAL_ORDER,
    REQUEST_TYPE_FIELDS,
    REQUEST_TYPE_FILTERS,
    REQUEST_TYPE_ORDER,
    SPACE_FIELDS,
    SPACE_MEMBER_FILTERS,
    SPACE_MEMBER_ORDER,
    SPACE_ORDER,
    AnnouncementMessage,
    JoinSpaceRequest,
    LeaveSpaceRequest,
    ListAnnouncementsResponse,
    ListMaterialsResponse,
    ListRequestTypesResponse,
    ListSpaceEventsResponse,
    ListSpaceMembersResponse,
    ListSpacesResponse,
    MaterialMessage,
    RequestTypeMessage,
    SpaceEventMessage,
    SpaceMemberMessage,
    SpaceMessage,
    UndeleteRequestTypeRequest,
    UndeleteSpaceRequest,
    announcement_message,
    field_specs,
    material_message,
    request_type_message,
    rule_specs,
    space_event_message,
    space_filters,
    space_member_message,
    space_message,
)
from api.dto.workspaces.iam import (
    GetIamPolicyRequest,
    PolicyMessage,
    SetIamPolicyRequest,
    TestIamPermissionsRequest,
    TestIamPermissionsResponse,
    bindings_of,
    policy_message,
)
from api.v1.deps import Context, service
from api.v1.listing import ListParams, list_query
from bomesh.services.collaboration.members import SpaceMemberService
from bomesh.services.collaboration.request_messages import RequestMessageService
from bomesh.services.collaboration.request_types import RequestTypeService
from bomesh.services.collaboration.requests import RequestService
from bomesh.services.collaboration.space_content import (
    AnnouncementService,
    MaterialService,
    SpaceEventService,
)
from bomesh.services.collaboration.spaces import SpaceService
from bomesh.services.collaboration.support import parse_space_name

router = APIRouter(tags=["Collaboration"])

Spaces = Annotated[SpaceService, Depends(service(SpaceService.from_runtime))]
Members = Annotated[
    SpaceMemberService, Depends(service(SpaceMemberService.from_runtime))
]
Materials = Annotated[MaterialService, Depends(service(MaterialService.from_runtime))]
Announcements = Annotated[
    AnnouncementService, Depends(service(AnnouncementService.from_runtime))
]
Events = Annotated[SpaceEventService, Depends(service(SpaceEventService.from_runtime))]
RequestTypes = Annotated[
    RequestTypeService, Depends(service(RequestTypeService.from_runtime))
]
Requests = Annotated[RequestService, Depends(service(RequestService.from_runtime))]
Messages = Annotated[
    RequestMessageService, Depends(service(RequestMessageService.from_runtime))
]
Listing = Annotated[ListParams, Depends()]

RequestId = Annotated[UUID | None, Query(alias="requestId")]
ValidateOnly = Annotated[bool, Query(alias="validateOnly")]
UpdateMask = Annotated[str | None, Query(alias="updateMask")]
Etag = Annotated[str | None, Query()]
RequestTypeCode = Annotated[str, Path(alias="requestType")]
RequestPath = Annotated[UUID, Path(alias="request")]

SPACE = "/workspaces/{workspace:id}/spaces/{space:id}"
REQUEST = "/workspaces/{workspace:id}/requests/{request:id}"


def _changes(
    fields: fieldmask.MutableFields, update_mask: str | None, body: Any
) -> dict[str, Any]:
    return fieldmask.apply(fields.parse(update_mask, body), body)


def _space_parent(workspace: UUID, space: str) -> str:
    return f"workspaces/{workspace}/spaces/{space}"


# -- Spaces ---------------------------------------------------------------------


@router.post("/workspaces/{workspace:id}/spaces", name="CreateSpace")
async def create_space(
    workspace: UUID,
    body: SpaceMessage,
    ctx: Context,
    spaces: Spaces,
    space_id: Annotated[str | None, Query(alias="spaceId")] = None,
    validate_only: ValidateOnly = False,
    request_id: RequestId = None,
) -> SpaceMessage:
    record = await spaces.create(
        ctx,
        workspace,
        space_id=space_id,
        display_name=body.display_name or "",
        space_type=body.space_type,
        description=body.description,
        join_policy=body.join_policy,
        validate_only=validate_only,
        request_id=request_id,
    )
    return space_message(record)


@router.get("/workspaces/{workspace:id}/spaces", name="ListSpaces")
async def list_spaces(
    workspace: UUID, params: Listing, ctx: Context, spaces: Spaces
) -> ListSpacesResponse:
    query, paging = list_query(
        params,
        parent=f"workspaces/{workspace}",
        filters=space_filters(ctx.user_id),
        order=SPACE_ORDER,
    )
    page = paging.page(await spaces.list(ctx, workspace, query))
    return ListSpacesResponse(
        spaces=[space_message(record) for record in page.items],
        next_page_token=page.next_page_token or None,
    )


@router.get(SPACE, name="GetSpace")
async def get_space(
    workspace: UUID, space: str, ctx: Context, spaces: Spaces
) -> SpaceMessage:
    return space_message(await spaces.get(ctx, workspace, space))


@router.patch(SPACE, name="UpdateSpace")
async def update_space(
    workspace: UUID,
    space: str,
    body: SpaceMessage,
    ctx: Context,
    spaces: Spaces,
    update_mask: UpdateMask = None,
) -> SpaceMessage:
    changes = _changes(SPACE_FIELDS, update_mask, body)
    return space_message(
        await spaces.update(ctx, workspace, space, changes, expected_etag=body.etag)
    )


@router.delete(SPACE, name="DeleteSpace")
async def delete_space(
    workspace: UUID, space: str, ctx: Context, spaces: Spaces, etag: Etag = None
) -> SpaceMessage:
    return space_message(await spaces.delete(ctx, workspace, space, expected_etag=etag))


@router.post(SPACE + ":undelete", name="UndeleteSpace")
async def undelete_space(
    workspace: UUID,
    space: str,
    body: UndeleteSpaceRequest,
    ctx: Context,
    spaces: Spaces,
) -> SpaceMessage:
    return space_message(
        await spaces.undelete(ctx, workspace, space, expected_etag=body.etag)
    )


@router.post(SPACE + ":join", name="JoinSpace")
async def join_space(
    workspace: UUID,
    space: str,
    body: JoinSpaceRequest,
    ctx: Context,
    spaces: Spaces,
) -> SpaceMemberMessage:
    return space_member_message(await spaces.join(ctx, workspace, space))


@router.post(SPACE + ":leave", name="LeaveSpace")
async def leave_space(
    workspace: UUID, space: str, body: LeaveSpaceRequest, ctx: Context, spaces: Spaces
) -> dict[str, object]:
    await spaces.leave(ctx, workspace, space)
    return {}


@router.post(SPACE + ":getIamPolicy", name="GetSpaceIamPolicy")
async def get_space_iam_policy(
    workspace: UUID, space: str, body: GetIamPolicyRequest, ctx: Context, spaces: Spaces
) -> PolicyMessage:
    return policy_message(await spaces.get_policy(ctx, workspace, space))


@router.post(SPACE + ":setIamPolicy", name="SetSpaceIamPolicy")
async def set_space_iam_policy(
    workspace: UUID, space: str, body: SetIamPolicyRequest, ctx: Context, spaces: Spaces
) -> PolicyMessage:
    policy = await spaces.set_policy(
        ctx, workspace, space, bindings_of(body.policy), expected_etag=body.policy.etag
    )
    return policy_message(policy)


@router.post(SPACE + ":testIamPermissions", name="TestSpaceIamPermissions")
async def test_space_iam_permissions(
    workspace: UUID,
    space: str,
    body: TestIamPermissionsRequest,
    ctx: Context,
    spaces: Spaces,
) -> TestIamPermissionsResponse:
    held = await spaces.test_permissions(ctx, workspace, space, body.permissions)
    return TestIamPermissionsResponse(permissions=held)


# -- Space members --------------------------------------------------------------


@router.post(SPACE + "/members", name="CreateSpaceMember")
async def create_space_member(
    workspace: UUID,
    space: str,
    body: SpaceMemberMessage,
    ctx: Context,
    members: Members,
    request_id: RequestId = None,
) -> SpaceMemberMessage:
    record = await members.create(
        ctx, workspace, space, body.member or "", request_id=request_id
    )
    return space_member_message(record)


@router.get(SPACE + "/members", name="ListSpaceMembers")
async def list_space_members(
    workspace: UUID, space: str, params: Listing, ctx: Context, members: Members
) -> ListSpaceMembersResponse:
    query, paging = list_query(
        params,
        parent=_space_parent(workspace, space),
        filters=SPACE_MEMBER_FILTERS,
        order=SPACE_MEMBER_ORDER,
    )
    page = paging.page(await members.list(ctx, workspace, space, query))
    return ListSpaceMembersResponse(
        members=[space_member_message(record) for record in page.items],
        next_page_token=page.next_page_token or None,
    )


@router.get(SPACE + "/members/{member:id}", name="GetSpaceMember")
async def get_space_member(
    workspace: UUID, space: str, member: UUID, ctx: Context, members: Members
) -> SpaceMemberMessage:
    return space_member_message(await members.get(ctx, workspace, space, member))


@router.delete(SPACE + "/members/{member:id}", name="DeleteSpaceMember")
async def delete_space_member(
    workspace: UUID, space: str, member: UUID, ctx: Context, members: Members
) -> dict[str, object]:
    await members.delete(ctx, workspace, space, member)
    return {}


# -- Materials ------------------------------------------------------------------


@router.post(SPACE + "/materials", name="CreateMaterial")
async def create_material(
    workspace: UUID,
    space: str,
    body: MaterialMessage,
    ctx: Context,
    materials: Materials,
    request_id: RequestId = None,
) -> MaterialMessage:
    record = await materials.create(
        ctx,
        workspace,
        space,
        item=body.item or "",
        note=body.note,
        request_id=request_id,
    )
    return material_message(record)


@router.get(SPACE + "/materials", name="ListMaterials")
async def list_materials(
    workspace: UUID, space: str, params: Listing, ctx: Context, materials: Materials
) -> ListMaterialsResponse:
    query, paging = list_query(
        params,
        parent=_space_parent(workspace, space),
        filters=MATERIAL_FILTERS,
        order=MATERIAL_ORDER,
    )
    page = paging.page(await materials.list(ctx, workspace, space, query))
    return ListMaterialsResponse(
        materials=[material_message(record) for record in page.items],
        next_page_token=page.next_page_token or None,
    )


@router.get(SPACE + "/materials/{material:id}", name="GetMaterial")
async def get_material(
    workspace: UUID, space: str, material: UUID, ctx: Context, materials: Materials
) -> MaterialMessage:
    return material_message(await materials.get(ctx, workspace, space, material))


@router.delete(SPACE + "/materials/{material:id}", name="DeleteMaterial")
async def delete_material(
    workspace: UUID, space: str, material: UUID, ctx: Context, materials: Materials
) -> dict[str, object]:
    await materials.delete(ctx, workspace, space, material)
    return {}


# -- Announcements --------------------------------------------------------------


@router.post(SPACE + "/announcements", name="CreateAnnouncement")
async def create_announcement(
    workspace: UUID,
    space: str,
    body: AnnouncementMessage,
    ctx: Context,
    announcements: Announcements,
    request_id: RequestId = None,
) -> AnnouncementMessage:
    record = await announcements.create(
        ctx,
        workspace,
        space,
        title=body.title or "",
        body=body.body,
        pinned=bool(body.pinned),
        request_id=request_id,
    )
    return announcement_message(record)


@router.get(SPACE + "/announcements", name="ListAnnouncements")
async def list_announcements(
    workspace: UUID,
    space: str,
    params: Listing,
    ctx: Context,
    announcements: Announcements,
) -> ListAnnouncementsResponse:
    query, paging = list_query(
        params,
        parent=_space_parent(workspace, space),
        filters=ANNOUNCEMENT_FILTERS,
        order=ANNOUNCEMENT_ORDER,
    )
    page = paging.page(await announcements.list(ctx, workspace, space, query))
    return ListAnnouncementsResponse(
        announcements=[announcement_message(record) for record in page.items],
        next_page_token=page.next_page_token or None,
    )


@router.get(SPACE + "/announcements/{announcement:id}", name="GetAnnouncement")
async def get_announcement(
    workspace: UUID,
    space: str,
    announcement: UUID,
    ctx: Context,
    announcements: Announcements,
) -> AnnouncementMessage:
    return announcement_message(
        await announcements.get(ctx, workspace, space, announcement)
    )


@router.patch(SPACE + "/announcements/{announcement:id}", name="UpdateAnnouncement")
async def update_announcement(
    workspace: UUID,
    space: str,
    announcement: UUID,
    body: AnnouncementMessage,
    ctx: Context,
    announcements: Announcements,
    update_mask: UpdateMask = None,
) -> AnnouncementMessage:
    changes = _changes(ANNOUNCEMENT_FIELDS, update_mask, body)
    record = await announcements.update(
        ctx, workspace, space, announcement, changes, expected_etag=body.etag
    )
    return announcement_message(record)


@router.delete(SPACE + "/announcements/{announcement:id}", name="DeleteAnnouncement")
async def delete_announcement(
    workspace: UUID,
    space: str,
    announcement: UUID,
    ctx: Context,
    announcements: Announcements,
    etag: Etag = None,
) -> dict[str, object]:
    await announcements.delete(ctx, workspace, space, announcement, expected_etag=etag)
    return {}


# -- Events ---------------------------------------------------------------------


@router.post(SPACE + "/events", name="CreateSpaceEvent")
async def create_space_event(
    workspace: UUID,
    space: str,
    body: SpaceEventMessage,
    ctx: Context,
    events: Events,
    request_id: RequestId = None,
) -> SpaceEventMessage:
    record = await events.create(
        ctx,
        workspace,
        space,
        title=body.title or "",
        start_time=body.start_time,
        end_time=body.end_time,
        location=body.location,
        description=body.description,
        request_id=request_id,
    )
    return space_event_message(record)


@router.get(SPACE + "/events", name="ListSpaceEvents")
async def list_space_events(
    workspace: UUID, space: str, params: Listing, ctx: Context, events: Events
) -> ListSpaceEventsResponse:
    query, paging = list_query(
        params,
        parent=_space_parent(workspace, space),
        filters=EVENT_FILTERS,
        order=EVENT_ORDER,
    )
    page = paging.page(await events.list(ctx, workspace, space, query))
    return ListSpaceEventsResponse(
        events=[space_event_message(record) for record in page.items],
        next_page_token=page.next_page_token or None,
    )


@router.get(SPACE + "/events/{event:id}", name="GetSpaceEvent")
async def get_space_event(
    workspace: UUID, space: str, event: UUID, ctx: Context, events: Events
) -> SpaceEventMessage:
    return space_event_message(await events.get(ctx, workspace, space, event))


@router.patch(SPACE + "/events/{event:id}", name="UpdateSpaceEvent")
async def update_space_event(
    workspace: UUID,
    space: str,
    event: UUID,
    body: SpaceEventMessage,
    ctx: Context,
    events: Events,
    update_mask: UpdateMask = None,
) -> SpaceEventMessage:
    changes = _changes(EVENT_FIELDS, update_mask, body)
    record = await events.update(
        ctx, workspace, space, event, changes, expected_etag=body.etag
    )
    return space_event_message(record)


@router.delete(SPACE + "/events/{event:id}", name="DeleteSpaceEvent")
async def delete_space_event(
    workspace: UUID,
    space: str,
    event: UUID,
    ctx: Context,
    events: Events,
    etag: Etag = None,
) -> dict[str, object]:
    await events.delete(ctx, workspace, space, event, expected_etag=etag)
    return {}


# -- Request types --------------------------------------------------------------


@router.post(SPACE + "/requestTypes", name="CreateRequestType")
async def create_request_type(
    workspace: UUID,
    space: str,
    body: RequestTypeMessage,
    ctx: Context,
    request_types: RequestTypes,
    request_type_id: Annotated[str | None, Query(alias="requestTypeId")] = None,
    request_id: RequestId = None,
) -> RequestTypeMessage:
    record = await request_types.create(
        ctx,
        workspace,
        space,
        request_type_id=request_type_id,
        display_name=body.display_name or "",
        description=body.description,
        fields=field_specs(body.fields),
        rules=rule_specs(body.rules),
        sla_duration=body.sla_duration,
        request_id=request_id,
    )
    return request_type_message(record)


@router.get(SPACE + "/requestTypes", name="ListRequestTypes")
async def list_request_types(
    workspace: UUID,
    space: str,
    params: Listing,
    ctx: Context,
    request_types: RequestTypes,
) -> ListRequestTypesResponse:
    query, paging = list_query(
        params,
        parent=_space_parent(workspace, space),
        filters=REQUEST_TYPE_FILTERS,
        order=REQUEST_TYPE_ORDER,
    )
    page = paging.page(await request_types.list(ctx, workspace, space, query))
    return ListRequestTypesResponse(
        request_types=[request_type_message(record) for record in page.items],
        next_page_token=page.next_page_token or None,
    )


@router.get(SPACE + "/requestTypes/{requestType:id}", name="GetRequestType")
async def get_request_type(
    workspace: UUID,
    space: str,
    request_type: RequestTypeCode,
    ctx: Context,
    request_types: RequestTypes,
) -> RequestTypeMessage:
    return request_type_message(
        await request_types.get(ctx, workspace, space, request_type)
    )


@router.patch(SPACE + "/requestTypes/{requestType:id}", name="UpdateRequestType")
async def update_request_type(
    workspace: UUID,
    space: str,
    request_type: RequestTypeCode,
    body: RequestTypeMessage,
    ctx: Context,
    request_types: RequestTypes,
    update_mask: UpdateMask = None,
) -> RequestTypeMessage:
    changes = _changes(REQUEST_TYPE_FIELDS, update_mask, body)
    if "fields" in changes:
        changes["fields"] = field_specs(body.fields)
    if "rules" in changes:
        changes["rules"] = rule_specs(body.rules)
    record = await request_types.update(
        ctx, workspace, space, request_type, changes, expected_etag=body.etag
    )
    return request_type_message(record)


@router.delete(SPACE + "/requestTypes/{requestType:id}", name="DeleteRequestType")
async def delete_request_type(
    workspace: UUID,
    space: str,
    request_type: RequestTypeCode,
    ctx: Context,
    request_types: RequestTypes,
    etag: Etag = None,
) -> RequestTypeMessage:
    record = await request_types.delete(
        ctx, workspace, space, request_type, expected_etag=etag
    )
    return request_type_message(record)


@router.post(
    SPACE + "/requestTypes/{requestType:id}:undelete", name="UndeleteRequestType"
)
async def undelete_request_type(
    workspace: UUID,
    space: str,
    request_type: RequestTypeCode,
    body: UndeleteRequestTypeRequest,
    ctx: Context,
    request_types: RequestTypes,
) -> RequestTypeMessage:
    record = await request_types.undelete(
        ctx, workspace, space, request_type, expected_etag=body.etag
    )
    return request_type_message(record)


# -- Requests -------------------------------------------------------------------


@router.post("/workspaces/{workspace:id}/requests", name="CreateRequest")
async def create_request(
    workspace: UUID,
    body: RequestResource,
    ctx: Context,
    requests: Requests,
    validate_only: ValidateOnly = False,
    request_id: RequestId = None,
) -> RequestResource:
    record = await requests.create(
        ctx,
        workspace,
        new_request(body),
        validate_only=validate_only,
        request_id=request_id,
    )
    return request_message(record)


@router.get("/workspaces/{workspace:id}/requests", name="ListRequests")
async def list_requests(
    workspace: UUID, params: Listing, ctx: Context, requests: Requests
) -> ListRequestsResponse:
    query, paging = list_query(
        params,
        parent=f"workspaces/{workspace}",
        filters=request_filters(workspace),
        order=REQUEST_ORDER,
    )
    spaces = [
        parse_space_name(restriction.value.text, workspace, field="filter")
        for restriction in filtering.restrictions(filtering.parse(params.filter))
        if restriction.field == "space" and not restriction.value.is_null
    ]
    page = paging.page(
        await requests.list(ctx, workspace, query, filtered_spaces=spaces)
    )
    return ListRequestsResponse(
        requests=[request_message(record) for record in page.items],
        next_page_token=page.next_page_token or None,
    )


@router.get(REQUEST, name="GetRequest")
async def get_request(
    workspace: UUID, request: RequestPath, ctx: Context, requests: Requests
) -> RequestResource:
    return request_message(await requests.get(ctx, workspace, request))


@router.patch(REQUEST, name="UpdateRequest")
async def update_request(
    workspace: UUID,
    request: RequestPath,
    body: RequestResource,
    ctx: Context,
    requests: Requests,
    update_mask: UpdateMask = None,
) -> RequestResource:
    changes = _changes(REQUEST_FIELDS, update_mask, body)
    record = await requests.update(
        ctx, workspace, request, changes, expected_etag=body.etag
    )
    return request_message(record)


@router.post(REQUEST + ":approve", name="ApproveRequest")
async def approve_request(
    workspace: UUID,
    request: RequestPath,
    body: ApproveRequestRequest,
    ctx: Context,
    requests: Requests,
) -> RequestResource:
    record = await requests.approve(
        ctx,
        workspace,
        request,
        message=body.message,
        role=body.role,
        expected_etag=body.etag,
    )
    return request_message(record)


@router.post(REQUEST + ":deny", name="DenyRequest")
async def deny_request(
    workspace: UUID,
    request: RequestPath,
    body: DenyRequestRequest,
    ctx: Context,
    requests: Requests,
) -> RequestResource:
    record = await requests.deny(
        ctx, workspace, request, message=body.message, expected_etag=body.etag
    )
    return request_message(record)


@router.post(REQUEST + ":sendBack", name="SendBackRequest")
async def send_back_request(
    workspace: UUID,
    request: RequestPath,
    body: SendBackRequestRequest,
    ctx: Context,
    requests: Requests,
) -> RequestResource:
    record = await requests.send_back(
        ctx, workspace, request, message=body.message, expected_etag=body.etag
    )
    return request_message(record)


@router.post(REQUEST + ":answer", name="AnswerRequest")
async def answer_request(
    workspace: UUID,
    request: RequestPath,
    body: AnswerRequestRequest,
    ctx: Context,
    requests: Requests,
) -> RequestResource:
    record = await requests.answer(
        ctx,
        workspace,
        request,
        answer=body.answer,
        publish_to_collection=body.publish_to_collection,
        expected_etag=body.etag,
    )
    return request_message(record)


@router.post(REQUEST + ":close", name="CloseRequest")
async def close_request(
    workspace: UUID,
    request: RequestPath,
    body: CloseRequestRequest,
    ctx: Context,
    requests: Requests,
) -> RequestResource:
    return request_message(
        await requests.close(ctx, workspace, request, expected_etag=body.etag)
    )


@router.post(REQUEST + ":withdraw", name="WithdrawRequest")
async def withdraw_request(
    workspace: UUID,
    request: RequestPath,
    body: WithdrawRequestRequest,
    ctx: Context,
    requests: Requests,
) -> RequestResource:
    return request_message(
        await requests.withdraw(ctx, workspace, request, expected_etag=body.etag)
    )


# -- Request messages -----------------------------------------------------------


@router.post(REQUEST + "/messages", name="CreateRequestMessage")
async def create_request_message(
    workspace: UUID,
    request: RequestPath,
    body: RequestMessageMessage,
    ctx: Context,
    messages: Messages,
    request_id: RequestId = None,
) -> RequestMessageMessage:
    record = await messages.create(
        ctx,
        workspace,
        request,
        text=body.text,
        internal=bool(body.internal),
        request_id_key=request_id,
    )
    return request_message_message(record)


@router.get(REQUEST + "/messages", name="ListRequestMessages")
async def list_request_messages(
    workspace: UUID,
    request: RequestPath,
    params: Listing,
    ctx: Context,
    messages: Messages,
) -> ListRequestMessagesResponse:
    query, paging = list_query(
        params,
        parent=f"workspaces/{workspace}/requests/{request}",
        filters=request_message_filters(workspace),
        order=REQUEST_MESSAGE_ORDER,
    )
    page = paging.page(await messages.list(ctx, workspace, request, query))
    return ListRequestMessagesResponse(
        messages=[request_message_message(record) for record in page.items],
        next_page_token=page.next_page_token or None,
    )


@router.get(REQUEST + "/messages/{message:id}", name="GetRequestMessage")
async def get_request_message(
    workspace: UUID,
    request: RequestPath,
    message: UUID,
    ctx: Context,
    messages: Messages,
) -> RequestMessageMessage:
    return request_message_message(await messages.get(ctx, workspace, request, message))
