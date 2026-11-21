"""Who may see and decide a contribution.

Visibility: the contributor, and holders of ``contributions.review`` on the
decision collection — ``targetCollection``; when empty, the assistant-suggested
collection; when that is empty too, the workspace (tenant-wide holders).
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from typing import Any
from uuid import UUID

from sqlalchemy import ColumnElement, Uuid, cast, false, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from bomesh.db.models import Contribution
from bomesh.db.models.knowledge import OPEN_CONTRIBUTION_STATES
from bomesh.iam.authorizer import Authorizer, ItemRef, Principal, Resource, WorkspaceRef

REVIEW = "contributions.review"


def decision_collection() -> ColumnElement[Any]:
    """SQL: the collection whose reviewers decide (target, else the suggested one)."""
    return func.coalesce(
        Contribution.target_item_id,
        cast(Contribution.suggestions["collection_id"].astext, Uuid),
    )


def suggested_collection(contribution: Contribution) -> UUID | None:
    value = (contribution.suggestions or {}).get("collection_id")
    return UUID(str(value)) if value else None


def deciding_collection(contribution: Contribution) -> UUID | None:
    """The collection whose reviewers decide: target, else suggested (``None``: workspace)."""
    return contribution.target_item_id or suggested_collection(contribution)


async def open_new_document_contributions(
    session: AsyncSession, workspace_id: UUID, item_ids: Sequence[UUID]
) -> dict[UUID, Contribution]:
    """The open NEW_DOCUMENT contribution of each candidate among ``item_ids``."""
    if not item_ids:
        return {}
    rows = await session.scalars(
        select(Contribution).where(
            Contribution.tenant_id == workspace_id,
            Contribution.item_id.in_(list(item_ids)),
            Contribution.kind == "new_document",
            Contribution.state.in_(OPEN_CONTRIBUTION_STATES),
            Contribution.deleted_at.is_(None),
        )
    )
    return {contribution.item_id: contribution for contribution in rows}


async def reviewer_clause(
    authorizer: Authorizer, principal: Principal, workspace_id: UUID
) -> ColumnElement[bool]:
    """SQL: contributions of the workspace the caller may review (any state)."""
    if REVIEW in await authorizer.workspace_permissions(principal, workspace_id):
        return Contribution.tenant_id == workspace_id
    collections = await authorizer.allowed_collections(principal, workspace_id, REVIEW)
    if not collections:
        return false()
    return decision_collection().in_(collections)


async def is_any_reviewer(authorizer: Authorizer, principal: Principal, workspace_id: UUID) -> bool:
    """Whether the caller reviews contributions anywhere in the workspace."""
    if REVIEW in await authorizer.workspace_permissions(principal, workspace_id):
        return True
    return bool(await authorizer.allowed_collections(principal, workspace_id, REVIEW))


async def readable_clause(
    authorizer: Authorizer, principal: Principal, workspace_id: UUID
) -> ColumnElement[bool]:
    """SQL: contributions the caller may read."""
    return or_(
        Contribution.contributor_user_id == principal.user_id,
        await reviewer_clause(authorizer, principal, workspace_id),
    )


async def is_reviewer(
    authorizer: Authorizer,
    principal: Principal,
    contribution: Contribution,
    *,
    include_deleted: bool = False,
) -> bool:
    """``include_deleted`` resolves grants through a deleted decision collection, so
    an approval can tell its deciders that the target is gone (TARGET_DELETED)."""
    if REVIEW in await authorizer.workspace_permissions(principal, contribution.tenant_id):
        return True
    collection_id = deciding_collection(contribution)
    return collection_id is not None and REVIEW in await authorizer.collection_permissions(
        principal, collection_id, include_deleted=include_deleted
    )


async def reviewers(
    authorizer: Authorizer, user_ids: Iterable[UUID], contribution: Contribution
) -> frozenset[UUID]:
    """The users among ``user_ids`` for whom :func:`is_reviewer` holds (fan-out)."""
    users = frozenset(user_ids)
    workspace = WorkspaceRef(contribution.tenant_id)
    collection_id = deciding_collection(contribution)
    refs: list[Resource] = [workspace]
    if collection_id is not None:
        refs.append(ItemRef(contribution.tenant_id, collection_id))
    held = await authorizer.holders_permissions(users, refs)
    return frozenset(
        user_id for user_id in users if any(REVIEW in held[ref][user_id] for ref in refs)
    )


__all__ = [
    "REVIEW",
    "deciding_collection",
    "decision_collection",
    "is_any_reviewer",
    "is_reviewer",
    "open_new_document_contributions",
    "readable_clause",
    "reviewer_clause",
    "reviewers",
    "suggested_collection",
]
