#!/usr/bin/env python3
"""Seed the HCMUTE role-matrix accounts: one account per predefined IAM role.

Idempotent utility (``auth_contract.md`` "Seeded role accounts"), not an API.
In one transaction it:

- syncs the IAM catalog (permissions and predefined roles);
- reuses or creates the HCMUTE workspace (code ``hcmute``, campus template),
  its restricted root collection *Kho bài giảng nội bộ* and the space
  *Khoa Công nghệ Thông tin*;
- creates or refreshes every account in ``SEED_ACCOUNTS``: name, status,
  password, platform role, workspace membership (with its PERSONAL collection)
  and the exact role bindings on the workspace, the collection and the space.

Every re-run restores the matrix: passwords are reset to the seed password,
extra roles on the seeded resources are removed and missing ones granted.
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from uuid import UUID

from dotenv import load_dotenv
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

load_dotenv(BACKEND_ROOT.parent / ".env", override=False)

from bomesh.db.engine import get_session_factory, transaction_scope  # noqa: E402
from bomesh.db.models import Item, Space, Tenant, TenantMembership, User  # noqa: E402
from bomesh.iam.authorizer import Authorizer, ItemRef, SpaceRef, WorkspaceRef  # noqa: E402
from bomesh.iam.policy import PolicyResource, PolicyStore, set_platform_role  # noqa: E402
from bomesh.iam.sync import sync_catalog  # noqa: E402
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
WORKSPACE_CODE = "hcmute"
WORKSPACE_NAME = "Trường Đại học Sư phạm Kỹ thuật TP. Hồ Chí Minh"
WORKSPACE_TEMPLATE = "campus"
STAFF = "hcmute.edu.vn"
STUDENT = "student.hcmute.edu.vn"
#: Restricted root collection: the internal lecture repository curated by the Library.
COLLECTION_TITLE = "Kho bài giảng nội bộ"
SPACE_CODE = "khoa-cntt"
SPACE_NAME = "Khoa Công nghệ Thông tin"
SPACE_DESCRIPTION = (
    "Thông báo, tài liệu môn học và yêu cầu gửi văn phòng Khoa Công nghệ Thông tin."
)

WORKSPACE_ADMIN = "roles/workspaceAdmin"
WORKSPACE_MEMBER = "roles/workspaceMember"


@dataclass(frozen=True, slots=True)
class SeedAccount:
    """One HCMUTE identity and the exact roles it holds in the seeded scopes.

    ``member`` puts the account in the HCMUTE workspace. Collection and space
    roles only take effect for active members, so those accounts are members
    with ``roles/workspaceMember`` as well. The username is the email's local
    part (staff ``longnh``, students their student ID).
    """

    email: str
    display_name: str
    position: str
    platform_role: str | None = None
    member: bool = True
    workspace_roles: tuple[str, ...] = (WORKSPACE_MEMBER,)
    collection_roles: tuple[str, ...] = ()
    space_roles: tuple[str, ...] = ()
    suspended: bool = False

    @property
    def username(self) -> str:
        return self.email.split("@", 1)[0]

    @property
    def grants(self) -> str:
        roles = [
            self.platform_role,
            *self.workspace_roles,
            *(f"{r} · {COLLECTION_TITLE}" for r in self.collection_roles),
            *(f"{r} · {SPACE_NAME}" for r in self.space_roles),
        ]
        text = ", ".join(r.removeprefix("roles/") for r in roles if r) or "no roles"
        if not self.member:
            text += ", not a member"
        return text + (", SUSPENDED" if self.suspended else "")


SEED_ACCOUNTS: tuple[SeedAccount, ...] = (
    # System administrator (Information Technology Center): platform console + workspace data.
    SeedAccount(
        f"admin@{STAFF}",
        "Quản trị hệ thống",
        "Trung tâm Thông tin – Máy tính",
        platform_role="roles/platformAdmin",
        workspace_roles=(WORKSPACE_ADMIN,),
    ),
    # Platform roles: platform metadata, never workspace content.
    SeedAccount(
        f"longnh@{STAFF}",
        "Nguyễn Hoàng Long",
        "Trung tâm Thông tin – Máy tính · Kỹ sư quản trị nền tảng",
        platform_role="roles/platformAdmin",
        member=False,
        workspace_roles=(),
    ),
    SeedAccount(
        f"quantm@{STAFF}",
        "Trần Minh Quân",
        "Trung tâm Thông tin – Máy tính · Kỹ sư vận hành",
        platform_role="roles/platformOperator",
        member=False,
        workspace_roles=(),
    ),
    # Workspace roles.
    SeedAccount(
        f"hapt@{STAFF}",
        "Phạm Thu Hà",
        "Thư viện · Quản trị tri thức",
        workspace_roles=(WORKSPACE_ADMIN,),
    ),
    SeedAccount(
        f"22110345@{STUDENT}",
        "Võ Minh Khang",
        "Sinh viên Khoa Công nghệ Thông tin · K22",
    ),
    # Collection roles on the internal lecture repository.
    SeedAccount(
        f"maint@{STAFF}",
        "Nguyễn Thị Mai",
        "Thư viện · Phụ trách thư viện số",
        collection_roles=("roles/collectionOwner",),
    ),
    SeedAccount(
        f"baohq@{STAFF}",
        "Huỳnh Quốc Bảo",
        "Giảng viên Khoa Công nghệ Thông tin",
        collection_roles=("roles/collectionEditor",),
    ),
    SeedAccount(
        f"anhln@{STAFF}",
        "Lâm Ngọc Anh",
        "Giảng viên Khoa Kinh tế",
        collection_roles=("roles/collectionViewer",),
    ),
    # Space roles in the Faculty of Information Technology.
    SeedAccount(
        f"sonpt@{STAFF}",
        "Phan Thanh Sơn",
        "Trưởng Khoa Công nghệ Thông tin",
        space_roles=("roles/spaceLead",),
    ),
    SeedAccount(
        f"lannt@{STAFF}",
        "Ngô Thị Lan",
        "Giáo vụ Khoa Công nghệ Thông tin",
        space_roles=("roles/spaceStaff",),
    ),
    SeedAccount(
        f"22110289@{STUDENT}",
        "Đặng Gia Huy",
        "Sinh viên Khoa Công nghệ Thông tin · K22",
        space_roles=("roles/spaceMember",),
    ),
    # Negative cases.
    SeedAccount(
        f"18110123@{STUDENT}",
        "Bùi Anh Tuấn",
        "Cựu sinh viên · tài khoản chưa được cấp quyền",
        member=False,
        workspace_roles=(),
    ),
    SeedAccount(
        f"21110567@{STUDENT}",
        "Trịnh Văn Phúc",
        "Sinh viên · tài khoản bị tạm khóa",
        suspended=True,
    ),
)


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Seed the HCMUTE role-matrix accounts.")
    parser.add_argument(
        "--password",
        default=DEFAULT_PASSWORD,
        help="Password of every seeded account (default: %(default)s).",
    )
    return parser.parse_args()


# -- Scopes ------------------------------------------------------------------------


async def _workspace(session: AsyncSession, identity: IdentityStoreService) -> Tenant:
    """The active HCMUTE workspace (campus template), created when missing."""
    tenant = await session.scalar(select(Tenant).where(Tenant.code == WORKSPACE_CODE))
    if tenant is None:
        tenant = await identity.create_tenant(WORKSPACE_CODE, WORKSPACE_NAME)
    tenant.tenant_name = WORKSPACE_NAME
    tenant.template = WORKSPACE_TEMPLATE
    tenant.status = ACTIVE_STATUS
    await session.flush()
    return tenant


async def _collection(session: AsyncSession, workspace_id: UUID, creator_id: UUID) -> Item:
    """The live root lecture repository: an access boundary with no workspaceMembers grant."""
    item = await session.scalar(
        select(Item).where(
            Item.tenant_id == workspace_id,
            Item.item_kind == "collection",
            Item.parent_item_id.is_(None),
            Item.item_name == COLLECTION_TITLE,
            Item.deleted_at.is_(None),
        )
    )
    if item is not None:
        return item
    return await ItemService(session).create_collection(
        workspace_id=workspace_id,
        item_name=COLLECTION_TITLE,
        created_by_user_id=creator_id,
    )


async def _space(session: AsyncSession, workspace_id: UUID, creator_id: UUID) -> Space:
    space = await find_space(session, workspace_id, SPACE_CODE)
    if space is None:
        space = Space(
            tenant_id=workspace_id,
            code=SPACE_CODE,
            space_name=SPACE_NAME,
            space_type="",
            join_policy="invite",
            created_by_user_id=creator_id,
        )
        session.add(space)
    space.space_name = SPACE_NAME
    space.description = SPACE_DESCRIPTION
    space.deleted_at = None
    await session.flush()
    return space


# -- Accounts ----------------------------------------------------------------------


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


async def seed_accounts(*, password: str) -> list[str]:
    """Create or restore the role matrix in one transaction; returns the summary lines."""
    password_hash = PasswordCredentialService.hash(password)
    factory = get_session_factory()
    async with transaction_scope(factory) as session:
        identity = IdentityStoreService(session)
        policies = PolicyStore(session, Authorizer(factory))
        await sync_catalog(session)
        workspace = await _workspace(session, identity)

        users: dict[str, tuple[User, bool]] = {}
        for account in SEED_ACCOUNTS:
            user, created = await _user(session, identity, account, password_hash)
            users[account.username] = (user, created)
            await set_platform_role(session, user.id, account.platform_role)
            await _membership(session, identity, user.id, workspace.id, member=account.member)

        # The Library's knowledge administrator creates the shared resources.
        creator = users["hapt"][0].id
        collection = await _collection(session, workspace.id, creator)
        space = await _space(session, workspace.id, creator)
        scopes: tuple[tuple[PolicyResource, Callable[[SeedAccount], tuple[str, ...]]], ...] = (
            (WorkspaceRef(workspace.id), lambda a: a.workspace_roles),
            (ItemRef(workspace.id, collection.id), lambda a: a.collection_roles),
            (SpaceRef(workspace.id, space.id), lambda a: a.space_roles),
        )

        lines: list[str] = []
        for account in SEED_ACCOUNTS:
            user, created = users[account.username]
            if account.member:
                for resource, roles_of in scopes:
                    await _exact_roles(
                        policies,
                        resource,
                        f"user:{user.id}",
                        roles_of(account),
                        created_by=creator,
                    )
            if account.suspended:
                await identity.set_user_status(user.id, SUSPENDED_STATUS)
            state = "created" if created else "refreshed"
            lines.append(
                f"{account.username:<10} {account.email:<34} {state:<9} "
                f"{account.display_name} — {account.position} [{account.grants}]"
            )
        lines.append(
            f"Workspace '{WORKSPACE_NAME}' ({workspace.code}) · collection '{COLLECTION_TITLE}' "
            f"· space '{SPACE_NAME}' ({SPACE_CODE})"
        )
    return lines


async def _main() -> None:
    args = _parse_args()
    lines = await seed_accounts(password=args.password)
    print(f"Seeded {len(SEED_ACCOUNTS)} accounts; password: {args.password}")
    for line in lines:
        print(line)


if __name__ == "__main__":
    asyncio.run(_main())
