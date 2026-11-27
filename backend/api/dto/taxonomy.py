"""Taxonomy messages (``openapi.yaml`` tag Knowledge: concept schemes, concepts, groups,
versions, rules, proposals, shared labels) and their filter/order maps."""

from __future__ import annotations

from typing import Any, Literal
from uuid import UUID

from sqlalchemy import exists, select

from api.aip.filtering import FilterSchema, repeated, resource_name, stored_enum, string
from api.aip.messages import ProtoMessage, Timestamp
from api.aip.ordering import OrderSchema
from api.dto.operations import register_response_message
from bomesh.db.models.taxonomy import (
    Concept,
    ConceptGroup,
    ConceptProposal,
    ConceptRelation,
    ConceptRule,
    ConceptScheme,
    ConceptSchemeVersion,
)
from bomesh.errors import InvalidArgument
from bomesh.services.taxonomy.concepts import DOCUMENT_COUNT
from bomesh.services.taxonomy.names import parse_concept, parse_scheme
from bomesh.services.taxonomy.records import (
    ConceptRecord,
    ExportResult,
    GroupRecord,
    ImportResult,
    ProposalRecord,
    RuleRecord,
    SchemeRecord,
    SharedLabelRecord,
    TemplateDiff,
    VersionRecord,
)

Purpose = Literal["CLASSIFICATION", "AUTHORITY"]
LlmPolicy = Literal["ALWAYS", "FALLBACK", "NEVER"]
ConceptState = Literal["DRAFT", "PUBLISHED", "DEPRECATED", "DELETED"]
MatchType = Literal["EXACT", "CLOSE", "BROAD", "NARROW"]

# -- Concept schemes -----------------------------------------------------------------


class ConceptSchemeCardinalityMessage(ProtoMessage):
    min: int | None = None
    max: int | None = None
    primary: bool | None = None


class ConceptSchemeMessage(ProtoMessage):
    name: str | None = None
    display_name: str | None = None
    description: str | None = None
    purpose: Purpose | None = None
    position: int | None = None
    cardinality: ConceptSchemeCardinalityMessage | None = None
    max_depth: int | None = None
    assign_top_concepts: bool | None = None
    section_assignments: bool | None = None
    llm_policy: LlmPolicy | None = None
    auto_threshold: float | None = None
    review_threshold: float | None = None
    template: str | None = None
    template_version: int | None = None
    published_version: int | None = None
    unpublished_changes: int | None = None
    create_time: Timestamp | None = None
    update_time: Timestamp | None = None
    etag: str | None = None


class ListConceptSchemesResponse(ProtoMessage):
    concept_schemes: list[ConceptSchemeMessage]
    next_page_token: str | None = None
    total_size: int | None = None


def scheme_message(record: SchemeRecord) -> ConceptSchemeMessage:
    return ConceptSchemeMessage(
        name=record.name,
        display_name=record.display_name,
        description=record.description,
        purpose=record.purpose.upper(),  # type: ignore[arg-type]
        position=record.position,
        cardinality=ConceptSchemeCardinalityMessage(
            min=record.min_labels, max=record.max_labels, primary=record.has_primary
        ),
        max_depth=record.max_depth,
        assign_top_concepts=record.assign_top_concepts,
        section_assignments=record.section_assignments,
        llm_policy=record.llm_policy.upper(),  # type: ignore[arg-type]
        auto_threshold=record.auto_threshold,
        review_threshold=record.review_threshold,
        template=record.template,
        template_version=record.template_version,
        published_version=record.published_version,
        unpublished_changes=record.unpublished_changes,
        create_time=record.create_time,
        update_time=record.update_time,
        etag=record.etag,
    )


def scheme_settings(paths: tuple[str, ...], body: ConceptSchemeMessage) -> dict[str, Any]:
    """UpdateConceptScheme changes by mask path; enums lowercased for the service."""
    cardinality = body.cardinality or ConceptSchemeCardinalityMessage()
    values: dict[str, Any] = {
        "displayName": body.display_name,
        "description": body.description,
        "position": body.position,
        "cardinality.min": cardinality.min,
        "cardinality.max": cardinality.max,
        "cardinality.primary": cardinality.primary,
        "maxDepth": body.max_depth,
        "assignTopConcepts": body.assign_top_concepts,
        "sectionAssignments": body.section_assignments,
        "llmPolicy": body.llm_policy.lower() if body.llm_policy else None,
        "autoThreshold": body.auto_threshold,
        "reviewThreshold": body.review_threshold,
    }
    return {path: values[path] for path in paths}


SCHEME_FILTERS = FilterSchema(
    {
        "purpose": stored_enum(ConceptScheme.purpose, Purpose.__args__),
        "displayName": string(ConceptScheme.scheme_name),
    }
)
SCHEME_ORDER = OrderSchema(
    {"position": ConceptScheme.position, "displayName": ConceptScheme.scheme_name},
    tie_breaker=[ConceptScheme.code],
    default="position",
)


class PublishConceptSchemeRequest(ProtoMessage):
    etag: str | None = None
    validate_only: bool | None = None


class TemplateChangeMessage(ProtoMessage):
    key: str
    kind: Literal["ADD_CONCEPT", "UPDATE_CONCEPT", "DEPRECATE_CONCEPT", "UPDATE_SCHEME"]
    concept: str | None = None
    field: str | None = None
    base_value: Any = None
    template_value: Any = None
    current_value: Any = None
    replaced_by: list[str] | None = None
    conflict: bool


class DiffConceptSchemeTemplateResponse(ProtoMessage):
    template: str
    from_version: int | None = None
    to_version: int
    changes: list[TemplateChangeMessage]


def template_diff_message(diff: TemplateDiff) -> DiffConceptSchemeTemplateResponse:
    return DiffConceptSchemeTemplateResponse(
        template=diff.template,
        from_version=diff.from_version,
        to_version=diff.to_version,
        changes=[
            TemplateChangeMessage(
                key=change.key,
                kind=change.kind.upper(),  # type: ignore[arg-type]
                concept=change.concept,
                field=change.field,
                base_value=change.base_value,
                template_value=change.template_value,
                current_value=change.current_value,
                replaced_by=list(change.replaced_by) or None,
                conflict=change.conflict,
            )
            for change in diff.changes
        ],
    )


class ApplyConceptSchemeTemplateChangesRequest(ProtoMessage):
    changes: list[str] = []
    etag: str | None = None


class ConceptImportRowMessage(ProtoMessage):
    notation: str
    broader: str | None = None
    related: str | None = None
    pref_vi: str | None = None
    pref_en: str | None = None
    alt_vi: str | None = None
    alt_en: str | None = None
    hidden: str | None = None
    definition: str | None = None
    scope_note: str | None = None
    examples: str | None = None
    color: str | None = None
    icon: str | None = None
    match_patterns: str | None = None
    time_sensitive: str | None = None
    mappings: str | None = None


class ImportConceptsRequest(ProtoMessage):
    rows: list[ConceptImportRowMessage]
    validate_only: bool | None = None


class ImportConceptsResponse(ProtoMessage):
    created: list[str]
    updated: list[str]
    unchanged_count: int


def import_rows(body: ImportConceptsRequest) -> list[dict[str, str]]:
    """Each row's present columns by API name (absent = keep, empty = clear)."""
    return [row.model_dump(by_alias=True, exclude_unset=True) for row in body.rows]


def import_response(result: ImportResult) -> ImportConceptsResponse:
    return ImportConceptsResponse(
        created=list(result.created), updated=list(result.updated), unchanged_count=result.unchanged_count
    )


# -- Concepts ------------------------------------------------------------------------


class ConceptLabelMessage(ProtoMessage):
    language_code: str
    text: str


class ConceptMappingMessage(ProtoMessage):
    system: str
    code: str
    label: str | None = None
    match: MatchType


class ConceptMessage(ProtoMessage):
    name: str | None = None
    display_name: str | None = None
    pref_labels: list[ConceptLabelMessage] | None = None
    alt_labels: list[ConceptLabelMessage] | None = None
    hidden_labels: list[ConceptLabelMessage] | None = None
    definition: str | None = None
    scope_note: str | None = None
    examples: list[str] | None = None
    broader: list[str] | None = None
    related: list[str] | None = None
    mappings: list[ConceptMappingMessage] | None = None
    match_patterns: list[str] | None = None
    time_sensitive: bool | None = None
    color: str | None = None
    icon: str | None = None
    state: ConceptState | None = None
    deprecation_pending: bool | None = None
    replaced_by: list[str] | None = None
    groups: list[str] | None = None
    template_concept: str | None = None
    first_version: int | None = None
    deprecated_version: int | None = None
    document_count: int | None = None
    in_review_count: int | None = None
    create_time: Timestamp | None = None
    update_time: Timestamp | None = None
    delete_time: Timestamp | None = None
    etag: str | None = None


class ListConceptsResponse(ProtoMessage):
    concepts: list[ConceptMessage]
    next_page_token: str | None = None
    total_size: int | None = None


class DeprecateConceptRequest(ProtoMessage):
    replaced_by: list[str] = []
    etag: str | None = None


def _labels(values: tuple[tuple[str, str], ...]) -> list[ConceptLabelMessage]:
    return [ConceptLabelMessage(language_code=language, text=text) for language, text in values]


def concept_message(record: ConceptRecord) -> ConceptMessage:
    return ConceptMessage(
        name=record.name,
        display_name=record.display_name,
        pref_labels=_labels(record.pref_labels),
        alt_labels=_labels(record.alt_labels),
        hidden_labels=_labels(record.hidden_labels),
        definition=record.definition,
        scope_note=record.scope_note,
        examples=list(record.examples),
        broader=list(record.broader),
        related=list(record.related),
        mappings=[
            ConceptMappingMessage(system=system, code=code, label=label, match=match.upper())  # type: ignore[arg-type]
            for system, code, label, match in record.mappings
        ],
        match_patterns=list(record.match_patterns),
        time_sensitive=record.time_sensitive,
        color=record.color,
        icon=record.icon,
        state=record.state.upper(),  # type: ignore[arg-type]
        deprecation_pending=record.deprecation_pending,
        replaced_by=list(record.replaced_by),
        groups=list(record.groups),
        template_concept=record.template_concept,
        first_version=record.first_version,
        deprecated_version=record.deprecated_version,
        document_count=record.document_count,
        in_review_count=record.in_review_count,
        create_time=record.create_time,
        update_time=record.update_time,
        delete_time=record.delete_time,
        etag=record.etag,
    )


def concept_changes(
    paths: tuple[str, ...],
    body: ConceptMessage,
    workspace_id: UUID | None,
    scheme_code: str,
) -> dict[str, Any]:
    """Concept changes by path for the service: labels as pairs, references as notations."""

    def notations(values: list[str] | None, field: str) -> list[str]:
        found = []
        for position, value in enumerate(values or ()):
            code, notation = parse_concept(value, workspace_id, field=f"{field}[{position}]")
            if code != scheme_code:
                raise InvalidArgument.for_field(f"{field}[{position}]", "Name a concept of the same scheme.")
            found.append(notation)
        return found

    values: dict[str, Any] = {
        "prefLabels": [(label.language_code, label.text) for label in body.pref_labels or ()],
        "altLabels": [(label.language_code, label.text) for label in body.alt_labels or ()],
        "hiddenLabels": [(label.language_code, label.text) for label in body.hidden_labels or ()],
        "definition": body.definition,
        "scopeNote": body.scope_note,
        "examples": list(body.examples or ()),
        "broader": notations(body.broader, "broader") if "broader" in paths else None,
        "related": notations(body.related, "related") if "related" in paths else None,
        "mappings": [
            (mapping.system, mapping.code, mapping.label, mapping.match.lower()) for mapping in body.mappings or ()
        ],
        "matchPatterns": list(body.match_patterns or ()),
        "timeSensitive": body.time_sensitive,
        "color": body.color,
        "icon": body.icon,
    }
    return {path: values[path] for path in paths}


def concept_filters(workspace_id: UUID | None) -> FilterSchema:
    parent = Concept.__table__.alias("broader_concept")

    def broader(notation: str) -> Any:
        # Relations stay within one scheme, so the parent's notation identifies it.
        return exists(
            select(ConceptRelation.source_concept_id)
            .join(parent, parent.c.id == ConceptRelation.target_concept_id)
            .where(
                ConceptRelation.source_concept_id == Concept.id,
                ConceptRelation.kind == "broader",
                parent.c.notation == notation,
            )
        )

    return FilterSchema(
        {
            "state": stored_enum(Concept.state, ("DRAFT", "PUBLISHED", "DEPRECATED")),
            "notation": string(Concept.notation),
            "broader": repeated(
                resource_name(Concept.notation, lambda name: parse_concept(name, workspace_id, field="filter")[1]),
                has=broader,
                present=exists().where(
                    ConceptRelation.source_concept_id == Concept.id, ConceptRelation.kind == "broader"
                ),
            ),
        }
    )


CONCEPT_ORDER = OrderSchema(
    {"notation": Concept.notation, "documentCount": DOCUMENT_COUNT},
    tie_breaker=[Concept.id],
    default="notation",
)


# -- Groups --------------------------------------------------------------------------


class ConceptGroupMessage(ProtoMessage):
    name: str | None = None
    display_name: str | None = None
    position: int | None = None
    members: list[str] | None = None
    query_expansion: bool | None = None
    create_time: Timestamp | None = None
    update_time: Timestamp | None = None
    etag: str | None = None


class ListConceptGroupsResponse(ProtoMessage):
    concept_groups: list[ConceptGroupMessage]
    next_page_token: str | None = None


def group_message(record: GroupRecord) -> ConceptGroupMessage:
    return ConceptGroupMessage(
        name=record.name,
        display_name=record.display_name,
        position=record.position,
        members=list(record.members),
        query_expansion=record.query_expansion,
        create_time=record.create_time,
        update_time=record.update_time,
        etag=record.etag,
    )


def group_changes(
    paths: tuple[str, ...], body: ConceptGroupMessage, workspace_id: UUID | None, scheme_code: str
) -> dict[str, Any]:
    values: dict[str, Any] = {
        "displayName": body.display_name,
        "position": body.position,
        "queryExpansion": body.query_expansion,
    }
    if "members" in paths:
        members = []
        for position, value in enumerate(body.members or ()):
            code, notation = parse_concept(value, workspace_id, field=f"members[{position}]")
            if code != scheme_code:
                raise InvalidArgument.for_field(f"members[{position}]", "Name a concept of the group's scheme.")
            members.append(notation)
        values["members"] = members
    return {path: values[path] for path in paths}


GROUP_ORDER = OrderSchema(
    {"position": ConceptGroup.position}, tie_breaker=[ConceptGroup.code], default="position"
)
NO_FILTERS = FilterSchema({})


# -- Versions ------------------------------------------------------------------------


class ConceptChangeMessage(ProtoMessage):
    kind: str
    concept: str | None = None
    group: str | None = None
    replaced_by: list[str] | None = None


class ConceptSchemeWarningMessage(ProtoMessage):
    kind: str
    concepts: list[str] | None = None
    label: str | None = None
    message: str | None = None


class ConceptSchemeViolationMessage(ProtoMessage):
    invariant: str
    concepts: list[str] | None = None
    message: str | None = None


class RerankMessage(ProtoMessage):
    concept: str
    among: list[str]


class RerunParentMessage(ProtoMessage):
    parent: str
    among: list[str]


class ConceptReclassificationMessage(ProtoMessage):
    remapped_count: int
    rerank: list[RerankMessage]
    rerun_parents: list[RerunParentMessage]
    patterns_changed: list[str]
    thresholds_changed: bool
    state: str
    runs: list[str]


class ConceptSchemeVersionMessage(ProtoMessage):
    name: str
    version: int
    publish_time: Timestamp | None = None
    publisher: str | None = None
    concept_count: int
    changes: list[ConceptChangeMessage]
    warnings: list[ConceptSchemeWarningMessage]
    violations: list[ConceptSchemeViolationMessage] | None = None
    reclassification: ConceptReclassificationMessage | None = None


class ListConceptSchemeVersionsResponse(ProtoMessage):
    concept_scheme_versions: list[ConceptSchemeVersionMessage]
    next_page_token: str | None = None


def version_message(record: VersionRecord) -> ConceptSchemeVersionMessage:
    plan = record.reclassification
    return ConceptSchemeVersionMessage(
        name=record.name,
        version=record.version,
        publish_time=record.publish_time,
        publisher=record.publisher,
        concept_count=record.concept_count,
        changes=[
            ConceptChangeMessage(
                kind=change.kind.upper(),
                concept=change.concept,
                group=change.group,
                replaced_by=list(change.replaced_by) or None,
            )
            for change in record.changes
        ],
        warnings=[
            ConceptSchemeWarningMessage(
                kind=warning.kind.upper(),
                concepts=list(warning.concepts) or None,
                label=warning.label,
                message=warning.message,
            )
            for warning in record.warnings
        ],
        violations=[
            ConceptSchemeViolationMessage(
                invariant=violation.invariant.upper(),
                concepts=list(violation.concepts) or None,
                message=violation.message,
            )
            for violation in record.violations
        ]
        or None,
        reclassification=None
        if plan is None
        else ConceptReclassificationMessage(
            remapped_count=plan.remapped_count,
            rerank=[RerankMessage(concept=entry.concept, among=list(entry.among)) for entry in plan.rerank],
            rerun_parents=[
                RerunParentMessage(parent=entry.concept, among=list(entry.among)) for entry in plan.rerun_parents
            ],
            patterns_changed=list(plan.patterns_changed),
            thresholds_changed=plan.thresholds_changed,
            state=plan.state.upper(),
            runs=list(plan.runs),
        ),
    )


register_response_message("ConceptSchemeVersion", version_message)

VERSION_ORDER = OrderSchema(
    {"version": ConceptSchemeVersion.version},
    tie_breaker=[ConceptSchemeVersion.version],
    default="version desc",
)


class ExportConceptSchemeVersionResponse(ProtoMessage):
    format: Literal["TURTLE", "JSON_LD"]
    mime_type: str
    content: str


def export_message(result: ExportResult) -> ExportConceptSchemeVersionResponse:
    return ExportConceptSchemeVersionResponse(
        format=result.format.upper(),  # type: ignore[arg-type]
        mime_type=result.mime_type,
        content=result.content,
    )


# -- Rules ---------------------------------------------------------------------------


class ConceptRuleConditionMessage(ProtoMessage):
    concept: str | None = None
    collection: str | None = None
    source: str | None = None


class ConceptRuleMessage(ProtoMessage):
    name: str | None = None
    when: ConceptRuleConditionMessage | None = None
    then: str | None = None
    effect: Literal["IMPLIES", "PRIOR"] | None = None
    weight: float | None = None
    creator: str | None = None
    create_time: Timestamp | None = None
    etag: str | None = None


class ListConceptRulesResponse(ProtoMessage):
    concept_rules: list[ConceptRuleMessage]
    next_page_token: str | None = None
    total_size: int | None = None


def rule_message(record: RuleRecord) -> ConceptRuleMessage:
    return ConceptRuleMessage(
        name=record.name,
        when=ConceptRuleConditionMessage(
            concept=record.when_concept, collection=record.when_collection, source=record.when_source
        ),
        then=record.then,
        effect=record.effect.upper(),  # type: ignore[arg-type]
        weight=record.weight,
        creator=record.creator,
        create_time=record.create_time,
        etag=record.etag,
    )


def rule_filters(workspace_id: UUID) -> FilterSchema:
    def concept_id(name: str) -> Any:
        code, notation = parse_concept(name, workspace_id, field="filter")
        return (
            select(Concept.id)
            .join(ConceptScheme, ConceptScheme.id == Concept.scheme_id)
            .where(ConceptScheme.tenant_id == workspace_id, ConceptScheme.code == code, Concept.notation == notation)
            .scalar_subquery()
        )

    return FilterSchema(
        {
            "effect": stored_enum(ConceptRule.effect, ("IMPLIES", "PRIOR")),
            "then": resource_name(ConceptRule.then_concept_id, concept_id),
            "when.concept": resource_name(ConceptRule.when_concept_id, concept_id),
        }
    )


RULE_ORDER = OrderSchema(
    {"createTime": ConceptRule.created_at, "name": ConceptRule.code},
    tie_breaker=[ConceptRule.id],
    default="name",
)


# -- Proposals -----------------------------------------------------------------------


class ConceptProposalMessage(ProtoMessage):
    name: str
    scheme: str
    kind: Literal["NEW_CONCEPT", "LABEL"]
    display_name: str
    definition: str | None = None
    suggested_broader: str | None = None
    target_concept: str | None = None
    origin: Literal["CLUSTER", "CORRECTION", "MEMBER"]
    state: Literal["OPEN", "ACCEPTED", "REJECTED"]
    concept: str | None = None
    evidence: list[str]
    decider: str | None = None
    decide_time: Timestamp | None = None
    create_time: Timestamp


class ListConceptProposalsResponse(ProtoMessage):
    concept_proposals: list[ConceptProposalMessage]
    next_page_token: str | None = None
    total_size: int | None = None


class AcceptConceptProposalRequest(ProtoMessage):
    concept_id: str | None = None
    concept: ConceptMessage | None = None
    label_kind: Literal["ALT", "HIDDEN"] | None = None
    language_code: str | None = None


class RejectConceptProposalRequest(ProtoMessage):
    pass


def proposal_message(record: ProposalRecord) -> ConceptProposalMessage:
    return ConceptProposalMessage(
        name=record.name,
        scheme=record.scheme,
        kind=record.kind.upper(),  # type: ignore[arg-type]
        display_name=record.display_name,
        definition=record.definition,
        suggested_broader=record.suggested_broader,
        target_concept=record.target_concept,
        origin=record.origin.upper(),  # type: ignore[arg-type]
        state=record.state.upper(),  # type: ignore[arg-type]
        concept=record.concept,
        evidence=list(record.evidence),
        decider=record.decider,
        decide_time=record.decide_time,
        create_time=record.create_time,
    )


def proposal_filters(workspace_id: UUID) -> FilterSchema:
    scheme_code = (
        select(ConceptScheme.code).where(ConceptScheme.id == ConceptProposal.scheme_id).scalar_subquery()
    )
    return FilterSchema(
        {
            "state": stored_enum(ConceptProposal.state, ("OPEN", "ACCEPTED", "REJECTED")),
            "kind": stored_enum(ConceptProposal.kind, ("NEW_CONCEPT", "LABEL")),
            "origin": stored_enum(ConceptProposal.origin, ("CLUSTER", "CORRECTION", "MEMBER")),
            "scheme": resource_name(scheme_code, lambda name: parse_scheme(name, workspace_id, field="filter")),
        }
    )


PROPOSAL_ORDER = OrderSchema(
    {"createTime": ConceptProposal.created_at},
    tie_breaker=[ConceptProposal.id],
    default="createTime desc",
)


# -- Shared labels -------------------------------------------------------------------


class SharedLabelConceptMessage(ProtoMessage):
    concept: str
    scheme: str
    kind: Literal["PREF", "ALT", "HIDDEN"]
    language_code: str
    text: str


class SharedLabelMessage(ProtoMessage):
    label: str
    cross_scheme: bool
    concepts: list[SharedLabelConceptMessage]


class ListSharedLabelsResponse(ProtoMessage):
    shared_labels: list[SharedLabelMessage]
    next_page_token: str | None = None


def shared_label_message(record: SharedLabelRecord) -> SharedLabelMessage:
    return SharedLabelMessage(
        label=record.label,
        cross_scheme=record.cross_scheme,
        concepts=[
            SharedLabelConceptMessage(
                concept=entry.concept,
                scheme=entry.scheme,
                kind=entry.kind.upper(),  # type: ignore[arg-type]
                language_code=entry.language_code,
                text=entry.text,
            )
            for entry in record.concepts
        ],
    )


__all__ = [
    "CONCEPT_ORDER",
    "GROUP_ORDER",
    "NO_FILTERS",
    "PROPOSAL_ORDER",
    "RULE_ORDER",
    "SCHEME_FILTERS",
    "SCHEME_ORDER",
    "VERSION_ORDER",
    "AcceptConceptProposalRequest",
    "ApplyConceptSchemeTemplateChangesRequest",
    "ConceptGroupMessage",
    "ConceptMessage",
    "ConceptRuleMessage",
    "ConceptSchemeMessage",
    "ConceptSchemeVersionMessage",
    "DeprecateConceptRequest",
    "DiffConceptSchemeTemplateResponse",
    "ExportConceptSchemeVersionResponse",
    "ImportConceptsRequest",
    "ImportConceptsResponse",
    "ListConceptGroupsResponse",
    "ListConceptProposalsResponse",
    "ListConceptRulesResponse",
    "ListConceptSchemeVersionsResponse",
    "ListConceptSchemesResponse",
    "ListConceptsResponse",
    "ListSharedLabelsResponse",
    "PublishConceptSchemeRequest",
    "RejectConceptProposalRequest",
    "concept_changes",
    "concept_filters",
    "concept_message",
    "export_message",
    "group_changes",
    "group_message",
    "import_response",
    "import_rows",
    "proposal_filters",
    "proposal_message",
    "rule_filters",
    "rule_message",
    "scheme_message",
    "scheme_settings",
    "shared_label_message",
    "template_diff_message",
    "version_message",
]
