#!/usr/bin/env python3
"""Seed the BoMesh workspaces, their role-matrix accounts, the university taxonomy and
HCM-UTE's library structure.

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
2. **Taxonomy and library structure**, through the public API in process
   (``httpx.ASGITransport`` over ``create_app``):

   - as the platform administrator, the platform templates of
     ``seed_fixtures/templates/vn-university`` (function, document-type and
     audience schemes: settings, ImportConcepts, groups) are created or
     restored and published;
   - as each CAMPUS workspace's knowledge administrator, the templates are
     forked (a re-run applies the template's non-conflicting changes), the
     workspace's own schemes from ``seed_fixtures/{fixtures}`` (domain and the
     org-unit and program authorities) are created or restored, every scheme
     is published, the template's and the workspace's ``rules.csv`` become
     ConceptRules, the seeded students' affiliations are imported
     (ImportMemberAffiliations) and ``collections.json`` is imported into the
     shared collection (ImportCollections).

   Imports MERGE by notation, name or code, so a re-run creates only what is
   missing and restores what the fixtures define; a publish without changes is
   skipped.

Every re-run restores the matrix: names and passwords are reset to the seed
password, extra roles on the seeded resources are removed and missing ones granted.
New workspaces created through the API fork nothing: their administrator forks
the templates they want (CreateConceptScheme ``template``).
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
from bomesh.services.taxonomy.classification import (  # noqa: E402
    DEFAULT_AUTO_THRESHOLD,
    DEFAULT_REVIEW_THRESHOLD,
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
class SeedScheme:
    """A concept scheme and its settings (``item_model.md`` §4.13). Its
    concepts are ``{code}.csv`` (ImportConcepts columns) and its groups, when
    present, ``{code}-groups.csv`` (code, name, position, queryExpansion, members)
    in the fixture directory."""

    code: str
    name: str
    description: str
    position: int
    classification: bool = True
    min_labels: int = 0
    max_labels: int | None = None
    has_primary: bool = False
    max_depth: int = 1
    assign_top_concepts: bool = True
    section_assignments: bool = False
    llm_policy: str = "NEVER"

    def settings(self) -> dict[str, Any]:
        """The CreateConceptScheme/UpdateConceptScheme body; classification schemes
        start at the classifier's default thresholds, authorities have none."""
        return {
            "displayName": self.name,
            "description": self.description,
            "position": self.position,
            "cardinality": {"min": self.min_labels, "max": self.max_labels, "primary": self.has_primary},
            "maxDepth": self.max_depth,
            "assignTopConcepts": self.assign_top_concepts,
            "sectionAssignments": self.section_assignments,
            "llmPolicy": self.llm_policy,
            "autoThreshold": DEFAULT_AUTO_THRESHOLD if self.classification else None,
            "reviewThreshold": DEFAULT_REVIEW_THRESHOLD if self.classification else None,
        }


#: The platform templates of a Vietnamese university (``seed_fixtures/templates/vn-university``).
TEMPLATE_FIXTURES = FIXTURES / "templates" / "vn-university"
TEMPLATE_SCHEMES: tuple[SeedScheme, ...] = (
    SeedScheme(
        "function",
        "Nghiệp vụ",
        "Hoạt động của nhà trường mà tài liệu phục vụ: tuyển sinh, đào tạo, công tác sinh viên, "
        "khoa học công nghệ, tổ chức và hành chính.",
        position=2,
        min_labels=1,
        max_labels=2,
        max_depth=2,
        assign_top_concepts=False,
        section_assignments=True,
        llm_policy="ALWAYS",
    ),
    SeedScheme(
        "document-type",
        "Loại tài liệu",
        "Hình thức của tài liệu: quy chế, quyết định, thông báo, giáo trình, khóa luận…",
        position=3,
        min_labels=1,
        max_labels=1,
        llm_policy="FALLBACK",
    ),
    SeedScheme(
        "audience",
        "Đối tượng",
        "Người đọc mà tài liệu hướng tới.",
        position=4,
        llm_policy="FALLBACK",
    ),
)
#: HCM-UTE's own schemes (``seed_fixtures/hcmute``).
DOMAIN = SeedScheme(
    "domain",
    "Lĩnh vực",
    "Kiến thức chuyên môn mà tài liệu đề cập: ngành, môn học, chủ đề nghiên cứu.",
    position=1,
    max_labels=3,
    has_primary=True,
    max_depth=3,
    assign_top_concepts=False,
    llm_policy="ALWAYS",
)
ORG_UNIT = SeedScheme(
    "org-unit",
    "Đơn vị",
    "Khoa, viện, phòng, trung tâm và phân hiệu: đơn vị ban hành, phạm vi áp dụng của văn bản "
    "và đơn vị của thành viên.",
    position=5,
    classification=False,
    max_depth=2,
)
PROGRAM = SeedScheme(
    "program",
    "Ngành đào tạo",
    "Ngành đào tạo theo mã Bộ GD&ĐT: phạm vi áp dụng của văn bản và ngành của sinh viên.",
    position=6,
    classification=False,
)


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
    #: ``seed_fixtures/{fixtures}/``: ``{scheme}.csv`` of ``schemes``, ``rules.csv``
    #: and ``collections.json``, when present.
    fixtures: str | None = None
    #: The workspace's own schemes; a CAMPUS workspace also forks ``TEMPLATE_SCHEMES``.
    schemes: tuple[SeedScheme, ...] = ()
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
    schemes=(DOMAIN, ORG_UNIT, PROGRAM),
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
    #: A student's registrar row (ImportMemberAffiliations): program notation and cohort.
    affiliation: tuple[str, int] | None = None


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


def _ute(
    *roles: str,
    collection: tuple[str, ...] = (),
    space: tuple[str, ...] = (),
    affiliation: tuple[str, int] | None = None,
) -> Membership:
    return Membership("hcmute", roles or (WORKSPACE_MEMBER,), collection, space, affiliation)


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
        "workspaceAdmin · tạo kho, phân loại và space được seed",
        memberships=(_ute(WORKSPACE_ADMIN),),
    ),
    _system(
        "hcmute.member",
        "HCM-UTE · Thành viên",
        "workspaceMember · sinh viên ngành Công nghệ thông tin, khóa 2022",
        memberships=(_ute(affiliation=("p-7480201", 2022)),),
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
        "workspaceAdmin · quản lý kho và phân loại",
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


# -- Step 2: taxonomy and library structure through the API ------------------------

#: Username of the platform administrator who creates the platform templates.
TEMPLATE_CURATOR = "platform.admin"
#: ImportConcepts columns (``ConceptImportRow``).
CONCEPT_COLUMNS = (
    "notation",
    "broader",
    "related",
    "prefVi",
    "prefEn",
    "altVi",
    "altEn",
    "hidden",
    "definition",
    "scopeNote",
    "examples",
    "color",
    "icon",
    "matchPatterns",
    "timeSensitive",
    "mappings",
)
#: Fixture columns that become mappings: (column, target system, default match).
#: A program's faculty and domain are mappings because ``broader`` never crosses schemes.
MAPPING_COLUMNS = (("faculty", "org-unit", "broad"), ("domainMatch", "domain", "close"))


def _csv(path: Path) -> list[dict[str, str]]:
    with path.open(encoding="utf-8-sig", newline="") as handle:
        return [{key: (value or "").strip() for key, value in record.items()} for record in csv.DictReader(handle)]


def _split(value: str) -> list[str]:
    return [part.strip() for part in value.split("|") if part.strip()]


def _concept_rows(path: Path) -> list[dict[str, str]]:
    """``{scheme}.csv`` as ImportConcepts rows; ``faculty`` (``org-unit:<notation>``)
    and ``domainMatch`` (``domain:<notation>[:match]``) cells join ``mappings`` as
    ``org-unit:<notation>:broad`` and ``domain:<notation>:close``."""
    rows: list[dict[str, str]] = []
    for line, record in enumerate(_csv(path), start=2):
        row = {column: record[column] for column in CONCEPT_COLUMNS if column in record}
        mappings = _split(row.get("mappings", ""))
        for column, system, match in MAPPING_COLUMNS:
            for value in _split(record.get(column, "")):
                parts = value.split(":")
                if parts[0] != system or len(parts) not in (2, 3) or not parts[1]:
                    raise SystemExit(f"{path}:{line}: {column} '{value}' is not {system}:<notation>[:match].")
                mappings.append(":".join((system, parts[1], parts[2] if len(parts) == 3 else match)))
        if "mappings" in row or mappings:
            row["mappings"] = "|".join(mappings)
        rows.append(row)
    return rows


def _concept_name(scheme: str, notation: str) -> str:
    return f"{scheme}/concepts/{notation}"


def _group_bodies(path: Path, scheme: str) -> list[tuple[str, dict[str, Any]]]:
    """``{scheme}-groups.csv`` as (groupId, CreateConceptGroup body); members are notations."""
    return [
        (
            record["code"],
            {
                "displayName": record["name"],
                "position": int(record["position"]),
                "members": [_concept_name(scheme, notation) for notation in _split(record["members"])],
                "queryExpansion": record["queryExpansion"].lower() == "true",
            },
        )
        for record in _csv(path)
    ]


def _rule_bodies(path: Path, workspace: str) -> list[tuple[str, dict[str, Any]]]:
    """``rules.csv`` (code, when, then, effect, weight; concepts as ``scheme:notation``)
    as (conceptRuleId, CreateConceptRule body)."""

    def concept(value: str, line: int) -> str:
        scheme, _, notation = value.partition(":")
        if not scheme or not notation:
            raise SystemExit(f"{path}:{line}: '{value}' is not scheme:notation.")
        return _concept_name(f"{workspace}/conceptSchemes/{scheme}", notation)

    return [
        (
            record["code"],
            {
                "when": {"concept": concept(record["when"], line)},
                "then": concept(record["then"], line),
                "effect": record["effect"].upper(),
                "weight": float(record["weight"]) if record["weight"] else None,
            },
        )
        for line, record in enumerate(_csv(path), start=2)
    ]


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


def _flat(message: dict[str, Any], prefix: str = "") -> dict[str, Any]:
    """A message's fields by update-mask path (``cardinality.max``)."""
    flat: dict[str, Any] = {}
    for key, value in message.items():
        if isinstance(value, dict):
            flat.update(_flat(value, f"{prefix}{key}."))
        else:
            flat[f"{prefix}{key}"] = value
    return flat


class _Api:
    """The in-process API as one signed-in account; paths are resource names."""

    def __init__(self, http: httpx.AsyncClient, token: str) -> None:
        self._http = http
        self._headers = {"Authorization": f"Bearer {token}"}

    @classmethod
    async def sign_in(cls, http: httpx.AsyncClient, username: str, password: str) -> _Api:
        email = next(account.email for account in ACCOUNTS if account.username == username)
        response = await http.post(
            "/api/v1/sessions", json={"credential": {"password": {"email": email, "password": password}}}
        )
        _raise_for(response)
        return cls(http, response.json()["accessToken"])

    async def send(self, method: str, path: str, **kwargs: Any) -> httpx.Response:
        return await self._http.request(method, f"/api/v1/{path}", headers=self._headers, **kwargs)

    async def call(self, method: str, path: str, **kwargs: Any) -> dict[str, Any]:
        response = await self.send(method, path, **kwargs)
        _raise_for(response)
        return response.json() if response.content else {}

    async def find(self, path: str) -> dict[str, Any] | None:
        """GET ``path``; None when it does not exist."""
        response = await self.send("GET", path)
        if response.status_code == 404:
            return None
        _raise_for(response)
        return response.json()


def _raise_for(response: httpx.Response) -> None:
    if response.status_code >= 400:
        request = response.request
        raise RuntimeError(f"{request.method} {request.url.path} → {response.status_code}: {response.text[:2000]}")


def _schemes(parent: str) -> str:
    """The scheme collection under ``parent`` (``""``: the platform templates)."""
    return f"{parent}/conceptSchemes" if parent else "conceptSchemes"


async def _seed_scheme(api: _Api, parent: str, seed: SeedScheme, directory: Path) -> str:
    """Create ``seed`` under ``parent`` or restore its settings, then ImportConcepts
    and the groups from ``directory``."""
    schemes = _schemes(parent)
    scheme = f"{schemes}/{seed.code}"
    settings = seed.settings()
    current = await api.find(scheme)
    if current is None:
        purpose = "CLASSIFICATION" if seed.classification else "AUTHORITY"
        await api.call(
            "POST", schemes, params={"conceptSchemeId": seed.code}, json={"purpose": purpose, **settings}
        )
    else:
        held = _flat(current)
        changed = [path for path, value in _flat(settings).items() if held.get(path) != value]
        if changed:
            await api.call("PATCH", scheme, params={"updateMask": ",".join(changed)}, json=settings)
    result = await api.call(
        "POST", f"{scheme}:importConcepts", json={"rows": _concept_rows(directory / f"{seed.code}.csv")}
    )
    groups = directory / f"{seed.code}-groups.csv"
    if groups.exists():
        for code, body in _group_bodies(groups, scheme):
            held_group = await api.find(f"{scheme}/groups/{code}")
            if held_group is None:
                await api.call("POST", f"{scheme}/groups", params={"groupId": code}, json=body)
            elif any(held_group.get(key) != value for key, value in body.items()):
                await api.call(
                    "PATCH", f"{scheme}/groups/{code}", params={"updateMask": ",".join(body)}, json=body
                )
    return (
        f"{seed.code} (concepts created {len(result.get('created', []))}, "
        f"updated {len(result.get('updated', []))}, unchanged {result.get('unchangedCount', 0)})"
    )


async def _fork(api: _Api, parent: str, template: SeedScheme) -> str:
    """Fork the platform template, or take its non-conflicting changes since the
    fork's template version (conflicting ones keep the fork's own edits)."""
    schemes = _schemes(parent)
    scheme = f"{schemes}/{template.code}"
    current = await api.find(scheme)
    if current is None:
        await api.call(
            "POST",
            schemes,
            params={"conceptSchemeId": template.code},
            json={"template": f"{_schemes('')}/{template.code}"},
        )
        return f"{template.code} (forked)"
    diff = await api.call("GET", f"{scheme}:diffTemplate")
    keys = [change["key"] for change in diff.get("changes", []) if not change.get("conflict")]
    if not keys:
        return f"{template.code} (fork up to date)"
    await api.call("POST", f"{scheme}:applyTemplateChanges", json={"changes": keys, "etag": current.get("etag")})
    return f"{template.code} (took {len(keys)} template changes)"


async def _publish(api: _Api, parent: str, code: str) -> str:
    """Publish the scheme's working copy: ``code vN``, or ``code unchanged``."""
    response = await api.send("POST", f"{_schemes(parent)}/{code}:publish", json={})
    if response.status_code >= 400 and "NO_CHANGES" in response.text:
        return f"{code} unchanged"
    _raise_for(response)
    operation = response.json()
    if operation.get("error"):
        raise RuntimeError(f"Publishing {code} failed: {operation['error']}")
    return f"{code} v{operation['response']['name'].rsplit('/', 1)[-1]}"


async def _seed_rules(api: _Api, workspace: str, path: Path) -> tuple[int, int, int]:
    """``rules.csv`` as ConceptRules: (created, updated, unchanged)."""
    created = updated = unchanged = 0
    for code, body in _rule_bodies(path, workspace):
        rule = f"{workspace}/conceptRules/{code}"
        current = await api.find(rule)
        if current is None:
            await api.call("POST", f"{workspace}/conceptRules", params={"conceptRuleId": code}, json=body)
            created += 1
            continue
        held = (current.get("when", {}).get("concept"), current.get("then"), current.get("effect"))
        if (*held, current.get("weight")) == (body["when"]["concept"], body["then"], body["effect"], body["weight"]):
            unchanged += 1
            continue
        await api.call("PATCH", rule, params={"updateMask": "when,then,effect,weight"}, json=body)
        updated += 1
    return created, updated, unchanged


async def _seed_workspace(api: _Api, seeded: _Seeded, ws: SeedWorkspace) -> str:
    """A workspace's taxonomy (forks, own schemes, publish, rules), affiliations and folders."""
    workspace = f"workspaces/{seeded.workspaces[ws.code]}"
    fixtures = FIXTURES / ws.fixtures if ws.fixtures else None
    templates = TEMPLATE_SCHEMES if ws.template == "campus" else ()
    if ws.schemes and fixtures is None:
        raise SystemExit(f"{ws.code}: schemes need a fixtures directory.")
    parts: list[str] = []

    seeded_schemes = [await _fork(api, workspace, template) for template in templates]
    if fixtures is not None:
        seeded_schemes += [await _seed_scheme(api, workspace, scheme, fixtures) for scheme in ws.schemes]
    if seeded_schemes:
        parts.append("schemes " + "; ".join(seeded_schemes))
        ordered = sorted((*templates, *ws.schemes), key=lambda scheme: scheme.position)
        parts.append("published " + ", ".join([await _publish(api, workspace, s.code) for s in ordered]))

    rule_files = [TEMPLATE_FIXTURES / "rules.csv"] if templates else []
    if fixtures is not None and (fixtures / "rules.csv").exists():
        rule_files.append(fixtures / "rules.csv")
    if rule_files:
        counts = [await _seed_rules(api, workspace, path) for path in rule_files]
        created, updated, unchanged = (sum(column) for column in zip(*counts, strict=True))
        parts.append(f"rules (created {created}, updated {updated}, unchanged {unchanged})")

    rows = [
        {"email": account.email, "program": membership.affiliation[0], "cohort": membership.affiliation[1]}
        for account in ACCOUNTS
        for membership in account.memberships
        if membership.workspace == ws.code and membership.affiliation is not None
    ]
    if rows:
        result = await api.call("POST", f"{workspace}/members:importAffiliations", json={"rows": rows})
        parts.append(
            f"affiliations {len(result.get('members', []))} "
            f"(skipped {len(result.get('skippedMembers', []))} edited by an admin)"
        )

    shared = seeded.shared_collections.get(ws.code)
    if fixtures is not None and shared is not None and (fixtures / "collections.json").exists():
        folders = await api.call(
            "POST",
            f"{workspace}/items/{shared}:importCollections",
            json={"rows": _collection_rows(fixtures / "collections.json")},
        )
        name = ws.shared_collection.name if ws.shared_collection else ""
        parts.append(f"folders of '{name}' {_summary(folders)}")
    return f"{ws.code}: " + " · ".join(parts)


async def seed_structure(seeded: _Seeded, *, password: str) -> list[str]:
    """The platform templates, then each workspace's taxonomy, affiliations and folders."""
    lines: list[str] = []
    runtime = AppRuntime()
    try:
        transport = httpx.ASGITransport(app=create_app(runtime))
        async with httpx.AsyncClient(transport=transport, base_url="http://seed", timeout=None) as http:
            platform = await _Api.sign_in(http, TEMPLATE_CURATOR, password)
            templates = [await _seed_scheme(platform, "", scheme, TEMPLATE_FIXTURES) for scheme in TEMPLATE_SCHEMES]
            published = [await _publish(platform, "", scheme.code) for scheme in TEMPLATE_SCHEMES]
            lines.append(f"templates: {'; '.join(templates)} · published {', '.join(published)}")
            for ws in WORKSPACES:
                api = await _Api.sign_in(http, ws.curator, password)
                lines.append(await _seed_workspace(api, seeded, ws))
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
