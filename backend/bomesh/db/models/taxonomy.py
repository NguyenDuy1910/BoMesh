"""The faceted (SKOS) taxonomy: concept schemes, concepts and their published versions.

A scheme with ``tenant_id`` NULL is a platform template; a workspace forks it.
Assignments and document metadata live in :mod:`bomesh.db.models.knowledge`.
Cross-row rules (same tenant, notation immutability, cycles, colors) are
triggers in :mod:`bomesh.db.models.triggers` (``item_model.md`` §4.13).
"""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import Any
from uuid import UUID

from sqlalchemy import (
    CheckConstraint,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    SmallInteger,
    String,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.orm import Mapped, mapped_column

from bomesh.db.models.base import (
    Base,
    CreatedAtMixin,
    JsonObject,
    TimestampMixin,
    UUIDPrimaryKeyMixin,
    choice,
    created_now,
    flag,
    json_array,
    json_object,
    one_of,
    text_array,
    timestamp,
    uuid_fk,
)

#: API ID pattern of scheme, concept (notation), group and rule codes.
CODE_PATTERN = "^[a-z][a-z0-9-]{0,62}$"
SCHEME_PURPOSES = ("classification", "authority")
LLM_POLICIES = ("always", "fallback", "never")
CONCEPT_STATES = ("draft", "published", "deprecated")
LABEL_KINDS = ("pref", "alt", "hidden")
RELATION_KINDS = ("broader", "related")
MAPPING_MATCH_TYPES = ("exact", "close", "broad", "narrow")
RULE_EFFECTS = ("implies", "prior")
PROPOSAL_KINDS = ("new_concept", "label")
PROPOSAL_ORIGINS = ("cluster", "correction", "member")
PROPOSAL_STATES = ("open", "accepted", "rejected")


def _concept_fk(*, nullable: bool = False, primary_key: bool = False) -> Any:
    """A reference to ``concepts.id`` removed with the concept (child rows of a concept)."""

    return mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("concepts.id", ondelete="CASCADE"),
        nullable=nullable,
        primary_key=primary_key,
    )


def _small(default: int | None = None, *, nullable: bool = False) -> Any:
    if default is None:
        return mapped_column(SmallInteger, nullable=nullable)
    return mapped_column(
        SmallInteger, nullable=nullable, default=default, server_default=str(default)
    )


class ConceptScheme(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """One axis of the taxonomy (skos:ConceptScheme) with its assignment settings."""

    __tablename__ = "concept_schemes"
    __table_args__ = (
        # NULLS NOT DISTINCT: one template per code too.
        Index(
            "uq_concept_schemes_tenant_id_code",
            "tenant_id",
            "code",
            unique=True,
            postgresql_nulls_not_distinct=True,
        ),
        Index(None, "template_scheme_id"),
        CheckConstraint(f"code ~ '{CODE_PATTERN}'", name="scheme_code_is_valid"),
        CheckConstraint(one_of("purpose", SCHEME_PURPOSES), name="scheme_purpose_is_valid"),
        CheckConstraint(one_of("llm_policy", LLM_POLICIES), name="scheme_llm_policy_is_valid"),
        CheckConstraint(
            "min_labels >= 0 AND (max_labels IS NULL OR max_labels >= GREATEST(min_labels, 1))",
            name="scheme_label_bounds_are_valid",
        ),
        CheckConstraint("max_depth >= 1", name="scheme_max_depth_is_valid"),
        CheckConstraint(
            "(review_threshold IS NULL OR review_threshold >= 0)"
            " AND (auto_threshold IS NULL OR auto_threshold <= 1)"
            " AND (review_threshold IS NULL OR auto_threshold IS NULL"
            " OR review_threshold <= auto_threshold)",
            name="scheme_thresholds_are_ordered",
        ),
        CheckConstraint(
            "purpose = 'classification' OR (llm_policy = 'never'"
            " AND auto_threshold IS NULL AND review_threshold IS NULL)",
            name="authority_scheme_is_never_classified",
        ),
        CheckConstraint(
            "template_scheme_id IS NULL OR template_scheme_id <> id",
            name="scheme_is_not_its_own_template",
        ),
    )

    #: NULL = platform template.
    tenant_id: Mapped[UUID | None] = uuid_fk("tenants.id")
    code: Mapped[str] = mapped_column(String(64), nullable=False)
    scheme_name: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    purpose: Mapped[str] = mapped_column(String(16), nullable=False)
    #: Tab order; the lowest classification scheme feeds Home.
    position: Mapped[int] = _small(0)
    min_labels: Mapped[int] = _small(0)
    #: NULL = unbounded.
    max_labels: Mapped[int | None] = _small(nullable=True)
    has_primary: Mapped[bool] = flag(False)
    max_depth: Mapped[int] = _small(1)
    #: false: top concepts are never a target; documents roll up via closure.
    assign_top_concepts: Mapped[bool] = flag(True)
    section_assignments: Mapped[bool] = flag(False)
    llm_policy: Mapped[str] = choice("never")
    auto_threshold: Mapped[Decimal | None] = mapped_column(Numeric(4, 3))
    review_threshold: Mapped[Decimal | None] = mapped_column(Numeric(4, 3))
    template_scheme_id: Mapped[UUID | None] = uuid_fk("concept_schemes.id")
    template_version: Mapped[int | None] = mapped_column(Integer)
    #: NULL = never published.
    published_version: Mapped[int | None] = mapped_column(Integer)
    deleted_at: Mapped[datetime | None] = timestamp()


class Concept(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """One skos:Concept; ``notation`` is its immutable, never reused API ID."""

    __tablename__ = "concepts"
    __table_args__ = (
        # Over every row, deprecated and deleted included: a notation is never reused.
        UniqueConstraint("scheme_id", "notation"),
        Index(None, "scheme_id", "state"),
        Index(None, "tenant_id"),
        Index(None, "template_concept_id"),
        CheckConstraint(f"notation ~ '{CODE_PATTERN}'", name="concept_notation_is_valid"),
        CheckConstraint(one_of("state", CONCEPT_STATES), name="concept_state_is_valid"),
        CheckConstraint("color ~ '^#[0-9a-f]{6}$'", name="concept_color_is_valid"),
        CheckConstraint("cardinality(examples) <= 5", name="concept_examples_are_bounded"),
        CheckConstraint(
            "cardinality(match_patterns) <= 20", name="concept_match_patterns_are_bounded"
        ),
        CheckConstraint(
            "deleted_at IS NULL OR (state = 'draft' AND first_version IS NULL)",
            name="only_unpublished_draft_is_deleted",
        ),
        CheckConstraint(
            # Set on a published concept by DeprecateConcept (pending until that
            # version is published, which flips state to deprecated).
            "deprecated_version IS NULL OR state <> 'draft'",
            name="deprecated_version_is_not_draft",
        ),
        CheckConstraint(
            "template_concept_id IS NULL OR template_concept_id <> id",
            name="concept_is_not_its_own_template",
        ),
    )

    #: The scheme's tenant (NULL in a template).
    tenant_id: Mapped[UUID | None] = uuid_fk("tenants.id")
    scheme_id: Mapped[UUID] = uuid_fk("concept_schemes.id", nullable=False)
    notation: Mapped[str] = mapped_column(String(64), nullable=False)
    definition: Mapped[str | None] = mapped_column(Text)
    scope_note: Mapped[str | None] = mapped_column(Text)
    examples: Mapped[list[str]] = text_array()
    #: Top concepts only; narrower concepts inherit it.
    color: Mapped[str | None] = mapped_column(String(7))
    icon: Mapped[str | None] = mapped_column(String(64))
    match_patterns: Mapped[list[str]] = text_array()
    time_sensitive: Mapped[bool] = flag(False)
    state: Mapped[str] = choice("draft")
    first_version: Mapped[int | None] = mapped_column(Integer)
    deprecated_version: Mapped[int | None] = mapped_column(Integer)
    template_concept_id: Mapped[UUID | None] = uuid_fk("concepts.id")
    created_by_user_id: Mapped[UUID | None] = uuid_fk("users.id")
    #: Only a never-published draft; the notation stays reserved.
    deleted_at: Mapped[datetime | None] = timestamp()


class ConceptReplacement(Base):
    """dct:isReplacedBy of a deprecated concept (same scheme)."""

    __tablename__ = "concept_replacements"
    __table_args__ = (
        Index(None, "replacement_concept_id"),
        CheckConstraint(
            "concept_id <> replacement_concept_id", name="concept_does_not_replace_itself"
        ),
    )

    concept_id: Mapped[UUID] = _concept_fk(primary_key=True)
    replacement_concept_id: Mapped[UUID] = _concept_fk(primary_key=True)


class ConceptLabel(UUIDPrimaryKeyMixin, Base):
    """One pref/alt/hidden label; ``normalized`` is ``normalize_label(label_text)``."""

    __tablename__ = "concept_labels"
    __table_args__ = (
        # pref/alt/hidden are disjoint within a concept and language (SKOS S13).
        UniqueConstraint("concept_id", "language_code", "normalized"),
        # At most one prefLabel per language (SKOS S14).
        Index(
            "uq_concept_labels_pref",
            "concept_id",
            "language_code",
            unique=True,
            postgresql_where=text("kind = 'pref'"),
        ),
        Index(None, "normalized"),
        CheckConstraint(one_of("kind", LABEL_KINDS), name="label_kind_is_valid"),
        CheckConstraint("normalized <> ''", name="label_normalized_is_not_empty"),
    )

    concept_id: Mapped[UUID] = _concept_fk()
    kind: Mapped[str] = mapped_column(String(8), nullable=False)
    language_code: Mapped[str] = mapped_column(String(16), nullable=False)
    label_text: Mapped[str] = mapped_column(String(255), nullable=False)
    normalized: Mapped[str] = mapped_column(Text, nullable=False)


class ConceptRelation(Base):
    """skos:broader (poly-hierarchy: several rows) or skos:related (stored once, source < target)."""

    __tablename__ = "concept_relations"
    __table_args__ = (
        Index(None, "target_concept_id", "kind"),
        CheckConstraint(one_of("kind", RELATION_KINDS), name="relation_kind_is_valid"),
        CheckConstraint(
            "source_concept_id <> target_concept_id", name="relation_is_not_reflexive"
        ),
        CheckConstraint(
            "kind <> 'related' OR source_concept_id < target_concept_id",
            name="related_is_stored_once",
        ),
    )

    source_concept_id: Mapped[UUID] = _concept_fk(primary_key=True)
    target_concept_id: Mapped[UUID] = _concept_fk(primary_key=True)
    kind: Mapped[str] = mapped_column(String(8), primary_key=True)


class ConceptClosure(Base):
    """Ancestor/descendant pairs of the PUBLISHED broader graph, rebuilt per scheme on publish."""

    __tablename__ = "concept_closure"
    __table_args__ = (
        Index(None, "descendant_id"),
        CheckConstraint(
            "depth >= 0 AND (depth = 0) = (ancestor_id = descendant_id)",
            name="closure_depth_is_valid",
        ),
    )

    ancestor_id: Mapped[UUID] = _concept_fk(primary_key=True)
    descendant_id: Mapped[UUID] = _concept_fk(primary_key=True)
    #: Shortest path; 0 = self.
    depth: Mapped[int] = mapped_column(SmallInteger, nullable=False)


class ConceptGroup(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """skos:Collection: display grouping and query expansion, never a target."""

    __tablename__ = "concept_groups"
    __table_args__ = (
        UniqueConstraint("scheme_id", "code"),
        CheckConstraint(f"code ~ '{CODE_PATTERN}'", name="group_code_is_valid"),
    )

    scheme_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("concept_schemes.id", ondelete="CASCADE"),
        nullable=False,
    )
    code: Mapped[str] = mapped_column(String(64), nullable=False)
    group_name: Mapped[str] = mapped_column(String(255), nullable=False)
    position: Mapped[int] = _small(0)
    #: Members are interchangeable in queries.
    query_expansion: Mapped[bool] = flag(False)


class ConceptGroupMember(Base):
    __tablename__ = "concept_group_members"
    __table_args__ = (Index(None, "concept_id"),)

    group_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("concept_groups.id", ondelete="CASCADE"),
        primary_key=True,
    )
    concept_id: Mapped[UUID] = _concept_fk(primary_key=True)
    position: Mapped[int] = _small(0)


class ConceptMapping(Base):
    """A SKOS mapping to an external code system (MOET program codes, ISCED-F …)."""

    __tablename__ = "concept_mappings"
    __table_args__ = (
        CheckConstraint(
            one_of("match_type", MAPPING_MATCH_TYPES), name="mapping_match_type_is_valid"
        ),
    )

    concept_id: Mapped[UUID] = _concept_fk(primary_key=True)
    target_system: Mapped[str] = mapped_column(String(32), primary_key=True)
    target_code: Mapped[str] = mapped_column(String(64), primary_key=True)
    target_label: Mapped[str | None] = mapped_column(Text)
    match_type: Mapped[str] = mapped_column(String(8), nullable=False)


class ConceptRule(UUIDPrimaryKeyMixin, CreatedAtMixin, Base):
    """When a concept, collection or source holds, imply or favor a classification concept."""

    __tablename__ = "concept_rules"
    __table_args__ = (
        Index(
            "uq_concept_rules_live_code",
            "tenant_id",
            "code",
            unique=True,
            postgresql_where=text("deleted_at IS NULL"),
        ),
        Index(None, "when_concept_id"),
        Index(None, "when_collection_item_id"),
        Index(None, "when_ingestion_source_id"),
        Index(None, "then_concept_id"),
        CheckConstraint(f"code ~ '{CODE_PATTERN}'", name="rule_code_is_valid"),
        CheckConstraint(one_of("effect", RULE_EFFECTS), name="rule_effect_is_valid"),
        CheckConstraint(
            "num_nonnulls(when_concept_id, when_collection_item_id, when_ingestion_source_id) = 1",
            name="rule_has_one_condition",
        ),
        CheckConstraint(
            "weight IS NULL OR (effect = 'prior' AND weight >= 0 AND weight <= 1)",
            name="rule_weight_is_prior_only",
        ),
        CheckConstraint(
            "when_concept_id IS NULL OR when_concept_id <> then_concept_id",
            name="rule_does_not_imply_itself",
        ),
    )

    tenant_id: Mapped[UUID] = uuid_fk("tenants.id", nullable=False)
    code: Mapped[str] = mapped_column(String(64), nullable=False)
    when_concept_id: Mapped[UUID | None] = uuid_fk("concepts.id")
    when_collection_item_id: Mapped[UUID | None] = uuid_fk("items.id")
    when_ingestion_source_id: Mapped[UUID | None] = uuid_fk("ingestion_sources.id")
    then_concept_id: Mapped[UUID] = uuid_fk("concepts.id", nullable=False)
    effect: Mapped[str] = mapped_column(String(8), nullable=False)
    weight: Mapped[Decimal | None] = mapped_column(Numeric(4, 3))
    created_by_user_id: Mapped[UUID | None] = uuid_fk("users.id")
    deleted_at: Mapped[datetime | None] = timestamp()


class ConceptSchemeVersion(Base):
    """One published version: the immutable snapshot classification and queries read."""

    __tablename__ = "concept_scheme_versions"
    __table_args__ = (
        CheckConstraint("version >= 1", name="scheme_version_is_positive"),
        CheckConstraint("jsonb_typeof(snapshot) = 'object'", name="snapshot_is_object"),
        CheckConstraint("jsonb_typeof(changes) = 'array'", name="changes_is_array"),
        CheckConstraint("jsonb_typeof(warnings) = 'array'", name="warnings_is_array"),
    )

    scheme_id: Mapped[UUID] = uuid_fk("concept_schemes.id", primary_key=True)
    version: Mapped[int] = mapped_column(Integer, primary_key=True)
    published_by_user_id: Mapped[UUID] = uuid_fk("users.id", nullable=False)
    published_at: Mapped[datetime] = created_now()
    #: ``bomesh.services.taxonomy.snapshot.snapshot_json`` of the scheme.
    snapshot: Mapped[JsonObject] = json_object()
    changes: Mapped[list[Any]] = json_array()
    warnings: Mapped[list[Any]] = json_array()
    reclassification: Mapped[JsonObject | None] = mapped_column(JSONB(none_as_null=True))


class ConceptProposal(UUIDPrimaryKeyMixin, CreatedAtMixin, Base):
    """A proposed new concept or label, with the documents that motivated it."""

    __tablename__ = "concept_proposals"
    __table_args__ = (
        Index(None, "tenant_id", "state", "created_at"),
        Index(None, "scheme_id", "state"),
        CheckConstraint(one_of("kind", PROPOSAL_KINDS), name="proposal_kind_is_valid"),
        CheckConstraint(one_of("origin", PROPOSAL_ORIGINS), name="proposal_origin_is_valid"),
        CheckConstraint(one_of("state", PROPOSAL_STATES), name="proposal_state_is_valid"),
        CheckConstraint(
            "(kind = 'label') = (target_concept_id IS NOT NULL)"
            " AND (kind = 'new_concept' OR broader_concept_id IS NULL)",
            name="proposal_kind_matches_target",
        ),
        CheckConstraint(
            "(state = 'open') = (decided_at IS NULL)", name="proposal_decision_is_recorded"
        ),
    )

    tenant_id: Mapped[UUID] = uuid_fk("tenants.id", nullable=False)
    scheme_id: Mapped[UUID] = uuid_fk("concept_schemes.id", nullable=False)
    kind: Mapped[str] = mapped_column(String(16), nullable=False)
    #: The concept name (new_concept) or the label text (label).
    proposal_name: Mapped[str] = mapped_column(String(255), nullable=False)
    definition: Mapped[str | None] = mapped_column(Text)
    broader_concept_id: Mapped[UUID | None] = uuid_fk("concepts.id")
    target_concept_id: Mapped[UUID | None] = uuid_fk("concepts.id")
    origin: Mapped[str] = mapped_column(String(16), nullable=False)
    state: Mapped[str] = choice("open")
    #: The draft concept that accepting created.
    concept_id: Mapped[UUID | None] = uuid_fk("concepts.id")
    decided_by_user_id: Mapped[UUID | None] = uuid_fk("users.id")
    decided_at: Mapped[datetime | None] = timestamp()


class ConceptProposalItem(Base):
    __tablename__ = "concept_proposal_items"
    __table_args__ = (Index(None, "item_id"),)

    proposal_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("concept_proposals.id", ondelete="CASCADE"),
        primary_key=True,
    )
    item_id: Mapped[UUID] = uuid_fk("items.id", primary_key=True)
