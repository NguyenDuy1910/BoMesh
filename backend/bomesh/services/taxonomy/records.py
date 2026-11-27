"""Records the taxonomy services return; every reference is already a resource name."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any
from uuid import UUID

from bomesh.db.models import Operation

#: (language_code, text)
LabelValue = tuple[str, str]
#: (system, code, label, match) — match lowercase (``exact`` …).
MappingValue = tuple[str, str, str | None, str]


@dataclass(frozen=True, slots=True)
class SchemeRecord:
    name: str
    display_name: str
    description: str | None
    purpose: str
    position: int
    min_labels: int
    max_labels: int | None
    has_primary: bool
    max_depth: int
    assign_top_concepts: bool
    section_assignments: bool
    llm_policy: str
    auto_threshold: float | None
    review_threshold: float | None
    template: str | None
    template_version: int | None
    published_version: int | None
    unpublished_changes: int
    create_time: datetime
    update_time: datetime
    etag: str


@dataclass(frozen=True, slots=True)
class SchemeDraft:
    """CreateConceptScheme input; ``template`` is a template code (fork)."""

    code: str | None
    display_name: str | None = None
    description: str | None = None
    purpose: str | None = None
    template: str | None = None
    #: Settings by API path (``position``, ``cardinality.min`` …), as UpdateConceptScheme.
    settings: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class ConceptRecord:
    name: str
    display_name: str
    pref_labels: tuple[LabelValue, ...]
    alt_labels: tuple[LabelValue, ...]
    hidden_labels: tuple[LabelValue, ...]
    definition: str | None
    scope_note: str | None
    examples: tuple[str, ...]
    broader: tuple[str, ...]
    related: tuple[str, ...]
    mappings: tuple[MappingValue, ...]
    match_patterns: tuple[str, ...]
    time_sensitive: bool
    color: str | None
    icon: str | None
    state: str
    deprecation_pending: bool
    replaced_by: tuple[str, ...]
    groups: tuple[str, ...]
    template_concept: str | None
    first_version: int | None
    deprecated_version: int | None
    document_count: int | None
    in_review_count: int | None
    create_time: datetime
    update_time: datetime
    delete_time: datetime | None
    etag: str


@dataclass(frozen=True, slots=True)
class GroupRecord:
    name: str
    display_name: str
    position: int
    members: tuple[str, ...]
    query_expansion: bool
    create_time: datetime
    update_time: datetime
    etag: str


@dataclass(frozen=True, slots=True)
class ChangeEntry:
    kind: str
    concept: str | None = None
    group: str | None = None
    replaced_by: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class WarningEntry:
    kind: str
    concepts: tuple[str, ...]
    label: str | None
    message: str


@dataclass(frozen=True, slots=True)
class ViolationEntry:
    invariant: str
    concepts: tuple[str, ...]
    message: str


@dataclass(frozen=True, slots=True)
class RerankEntry:
    concept: str
    among: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class ReclassificationRecord:
    remapped_count: int
    rerank: tuple[RerankEntry, ...]
    rerun_parents: tuple[RerankEntry, ...]
    #: Concepts whose ``matchPatterns`` changed: pattern labels re-evaluated, no model.
    patterns_changed: tuple[str, ...]
    thresholds_changed: bool
    state: str
    runs: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class VersionRecord:
    name: str
    version: int
    publish_time: datetime | None
    publisher: str | None
    concept_count: int
    changes: tuple[ChangeEntry, ...]
    warnings: tuple[WarningEntry, ...]
    violations: tuple[ViolationEntry, ...]
    reclassification: ReclassificationRecord | None


@dataclass(frozen=True, slots=True)
class PublishResult:
    """The operation (stored, or transient for ``validateOnly``) and the version it produced."""

    operation: Operation
    version: VersionRecord


@dataclass(frozen=True, slots=True)
class RuleRecord:
    name: str
    when_concept: str | None
    when_collection: str | None
    when_source: str | None
    then: str
    effect: str
    weight: float | None
    creator: str | None
    create_time: datetime
    etag: str


@dataclass(frozen=True, slots=True)
class RuleDraft:
    """A rule's fields: concepts by resource name, the collection by ID, the source by code."""

    when_concept: str | None = None
    when_collection_id: UUID | None = None
    when_source_code: str | None = None
    then: str | None = None
    effect: str | None = None
    weight: float | None = None


@dataclass(frozen=True, slots=True)
class ProposalRecord:
    name: str
    scheme: str
    kind: str
    display_name: str
    definition: str | None
    suggested_broader: str | None
    target_concept: str | None
    origin: str
    state: str
    concept: str | None
    evidence: tuple[str, ...]
    decider: str | None
    decide_time: datetime | None
    create_time: datetime


@dataclass(frozen=True, slots=True)
class SharedLabelEntry:
    concept: str
    scheme: str
    kind: str
    language_code: str
    text: str


@dataclass(frozen=True, slots=True)
class SharedLabelRecord:
    label: str
    cross_scheme: bool
    concepts: tuple[SharedLabelEntry, ...]


@dataclass(frozen=True, slots=True)
class TemplateChangeRecord:
    key: str
    kind: str
    concept: str | None
    field: str | None
    base_value: Any
    template_value: Any
    current_value: Any
    replaced_by: tuple[str, ...]
    conflict: bool


@dataclass(frozen=True, slots=True)
class TemplateDiff:
    template: str
    from_version: int | None
    to_version: int
    changes: tuple[TemplateChangeRecord, ...]


@dataclass(frozen=True, slots=True)
class ImportResult:
    created: tuple[str, ...]
    updated: tuple[str, ...]
    unchanged_count: int


@dataclass(frozen=True, slots=True)
class ExportResult:
    format: str
    mime_type: str
    content: str


__all__ = [
    "ChangeEntry",
    "ConceptRecord",
    "ExportResult",
    "GroupRecord",
    "ImportResult",
    "LabelValue",
    "MappingValue",
    "ProposalRecord",
    "PublishResult",
    "ReclassificationRecord",
    "RerankEntry",
    "RuleDraft",
    "RuleRecord",
    "SchemeDraft",
    "SchemeRecord",
    "SharedLabelEntry",
    "SharedLabelRecord",
    "TemplateChangeRecord",
    "TemplateDiff",
    "VersionRecord",
    "ViolationEntry",
    "WarningEntry",
]
