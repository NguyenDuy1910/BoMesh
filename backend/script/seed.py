#!/usr/bin/env python3
"""Seed the BoMesh workspaces, their role-matrix accounts and HCM-UTE's library structure.

Idempotent utility (``auth_contract.md`` "Seeded workspaces and accounts"), not
an API. It runs in two steps:

1. **Identity**, in one transaction: syncs the IAM catalog; creates or refreshes
   every workspace in ``WORKSPACES`` (code, official name, CAMPUS template,
   ACTIVE), every account in ``ACCOUNTS`` (name, username, password, platform
   role, status), their memberships with a PERSONAL collection, and the
   workspace's shared resources: the shared collection readable by every member,
   the restricted collection and the space. Each account's direct bindings on the
   workspace, the restricted collection and the space become exactly its listed
   roles.
2. **Library structure**, through the public API in process
   (``httpx.ASGITransport`` over ``create_app``) as the workspace's knowledge
   administrator: ImportTopics (MERGE) from ``topics.csv`` and ImportCollections
   from ``collections.json`` into the shared collection. Both imports match by
   name, so a re-run creates only what is missing.

Every re-run restores the matrix: names and passwords are reset to the seed
password, extra roles on the seeded resources are removed and missing ones granted.
"""

from __future__ import annotations

import argparse
import asyncio
import csv
import json
import sys
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from uuid import UUID

import httpx
from dotenv import load_dotenv
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

load_dotenv(BACKEND_ROOT.parent / ".env", override=False)

from api.app import create_app  # noqa: E402
from bomesh.db.engine import get_session_factory, transaction_scope  # noqa: E402
from bomesh.db.models import Item, Space, Tenant, TenantMembership, User  # noqa: E402
from bomesh.iam.authorizer import Authorizer, ItemRef, SpaceRef, WorkspaceRef  # noqa: E402
from bomesh.iam.policy import (  # noqa: E402
    WORKSPACE_MEMBERS,
    PolicyResource,
    PolicyStore,
    set_platform_role,
)
from bomesh.iam.sync import sync_catalog  # noqa: E402
from bomesh.runtime import AppRuntime  # noqa: E402
from bomesh.services import (  # noqa: E402
    ACTIVE_STATUS,
    SUSPENDED_STATUS,
    IdentityNotFoundError,
)
from bomesh.services.collaboration.support import find_space  # noqa: E402
from bomesh.services.identity.identity_store import IdentityStoreService  # noqa: E402
from bomesh.services.identity.passwords import PasswordCredentialService  # noqa: E402
from bomesh.services.knowledge_items.item_store import (  # noqa: E402
    ItemService,
    ensure_personal_collection,
)

DEFAULT_PASSWORD = "19102003"
FIXTURES = Path(__file__).resolve().parent / "seed_fixtures"

PLATFORM_ADMIN = "roles/platformAdmin"
PLATFORM_OPERATOR = "roles/platformOperator"
WORKSPACE_ADMIN = "roles/workspaceAdmin"
WORKSPACE_MEMBER = "roles/workspaceMember"
COLLECTION_OWNER = "roles/collectionOwner"
COLLECTION_EDITOR = "roles/collectionEditor"
COLLECTION_VIEWER = "roles/collectionViewer"
SPACE_LEAD = "roles/spaceLead"
SPACE_STAFF = "roles/spaceStaff"
SPACE_MEMBER = "roles/spaceMember"


# -- Definitions -------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class SeedCollection:
    """A root collection: ``shared`` ones every member reads and contributes to;
    the others are access boundaries readable only through their role bindings."""

    name: str
    description: str
    shared: bool


@dataclass(frozen=True, slots=True)
class SeedSpace:
    code: str
    name: str
    description: str


@dataclass(frozen=True, slots=True)
class SeedWorkspace:
    """One organization: ``code`` is its web address (``api_design.md`` Workspace)."""

    code: str
    name: str
    #: Username of the knowledge administrator who creates the workspace's resources.
    curator: str
    shared_collection: SeedCollection | None = None
    restricted_collection: SeedCollection | None = None
    space: SeedSpace | None = None
    #: ``seed_fixtures/{fixtures}/topics.csv`` and ``collections.json``, when present.
    fixtures: str | None = None
    template: str = "campus"


HCMUTE = SeedWorkspace(
    code="hcmute",
    name="Trường Đại học Công nghệ Kỹ thuật TP. Hồ Chí Minh",
    curator="hcmute.curator",
    shared_collection=SeedCollection(
        "Kho tài liệu chung",
        "Tài liệu của các khoa, viện và phòng ban: bài giảng, giáo trình, đề cương, "
        "đề thi, văn bản và hướng dẫn người học.",
        shared=True,
    ),
    restricted_collection=SeedCollection(
        "Kho bài giảng nội bộ",
        "Bài giảng và học liệu nội bộ do Thư viện quản lý; chỉ người được cấp quyền mới xem được.",
        shared=False,
    ),
    space=SeedSpace(
        "khoa-cntt",
        "Khoa Công nghệ Thông tin",
        "Thông báo, tài liệu môn học và yêu cầu gửi văn phòng Khoa Công nghệ Thông tin.",
    ),
    fixtures="hcmute",
)
FTU_HCMC = SeedWorkspace(
    code="ftu-hcmc",
    name="Phân hiệu Trường Đại học Ngoại thương tại TP. Hồ Chí Minh",
    curator="ftu-hcmc.curator",
)
WORKSPACES: tuple[SeedWorkspace, ...] = (HCMUTE, FTU_HCMC)


@dataclass(frozen=True, slots=True)
class Membership:
    """Roles held in one workspace and on its restricted collection and space.

    Collection and space roles only take effect for active members, so every
    membership holds a workspace role as well.
    """

    workspace: str
    workspace_roles: tuple[str, ...] = (WORKSPACE_MEMBER,)
    collection_roles: tuple[str, ...] = ()
    space_roles: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class SeedAccount:
    """One identity: sign-in email and username, profile, and grants.

    Seeded accounts are system accounts named after what they are for, never
    after a person (the platform owner is the one real account). The username
    is unique across the platform: ``platform.{role}`` or ``{workspaceCode}.{role}``,
    and the email is ``{username}@bomesh.internal``, a reserved domain that never
    receives mail.
    """

    email: str
    username: str
    display_name: str
    position: str
    platform_role: str | None = None
    memberships: tuple[Membership, ...] = ()
    suspended: bool = False

    def grants(self, workspaces: dict[str, SeedWorkspace]) -> str:
        roles = [self.platform_role]
        for m in self.memberships:
            ws = workspaces[m.workspace]
            roles += [f"{r} @ {ws.code}" for r in m.workspace_roles]
            if ws.restricted_collection is not None:
                roles += [f"{r} · {ws.restricted_collection.name}" for r in m.collection_roles]
            if ws.space is not None:
                roles += [f"{r} · {ws.space.code}" for r in m.space_roles]
        text = ", ".join(r.removeprefix("roles/") for r in roles if r) or "no roles"
        if not self.memberships:
            text += ", no membership"
        return text + (", SUSPENDED" if self.suspended else "")


SYSTEM_DOMAIN = "bomesh.internal"


def _system(
    username: str,
    display_name: str,
    position: str,
    *,
    platform_role: str | None = None,
    memberships: tuple[Membership, ...] = (),
    suspended: bool = False,
) -> SeedAccount:
    return SeedAccount(
        f"{username}@{SYSTEM_DOMAIN}",
        username,
        display_name,
        position,
        platform_role=platform_role,
        memberships=memberships,
        suspended=suspended,
    )


def _ute(*roles: str, collection: tuple[str, ...] = (), space: tuple[str, ...] = ()) -> Membership:
    return Membership("hcmute", roles or (WORKSPACE_MEMBER,), collection, space)


def _ftu(*roles: str) -> Membership:
    return Membership("ftu-hcmc", roles or (WORKSPACE_MEMBER,))


ACCOUNTS: tuple[SeedAccount, ...] = (
    # The platform owner: the one real account. Platform console, and administers both workspaces.
    SeedAccount(
        "nguyendqduy@gmail.com",
        "nguyendqduy",
        "Nguyễn Đình Quốc Duy",
        "Chủ sở hữu nền tảng BoMesh",
        platform_role=PLATFORM_ADMIN,
        memberships=(_ute(WORKSPACE_ADMIN), _ftu(WORKSPACE_ADMIN)),
    ),
    # -- Platform: platform metadata, never workspace content ---------------------
    _system(
        "platform.admin",
        "Quản trị nền tảng",
        "platformAdmin, không thuộc workspace nào",
        platform_role=PLATFORM_ADMIN,
    ),
    _system(
        "platform.operator",
        "Vận hành nền tảng",
        "platformOperator, không thuộc workspace nào",
        platform_role=PLATFORM_OPERATOR,
    ),
    _system(
        "platform.noaccess",
        "Tài khoản chưa được cấp quyền",
        "không thuộc workspace nào, không có vai trò",
    ),
    # -- HCM-UTE ------------------------------------------------------------------
    _system(
        "hcmute.admin",
        "HCM-UTE · Quản trị hệ thống",
        "workspaceAdmin",
        memberships=(_ute(WORKSPACE_ADMIN),),
    ),
    _system(
        "hcmute.curator",
        "HCM-UTE · Quản trị tri thức",
        "workspaceAdmin · tạo kho, chủ đề và space được seed",
        memberships=(_ute(WORKSPACE_ADMIN),),
    ),
    _system(
        "hcmute.member",
        "HCM-UTE · Thành viên",
        "workspaceMember",
        memberships=(_ute(),),
    ),
    _system(
        "hcmute.collection-owner",
        "HCM-UTE · Chủ kho bài giảng nội bộ",
        "collectionOwner · Kho bài giảng nội bộ",
        memberships=(_ute(collection=(COLLECTION_OWNER,)),),
    ),
    _system(
        "hcmute.collection-editor",
        "HCM-UTE · Biên tập kho bài giảng nội bộ",
        "collectionEditor · Kho bài giảng nội bộ",
        memberships=(_ute(collection=(COLLECTION_EDITOR,)),),
    ),
    _system(
        "hcmute.collection-viewer",
        "HCM-UTE · Người xem kho bài giảng nội bộ",
        "collectionViewer · Kho bài giảng nội bộ",
        memberships=(_ute(collection=(COLLECTION_VIEWER,)),),
    ),
    _system(
        "hcmute.space-lead",
        "HCM-UTE · Trưởng space Khoa CNTT",
        "spaceLead · khoa-cntt",
        memberships=(_ute(space=(SPACE_LEAD,)),),
    ),
    _system(
        "hcmute.space-staff",
        "HCM-UTE · Nhân sự space Khoa CNTT",
        "spaceStaff · khoa-cntt",
        memberships=(_ute(space=(SPACE_STAFF,)),),
    ),
    _system(
        "hcmute.space-member",
        "HCM-UTE · Thành viên space Khoa CNTT",
        "spaceMember · khoa-cntt",
        memberships=(_ute(space=(SPACE_MEMBER,)),),
    ),
    _system(
        "hcmute.suspended",
        "HCM-UTE · Tài khoản bị khóa",
        "workspaceMember, tài khoản SUSPENDED",
        memberships=(_ute(),),
        suspended=True,
    ),
    # -- FTU HCMC campus ----------------------------------------------------------
    _system(
        "ftu-hcmc.admin",
        "FTU TP. HCM · Quản trị hệ thống",
        "workspaceAdmin",
        memberships=(_ftu(WORKSPACE_ADMIN),),
    ),
    _system(
        "ftu-hcmc.curator",
        "FTU TP. HCM · Quản trị tri thức",
        "workspaceAdmin · quản lý kho và chủ đề",
        memberships=(_ftu(WORKSPACE_ADMIN),),
    ),
    _system(
        "ftu-hcmc.member",
        "FTU TP. HCM · Thành viên",
        "workspaceMember",
        memberships=(_ftu(),),
    ),
    _system(
        "ftu-hcmc.suspended",
        "FTU TP. HCM · Tài khoản bị khóa",
        "workspaceMember, tài khoản SUSPENDED",
        memberships=(_ftu(),),
        suspended=True,
    ),
)


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Seed the BoMesh workspaces, their role-matrix accounts and library structure."
    )
    parser.add_argument(
        "--password",
        default=DEFAULT_PASSWORD,
        help="Password of every seeded account (default: %(default)s).",
    )
    return parser.parse_args()


# -- Step 1: identity --------------------------------------------------------------


@dataclass(slots=True)
class _Seeded:
    """What step 1 resolved for step 2 and the summary."""

    workspaces: dict[str, UUID] = field(default_factory=dict)
    shared_collections: dict[str, UUID] = field(default_factory=dict)
    lines: list[str] = field(default_factory=list)


async def _workspace(
    session: AsyncSession, identity: IdentityStoreService, seed: SeedWorkspace
) -> Tenant:
    """The active workspace, created when missing."""
    tenant = await session.scalar(select(Tenant).where(Tenant.code == seed.code))
    if tenant is None:
        tenant = await identity.create_tenant(seed.code, seed.name)
    tenant.tenant_name = seed.name
    tenant.template = seed.template
    tenant.status = ACTIVE_STATUS
    await session.flush()
    return tenant


async def _root_collection(
    session: AsyncSession,
    policies: PolicyStore,
    workspace_id: UUID,
    seed: SeedCollection,
    creator_id: UUID,
) -> Item:
    """A live root collection by name; a shared one grants every member read access."""
    item = await session.scalar(
        select(Item).where(
            Item.tenant_id == workspace_id,
            Item.item_kind == "collection",
            Item.parent_item_id.is_(None),
            Item.item_name == seed.name,
            Item.deleted_at.is_(None),
        )
    )
    if item is None:
        item = await ItemService(session).create_collection(
            workspace_id=workspace_id,
            item_name=seed.name,
            created_by_user_id=creator_id,
            description=seed.description,
            # Members find the restricted one and request access; the shared one
            # takes contributions.
            discoverable=True,
            accepts_contributions=seed.shared,
        )
    if seed.shared:
        resource = ItemRef(workspace_id, item.id)
        policy = await policies.get_policy(resource)
        if not any(
            b.role == COLLECTION_VIEWER and WORKSPACE_MEMBERS in b.members for b in policy.bindings
        ):
            await policies.add_binding(
                resource, COLLECTION_VIEWER, WORKSPACE_MEMBERS, created_by=creator_id
            )
    return item


async def _space(
    session: AsyncSession, workspace_id: UUID, seed: SeedSpace, creator_id: UUID
) -> Space:
    space = await find_space(session, workspace_id, seed.code)
    if space is None:
        space = Space(
            tenant_id=workspace_id,
            code=seed.code,
            space_name=seed.name,
            space_type="",
            join_policy="invite",
            created_by_user_id=creator_id,
        )
        session.add(space)
    space.space_name = seed.name
    space.description = seed.description
    space.deleted_at = None
    await session.flush()
    return space


async def _user(
    session: AsyncSession, identity: IdentityStoreService, account: SeedAccount, password_hash: str
) -> tuple[User, bool]:
    """The account, active, with its seeded name and password; suspension comes after the grants."""
    try:
        user = await identity.get_user_by_email(account.email, include_inactive=True)
        created = False
        await identity.set_username(user, account.username)
        identity.set_display_name(user, account.display_name)
    except IdentityNotFoundError:
        user = await identity.create_user(
            account.email, username=account.username, display_name=account.display_name
        )
        created = True
    user.password_hash = password_hash
    user.status = ACTIVE_STATUS
    await session.flush()
    return user, created


async def _membership(
    session: AsyncSession,
    identity: IdentityStoreService,
    user_id: UUID,
    workspace_id: UUID,
    *,
    member: bool,
) -> None:
    current = await session.get(TenantMembership, {"user_id": user_id, "tenant_id": workspace_id})
    if not member:
        if current is not None and current.deleted_at is None:
            await identity.remove_membership(user_id, workspace_id)
        return
    membership = await identity.assign_membership(user_id, workspace_id)
    membership.status = ACTIVE_STATUS
    await session.flush()
    await ensure_personal_collection(session, workspace_id, user_id)


async def _exact_roles(
    policies: PolicyStore,
    resource: PolicyResource,
    member: str,
    roles: tuple[str, ...],
    *,
    created_by: UUID,
) -> None:
    """Make ``member`` hold exactly ``roles`` directly on ``resource``."""
    policy = await policies.get_policy(resource)
    held = {binding.role for binding in policy.bindings if member in binding.members}
    if held == set(roles):
        return
    if held:
        await policies.remove_member(resource, member)
    for role in roles:
        await policies.add_binding(resource, role, member, created_by=created_by)


async def seed_identity(*, password: str) -> _Seeded:
    """Create or restore the workspaces and the role matrix in one transaction."""
    password_hash = PasswordCredentialService.hash(password)
    by_code = {ws.code: ws for ws in WORKSPACES}
    seeded = _Seeded()
    factory = get_session_factory()
    async with transaction_scope(factory) as session:
        identity = IdentityStoreService(session)
        policies = PolicyStore(session, Authorizer(factory))
        await sync_catalog(session)
        tenants = {ws.code: await _workspace(session, identity, ws) for ws in WORKSPACES}

        users: dict[str, tuple[User, bool]] = {}
        for account in ACCOUNTS:
            user, created = await _user(session, identity, account, password_hash)
            users[account.username] = (user, created)
            await set_platform_role(session, user.id, account.platform_role)
            joined = {m.workspace for m in account.memberships}
            for code, tenant in tenants.items():
                await _membership(session, identity, user.id, tenant.id, member=code in joined)

        for ws in WORKSPACES:
            tenant = tenants[ws.code]
            seeded.workspaces[ws.code] = tenant.id
            creator = users[ws.curator][0].id
            scopes: list[tuple[PolicyResource, Callable[[Membership], tuple[str, ...]]]] = [
                (WorkspaceRef(tenant.id), lambda m: m.workspace_roles)
            ]
            if ws.shared_collection is not None:
                shared = await _root_collection(
                    session, policies, tenant.id, ws.shared_collection, creator
                )
                seeded.shared_collections[ws.code] = shared.id
            if ws.restricted_collection is not None:
                restricted = await _root_collection(
                    session, policies, tenant.id, ws.restricted_collection, creator
                )
                scopes.append((ItemRef(tenant.id, restricted.id), lambda m: m.collection_roles))
            if ws.space is not None:
                space = await _space(session, tenant.id, ws.space, creator)
                scopes.append((SpaceRef(tenant.id, space.id), lambda m: m.space_roles))
            for account in ACCOUNTS:
                membership = next((m for m in account.memberships if m.workspace == ws.code), None)
                if membership is None:
                    continue
                user = users[account.username][0]
                for resource, roles_of in scopes:
                    await _exact_roles(
                        policies, resource, f"user:{user.id}", roles_of(membership), created_by=creator
                    )

        for account in ACCOUNTS:
            user, created = users[account.username]
            if account.suspended:
                await identity.set_user_status(user.id, SUSPENDED_STATUS)
            state = "created" if created else "refreshed"
            seeded.lines.append(
                f"{account.username:<25} {account.email:<42} {state:<9} "
                f"{account.display_name} — {account.position} [{account.grants(by_code)}]"
            )
    return seeded


# -- Step 2: library structure through the API -------------------------------------


def _topic_rows(path: Path) -> list[dict[str, Any]]:
    """``topics.csv`` (domain, topic, description, keywords, synonyms, guidance) as
    ImportTopics rows; list cells are ``;``-separated."""

    def listed(value: str) -> list[str]:
        return [part.strip() for part in value.split(";") if part.strip()]

    rows: list[dict[str, Any]] = []
    with path.open(encoding="utf-8-sig", newline="") as handle:
        for record in csv.DictReader(handle):
            row: dict[str, Any] = {"domain": record["domain"].strip()}
            if record.get("topic", "").strip():
                row["topic"] = record["topic"].strip()
            if record.get("description", "").strip():
                row["description"] = record["description"].strip()
            for column in ("keywords", "synonyms"):
                if record.get(column, "").strip():
                    row[column] = listed(record[column])
            if record.get("guidance", "").strip():
                row["guidance"] = record["guidance"].strip()
            rows.append(row)
    return rows


def _collection_rows(path: Path) -> list[dict[str, Any]]:
    """``collections.json`` (nested ``folders``) as ImportCollections rows, parents first."""

    def walk(folders: list[dict[str, Any]], parents: tuple[str, ...]) -> Iterator[dict[str, Any]]:
        for folder in folders:
            folder_path = (*parents, folder["name"])
            row: dict[str, Any] = {"path": list(folder_path)}
            if folder.get("description"):
                row["description"] = folder["description"]
            yield row
            yield from walk(folder.get("folders", []), folder_path)

    return list(walk(json.loads(path.read_text(encoding="utf-8"))["folders"], ()))


async def _call(http: httpx.AsyncClient, method: str, url: str, **kwargs: Any) -> dict[str, Any]:
    response = await http.request(method, url, **kwargs)
    if response.status_code >= 400:
        raise RuntimeError(f"{method} {url} → {response.status_code}: {response.text[:500]}")
    return response.json() if response.content else {}


async def seed_structure(seeded: _Seeded, *, password: str) -> list[str]:
    """ImportTopics and ImportCollections from each workspace's fixtures."""
    lines: list[str] = []
    runtime = AppRuntime()
    try:
        transport = httpx.ASGITransport(app=create_app(runtime))
        async with httpx.AsyncClient(transport=transport, base_url="http://seed") as http:
            for ws in WORKSPACES:
                if ws.fixtures is None:
                    continue
                curator = next(a for a in ACCOUNTS if a.username == ws.curator)
                session = await _call(
                    http,
                    "POST",
                    "/api/v1/sessions",
                    json={"credential": {"password": {"email": curator.email, "password": password}}},
                )
                http.headers["Authorization"] = f"Bearer {session['accessToken']}"
                workspace = f"/api/v1/workspaces/{seeded.workspaces[ws.code]}"
                fixtures = FIXTURES / ws.fixtures
                topics = await _call(
                    http,
                    "POST",
                    f"{workspace}/topics:import",
                    json={"rows": _topic_rows(fixtures / "topics.csv"), "mode": "MERGE"},
                )
                shared = seeded.shared_collections[ws.code]
                folders = await _call(
                    http,
                    "POST",
                    f"{workspace}/items/{shared}:importCollections",
                    json={"rows": _collection_rows(fixtures / "collections.json")},
                )
                lines.append(
                    f"{ws.code}: topics {_summary(topics)} · folders of "
                    f"'{ws.shared_collection.name if ws.shared_collection else ''}' "
                    f"{_summary(folders)}"
                )
                http.headers.pop("Authorization")
    finally:
        await runtime.aclose()
    return lines


def _summary(result: dict[str, Any]) -> str:
    counts = {
        key: len(value) if isinstance(value, list) else value
        for key, value in result.items()
        if key.endswith("Count") or isinstance(value, list)
    }
    return "(" + ", ".join(f"{key} {value}" for key, value in counts.items()) + ")"


async def _main() -> None:
    args = _parse_args()
    seeded = await seed_identity(password=args.password)
    for line in seeded.lines:
        print(line)
    for line in await seed_structure(seeded, password=args.password):
        print(line)
    for ws in WORKSPACES:
        print(f"Workspace '{ws.name}' ({ws.code}) id {seeded.workspaces[ws.code]}")


if __name__ == "__main__":
    asyncio.run(_main())
