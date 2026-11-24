"""Shares: every URL the platform hands out (``workspaces/{w}/shares/{share}``).

``database_architecture.md`` "Resource shares" is the design. A SHARE points
at an item, a space or a conversation and grants nothing: it opens for a
signed-in person in its audience who can already read the target (for a
conversation, the live share itself is what lets its audience read it). An
INVITE grants its role at the workspace, a space or a Collection; creating
one is an IAM change (the scope's ``setIamPolicy`` and ``require_grantable``),
re-checked against the creator on every accept. Invite URLs carry a secret
token of which only the SHA-256 is stored; share URLs carry the share ID.

Cross-domain API (no permission check; the caller's session):
:func:`conversation_shared_with`.
"""

from __future__ import annotations

import hashlib
import secrets
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any, Literal
from uuid import UUID

from sqlalchemy import (
    ColumnElement,
    Row,
    Select,
    String,
    and_,
    case,
    cast,
    func,
    or_,
    select,
    true,
)
from sqlalchemy.ext.asyncio import AsyncSession

from bomesh.db.engine import SessionFactory, transaction_scope
from bomesh.db.models import (
    ResourceShare,
    Role,
    RoleAssignment,
    Tenant,
    TenantMembership,
)
from bomesh.errors import (
    FailedPrecondition,
    InvalidArgument,
    NotFound,
    PermissionDenied,
    ServiceError,
)
from bomesh.iam.authorizer import Authorizer, ItemRef, Principal, SpaceRef, WorkspaceRef
from bomesh.iam.policy import PERSONAL_COLLECTION_TYPE, PolicyStore, role_name
from bomesh.iam.visibility import ItemVisibility, is_visible
from bomesh.services.collaboration.queries import space_code_of, space_rows
from bomesh.services.collaboration.records import space_name
from bomesh.services.conversations.records import conversation_name
from bomesh.services.conversations.references import (
    conversation_code_of,
    conversation_codes,
    conversation_rows,
    parse_conversation_name,
)
from bomesh.services.identity.identity_store import IdentityStoreService
from bomesh.services.kernel.audit import Audit
from bomesh.services.kernel.context import RequestContext
from bomesh.services.kernel.idempotency import Idempotency
from bomesh.services.kernel.listing import ListQuery
from bomesh.services.kernel.workspaces import (
    WorkspaceResolver,
    require_usable,
    workspace_name,
)
from bomesh.services.knowledge_items.inventory import is_visible_item, item_rows
from bomesh.services.knowledge_items.item_store import (
    HIDDEN_TYPES,
    ensure_personal_collection,
)
from bomesh.services.knowledge_items.names import item_name, parse_item
from bomesh.services.workspaces.records import member_name, parse_member_name
from bomesh.services.workspaces.support import lock_workspace

if TYPE_CHECKING:
    from bomesh.runtime import AppRuntime

Kind = Literal["SHARE", "INVITE"]
Audience = Literal["WORKSPACE", "PEOPLE", "ANYONE"]
State = Literal["ACTIVE", "EXPIRED", "EXHAUSTED", "REVOKED"]

#: The secret of an invite URL: 32 random bytes, URL-safe base64.
TOKEN_BYTES = 32
_SET_IAM = {
    "tenant": "workspaces.setIamPolicy",
    "space": "spaces.setIamPolicy",
    "collection": "items.setIamPolicy",
}
_UNTITLED_CONVERSATION = "Untitled conversation"


# -- Records ----------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class ShareDraft:
    """The writable fields of CreateShare (names as the API sends them)."""

    kind: str | None
    target: str | None
    role: str | None = None
    audience: str | None = None
    recipients: tuple[str, ...] = ()
    expire_time: datetime | None = None
    max_uses: int | None = None


@dataclass(frozen=True, slots=True)
class ShareRecord:
    workspace_id: UUID
    share_id: UUID
    kind: Kind
    target: str
    role: str | None
    audience: Audience
    recipient_ids: tuple[UUID, ...]
    expires_at: datetime | None
    max_uses: int | None
    use_count: int
    state: State
    creator_id: UUID
    created_at: datetime
    last_used_at: datetime | None
    #: The invite secret; set only on the record CreateShare returns.
    token: str | None = None

    @property
    def name(self) -> str:
        return share_name(self.workspace_id, self.share_id)

    @property
    def uri(self) -> str | None:
        """``/s/{share}`` for a share; ``/s/{token}`` for an invite, only when created."""
        if self.kind == "SHARE":
            return f"/s/{self.share_id}"
        return f"/s/{self.token}" if self.token else None

    @property
    def recipients(self) -> list[str]:
        return [member_name(self.workspace_id, user_id) for user_id in self.recipient_ids]

    @property
    def creator(self) -> str:
        return member_name(self.workspace_id, self.creator_id)


@dataclass(frozen=True, slots=True)
class ShareResolution:
    share: str
    kind: Kind
    target: str
    target_display_name: str | None
    workspace_display_name: str | None
    role: str | None
    can_open: bool
    can_accept: bool
    reason: str | None


def share_name(workspace_id: UUID, share_id: UUID) -> str:
    return f"{workspace_name(workspace_id)}/shares/{share_id}"


def hash_token(token: str) -> str:
    """The stored form of an invite token (``resource_shares.token_hash``): SHA-256 hex."""
    return hashlib.sha256(token.encode()).hexdigest()


# -- Cross-domain read ---------------------------------------------------------------


async def conversation_shared_with(
    session: AsyncSession, *, conversation_id: UUID, user_id: UUID, tenant_id: UUID
) -> bool:
    """Whether a live, unexpired SHARE of the conversation resolves for the user.

    The audience is every ACTIVE member (``workspace``) or the ACTIVE members
    among ``recipient_user_ids`` (``people``). The owner check is the caller's.
    """
    shared = await session.scalar(
        select(true())
        .select_from(ResourceShare)
        .join(
            TenantMembership,
            and_(
                TenantMembership.tenant_id == ResourceShare.tenant_id,
                TenantMembership.user_id == user_id,
            ),
        )
        .where(
            ResourceShare.tenant_id == tenant_id,
            ResourceShare.conversation_id == conversation_id,
            ResourceShare.kind == "share",
            _live(),
            TenantMembership.status == "active",
            TenantMembership.deleted_at.is_(None),
            or_(
                ResourceShare.audience == "workspace",
                ResourceShare.recipient_user_ids.any(user_id),
            ),
        )
        .limit(1)
    )
    return bool(shared)


# -- SQL projections for ListShares ----------------------------------------------------


def share_state_column() -> ColumnElement[str]:
    """``Share.state`` as SQL (filters)."""
    return case(
        (ResourceShare.revoked_at.is_not(None), "REVOKED"),
        (ResourceShare.expires_at <= func.now(), "EXPIRED"),
        (
            and_(
                ResourceShare.max_uses.is_not(None),
                ResourceShare.use_count >= ResourceShare.max_uses,
            ),
            "EXHAUSTED",
        ),
        else_="ACTIVE",
    )


def share_target_column() -> ColumnElement[str]:
    """``Share.target`` (a resource name) as SQL (filters)."""
    workspace = func.concat("workspaces/", cast(ResourceShare.tenant_id, String))
    space_code = space_code_of(ResourceShare.space_id)
    conversation_code = conversation_code_of(ResourceShare.conversation_id)
    return case(
        (
            ResourceShare.item_id.is_not(None),
            func.concat(workspace, "/items/", cast(ResourceShare.item_id, String)),
        ),
        (ResourceShare.space_id.is_not(None), func.concat(workspace, "/spaces/", space_code)),
        (
            ResourceShare.conversation_id.is_not(None),
            func.concat(workspace, "/conversations/", conversation_code),
        ),
        else_=workspace,
    )


# -- Service ----------------------------------------------------------------------------


class ShareService:
    def __init__(self, sessions: SessionFactory, request_hash_secret: bytes) -> None:
        self._sessions = sessions
        self._secret = request_hash_secret
        self._resolver = WorkspaceResolver()

    @classmethod
    def from_runtime(cls, runtime: AppRuntime) -> ShareService:
        return cls(runtime.sessions(), runtime.request_hash_secret())

    async def create(
        self,
        ctx: RequestContext,
        workspace_id: UUID,
        draft: ShareDraft,
        *,
        request_id: UUID | None,
    ) -> ShareRecord:
        """CreateShare: validate the draft for its kind, check the target, store it."""
        await self._resolver.open(ctx, WorkspaceRef(workspace_id), "shares.create", write=True)
        kind, audience = _kind_and_audience(draft)
        _check_fields(draft, kind, audience)
        recipient_ids = tuple(
            dict.fromkeys(
                parse_member_name(name, workspace_id, field="recipients")
                for name in draft.recipients
            )
        )
        now = datetime.now(UTC)
        if draft.expire_time is not None and draft.expire_time <= now:
            raise InvalidArgument.for_field("expireTime", "expireTime must be in the future.")
        async with transaction_scope(self._sessions) as session:
            idempotency = Idempotency(session, self._secret)
            key = None
            if request_id is not None:
                key = idempotency.key(
                    ctx.principal,
                    request_id,
                    method="CreateShare",
                    parent=workspace_name(workspace_id),
                    request={
                        "kind": kind,
                        "target": draft.target,
                        "role": draft.role,
                        "audience": audience,
                        "recipients": list(draft.recipients),
                        "expireTime": draft.expire_time,
                        "maxUses": draft.max_uses,
                    },
                )
                if (replayed := await idempotency.replay(key)) is not None:
                    row = await _row(session, workspace_id, _share_id(replayed))
                    return (await _records(session, [row]))[0]
            target = await _parse_target(session, workspace_id, draft.target or "")
            share = ResourceShare(
                tenant_id=workspace_id,
                kind=kind.lower(),
                audience=audience.lower(),
                recipient_user_ids=list(recipient_ids),
                expires_at=draft.expire_time,
                max_uses=draft.max_uses,
                created_by_user_id=ctx.user_id,
                item_id=target.item_id,
                space_id=target.space_id,
                conversation_id=target.conversation_id,
            )
            token = None
            if kind == "SHARE":
                await _require_shareable(session, ctx, target)
                if recipient_ids and not await _all_active(session, workspace_id, recipient_ids):
                    raise FailedPrecondition(
                        "Every recipient must be an active member of the workspace.",
                        reason="NOT_WORKSPACE_MEMBER",
                    )
            else:
                role = await _invite_role(session, ctx, target, draft.role or "")
                share.role_id = role.id
                token = secrets.token_urlsafe(TOKEN_BYTES)
                share.token_hash = hash_token(token)
            session.add(share)
            await session.flush()
            name = share_name(workspace_id, share.id)
            await Audit(session).record(
                ctx,
                workspace_id=workspace_id,
                category="people",
                action="CreateShare",
                target=name,
                details={"kind": kind, "target": target.name, "audience": audience},
            )
            if key is not None:
                await idempotency.remember(key, name)
            record = (await _records(session, [share]))[0]
            return _with_token(record, token)

    async def get(self, ctx: RequestContext, workspace_id: UUID, share_id: UUID) -> ShareRecord:
        """GetShare: the caller's own shares and those of targets they manage."""
        await self._resolver.open(ctx, WorkspaceRef(workspace_id), "shares.get", write=False)
        async with transaction_scope(self._sessions) as session:
            row = await _managed_row(session, ctx, workspace_id, share_id)
            return (await _records(session, [row]))[0]

    async def list(
        self, ctx: RequestContext, workspace_id: UUID, query: ListQuery
    ) -> list[ShareRecord]:
        """ListShares: the caller's own shares and every share of a target they manage."""
        await self._resolver.open(ctx, WorkspaceRef(workspace_id), "shares.list", write=False)
        managed = await _managed_clause(ctx, workspace_id)
        async with transaction_scope(self._sessions) as session:
            rows = list(
                await session.scalars(
                    query.apply(
                        select(ResourceShare).where(
                            ResourceShare.tenant_id == workspace_id, managed
                        )
                    )
                )
            )
            return await _records(session, rows)

    async def delete(
        self, ctx: RequestContext, workspace_id: UUID, share_id: UUID
    ) -> ShareRecord:
        """DeleteShare: revoke (never undone); an already revoked share is returned as is."""
        await self._resolver.open(ctx, WorkspaceRef(workspace_id), "shares.delete", write=True)
        async with transaction_scope(self._sessions) as session:
            row = await _managed_row(session, ctx, workspace_id, share_id, for_update=True)
            if row.revoked_at is None:
                row.revoked_at = datetime.now(UTC)
                await session.flush()
                await Audit(session).record(
                    ctx,
                    workspace_id=workspace_id,
                    category="people",
                    action="DeleteShare",
                    target=share_name(workspace_id, share_id),
                    details={"kind": row.kind.upper()},
                )
            return (await _records(session, [row]))[0]

    async def resolve(self, ctx: RequestContext, token: str) -> ShareResolution:
        """ResolveShare: what the share does for the caller; changes nothing."""
        async with transaction_scope(self._sessions) as session:
            row = await _by_token(session, token)
            return await _resolution(session, ctx.authorizer, ctx.principal, row)

    async def accept(self, ctx: RequestContext, token: str) -> ShareResolution:
        """AcceptShare: grant an invite's role (and the membership for a workspace invite).

        Accepting again grants and uses nothing; every accept is audited.
        """
        async with transaction_scope(self._sessions) as session:
            row = await _by_token(session, token, for_update=True)
            if row.kind != "invite":
                raise InvalidArgument.for_field("token", "Only an INVITE can be accepted.")
            workspace = await session.get(Tenant, row.tenant_id)
            assert workspace is not None
            require_usable(workspace, write=True)
            target = await _target_of(session, row)
            if not target.live:
                raise NotFound("The share was not found.")
            role = await session.get(Role, row.role_id)
            assert role is not None
            membership = await _membership(session, row.tenant_id, ctx.user_id)
            if membership is not None and membership.status != "active":
                raise FailedPrecondition(
                    "Your membership of this workspace is suspended.", reason="MEMBER_SUSPENDED"
                )
            if target.scope != "tenant" and membership is None:
                raise FailedPrecondition(
                    "Only members of the workspace can accept this invite.",
                    reason="NOT_WORKSPACE_MEMBER",
                )
            granted = False
            if membership is None or not await _holds(session, ctx.user_id, role.id, target):
                state = _state(row, datetime.now(UTC))
                if state != "ACTIVE":
                    raise FailedPrecondition(f"The invite is {state.lower()}.", reason=state)
                if not await _creator_may_grant(session, ctx.authorizer, row, target, role):
                    raise FailedPrecondition(
                        "The person who created this invite can no longer grant it.",
                        reason="SHARE_CREATOR_NOT_ALLOWED",
                    )
                if membership is None:
                    await lock_workspace(session, row.tenant_id)
                    await IdentityStoreService(session).assign_membership(
                        ctx.user_id, row.tenant_id
                    )
                    await ensure_personal_collection(session, row.tenant_id, ctx.user_id)
                await PolicyStore(session, ctx.authorizer).add_binding(
                    target.resource,
                    role_name(role),
                    f"user:{ctx.user_id}",
                    created_by=row.created_by_user_id,
                )
                row.use_count += 1
                row.last_used_at = datetime.now(UTC)
                await session.flush()
                granted = True
            await Audit(session).record(
                ctx,
                workspace_id=row.tenant_id,
                category="people",
                action="AcceptShare",
                target=share_name(row.tenant_id, row.id),
                details={"granted": granted, "role": role_name(role), "target": target.name},
            )
        # The request's Authorizer memoized the caller's access before the grant.
        async with transaction_scope(self._sessions) as session:
            row = await _row(session, row.tenant_id, row.id)
            return await _resolution(session, Authorizer(self._sessions), ctx.principal, row)


# -- Targets ----------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class _Target:
    workspace_id: UUID
    name: str
    display_name: str
    #: ``tenant`` (the workspace), ``collection``/``document`` (an item), ``space``, ``conversation``.
    kind: str
    live: bool
    item_id: UUID | None = None
    space_id: UUID | None = None
    conversation_id: UUID | None = None
    owner_id: UUID | None = None
    #: The item's ``item_type`` (``personal``, ``standard``, a file class…).
    item_type: str | None = None

    @property
    def scope(self) -> str:
        """The role scope an invite on this target grants at."""
        return {"document": "collection"}.get(self.kind, self.kind)

    @property
    def resource(self) -> WorkspaceRef | ItemRef | SpaceRef:
        if self.item_id is not None:
            return ItemRef(self.workspace_id, self.item_id)
        if self.space_id is not None:
            return SpaceRef(self.workspace_id, self.space_id)
        return WorkspaceRef(self.workspace_id)


async def _parse_target(session: AsyncSession, workspace_id: UUID, name: str) -> _Target:
    """The target a CreateShare ``target`` names (INVALID_ARGUMENT when malformed;
    PERMISSION_DENIED when it does not exist, as for any unreadable reference)."""
    if not name:
        raise InvalidArgument.for_field("target", "target is required.")
    parts = name.split("/")
    if name == workspace_name(workspace_id):
        tenant = await session.get(Tenant, workspace_id)
        assert tenant is not None
        return _workspace_target(tenant)
    target: _Target | None = None
    if len(parts) == 4 and parts[2] == "items":
        target = await _item_target(session, workspace_id, parse_item(name, workspace_id, field="target"))
    elif len(parts) == 4 and parts[2] == "spaces" and parts[1] == str(workspace_id):
        space = await _first(session, space_rows(), tenant_id=workspace_id, code=parts[3])
        target = _space_target(space) if space is not None else None
    elif len(parts) == 4 and parts[2] == "conversations":
        code = parse_conversation_name(name, workspace_id, field="target")
        conversation = await _first(
            session, conversation_rows(), tenant_id=workspace_id, code=code
        )
        target = _conversation_target(conversation) if conversation is not None else None
    else:
        raise InvalidArgument.for_field(
            "target",
            f"'{name}' is not the workspace, an item, a space or a conversation of this workspace.",
        )
    if target is None:
        raise PermissionDenied(f"You cannot share '{name}' (or it might not exist).")
    return target


async def _target_of(session: AsyncSession, row: ResourceShare) -> _Target:
    if row.item_id is not None:
        target = await _item_target(session, row.tenant_id, row.item_id)
    elif row.space_id is not None:
        space = await _first(session, space_rows(), id=row.space_id)
        target = _space_target(space) if space is not None else None
    elif row.conversation_id is not None:
        conversation = await _first(session, conversation_rows(), id=row.conversation_id)
        target = _conversation_target(conversation) if conversation is not None else None
    else:
        tenant = await session.get(Tenant, row.tenant_id)
        target = _workspace_target(tenant) if tenant is not None else None
    assert target is not None, "resource_shares targets are foreign keys"
    return target


async def _first(session: AsyncSession, rows: Select[Any], **equals: Any) -> Row[Any] | None:
    """The first row of a domain's row builder whose named columns equal ``equals``."""
    columns = rows.selected_columns
    statement = rows.where(*(columns[name] == value for name, value in equals.items()))
    return (await session.execute(statement)).first()


async def _item_target(session: AsyncSession, workspace_id: UUID, item_id: UUID) -> _Target | None:
    item = await _first(session, item_rows(), id=item_id, tenant_id=workspace_id)
    if item is None:
        return None
    return _Target(
        workspace_id=workspace_id,
        name=item_name(workspace_id, item.id),
        display_name=item.item_name,
        kind=item.item_kind,
        live=item.deleted_at is None,
        item_id=item.id,
        item_type=item.item_type,
    )


def _space_target(space: Row[Any]) -> _Target:
    return _Target(
        workspace_id=space.tenant_id,
        name=space_name(space.tenant_id, space.code),
        display_name=space.space_name,
        kind="space",
        live=space.deleted_at is None,
        space_id=space.id,
    )


def _conversation_target(conversation: Row[Any]) -> _Target:
    return _Target(
        workspace_id=conversation.tenant_id,
        name=conversation_name(conversation.tenant_id, conversation.code),
        display_name=conversation.conversation_name or _UNTITLED_CONVERSATION,
        kind="conversation",
        live=conversation.deleted_at is None,
        conversation_id=conversation.id,
        owner_id=conversation.owner_user_id,
    )


def _workspace_target(tenant: Tenant) -> _Target:
    return _Target(
        workspace_id=tenant.id,
        name=workspace_name(tenant.id),
        display_name=tenant.tenant_name,
        kind="tenant",
        live=True,
    )


async def _can_read(
    session: AsyncSession, authorizer: Authorizer, principal: Principal, target: _Target
) -> bool:
    """Whether ``principal`` can read the live target without any share."""
    if not target.live:
        return False
    match target.kind:
        case "tenant":
            return await authorizer.is_active_member(principal, target.workspace_id)
        case "space":
            return "spaces.get" in await authorizer.permissions(principal, target.resource)
        case "conversation":
            return target.owner_id == principal.user_id
    assert target.item_id is not None
    if any(node.item_type in HIDDEN_TYPES for node in await authorizer.ancestry(target.item_id)):
        return False
    return await is_visible(authorizer, principal, ItemRef(target.workspace_id, target.item_id))


# -- Create ------------------------------------------------------------------------------


def _kind_and_audience(draft: ShareDraft) -> tuple[Kind, Audience]:
    if draft.kind not in ("SHARE", "INVITE"):
        raise InvalidArgument.for_field("kind", "kind must be SHARE or INVITE.")
    kind: Kind = draft.kind  # type: ignore[assignment]
    default = "WORKSPACE" if kind == "SHARE" else "ANYONE"
    audience = draft.audience or default
    allowed = ("WORKSPACE", "PEOPLE") if kind == "SHARE" else ("ANYONE",)
    if audience not in allowed:
        raise InvalidArgument.for_field(
            "audience", f"A {kind} takes audience {' or '.join(allowed)}."
        )
    return kind, audience  # type: ignore[return-value]


def _check_fields(draft: ShareDraft, kind: Kind, audience: Audience) -> None:
    if audience == "PEOPLE" and not draft.recipients:
        raise InvalidArgument.for_field("recipients", "recipients is required for audience PEOPLE.")
    if audience != "PEOPLE" and draft.recipients:
        raise InvalidArgument.for_field("recipients", "recipients is only used with audience PEOPLE.")
    if kind == "SHARE":
        if draft.role:
            raise InvalidArgument.for_field("role", "role is only used by an INVITE.")
        if draft.max_uses is not None:
            raise InvalidArgument.for_field("maxUses", "maxUses is only used by an INVITE.")
        return
    if not draft.role:
        raise InvalidArgument.for_field("role", "role is required for an INVITE.")
    if draft.max_uses is not None and draft.max_uses < 1:
        raise InvalidArgument.for_field("maxUses", "maxUses must be at least 1.")


async def _require_shareable(session: AsyncSession, ctx: RequestContext, target: _Target) -> None:
    """A SHARE needs a target the caller can read (a conversation: its owner)."""
    if target.kind == "tenant":
        raise InvalidArgument.for_field(
            "target", "A SHARE targets an item, a space or a conversation."
        )
    if target.kind == "conversation" and target.owner_id == ctx.user_id and not target.live:
        raise FailedPrecondition("The conversation is deleted.", reason="CONVERSATION_DELETED")
    if not await _can_read(session, ctx.authorizer, ctx.principal, target):
        raise PermissionDenied(f"You cannot share '{target.name}' (or it might not exist).")


async def _invite_role(
    session: AsyncSession, ctx: RequestContext, target: _Target, name: str
) -> Role:
    """The role an INVITE grants: valid at the target scope and grantable by the caller."""
    if target.kind == "conversation":
        raise InvalidArgument.for_field(
            "target", "An INVITE targets the workspace, a space or a collection."
        )
    if target.kind == "document":
        raise InvalidArgument.for_field("target", "An INVITE targets a COLLECTION, not a DOCUMENT.")
    if target.item_type in HIDDEN_TYPES or not target.live:
        raise PermissionDenied(f"You cannot share '{target.name}' (or it might not exist).")
    if target.item_type == PERSONAL_COLLECTION_TYPE:
        raise FailedPrecondition(
            "A PERSONAL collection cannot be shared.", reason="PERSONAL_COLLECTION"
        )
    permission = _SET_IAM[target.scope]
    await ctx.authorizer.require(ctx.principal, permission, target.resource)
    role = await _role(session, target, name)
    await PolicyStore(session, ctx.authorizer).require_grantable(
        ctx.principal, target.resource, role_name(role)
    )
    return role


async def _role(session: AsyncSession, target: _Target, name: str) -> Role:
    """``roles/{r}`` of the target's scope, or a live custom role of the workspace."""
    parts = name.split("/")
    role: Role | None = None
    if len(parts) == 2 and parts[0] == "roles":
        role = await session.scalar(
            select(Role).where(
                Role.tenant_id.is_(None), Role.code == parts[1], Role.scope_type == target.scope
            )
        )
    elif len(parts) == 4 and parts[:3] == ["workspaces", str(target.workspace_id), "roles"]:
        role = await session.scalar(
            select(Role).where(
                Role.tenant_id == target.workspace_id,
                Role.code == parts[3],
                Role.deleted_at.is_(None),
            )
        )
    if role is None:
        raise InvalidArgument.for_field("role", f"Role '{name}' cannot be granted on the target.")
    return role


async def _all_active(session: AsyncSession, workspace_id: UUID, user_ids: Iterable[UUID]) -> bool:
    wanted = set(user_ids)
    active = set(
        await session.scalars(
            select(TenantMembership.user_id).where(
                TenantMembership.tenant_id == workspace_id,
                TenantMembership.user_id.in_(wanted),
                TenantMembership.status == "active",
                TenantMembership.deleted_at.is_(None),
            )
        )
    )
    return wanted <= active


# -- Read --------------------------------------------------------------------------------


async def _managed_clause(ctx: RequestContext, workspace_id: UUID) -> ColumnElement[bool]:
    """Shares the caller sees: their own, and every share of a target they manage."""
    held = await ctx.authorizer.workspace_permissions(ctx.principal, workspace_id)
    if "workspaces.setIamPolicy" in held:
        return true()
    owned = await ctx.authorizer.allowed_collections(
        ctx.principal, workspace_id, "items.setIamPolicy"
    )
    spaces = await ctx.authorizer.allowed_spaces(
        ctx.principal, workspace_id, "spaces.setIamPolicy"
    )
    clauses: list[ColumnElement[bool]] = [ResourceShare.created_by_user_id == ctx.user_id]
    if owned:
        clauses.append(
            is_visible_item(ResourceShare.item_id, ItemVisibility(workspace_id, owned, owned))
        )
    if spaces:
        clauses.append(ResourceShare.space_id.in_(spaces))
    return or_(*clauses)


async def _managed_row(
    session: AsyncSession,
    ctx: RequestContext,
    workspace_id: UUID,
    share_id: UUID,
    *,
    for_update: bool = False,
) -> ResourceShare:
    statement = select(ResourceShare).where(
        ResourceShare.id == share_id,
        ResourceShare.tenant_id == workspace_id,
        await _managed_clause(ctx, workspace_id),
    )
    row = await session.scalar(statement.with_for_update() if for_update else statement)
    if row is None:
        raise NotFound(f"Resource '{share_name(workspace_id, share_id)}' was not found.")
    return row


async def _row(session: AsyncSession, workspace_id: UUID, share_id: UUID) -> ResourceShare:
    row = await session.scalar(
        select(ResourceShare).where(
            ResourceShare.id == share_id, ResourceShare.tenant_id == workspace_id
        )
    )
    if row is None:
        raise NotFound(f"Resource '{share_name(workspace_id, share_id)}' was not found.")
    return row


async def _by_token(
    session: AsyncSession, token: str, *, for_update: bool = False
) -> ResourceShare:
    """A SHARE by its ID or an INVITE by its secret; NOT_FOUND for anything else."""
    try:
        share_id: UUID | None = UUID(token)
    except ValueError:
        share_id = None
    if share_id is not None:
        statement = select(ResourceShare).where(
            ResourceShare.id == share_id, ResourceShare.kind == "share"
        )
    else:
        statement = select(ResourceShare).where(
            ResourceShare.token_hash == hash_token(token), ResourceShare.kind == "invite"
        )
    row = await session.scalar(statement.with_for_update() if for_update else statement)
    if row is None:
        raise NotFound("The share was not found.")
    return row


async def _records(session: AsyncSession, rows: Sequence[ResourceShare]) -> list[ShareRecord]:
    """Records of ``rows`` with target and role names in a fixed number of queries."""
    space_ids = {row.space_id for row in rows if row.space_id is not None}
    conversation_ids = {row.conversation_id for row in rows if row.conversation_id is not None}
    role_ids = {row.role_id for row in rows if row.role_id is not None}
    spaces: dict[UUID, str] = {}
    conversations = await conversation_codes(session, conversation_ids)
    roles: dict[UUID, Role] = {}
    if space_ids:
        found = space_rows()
        spaces = {
            row.id: row.code
            for row in await session.execute(found.where(found.selected_columns.id.in_(space_ids)))
        }
    if role_ids:
        roles = {
            role.id: role
            for role in await session.scalars(select(Role).where(Role.id.in_(role_ids)))
        }
    now = datetime.now(UTC)
    records = []
    for row in rows:
        workspace_id = row.tenant_id
        if row.item_id is not None:
            target = item_name(workspace_id, row.item_id)
        elif row.space_id is not None:
            target = space_name(workspace_id, spaces[row.space_id])
        elif row.conversation_id is not None:
            target = conversation_name(workspace_id, conversations[row.conversation_id])
        else:
            target = workspace_name(workspace_id)
        records.append(
            ShareRecord(
                workspace_id=workspace_id,
                share_id=row.id,
                kind=row.kind.upper(),  # type: ignore[arg-type]
                target=target,
                role=role_name(roles[row.role_id]) if row.role_id is not None else None,
                audience=row.audience.upper(),  # type: ignore[arg-type]
                recipient_ids=tuple(row.recipient_user_ids),
                expires_at=row.expires_at,
                max_uses=row.max_uses,
                use_count=row.use_count,
                state=_state(row, now),
                creator_id=row.created_by_user_id,
                created_at=row.created_at,
                last_used_at=row.last_used_at,
            )
        )
    return records


def _with_token(record: ShareRecord, token: str | None) -> ShareRecord:
    if token is None:
        return record
    values: dict[str, Any] = {name: getattr(record, name) for name in ShareRecord.__slots__}
    values["token"] = token
    return ShareRecord(**values)


def _share_id(name: str) -> UUID:
    return UUID(name.rsplit("/", 1)[-1])


def _state(row: ResourceShare, now: datetime) -> State:
    if row.revoked_at is not None:
        return "REVOKED"
    if row.expires_at is not None and row.expires_at <= now:
        return "EXPIRED"
    if row.max_uses is not None and row.use_count >= row.max_uses:
        return "EXHAUSTED"
    return "ACTIVE"


def _live() -> ColumnElement[bool]:
    return and_(
        ResourceShare.revoked_at.is_(None),
        or_(ResourceShare.expires_at.is_(None), ResourceShare.expires_at > func.now()),
    )


# -- Resolve and accept ---------------------------------------------------------------------


async def _membership(
    session: AsyncSession, workspace_id: UUID, user_id: UUID
) -> TenantMembership | None:
    """The user's live membership (any status), or None."""
    membership = await session.get(
        TenantMembership, {"user_id": user_id, "tenant_id": workspace_id}
    )
    return membership if membership is not None and membership.deleted_at is None else None


async def _holds(session: AsyncSession, user_id: UUID, role_id: UUID, target: _Target) -> bool:
    """Whether the user directly holds ``role_id`` at the invite's scope."""
    if target.item_id is not None:
        scope = RoleAssignment.item_id == target.item_id
    elif target.space_id is not None:
        scope = RoleAssignment.space_id == target.space_id
    else:
        scope = RoleAssignment.tenant_id == target.workspace_id
    return bool(
        await session.scalar(
            select(true())
            .where(
                RoleAssignment.user_id == user_id,
                RoleAssignment.role_id == role_id,
                RoleAssignment.deleted_at.is_(None),
                scope,
            )
            .limit(1)
        )
    )


async def _creator_may_grant(
    session: AsyncSession, authorizer: Authorizer, row: ResourceShare, target: _Target, role: Role
) -> bool:
    """The creator still holds the scope's ``setIamPolicy`` and could grant ``role``."""
    creator = Principal(row.created_by_user_id)
    if _SET_IAM[target.scope] not in await authorizer.permissions(creator, target.resource):
        return False
    try:
        await PolicyStore(session, authorizer).require_grantable(
            creator, target.resource, role_name(role)
        )
    except ServiceError:
        return False
    return True


async def _resolution(
    session: AsyncSession, authorizer: Authorizer, principal: Principal, row: ResourceShare
) -> ShareResolution:
    target = await _target_of(session, row)
    if row.kind == "share" and target.kind == "conversation" and not target.live:
        raise NotFound("The share was not found.")
    tenant = await session.get(Tenant, row.tenant_id)
    assert tenant is not None
    role = await session.get(Role, row.role_id) if row.role_id is not None else None
    member = await authorizer.is_active_member(principal, row.tenant_id)
    state = _state(row, datetime.now(UTC))
    can_open = can_accept = False
    reason: str | None = None
    if row.kind == "share":
        in_audience = row.created_by_user_id == principal.user_id or (
            member
            and (row.audience == "workspace" or principal.user_id in row.recipient_user_ids)
        )
        if state != "ACTIVE":
            reason = state
        elif not in_audience:
            reason = "NOT_IN_AUDIENCE"
        elif target.kind == "conversation" or await _can_read(
            session, authorizer, principal, target
        ):
            # A live conversation share is itself what lets its audience read.
            can_open = True
        else:
            reason = "NO_ACCESS"
        shown = can_open
    else:
        if not target.live:
            raise NotFound("The share was not found.")
        assert role is not None
        membership = await _membership(session, row.tenant_id, principal.user_id)
        can_open = await _can_read(session, authorizer, principal, target)
        if membership is not None and membership.status != "active":
            reason = "MEMBER_SUSPENDED"
        elif membership is not None and await _holds(session, principal.user_id, role.id, target):
            reason = "ALREADY_MEMBER"
        elif state != "ACTIVE":
            reason = state
        elif target.scope != "tenant" and membership is None:
            reason = "NOT_WORKSPACE_MEMBER"
        elif not await _creator_may_grant(session, authorizer, row, target, role):
            reason = "SHARE_CREATOR_NOT_ALLOWED"
        else:
            can_accept = True
        shown = True
    return ShareResolution(
        share=share_name(row.tenant_id, row.id),
        kind=row.kind.upper(),  # type: ignore[arg-type]
        target=target.name,
        target_display_name=target.display_name if shown else None,
        workspace_display_name=tenant.tenant_name if shown or member else None,
        role=role_name(role) if role is not None else None,
        can_open=can_open,
        can_accept=can_accept,
        reason=reason,
    )


__all__ = [
    "ShareDraft",
    "ShareRecord",
    "ShareResolution",
    "ShareService",
    "conversation_shared_with",
    "hash_token",
    "share_name",
    "share_state_column",
    "share_target_column",
]
