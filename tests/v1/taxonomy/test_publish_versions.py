"""PublishConceptScheme and versions through the API (``item_model.md`` §4.13; ``api_design.md`` ConceptScheme ``:publish``).

Publish validates the prospective version, stores an immutable snapshot,
flips drafts and pending deprecations, rebuilds the closure and plans the
reclassification; the real ``assignments.remap`` and
``reclassify.schedule_reclassification`` run behind it.
"""

from __future__ import annotations

from typing import Any

import pytest
from sqlalchemy import select, text

from bomesh.db.models import (
    ConceptClosure,
    ConceptRelation,
    ConceptRule,
    ConceptScheme,
    ConceptSchemeVersion,
    ItemClassification,
    ItemConcept,
    Operation,
)
from taxonomy_scene import TaxonomyScene

pytestmark = pytest.mark.asyncio


def _notations(concepts: list[dict[str, Any]] | None) -> list[str]:
    return [name.rsplit("/", 1)[1] for name in concepts or ()]


async def _closure(tx: TaxonomyScene, scheme: str) -> set[tuple[str, str, int]]:
    """``(ancestor, descendant, depth)`` rows of the scheme, depth > 0."""
    async with tx.sessions.begin() as session:
        ids = {}
        for notation in ("it", "ai", "ml"):
            ids[await tx.concept_id(scheme, notation)] = notation
        rows = await session.execute(
            select(ConceptClosure.ancestor_id, ConceptClosure.descendant_id, ConceptClosure.depth).where(
                ConceptClosure.descendant_id.in_(list(ids)), ConceptClosure.depth > 0
            )
        )
        return {(ids[ancestor], ids[descendant], depth) for ancestor, descendant, depth in rows.tuples()}


async def test_validate_only_reports_violations_and_warnings_without_writing(tx: TaxonomyScene) -> None:
    await tx.scheme("domain", maxDepth=2)
    await tx.concept("domain", "a")
    await tx.concept("domain", "dep")
    await tx.concept("domain", "x")
    await tx.concept("domain", "y")
    await tx.published("domain")
    deprecated = await tx.ok(
        await tx.api.post(tx.url("conceptSchemes/domain/concepts/dep:deprecate"), json={"replacedBy": []})
    )
    assert (deprecated["state"], deprecated["deprecationPending"]) == ("PUBLISHED", True)
    # I8: a new narrower concept under a concept whose deprecation is pending.
    await tx.concept("domain", "orphan", broader=["dep"])
    # I6: a > b > c is three levels; the scheme allows two.
    await tx.concept("domain", "b", broader=["a"])
    await tx.concept("domain", "c", broader=["b"])
    # I4: related to its own ancestor.
    await tx.concept("domain", "r", broader=["a"], related=[tx.concept_name("domain", "a")])
    # I7: no definition.
    await tx.concept("domain", "nodef", definition=None)
    # I3: z has two parents x and y. The API and the concept_relations trigger
    # both refuse x → z; the edge is written with triggers off (legacy data) to
    # show the validator is the last line of defence.
    await tx.concept("domain", "z", broader=["x", "y"])
    x_id, z_id = await tx.concept_id("domain", "x"), await tx.concept_id("domain", "z")
    async with tx.sessions.begin() as session:
        await session.execute(text("SET LOCAL session_replication_role = replica"))
        session.add(ConceptRelation(source_concept_id=x_id, target_concept_id=z_id, kind="broader"))
        await session.flush()
    # W1: one label on two concepts of the scheme.
    await tx.concept("domain", "w1", altLabels=[{"languageCode": "vi", "text": "Trùng"}])
    await tx.concept("domain", "w2", altLabels=[{"languageCode": "vi", "text": "trùng"}])
    before = await tx.ok(await tx.api.get(tx.url("conceptSchemes/domain")))

    operation = await tx.ok(await tx.publish("domain", validate_only=True))

    assert operation["done"] is True
    preview = operation["response"]
    assert preview["version"] == 2
    found = {
        (violation["invariant"], tuple(sorted(_notations(violation.get("concepts")))))
        for violation in preview["violations"]
    }
    assert ("BROADER_CYCLE", ("x", "z")) in found
    assert ("RELATED_IN_HIERARCHY", ("a", "r")) in found
    assert ("MAX_DEPTH", ("c",)) in found
    assert ("DEFINITION_REQUIRED", ("nodef",)) in found
    assert ("DEPRECATION", ("dep", "orphan")) in found
    warnings = {warning["kind"]: warning for warning in preview["warnings"]}
    assert sorted(_notations(warnings["SHARED_LABEL"]["concepts"])) == ["w1", "w2"]
    assert "TOP_CONCEPT_COUNT" in warnings

    # Nothing was written: no version, no state change, no stored operation, no audit.
    after = await tx.ok(await tx.api.get(tx.url("conceptSchemes/domain")))
    assert (after["publishedVersion"], after["etag"]) == (1, before["etag"])
    versions = await tx.ok(await tx.api.get(tx.url("conceptSchemes/domain/versions")))
    assert [version["version"] for version in versions["conceptSchemeVersions"]] == [1]
    assert (await tx.ok(await tx.api.get(tx.url("conceptSchemes/domain/concepts/b"))))["state"] == "DRAFT"
    dep = await tx.ok(await tx.api.get(tx.url("conceptSchemes/domain/concepts/dep")))
    assert (dep["state"], dep["deprecationPending"]) == ("PUBLISHED", True)
    async with tx.sessions.begin() as session:
        verbs = list(await session.scalars(select(Operation.verb).where(Operation.tenant_id == tx.ws.id)))
    assert verbs == ["publishConceptScheme"]
    assert (await tx.audit_actions()).count("PublishConceptScheme") == 1

    refused = await tx.publish("domain")
    assert refused.status_code == 400, refused.text
    error = refused.json()["error"]
    assert error["status"] == "FAILED_PRECONDITION"
    assert any(detail.get("reason") == "TAXONOMY_INVALID" for detail in error["details"])


async def test_publish_versions_snapshots_states_and_closure(tx: TaxonomyScene) -> None:
    scheme = await tx.scheme("domain")
    await tx.concept("domain", "it", "Công nghệ thông tin")
    await tx.concept("domain", "ai", "Trí tuệ nhân tạo", broader=["it"])
    await tx.concept("domain", "ml", "Học máy")
    await tx.concept("domain", "old", "Cũ")
    stale = await tx.api.post(
        tx.url("conceptSchemes/domain:publish"), json={"etag": scheme["etag"]}
    )
    assert stale.status_code == 409, stale.text
    assert stale.json()["error"]["status"] == "ABORTED"
    current = await tx.ok(await tx.api.get(tx.url("conceptSchemes/domain")))

    operation = await tx.ok(
        await tx.api.post(tx.url("conceptSchemes/domain:publish"), json={"etag": current["etag"]})
    )

    assert operation["done"] is True and "error" not in operation
    first = operation["response"]
    assert (first["version"], first["conceptCount"]) == (1, 4)
    assert {change["kind"] for change in first["changes"]} == {"ADDED"}
    assert first["publisher"] == f"users/{tx.admin.id}"
    ai = await tx.ok(await tx.api.get(tx.url("conceptSchemes/domain/concepts/ai")))
    assert (ai["state"], ai["firstVersion"]) == ("PUBLISHED", 1)
    assert await _closure(tx, "domain") == {("it", "ai", 1)}
    v1_export = await tx.ok(
        await tx.api.get(tx.url("conceptSchemes/domain/versions/1:export"), params={"format": "JSON_LD"})
    )
    nothing = await tx.publish("domain")
    assert nothing.status_code == 400
    assert nothing.json()["error"]["status"] == "FAILED_PRECONDITION"

    # Working-copy edits: rename, move, a new draft and a pending deprecation.
    await tx.ok(
        await tx.api.patch(
            tx.url("conceptSchemes/domain/concepts/ai"),
            params={"updateMask": "prefLabels"},
            json={"prefLabels": [{"languageCode": "vi", "text": "AI"}]},
        )
    )
    await tx.ok(
        await tx.api.patch(
            tx.url("conceptSchemes/domain/concepts/ml"),
            params={"updateMask": "broader"},
            json={"broader": [tx.concept_name("domain", "ai")]},
        )
    )
    await tx.concept("domain", "new", broader=["it"])
    await tx.ok(
        await tx.api.post(
            tx.url("conceptSchemes/domain/concepts/old:deprecate"),
            json={"replacedBy": [tx.concept_name("domain", "it")]},
        )
    )
    # The closure is the published graph: the move is not there yet.
    assert await _closure(tx, "domain") == {("it", "ai", 1)}

    second = await tx.published("domain")

    assert second["version"] == 2
    assert {(change["kind"], _notations([change["concept"]])[0]) for change in second["changes"]} == {
        ("ADDED", "new"),
        ("RELABELED", "ai"),
        ("MOVED", "ml"),
        ("DEPRECATED", "old"),
    }
    assert await _closure(tx, "domain") == {("it", "ai", 1), ("ai", "ml", 1), ("it", "ml", 2)}
    new = await tx.ok(await tx.api.get(tx.url("conceptSchemes/domain/concepts/new")))
    assert (new["state"], new["firstVersion"]) == ("PUBLISHED", 2)
    old = await tx.ok(await tx.api.get(tx.url("conceptSchemes/domain/concepts/old")))
    assert (old["state"], old["deprecatedVersion"], old["deprecationPending"]) == ("DEPRECATED", 2, False)
    assert old["replacedBy"] == [tx.concept_name("domain", "it")]
    got = await tx.ok(await tx.api.get(tx.url("conceptSchemes/domain")))
    assert (got["publishedVersion"], got["unpublishedChanges"]) == (2, 0)

    # Version 1 is immutable: later edits and publishes leave its snapshot alone.
    assert (
        await tx.ok(
            await tx.api.get(tx.url("conceptSchemes/domain/versions/1:export"), params={"format": "JSON_LD"})
        )
    ) == v1_export
    assert '"Trí tuệ nhân tạo"' in v1_export["content"]
    v1 = await tx.ok(await tx.api.get(tx.url("conceptSchemes/domain/versions/1")))
    assert (v1["version"], v1["conceptCount"]) == (1, 4)
    listed = await tx.ok(await tx.api.get(tx.url("conceptSchemes/domain/versions")))
    assert [version["version"] for version in listed["conceptSchemeVersions"]] == [2, 1]
    async with tx.sessions.begin() as session:
        stored = list(
            await session.scalars(select(ConceptSchemeVersion.version).order_by(ConceptSchemeVersion.version))
        )
    assert stored == [1, 2]

    actions = await tx.audit_actions()
    for action in ("CreateConceptScheme", "CreateConcept", "UpdateConcept", "DeprecateConcept"):
        assert action in actions, actions
    assert actions.count("PublishConceptScheme") == 2

    # Members read versions but never publish.
    assert (await tx.member_api.get(tx.url("conceptSchemes/domain/versions/2"))).status_code == 200
    assert (await tx.member_api.post(tx.url("conceptSchemes/domain:publish"), json={"validateOnly": True})).status_code == 403


async def _version(tx: TaxonomyScene, version: int) -> dict[str, Any]:
    return await tx.ok(await tx.api.get(tx.url(f"conceptSchemes/domain/versions/{version}")))


async def test_publish_reclassifies_only_what_changed(tx: TaxonomyScene) -> None:
    await tx.scheme("domain")
    for notation in ("a", "b", "s", "s1", "s2", "p"):
        await tx.concept("domain", notation)
    await tx.concept("domain", "p1", broader=["p"])
    await tx.published("domain")
    machine_a, human_a, split_doc, parent_doc, child_doc = [await tx.document() for _ in range(5)]
    await tx.label(machine_a, "domain", "a")
    await tx.label(human_a, "domain", "a", source="human")
    await tx.label(human_a, "domain", "b")
    await tx.label(split_doc, "domain", "s")
    await tx.label(parent_doc, "domain", "p")
    await tx.label(child_doc, "domain", "p1")
    assert await tx.runs() == []

    # Rename and redefine: no rerank, no run.
    await tx.ok(
        await tx.api.patch(
            tx.url("conceptSchemes/domain/concepts/b"),
            params={"updateMask": "prefLabels,definition"},
            json={"prefLabels": [{"languageCode": "vi", "text": "Bê"}], "definition": "Khác."},
        )
    )
    renamed = await tx.published("domain")
    assert {change["kind"] for change in renamed["changes"]} == {"RELABELED", "REDEFINED"}
    plan = renamed["reclassification"]
    assert (plan["rerank"], plan["rerunParents"], plan["thresholdsChanged"]) == ([], [], False)
    assert (await _version(tx, 2))["reclassification"]["state"] == "DONE"
    assert await tx.runs() == []

    # Merge a → b: labels remapped by publish, deduplicated, human rows stay human; no run.
    await tx.ok(
        await tx.api.post(
            tx.url("conceptSchemes/domain/concepts/a:deprecate"),
            json={"replacedBy": [tx.concept_name("domain", "b")]},
        )
    )
    merged = await tx.published("domain")
    assert merged["reclassification"]["remappedCount"] == 2
    assert merged["reclassification"]["rerank"] == []
    b_id, a_id = await tx.concept_id("domain", "b"), await tx.concept_id("domain", "a")
    [moved] = await tx.labels(machine_a)
    assert (moved.concept_id, moved.source, moved.evidence["replacedFrom"]) == (b_id, "llm", str(a_id))
    [kept] = await tx.labels(human_a)
    assert (kept.concept_id, kept.source) == (b_id, "human")
    version = await _version(tx, 3)
    assert (version["reclassification"]["state"], version["reclassification"]["runs"]) == ("DONE", [])
    assert await tx.runs() == []

    # Split s → s1, s2: one rerank entry, one run with exactly s's Documents.
    await tx.ok(
        await tx.api.post(
            tx.url("conceptSchemes/domain/concepts/s:deprecate"),
            json={"replacedBy": [tx.concept_name("domain", "s1"), tx.concept_name("domain", "s2")]},
        )
    )
    split = await tx.published("domain")
    assert split["reclassification"]["rerank"] == [
        {"concept": tx.concept_name("domain", "s"), "among": [tx.concept_name("domain", "s1"), tx.concept_name("domain", "s2")]}
    ]
    assert split["reclassification"]["remappedCount"] == 0
    [(run, items)] = await tx.runs()
    assert items == {split_doc}
    assert run.trigger_type == "taxonomy"
    version = await _version(tx, 4)
    assert version["reclassification"]["state"] == "RUNNING"
    assert version["reclassification"]["runs"] == [f"workspaces/{tx.ws.id}/ingestionRuns/{run.id}"]

    # A new child of p: rerun p's Documents among p and its children.
    await tx.concept("domain", "p2", broader=["p"])
    child = await tx.published("domain")
    assert child["reclassification"]["rerunParents"] == [
        {
            "parent": tx.concept_name("domain", "p"),
            "among": [tx.concept_name("domain", notation) for notation in ("p", "p1", "p2")],
        }
    ]
    runs = [items for found, items in await tx.runs() if found.id != run.id]
    assert runs == [{parent_doc}]

    # Thresholds change: flagged, nothing for the model.
    scheme = await tx.ok(await tx.api.get(tx.url("conceptSchemes/domain")))
    await tx.ok(
        await tx.api.patch(
            tx.url("conceptSchemes/domain"),
            params={"updateMask": "autoThreshold"},
            json={"autoThreshold": 0.9, "etag": scheme["etag"]},
        )
    )
    thresholds = await tx.published("domain")
    assert [change["kind"] for change in thresholds["changes"]] == ["THRESHOLDS"]
    assert thresholds["reclassification"]["thresholdsChanged"] is True
    assert len(await tx.runs()) == 2


async def test_changed_match_patterns_reevaluate_pattern_labels_without_the_model(tx: TaxonomyScene) -> None:
    await tx.scheme(
        "document-type", cardinality={"min": 1, "max": 1, "primary": False}, llmPolicy="FALLBACK"
    )
    await tx.concept("document-type", "quyet-dinh", "Quyết định", matchPatterns=["(?i)^\\s*quyết định"])
    # Too broad: "bảo vệ" files a defence plan as a notice.
    await tx.concept("document-type", "thong-bao", "Thông báo", matchPatterns=["(?i)bảo vệ|(?i)^\\s*thông báo"])
    await tx.concept("document-type", "ke-hoach", "Kế hoạch")
    await tx.concept("document-type", "bien-ban", "Biên bản")
    await tx.published("document-type")
    pattern = lambda text: {"pattern": text, "signals": []}
    defence_plan = await tx.document("Kế hoạch bảo vệ đồ án")
    await tx.label(defence_plan, "document-type", "thong-bao", source="rule", evidence=pattern("(?i)bảo vệ"))
    notice = await tx.document("Thông báo lịch thi")
    await tx.label(notice, "document-type", "thong-bao", source="rule", evidence=pattern("(?i)^\\s*thông báo"))
    model_plan = await tx.document("Kế hoạch năm học")
    await tx.label(model_plan, "document-type", "quyet-dinh")
    minutes = await tx.document("Biên bản họp")
    await tx.label(minutes, "document-type", "thong-bao")
    human_plan = await tx.document("Kế hoạch tuyển sinh")
    await tx.label(human_plan, "document-type", "quyet-dinh", source="human")

    for notation, patterns in (("thong-bao", ["(?i)^\\s*thông báo"]), ("ke-hoach", ["(?i)^\\s*kế hoạch"])):
        await tx.ok(
            await tx.api.patch(
                tx.url(f"conceptSchemes/document-type/concepts/{notation}"),
                params={"updateMask": "matchPatterns"},
                json={"matchPatterns": patterns},
            )
        )
    version = await tx.published("document-type")

    assert {change["kind"] for change in version["changes"]} == {"REDEFINED"}
    assert version["reclassification"]["patternsChanged"] == [
        tx.concept_name("document-type", "ke-hoach"),
        tx.concept_name("document-type", "thong-bao"),
    ]
    ids = {await tx.concept_id("document-type", n): n for n in ("quyet-dinh", "thong-bao", "ke-hoach")}

    async def labels(item) -> list[tuple[str, str, str]]:
        return sorted(
            (ids[row.concept_id], row.source, row.state)
            for row in await tx.labels(item)
        )

    # The wrong pattern label is replaced by the new pattern's, as is the model's pick a pattern now settles.
    assert await labels(defence_plan) == [("ke-hoach", "rule", "accepted")]
    assert await labels(model_plan) == [("ke-hoach", "rule", "accepted")]
    assert (await tx.labels(model_plan))[0].evidence["pattern"] == "(?i)^\\s*kế hoạch"
    # Still matched, untouched by the patterns, or a person's: unchanged.
    assert await labels(notice) == [("thong-bao", "rule", "accepted")]
    assert await labels(minutes) == [("thong-bao", "llm", "accepted")]
    assert ("quyet-dinh", "human", "accepted") in await labels(human_plan)
    # No model: nothing queued.
    assert await tx.runs() == []
    stored = await tx.ok(await tx.api.get(tx.url("conceptSchemes/document-type/versions/2")))
    assert stored["reclassification"]["state"] == "DONE"


async def test_pattern_reevaluation_recomputes_outcomes_of_every_touched_scheme(tx: TaxonomyScene) -> None:
    """The re-smoke's BM5 form: a model-suggested Bài báo (0.66) implied Công bố khoa học;
    a new Biểu mẫu pattern settles the type by rule, the implied function goes, and
    ``item_classifications`` follows: type assigned 1.0 at version 2, function uncertain."""
    await tx.scheme("function", cardinality={"min": 1, "max": 2, "primary": False})
    await tx.concept("function", "kh-cong-bo", "Công bố khoa học")
    await tx.published("function")
    await tx.scheme(
        "document-type", cardinality={"min": 1, "max": 1, "primary": False}, llmPolicy="FALLBACK"
    )
    await tx.concept("document-type", "bai-bao", "Bài báo")
    await tx.concept("document-type", "bieu-mau", "Biểu mẫu")
    await tx.published("document-type")
    bai_bao = await tx.concept_id("document-type", "bai-bao")
    kh_cong_bo = await tx.concept_id("function", "kh-cong-bo")
    form = await tx.document("BM5 Nhiệm vụ đồ án tốt nghiệp")
    async with tx.sessions.begin() as session:
        session.add(
            ConceptRule(
                tenant_id=tx.ws.id, code="bai-bao-cong-bo", when_concept_id=bai_bao,
                then_concept_id=kh_cong_bo, effect="implies",
            )
        )
        schemes = {
            code: await session.scalar(
                select(ConceptScheme.id).where(ConceptScheme.tenant_id == tx.ws.id, ConceptScheme.code == code)
            )
            for code in ("document-type", "function")
        }
        for scheme_id, concept_id, source, evidence in (
            (schemes["document-type"], bai_bao, "llm", {"signals": [], "corroborated": False}),
            (schemes["function"], kh_cong_bo, "rule", {"rule": "bai-bao-cong-bo", "signals": []}),
        ):
            session.add(
                ItemConcept(
                    item_id=form, concept_id=concept_id, scheme_id=scheme_id, source=source,
                    state="suggested", confidence=0.66, evidence=evidence,
                )
            )
            session.add(
                ItemClassification(
                    item_id=form, scheme_id=scheme_id, outcome="assigned", confidence=0.66, scheme_version=1
                )
            )

    await tx.ok(
        await tx.api.patch(
            tx.url("conceptSchemes/document-type/concepts/bieu-mau"),
            params={"updateMask": "matchPatterns"},
            json={"matchPatterns": ["(?i)^\\s*BM\\d+\\b"]},
        )
    )
    await tx.published("document-type")

    assert [(row.concept_id, row.source, row.state) for row in await tx.labels(form)] == [
        (await tx.concept_id("document-type", "bieu-mau"), "rule", "accepted")
    ]
    async with tx.sessions.begin() as session:
        outcomes = {
            row.scheme_id: (row.outcome, row.confidence, row.scheme_version)
            for row in await session.scalars(select(ItemClassification).where(ItemClassification.item_id == form))
        }
    assert outcomes == {
        schemes["document-type"]: ("assigned", 1.0, 2),
        schemes["function"]: ("uncertain", None, 1),
    }
