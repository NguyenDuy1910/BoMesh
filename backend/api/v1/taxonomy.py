"""Knowledge interface — taxonomy: concept schemes, concepts, groups, versions, rules,
proposals and shared labels.

Routes are mounted under ``/api/v1``; ``name`` is the contract ``operationId``.
Scheme, concept, group, version and publish methods exist twice: under a
workspace (``workspaces/{workspace}/conceptSchemes/…``) and for the platform
templates (``conceptSchemes/…``, operation IDs ``…Template…``); one set of
handlers serves both, the tenant (``None`` for templates) comes from the path.
The assignment methods (``:confirmAssignments``, ``:testClassification`` …)
live in ``taxonomy_assignments``.

Annotations are evaluated eagerly (no ``from __future__ import annotations``):
the handlers defined in :func:`_register` close over its ``Tenant`` dependency.
"""

from collections.abc import Awaitable, Callable
from typing import Annotated, Any, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Request

from api.aip.fieldmask import MutableFields
from api.aip.filtering import And, Restriction, parse, restrictions
from api.aip.paging import PageRequest, query_fingerprint
from api.dto.identity import Empty
from api.dto.operations import OperationMessage, operation_message
from api.dto.taxonomy import (
    CONCEPT_ORDER,
    GROUP_ORDER,
    NO_FILTERS,
    PROPOSAL_ORDER,
    RULE_ORDER,
    SCHEME_FILTERS,
    SCHEME_ORDER,
    VERSION_ORDER,
    AcceptConceptProposalRequest,
    ApplyConceptSchemeTemplateChangesRequest,
    ConceptGroupMessage,
    ConceptMessage,
    ConceptProposalMessage,
    ConceptRuleMessage,
    ConceptSchemeMessage,
    ConceptSchemeVersionMessage,
    DeprecateConceptRequest,
    DiffConceptSchemeTemplateResponse,
    ExportConceptSchemeVersionResponse,
    ImportConceptsRequest,
    ImportConceptsResponse,
    ListConceptGroupsResponse,
    ListConceptProposalsResponse,
    ListConceptRulesResponse,
    ListConceptSchemeVersionsResponse,
    ListConceptSchemesResponse,
    ListConceptsResponse,
    ListSharedLabelsResponse,
    PublishConceptSchemeRequest,
    RejectConceptProposalRequest,
    concept_changes,
    concept_filters,
    concept_message,
    export_message,
    group_changes,
    group_message,
    import_response,
    import_rows,
    proposal_filters,
    proposal_message,
    rule_filters,
    rule_message,
    scheme_message,
    scheme_settings,
    shared_label_message,
    template_diff_message,
    version_message,
)
from api.v1.deps import Context, service
from api.v1.listing import ListParams, list_query
from bomesh.errors import InvalidArgument
from bomesh.services.ingestion.names import parse_source
from bomesh.services.knowledge_items.names import parse_item
from bomesh.services.kernel.operations import OPERATION_TYPES
from bomesh.services.operations.operations import OperationService, OperationView
from bomesh.services.taxonomy.concepts import CONCEPT_FIELDS, ConceptService
from bomesh.services.taxonomy.export import ExportService
from bomesh.services.taxonomy.groups import GROUP_FIELDS, GroupService
from bomesh.services.taxonomy.imports import ImportService
from bomesh.services.taxonomy.names import parse_scheme, parse_template
from bomesh.services.taxonomy.proposals import ProposalService
from bomesh.services.taxonomy.publish import VERB, PublishService
from bomesh.services.taxonomy.records import RuleDraft, SchemeDraft
from bomesh.services.taxonomy.rules import RuleService
from bomesh.services.taxonomy.schemes import SETTINGS, SchemeService
from bomesh.services.taxonomy.shared_labels import SharedLabelService
from bomesh.services.taxonomy.templates import TemplateService

router = APIRouter(tags=["Knowledge"])

Schemes = Annotated[SchemeService, Depends(service(SchemeService.from_runtime))]
Concepts = Annotated[ConceptService, Depends(service(ConceptService.from_runtime))]
Groups = Annotated[GroupService, Depends(service(GroupService.from_runtime))]
Publishing = Annotated[PublishService, Depends(service(PublishService.from_runtime))]
Imports = Annotated[ImportService, Depends(service(ImportService.from_runtime))]
Exports = Annotated[ExportService, Depends(service(ExportService.from_runtime))]
Templates = Annotated[TemplateService, Depends(service(TemplateService.from_runtime))]
Rules = Annotated[RuleService, Depends(service(RuleService.from_runtime))]
Proposals = Annotated[ProposalService, Depends(service(ProposalService.from_runtime))]
SharedLabels = Annotated[SharedLabelService, Depends(service(SharedLabelService.from_runtime))]
Operations = Annotated[OperationService, Depends(service(OperationService.from_runtime))]

RequestId = Annotated[UUID | None, Query(alias="requestId")]
Etag = Annotated[str | None, Query()]
UpdateMask = Annotated[str | None, Query(alias="updateMask")]
Paging = Annotated[ListParams, Depends()]

_SCHEME_FIELDS = MutableFields(tuple(SETTINGS))
_CONCEPT_FIELDS = MutableFields(CONCEPT_FIELDS)
_GROUP_FIELDS = MutableFields(GROUP_FIELDS)
_RULE_FIELDS = MutableFields(("when", "then", "effect", "weight"))


def _parent(tenant: UUID | None) -> str:
    return f"workspaces/{tenant}" if tenant is not None else ""


def _register(prefix: str, tenant_of: Callable[..., Awaitable[UUID | None]], kind: str) -> None:
    """The scheme, concept, group, version and publish routes under ``prefix``."""
    Tenant = Annotated[UUID | None, Depends(tenant_of)]
    schemes = f"{prefix}/conceptSchemes"
    scheme = f"{schemes}/{{conceptScheme:id}}"
    concepts = f"{scheme}/concepts"
    concept = f"{concepts}/{{concept:id}}"
    groups = f"{scheme}/groups"
    group = f"{groups}/{{group:id}}"
    versions = f"{scheme}/versions"
    version = f"{versions}/{{version:id}}"

    @router.post(schemes, name=f"Create{kind}ConceptScheme")
    async def create_scheme(
        tenant: Tenant,
        body: ConceptSchemeMessage,
        ctx: Context,
        service_: Schemes,
        scheme_id: Annotated[str | None, Query(alias="conceptSchemeId")] = None,
        request_id: RequestId = None,
    ) -> ConceptSchemeMessage:
        paths = tuple(
            path
            for path in _SCHEME_FIELDS.parse(None, body).paths
            if path not in ("displayName", "description")
        )
        draft = SchemeDraft(
            code=scheme_id,
            display_name=body.display_name,
            description=body.description,
            purpose=body.purpose.lower() if body.purpose else None,
            template=parse_template(body.template, field="template") if body.template else None,
            settings=scheme_settings(paths, body),
        )
        if draft.template is None and not body.display_name:
            raise InvalidArgument.for_field("displayName", "displayName is required.")
        return scheme_message(await service_.create(ctx, tenant, draft, request_id=request_id))

    @router.get(schemes, name=f"List{kind}ConceptSchemes")
    async def list_schemes(
        tenant: Tenant, ctx: Context, service_: Schemes, params: Paging
    ) -> ListConceptSchemesResponse:
        query, paging = list_query(params, parent=_parent(tenant), filters=SCHEME_FILTERS, order=SCHEME_ORDER)
        rows, total = await service_.list(ctx, tenant, query)
        page = paging.page(rows, total_size=total)
        return ListConceptSchemesResponse(
            concept_schemes=[scheme_message(record) for record in page.items],
            next_page_token=page.next_page_token or None,
            total_size=page.total_size,
        )

    @router.get(scheme, name=f"Get{kind}ConceptScheme")
    async def get_scheme(
        tenant: Tenant, conceptScheme: str, ctx: Context, service_: Schemes
    ) -> ConceptSchemeMessage:
        return scheme_message(await service_.get(ctx, tenant, conceptScheme))

    @router.patch(scheme, name=f"Update{kind}ConceptScheme")
    async def update_scheme(
        tenant: Tenant,
        conceptScheme: str,
        body: ConceptSchemeMessage,
        ctx: Context,
        service_: Schemes,
        update_mask: UpdateMask = None,
    ) -> ConceptSchemeMessage:
        changes = scheme_settings(_SCHEME_FIELDS.parse(update_mask, body).paths, body)
        return scheme_message(await service_.update(ctx, tenant, conceptScheme, changes, etag=body.etag))

    @router.post(f"{scheme}:publish", name=f"Publish{kind}ConceptScheme")
    async def publish_scheme(
        tenant: Tenant,
        conceptScheme: str,
        body: PublishConceptSchemeRequest,
        ctx: Context,
        service_: Publishing,
        operations: Operations,
    ) -> OperationMessage:
        result = await service_.publish(
            ctx, tenant, conceptScheme, etag=body.etag, validate_only=bool(body.validate_only)
        )
        if body.validate_only:
            types = OPERATION_TYPES[VERB]
            view = OperationView(
                operation=result.operation,
                metadata_type=types.metadata,
                response_type=types.response,
                response=result.version,
            )
            return operation_message(view)
        return operation_message(await operations.describe(result.operation))

    @router.post(f"{scheme}:importConcepts", name=f"Import{kind}Concepts")
    async def import_concepts(
        tenant: Tenant, conceptScheme: str, body: ImportConceptsRequest, ctx: Context, service_: Imports
    ) -> ImportConceptsResponse:
        result = await service_.import_concepts(
            ctx, tenant, conceptScheme, import_rows(body), validate_only=bool(body.validate_only)
        )
        return import_response(result)

    @router.post(concepts, name=f"Create{kind}Concept")
    async def create_concept(
        tenant: Tenant,
        conceptScheme: str,
        body: ConceptMessage,
        ctx: Context,
        service_: Concepts,
        concept_id: Annotated[str, Query(alias="conceptId")],
        request_id: RequestId = None,
    ) -> ConceptMessage:
        paths = _CONCEPT_FIELDS.parse(None, body).paths
        changes = concept_changes(paths, body, tenant, conceptScheme)
        record = await service_.create(ctx, tenant, conceptScheme, concept_id, changes, request_id=request_id)
        return concept_message(record)

    @router.get(concepts, name=f"List{kind}Concepts")
    async def list_concepts(
        tenant: Tenant, conceptScheme: str, ctx: Context, service_: Concepts, params: Paging
    ) -> ListConceptsResponse:
        query, paging = list_query(
            params,
            parent=f"{_parent(tenant)}/conceptSchemes/{conceptScheme}",
            filters=concept_filters(tenant),
            order=CONCEPT_ORDER,
        )
        rows, total = await service_.list(ctx, tenant, conceptScheme, query)
        page = paging.page(rows, total_size=total)
        return ListConceptsResponse(
            concepts=[concept_message(record) for record in page.items],
            next_page_token=page.next_page_token or None,
            total_size=page.total_size,
        )

    @router.get(concept, name=f"Get{kind}Concept")
    async def get_concept(
        tenant: Tenant, conceptScheme: str, concept: str, ctx: Context, service_: Concepts
    ) -> ConceptMessage:
        return concept_message(await service_.get(ctx, tenant, conceptScheme, concept))

    @router.patch(concept, name=f"Update{kind}Concept")
    async def update_concept(
        tenant: Tenant,
        conceptScheme: str,
        concept: str,
        body: ConceptMessage,
        ctx: Context,
        service_: Concepts,
        update_mask: UpdateMask = None,
    ) -> ConceptMessage:
        paths = _CONCEPT_FIELDS.parse(update_mask, body).paths
        changes = concept_changes(paths, body, tenant, conceptScheme)
        return concept_message(
            await service_.update(ctx, tenant, conceptScheme, concept, changes, etag=body.etag)
        )

    @router.delete(concept, name=f"Delete{kind}Concept")
    async def delete_concept(
        tenant: Tenant, conceptScheme: str, concept: str, ctx: Context, service_: Concepts, etag: Etag = None
    ) -> ConceptMessage:
        return concept_message(await service_.delete(ctx, tenant, conceptScheme, concept, etag=etag))

    @router.post(f"{concept}:deprecate", name=f"Deprecate{kind}Concept")
    async def deprecate_concept(
        tenant: Tenant,
        conceptScheme: str,
        concept: str,
        body: DeprecateConceptRequest,
        ctx: Context,
        service_: Concepts,
    ) -> ConceptMessage:
        replaced = concept_changes(
            ("related",), ConceptMessage(related=body.replaced_by), tenant, conceptScheme
        )["related"]
        return concept_message(
            await service_.deprecate(ctx, tenant, conceptScheme, concept, replaced, etag=body.etag)
        )

    @router.post(groups, name=f"Create{kind}ConceptGroup")
    async def create_group(
        tenant: Tenant,
        conceptScheme: str,
        body: ConceptGroupMessage,
        ctx: Context,
        service_: Groups,
        group_id: Annotated[str, Query(alias="groupId")],
    ) -> ConceptGroupMessage:
        changes = group_changes(_GROUP_FIELDS.parse(None, body).paths, body, tenant, conceptScheme)
        return group_message(await service_.create(ctx, tenant, conceptScheme, group_id, changes))

    @router.get(groups, name=f"List{kind}ConceptGroups")
    async def list_groups(
        tenant: Tenant, conceptScheme: str, ctx: Context, service_: Groups, params: Paging
    ) -> ListConceptGroupsResponse:
        query, paging = list_query(
            params,
            parent=f"{_parent(tenant)}/conceptSchemes/{conceptScheme}",
            filters=NO_FILTERS,
            order=GROUP_ORDER,
        )
        page = paging.page(await service_.list(ctx, tenant, conceptScheme, query))
        return ListConceptGroupsResponse(
            concept_groups=[group_message(record) for record in page.items],
            next_page_token=page.next_page_token or None,
        )

    @router.get(group, name=f"Get{kind}ConceptGroup")
    async def get_group(
        tenant: Tenant, conceptScheme: str, group: str, ctx: Context, service_: Groups
    ) -> ConceptGroupMessage:
        return group_message(await service_.get(ctx, tenant, conceptScheme, group))

    @router.patch(group, name=f"Update{kind}ConceptGroup")
    async def update_group(
        tenant: Tenant,
        conceptScheme: str,
        group: str,
        body: ConceptGroupMessage,
        ctx: Context,
        service_: Groups,
        update_mask: UpdateMask = None,
    ) -> ConceptGroupMessage:
        changes = group_changes(_GROUP_FIELDS.parse(update_mask, body).paths, body, tenant, conceptScheme)
        return group_message(await service_.update(ctx, tenant, conceptScheme, group, changes, etag=body.etag))

    @router.delete(group, name=f"Delete{kind}ConceptGroup")
    async def delete_group(
        tenant: Tenant, conceptScheme: str, group: str, ctx: Context, service_: Groups, etag: Etag = None
    ) -> Empty:
        await service_.delete(ctx, tenant, conceptScheme, group, etag=etag)
        return Empty()

    @router.get(versions, name=f"List{kind}ConceptSchemeVersions")
    async def list_versions(
        tenant: Tenant,
        conceptScheme: str,
        ctx: Context,
        service_: Publishing,
        page_size: Annotated[int | None, Query(alias="pageSize")] = None,
        page_token: Annotated[str | None, Query(alias="pageToken")] = None,
    ) -> ListConceptSchemeVersionsResponse:
        query, paging = list_query(
            ListParams(page_size=page_size, page_token=page_token),
            parent=f"{_parent(tenant)}/conceptSchemes/{conceptScheme}",
            filters=NO_FILTERS,
            order=VERSION_ORDER,
        )
        page = paging.page(await service_.list_versions(ctx, tenant, conceptScheme, query))
        return ListConceptSchemeVersionsResponse(
            concept_scheme_versions=[version_message(record) for record in page.items],
            next_page_token=page.next_page_token or None,
        )

    @router.get(version, name=f"Get{kind}ConceptSchemeVersion")
    async def get_version(
        tenant: Tenant, conceptScheme: str, version: str, ctx: Context, service_: Publishing
    ) -> ConceptSchemeVersionMessage:
        return version_message(await service_.get_version(ctx, tenant, conceptScheme, _version(version)))

    @router.get(f"{version}:export", name=f"Export{kind}ConceptSchemeVersion")
    async def export_version(
        tenant: Tenant,
        conceptScheme: str,
        version: str,
        request: Request,
        ctx: Context,
        service_: Exports,
        format: Annotated[Literal["TURTLE", "JSON_LD"], Query()] = "TURTLE",
    ) -> ExportConceptSchemeVersionResponse:
        result = await service_.export(
            ctx,
            tenant,
            conceptScheme,
            _version(version),
            format=format,
            base=f"{str(request.base_url).rstrip('/')}/api/v1/",
        )
        return export_message(result)


def _version(value: str) -> int:
    if not value.isdigit() or int(value) < 1:
        raise InvalidArgument.for_field("version", "A version is a positive number.")
    return int(value)


async def _workspace_tenant(workspace: UUID) -> UUID | None:
    return workspace


async def _template_tenant() -> UUID | None:
    return None


_register("/workspaces/{workspace:id}", _workspace_tenant, "")
_register("", _template_tenant, "Template")

_WS = "/workspaces/{workspace:id}"
_SCHEME = f"{_WS}/conceptSchemes/{{conceptScheme:id}}"


@router.get(f"{_SCHEME}:diffTemplate", name="DiffConceptSchemeTemplate")
async def diff_template(
    workspace: UUID, conceptScheme: str, ctx: Context, templates: Templates
) -> DiffConceptSchemeTemplateResponse:
    return template_diff_message(await templates.diff(ctx, workspace, conceptScheme))


@router.post(f"{_SCHEME}:applyTemplateChanges", name="ApplyConceptSchemeTemplateChanges")
async def apply_template_changes(
    workspace: UUID,
    conceptScheme: str,
    body: ApplyConceptSchemeTemplateChangesRequest,
    ctx: Context,
    templates: Templates,
) -> ConceptSchemeMessage:
    return scheme_message(await templates.apply(ctx, workspace, conceptScheme, body.changes, etag=body.etag))


# -- Rules ---------------------------------------------------------------------------

_RULE = f"{_WS}/conceptRules/{{conceptRule:id}}"


def _rule_draft(workspace: UUID, body: ConceptRuleMessage) -> RuleDraft:
    when = body.when
    return RuleDraft(
        when_concept=when.concept if when else None,
        when_collection_id=parse_item(when.collection, workspace, field="when.collection")
        if when and when.collection
        else None,
        when_source_code=parse_source(when.source, workspace, field="when.source") if when and when.source else None,
        then=body.then,
        effect=body.effect.lower() if body.effect else None,
        weight=body.weight,
    )


@router.post(f"{_WS}/conceptRules", name="CreateConceptRule")
async def create_rule(
    workspace: UUID,
    body: ConceptRuleMessage,
    ctx: Context,
    rules: Rules,
    rule_id: Annotated[str, Query(alias="conceptRuleId")],
    request_id: RequestId = None,
) -> ConceptRuleMessage:
    record = await rules.create(ctx, workspace, rule_id, _rule_draft(workspace, body), request_id=request_id)
    return rule_message(record)


@router.get(f"{_WS}/conceptRules", name="ListConceptRules")
async def list_rules(workspace: UUID, ctx: Context, rules: Rules, params: Paging) -> ListConceptRulesResponse:
    query, paging = list_query(
        params, parent=f"workspaces/{workspace}", filters=rule_filters(workspace), order=RULE_ORDER
    )
    rows, total = await rules.list(ctx, workspace, query)
    page = paging.page(rows, total_size=total)
    return ListConceptRulesResponse(
        concept_rules=[rule_message(record) for record in page.items],
        next_page_token=page.next_page_token or None,
        total_size=page.total_size,
    )


@router.get(_RULE, name="GetConceptRule")
async def get_rule(workspace: UUID, conceptRule: str, ctx: Context, rules: Rules) -> ConceptRuleMessage:
    return rule_message(await rules.get(ctx, workspace, conceptRule))


@router.patch(_RULE, name="UpdateConceptRule")
async def update_rule(
    workspace: UUID,
    conceptRule: str,
    body: ConceptRuleMessage,
    ctx: Context,
    rules: Rules,
    update_mask: UpdateMask = None,
) -> ConceptRuleMessage:
    paths = _RULE_FIELDS.parse(update_mask, body).paths
    record = await rules.update(ctx, workspace, conceptRule, _rule_draft(workspace, body), paths, etag=body.etag)
    return rule_message(record)


@router.delete(_RULE, name="DeleteConceptRule")
async def delete_rule(workspace: UUID, conceptRule: str, ctx: Context, rules: Rules, etag: Etag = None) -> Empty:
    await rules.delete(ctx, workspace, conceptRule, etag=etag)
    return Empty()


# -- Proposals -----------------------------------------------------------------------

_PROPOSAL = f"{_WS}/conceptProposals/{{conceptProposal:id}}"


def _proposal_id(value: str) -> UUID:
    try:
        return UUID(value)
    except ValueError:
        raise InvalidArgument.for_field("conceptProposal", "A proposal ID is a UUID.") from None


@router.get(f"{_WS}/conceptProposals", name="ListConceptProposals")
async def list_proposals(
    workspace: UUID, ctx: Context, proposals: Proposals, params: Paging
) -> ListConceptProposalsResponse:
    query, paging = list_query(
        params, parent=f"workspaces/{workspace}", filters=proposal_filters(workspace), order=PROPOSAL_ORDER
    )
    rows, total = await proposals.list(ctx, workspace, query)
    page = paging.page(rows, total_size=total)
    return ListConceptProposalsResponse(
        concept_proposals=[proposal_message(record) for record in page.items],
        next_page_token=page.next_page_token or None,
        total_size=page.total_size,
    )


@router.get(_PROPOSAL, name="GetConceptProposal")
async def get_proposal(
    workspace: UUID, conceptProposal: str, ctx: Context, proposals: Proposals
) -> ConceptProposalMessage:
    return proposal_message(await proposals.get(ctx, workspace, _proposal_id(conceptProposal)))


@router.post(f"{_PROPOSAL}:accept", name="AcceptConceptProposal")
async def accept_proposal(
    workspace: UUID, conceptProposal: str, body: AcceptConceptProposalRequest, ctx: Context, proposals: Proposals
) -> ConceptProposalMessage:
    overrides: dict[str, Any] = {}
    if body.concept is not None:
        paths = _CONCEPT_FIELDS.parse(None, body.concept).paths
        named = ("broader", "related")
        # broader/related stay names: the service checks them against the proposal's scheme.
        overrides = concept_changes(tuple(path for path in paths if path not in named), body.concept, workspace, "")
        for path in named:
            if path in paths:
                overrides[path] = list(getattr(body.concept, path) or ())
    record = await proposals.accept(
        ctx,
        workspace,
        _proposal_id(conceptProposal),
        concept_id=body.concept_id,
        overrides=overrides,
        label_kind=body.label_kind.lower() if body.label_kind else None,
        language_code=body.language_code,
    )
    return proposal_message(record)


@router.post(f"{_PROPOSAL}:reject", name="RejectConceptProposal")
async def reject_proposal(
    workspace: UUID, conceptProposal: str, body: RejectConceptProposalRequest, ctx: Context, proposals: Proposals
) -> ConceptProposalMessage:
    return proposal_message(await proposals.reject(ctx, workspace, _proposal_id(conceptProposal)))


# -- Shared labels -------------------------------------------------------------------


@router.get(f"{_WS}/sharedLabels", name="ListSharedLabels")
async def list_shared_labels(
    workspace: UUID,
    ctx: Context,
    shared: SharedLabels,
    page_size: Annotated[int | None, Query(alias="pageSize")] = None,
    page_token: Annotated[str | None, Query(alias="pageToken")] = None,
    filter: Annotated[str | None, Query()] = None,
) -> ListSharedLabelsResponse:
    cross: bool | None = None
    scheme_code: str | None = None
    node = parse(filter)
    if node is not None and not isinstance(node, (And, Restriction)):
        raise InvalidArgument.for_field("filter", "Combine crossScheme and scheme with AND only.")
    if isinstance(node, And) and not all(isinstance(operand, Restriction) for operand in node.operands):
        raise InvalidArgument.for_field("filter", "Combine crossScheme and scheme with AND only.")
    for restriction in restrictions(node):
        if restriction.field == "crossScheme" and restriction.value.text in ("true", "false"):
            cross = restriction.value.text == "true"
        elif restriction.field == "scheme":
            scheme_code = parse_scheme(restriction.value.text, workspace, field="filter")
        else:
            raise InvalidArgument.for_field("filter", "Filter on crossScheme (true/false) and scheme only.")
    paging = PageRequest.from_params(
        page_size, page_token, query_fingerprint(parent=f"workspaces/{workspace}", filter=filter or "")
    )
    records = await shared.list(ctx, workspace, cross_scheme=cross, scheme_code=scheme_code)
    page = paging.page(records[paging.offset : paging.offset + paging.fetch_limit])
    return ListSharedLabelsResponse(
        shared_labels=[shared_label_message(record) for record in page.items],
        next_page_token=page.next_page_token or None,
    )


__all__ = ["router"]
