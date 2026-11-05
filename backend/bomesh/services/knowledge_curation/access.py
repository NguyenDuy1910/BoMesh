"""Who may see and decide a contribution.

Visibility: the contributor, and holders of ``contributions.review`` on the
decision collection — ``targetCollection``; when empty, the assistant-suggested
collection; when that is empty too, the workspace (tenant-wide holders).
"""

from __future__ import annotations

from typing import Any
from uuid import UUID

from sqlalchemy import ColumnElement, Uuid, cast, false, func, or_

from bomesh.db.models import Contribution
from bomesh.iam.authorizer import Authorizer, Principal

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
    collection_id = contribution.target_item_id or suggested_collection(contribution)
    return collection_id is not None and REVIEW in await authorizer.collection_permissions(
        principal, collection_id, include_deleted=include_deleted
    )


__all__ = [
    "REVIEW",
    "decision_collection",
    "is_any_reviewer",
    "is_reviewer",
    "readable_clause",
    "reviewer_clause",
    "suggested_collection",
]
