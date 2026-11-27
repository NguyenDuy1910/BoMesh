"""SQL expressions of the Item fields lists, filters, orderings and facets read.

The API builds its AIP-160 filter and orderBy schemas from these, so a field
means the same thing in ListItems, SearchItems and the facets.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any
from uuid import UUID, uuid4

from sqlalchemy import ColumnElement, Text, and_, case, cast, func, select
from sqlalchemy.orm import aliased

from bomesh.db.models import (
    Concept,
    ConceptClosure,
    ConceptScheme,
    DocumentApplicability,
    DocumentProfile,
    ExternalResource,
    IngestionSource,
    Item,
    ItemClassification,
    ItemConcept,
    ItemIndexState,
    ItemRevision,
    SpaceMaterial,
)
from bomesh.iam.policy import PERSONAL_COLLECTION_TYPE
from bomesh.iam.visibility import below_document_reaching
from bomesh.services.knowledge_items.item_store import collections_below, in_subtree
from bomesh.services.taxonomy.ranking import labeled_with

#: ``document.contentState`` (derived: :attr:`Item.content_state`).
CONTENT_STATE: ColumnElement[Any] = func.upper(Item.content_state)
PUBLICATION_STATE: ColumnElement[Any] = case(
    (Item.is_published, "PUBLISHED"),
    (Item.is_published.is_(False), "UNPUBLISHED"),
)
ITEM_TYPE: ColumnElement[Any] = func.upper(Item.item_type)


def collection_kind(workspace_id: UUID) -> ColumnElement[Any]:
    """``document.collectionKind``: PERSONAL in a member's My files (their private scope),
    STANDARD in the workspace's shared collections; NULL for collections (a document field).

    The collections of the PERSONAL trees are few (the members' My files and their
    folders): a document is PERSONAL when its parent is one; only a document below
    another document climbs to its governing collection.
    """
    root = aliased(Item, name="personal_root")
    roots = select(root.id).where(
        root.tenant_id == workspace_id,
        root.item_kind == "collection",
        root.item_type == PERSONAL_COLLECTION_TYPE,
    )
    personal = select(collections_below(roots, live=False).c.id)
    return case(
        (Item.item_kind != "document", None),
        (Item.parent_item_id.in_(personal), "PERSONAL"),
        (
            below_document_reaching(
                Item, workspace_id, lambda node: node.c.id.in_(personal), live=False
            ),
            "PERSONAL",
        ),
        else_="STANDARD",
    )


#: ``document.owner`` as text, the form filters and facets compare.
OWNER_ID: ColumnElement[Any] = cast(Item.owner_user_id, Text)
#: ``document.origin.source``: the API ID (``ingestion_sources.code``) of the source
#: that registered the document (its ``external_resources`` row).
SOURCE_CODE: ColumnElement[Any] = (
    select(IngestionSource.code)
    .join(ExternalResource, ExternalResource.ingestion_source_id == IngestionSource.id)
    .where(ExternalResource.item_id == Item.id, Item.item_kind == "document")
    .order_by(ExternalResource.deleted_at.desc().nulls_first())
    .limit(1)
    .correlate(Item)
    .scalar_subquery()
)
LANGUAGE: ColumnElement[Any] = Item.language_code
#: ``document.summary``; a blank summary is unset (``NOT document.summary:*`` = without one).
SUMMARY: ColumnElement[Any] = func.nullif(func.btrim(Item.description), "")
VERIFICATION_STATE: ColumnElement[Any] = case(
    (Item.verified_at.is_(None), "UNVERIFIED"),
    (
        and_(Item.next_review_at.is_not(None), Item.next_review_at <= func.now()),
        "REVIEW_DUE",
    ),
    else_="VERIFIED",
)


_CURRENT_REVISION = aliased(ItemRevision)
#: When the current content was published: the current revision's time (always the
#: newest live one, a trigger keeps it so), else the item's (``recently published`` on Home).
PUBLISH_TIME: ColumnElement[Any] = func.coalesce(
    select(_CURRENT_REVISION.created_at)
    .where(_CURRENT_REVISION.id == Item.current_revision_id)
    .correlate(Item)
    .scalar_subquery(),
    Item.created_at,
)

#: ``document.mimeType``: the current revision's type (``items`` stores no content facts).
MIME_TYPE: ColumnElement[Any] = (
    select(_CURRENT_REVISION.mime_type)
    .where(_CURRENT_REVISION.id == Item.current_revision_id)
    .correlate(Item)
    .scalar_subquery()
)


def indexing_state(
    processing_version: str,
    status: ColumnElement[Any] | None = None,
    version: ColumnElement[Any] | None = None,
) -> ColumnElement[Any]:
    """``document.indexingState``; SUCCEEDED with another configuration is OUTDATED.

    ``status``/``version`` default to the Item's views of its index state; a caller
    reading ``item_index_states`` directly passes its columns (one row read, not one
    correlated subquery per reference)."""
    status = Item.index_status if status is None else status
    version = Item.processed_version if version is None else version
    return case(
        (status == "processing", "RUNNING"),
        (and_(status == "ready", version.is_distinct_from(processing_version)), "OUTDATED"),
        (status == "ready", "SUCCEEDED"),
        (status == "failed", "FAILED"),
        (status == "unsupported", "UNSUPPORTED"),
        else_="PENDING",
    )


def indexing_state_conditions(
    processing_version: str, item_id: ColumnElement[Any] = Item.id
) -> dict[str, ColumnElement[bool]]:
    """``document.indexingState = X`` per value, for the item ``item_id`` names: a
    probe of the set of documents in that state (``item_index_states`` by status,
    hashed once per statement), never the :func:`indexing_state` CASE, which reads
    the row once per branch and per row. A document without the row is PENDING."""

    def in_state(*conditions: ColumnElement[bool]) -> ColumnElement[bool]:
        return item_id.in_(select(ItemIndexState.item_id).where(*conditions))

    status = ItemIndexState.index_status
    version = ItemIndexState.processed_version
    return {
        "RUNNING": in_state(status == "processing"),
        "OUTDATED": in_state(status == "ready", version.is_distinct_from(processing_version)),
        "SUCCEEDED": in_state(status == "ready", version == processing_version),
        "FAILED": in_state(status == "failed"),
        "UNSUPPORTED": in_state(status == "unsupported"),
        "PENDING": ~in_state(status.in_(("processing", "ready", "failed", "unsupported"))),
    }


@dataclass(frozen=True, slots=True)
class SchemeValue:
    """A filter value naming a whole concept scheme (``…/conceptSchemes/{s}``):
    ``scheme_id`` is its ID or a scalar subquery resolving it."""

    scheme_id: Any


def scheme_id(workspace_id: UUID, code: str) -> Any:
    """The ID of the workspace's live scheme ``code`` (scalar subquery)."""
    return (
        select(ConceptScheme.id)
        .where(
            ConceptScheme.tenant_id == workspace_id,
            ConceptScheme.code == code,
            ConceptScheme.deleted_at.is_(None),
        )
        .scalar_subquery()
    )


def _labeled_in(value: Any, state: str) -> ColumnElement[bool]:
    if isinstance(value, SchemeValue):
        # A scheme: some whole-document label of that scheme in ``state``.
        return Item.id.in_(
            select(ItemConcept.item_id).where(
                ItemConcept.scheme_id == value.scheme_id,
                ItemConcept.state == state,
                ItemConcept.section_ref.is_(None),
            )
        )
    return labeled_with(value, state=state)


def has_concept(value: Any) -> ColumnElement[bool]:
    """``document.concepts:"…/conceptSchemes/{s}/concepts/{c}"``: an ACCEPTED label on the
    concept or any concept below it (``concept_closure``; poly-hierarchy and section
    labels included). ``value`` is its ID or a scalar subquery resolving it.

    ``document.concepts:"…/conceptSchemes/{s}"`` (a :class:`SchemeValue`): an ACCEPTED
    whole-document label of scheme ``s`` (``NOT`` = the scheme is not set)."""
    return _labeled_in(value, "accepted")


def has_suggested_concept(value: Any) -> ColumnElement[bool]:
    """``document.suggestedConcepts:"…"``: :func:`has_concept` over SUGGESTED labels
    (the assistant's, nobody confirmed or rejected them)."""
    return _labeled_in(value, "suggested")


def uncertain_in(value: SchemeValue) -> ColumnElement[bool]:
    """``document.uncertainSchemes:"…/conceptSchemes/{s}"``: the classifier was not sure
    enough to label the document in ``s`` (``item_classifications.outcome = uncertain``;
    Studio's unclassified pool)."""
    return Item.id.in_(
        select(ItemClassification.item_id).where(
            ItemClassification.scheme_id == value.scheme_id,
            ItemClassification.outcome == "uncertain",
        )
    )


#: ``document.uncertainSchemes:*``: uncertain in some scheme.
HAS_UNCERTAIN_SCHEMES: ColumnElement[bool] = Item.id.in_(
    select(ItemClassification.item_id).where(ItemClassification.outcome == "uncertain")
)


def _labeled(state: str) -> ColumnElement[bool]:
    return Item.id.in_(select(ItemConcept.item_id).where(ItemConcept.state == state))


#: ``document.concepts:*``: carries at least one accepted label.
HAS_CONCEPTS: ColumnElement[bool] = _labeled("accepted")
#: ``document.suggestedConcepts:*``: carries at least one suggested label.
HAS_SUGGESTED_CONCEPTS: ColumnElement[bool] = _labeled("suggested")

#: ``document.issuance.issuer``: the org-unit concept that issued the document.
ISSUER: ColumnElement[Any] = (
    select(DocumentProfile.issuer_concept_id)
    .where(DocumentProfile.item_id == Item.id)
    .correlate(Item)
    .scalar_subquery()
)


def applies_to(concept: Any) -> ColumnElement[bool]:
    """``document.applicability.units:`` / ``programs:``: the document applies to the
    concept or a concept below it (``concept_closure`` of its authority scheme)."""
    return Item.id.in_(
        select(DocumentApplicability.item_id)
        .join(ConceptClosure, ConceptClosure.descendant_id == DocumentApplicability.concept_id)
        .where(ConceptClosure.ancestor_id == concept)
    )


def applies_to_scheme(scheme: str) -> ColumnElement[bool]:
    """``document.applicability.units:*`` / ``programs:*``: applies to some concept of
    the authority scheme ``scheme``."""
    return Item.id.in_(
        select(DocumentApplicability.item_id)
        .join(Concept, Concept.id == DocumentApplicability.concept_id)
        .join(ConceptScheme, ConceptScheme.id == Concept.scheme_id)
        .where(ConceptScheme.code == scheme)
    )


def has_ancestor(item_id: UUID) -> ColumnElement[bool]:
    """``ancestors:"workspaces/w/items/{item}"``: the canonical subtree only, never links."""
    return in_subtree(Item, item_id)


def in_space(space_id: Any) -> ColumnElement[bool]:
    """``spaces:"workspaces/w/spaces/{space}"``: a live item the space pins as a material,
    or under a collection it pins (the space's collections, whole subtree).

    ``space_id`` is the space's ID or a scalar subquery resolving it. One recursive CTE
    seeded from ``space_materials (space_id, …)``, stepping by ``items.parent_item_id``.
    """
    material = aliased(Item, name="space_material")
    seed = select(material.id).where(
        material.id.in_(select(SpaceMaterial.item_id).where(SpaceMaterial.space_id == space_id)),
        material.deleted_at.is_(None),
    )
    tree = seed.cte(f"space_tree_{uuid4().hex[:8]}", recursive=True)
    child = aliased(Item, name="space_child")
    tree = tree.union_all(
        select(child.id).where(child.parent_item_id == tree.c.id, child.deleted_at.is_(None))
    )
    return Item.id.in_(select(tree.c.id))


__all__ = [
    "CONTENT_STATE",
    "HAS_CONCEPTS",
    "HAS_SUGGESTED_CONCEPTS",
    "HAS_UNCERTAIN_SCHEMES",
    "ISSUER",
    "ITEM_TYPE",
    "LANGUAGE",
    "OWNER_ID",
    "PUBLICATION_STATE",
    "PUBLISH_TIME",
    "SchemeValue",
    "SOURCE_CODE",
    "SUMMARY",
    "VERIFICATION_STATE",
    "applies_to",
    "applies_to_scheme",
    "collection_kind",
    "has_ancestor",
    "has_concept",
    "has_suggested_concept",
    "in_space",
    "indexing_state",
    "indexing_state_conditions",
    "scheme_id",
    "uncertain_in",
]
