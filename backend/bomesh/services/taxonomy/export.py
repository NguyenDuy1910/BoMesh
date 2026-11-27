"""ExportConceptSchemeVersion: a published version as SKOS (Turtle or JSON-LD).

Pure serializers over the stored snapshot. IRIs are the resource names under
the API base URL (``https://host/api/v1/workspaces/w/conceptSchemes/s/concepts/c``);
external mapping targets are ``urn:{system}:{code}``. Deprecated concepts carry
``owl:deprecated true`` and ``dct:isReplacedBy``; groups are ``skos:Collection``.
"""

from __future__ import annotations

import json
from typing import Any
from uuid import UUID

from sqlalchemy import select

from bomesh.db.engine import transaction_scope
from bomesh.db.models.taxonomy import ConceptSchemeVersion
from bomesh.errors import InvalidArgument, NotFound
from bomesh.services.kernel.context import RequestContext
from bomesh.services.taxonomy.names import concept_name, group_name, scheme_name, version_name
from bomesh.services.taxonomy.records import ExportResult
from bomesh.services.taxonomy.snapshot import ConceptView, SchemeSnapshot, from_json
from bomesh.services.taxonomy.support import TaxonomyDeps, authorize, load_scheme

FORMATS = {"turtle": "text/turtle", "json_ld": "application/ld+json"}
_MATCH = {"exact": "exactMatch", "close": "closeMatch", "broad": "broadMatch", "narrow": "narrowMatch"}
_PREFIXES = {
    "skos": "http://www.w3.org/2004/02/skos/core#",
    "dct": "http://purl.org/dc/terms/",
    "owl": "http://www.w3.org/2002/07/owl#",
    "xsd": "http://www.w3.org/2001/XMLSchema#",
}


class _Iris:
    def __init__(self, base: str, tenant_id: UUID | None, snapshot: SchemeSnapshot) -> None:
        self.base = base.rstrip("/") + "/"
        self.tenant_id = tenant_id
        self.snapshot = snapshot

    def scheme(self) -> str:
        return self.base + scheme_name(self.tenant_id, self.snapshot.code)

    def concept(self, cid: UUID) -> str:
        view = self.snapshot.concepts[cid]
        return self.base + concept_name(self.tenant_id, self.snapshot.code, view.notation)

    def group(self, code: str) -> str:
        return self.base + group_name(self.tenant_id, self.snapshot.code, code)


def _narrower(snapshot: SchemeSnapshot) -> dict[UUID, list[UUID]]:
    found: dict[UUID, list[UUID]] = {}
    for view in snapshot.concepts.values():
        for parent in view.broader:
            if parent in snapshot.concepts:
                found.setdefault(parent, []).append(view.id)
    return found


def _ordered(snapshot: SchemeSnapshot) -> list[ConceptView]:
    return sorted(snapshot.concepts.values(), key=lambda view: view.notation)


def _literal(text: str, language: str | None = None) -> str:
    escaped = (
        text.replace("\\", "\\\\")
        .replace('"', '\\"')
        .replace("\n", "\\n")
        .replace("\r", "\\r")
        .replace("\t", "\\t")
    )
    return f'"{escaped}"' + (f"@{language}" if language else "")


def turtle(snapshot: SchemeSnapshot, base: str, tenant_id: UUID | None) -> str:
    iris = _Iris(base, tenant_id, snapshot)
    narrower = _narrower(snapshot)
    lines = [f"@prefix {prefix}: <{iri}> ." for prefix, iri in _PREFIXES.items()]
    lines.append("")
    tops = [view.id for view in _ordered(snapshot) if view.state == "published" and snapshot.is_top(view.id)]
    scheme = [
        f"<{iris.scheme()}> a skos:ConceptScheme",
        f"    skos:prefLabel {_literal(snapshot.name)}",
        f"    dct:hasVersion {_literal(str(snapshot.version))}",
        *(f"    skos:hasTopConcept <{iris.concept(cid)}>" for cid in tops),
    ]
    lines.append(" ;\n".join(scheme) + " .")
    for view in _ordered(snapshot):
        statements = [
            f"<{iris.concept(view.id)}> a skos:Concept",
            f"    skos:inScheme <{iris.scheme()}>",
            f"    skos:notation {_literal(view.notation)}",
        ]
        if view.id in tops:
            statements.append(f"    skos:topConceptOf <{iris.scheme()}>")
        statements += [
            f"    skos:prefLabel {_literal(text, language)}"
            for language, text in sorted(view.pref_labels.items())
        ]
        statements += [f"    skos:altLabel {_literal(text, language)}" for language, text in view.alt_labels]
        statements += [f"    skos:hiddenLabel {_literal(text, language)}" for language, text in view.hidden_labels]
        if view.definition:
            statements.append(f"    skos:definition {_literal(view.definition)}")
        if view.scope_note:
            statements.append(f"    skos:scopeNote {_literal(view.scope_note)}")
        statements += [f"    skos:example {_literal(example)}" for example in view.examples]
        statements += [
            f"    skos:broader <{iris.concept(parent)}>" for parent in view.broader if parent in snapshot.concepts
        ]
        statements += [
            f"    skos:narrower <{iris.concept(child)}>"
            for child in sorted(narrower.get(view.id, ()), key=lambda cid: snapshot.concepts[cid].notation)
        ]
        statements += [
            f"    skos:related <{iris.concept(other)}>" for other in view.related if other in snapshot.concepts
        ]
        statements += [
            f"    skos:{_MATCH[match]} <urn:{system}:{code}>" for system, code, _label, match in view.mappings
        ]
        if view.state == "deprecated":
            statements.append('    owl:deprecated "true"^^xsd:boolean')
            statements += [
                f"    dct:isReplacedBy <{iris.concept(target)}>"
                for target in view.replaced_by
                if target in snapshot.concepts
            ]
        lines.append("")
        lines.append(" ;\n".join(statements) + " .")
    for group in snapshot.groups:
        statements = [
            f"<{iris.group(group.code)}> a skos:Collection",
            f"    skos:prefLabel {_literal(group.name)}",
            *(f"    skos:member <{iris.concept(member)}>" for member in group.members if member in snapshot.concepts),
        ]
        lines.append("")
        lines.append(" ;\n".join(statements) + " .")
    return "\n".join(lines) + "\n"


def json_ld(snapshot: SchemeSnapshot, base: str, tenant_id: UUID | None) -> str:
    iris = _Iris(base, tenant_id, snapshot)
    narrower = _narrower(snapshot)

    def ref(iri: str) -> dict[str, str]:
        return {"@id": iri}

    def labels(values: list[tuple[str, str]]) -> list[dict[str, str]]:
        return [{"@value": text, "@language": language} for language, text in values]

    tops = [view.id for view in _ordered(snapshot) if view.state == "published" and snapshot.is_top(view.id)]
    graph: list[dict[str, Any]] = [
        {
            "@id": iris.scheme(),
            "@type": "skos:ConceptScheme",
            "skos:prefLabel": snapshot.name,
            "dct:hasVersion": str(snapshot.version),
            "skos:hasTopConcept": [ref(iris.concept(cid)) for cid in tops],
        }
    ]
    for view in _ordered(snapshot):
        node: dict[str, Any] = {
            "@id": iris.concept(view.id),
            "@type": "skos:Concept",
            "skos:inScheme": ref(iris.scheme()),
            "skos:notation": view.notation,
            "skos:prefLabel": labels(sorted(view.pref_labels.items())),
        }
        if view.id in tops:
            node["skos:topConceptOf"] = ref(iris.scheme())
        if view.alt_labels:
            node["skos:altLabel"] = labels(list(view.alt_labels))
        if view.hidden_labels:
            node["skos:hiddenLabel"] = labels(list(view.hidden_labels))
        if view.definition:
            node["skos:definition"] = view.definition
        if view.scope_note:
            node["skos:scopeNote"] = view.scope_note
        if view.examples:
            node["skos:example"] = list(view.examples)
        for key, ids in (
            ("skos:broader", [cid for cid in view.broader if cid in snapshot.concepts]),
            ("skos:narrower", sorted(narrower.get(view.id, ()), key=lambda cid: snapshot.concepts[cid].notation)),
            ("skos:related", [cid for cid in view.related if cid in snapshot.concepts]),
        ):
            if ids:
                node[key] = [ref(iris.concept(cid)) for cid in ids]
        for system, code, _label, match in view.mappings:
            node.setdefault(f"skos:{_MATCH[match]}", []).append(ref(f"urn:{system}:{code}"))
        if view.state == "deprecated":
            node["owl:deprecated"] = True
            replaced = [ref(iris.concept(cid)) for cid in view.replaced_by if cid in snapshot.concepts]
            if replaced:
                node["dct:isReplacedBy"] = replaced
        graph.append(node)
    for group in snapshot.groups:
        graph.append(
            {
                "@id": iris.group(group.code),
                "@type": "skos:Collection",
                "skos:prefLabel": group.name,
                "skos:member": [
                    ref(iris.concept(member)) for member in group.members if member in snapshot.concepts
                ],
            }
        )
    return json.dumps({"@context": _PREFIXES, "@graph": graph}, ensure_ascii=False, indent=2) + "\n"


class ExportService:
    def __init__(self, deps: TaxonomyDeps) -> None:
        self._deps = deps

    @classmethod
    def from_runtime(cls, runtime: Any) -> ExportService:
        return cls(TaxonomyDeps.from_runtime(runtime))

    async def export(
        self,
        ctx: RequestContext,
        tenant_id: UUID | None,
        code: str,
        version: int,
        *,
        format: str,
        base: str,
    ) -> ExportResult:
        await authorize(ctx, tenant_id, "conceptSchemes.get", write=False)
        format = format.lower()
        if format not in FORMATS:
            raise InvalidArgument.for_field("format", "TURTLE or JSON_LD.")
        async with transaction_scope(self._deps.sessions) as session:
            scheme = await load_scheme(session, tenant_id, code)
            data = await session.scalar(
                select(ConceptSchemeVersion.snapshot).where(
                    ConceptSchemeVersion.scheme_id == scheme.id, ConceptSchemeVersion.version == version
                )
            )
        if data is None:
            raise NotFound(f"'{version_name(tenant_id, code, version)}' does not exist.")
        snapshot = from_json(data)
        content = turtle(snapshot, base, tenant_id) if format == "turtle" else json_ld(snapshot, base, tenant_id)
        return ExportResult(format=format, mime_type=FORMATS[format], content=content)


__all__ = ["ExportService", "json_ld", "turtle"]
