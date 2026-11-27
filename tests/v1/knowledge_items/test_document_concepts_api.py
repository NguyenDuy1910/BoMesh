"""Document concepts, issuance and applicability through the Item API, MergeItem's move
of them, Confirm/RejectConceptAssignments by filter, TestClassification and
CompileClassificationPrompt (``openapi.yaml``; ``api_design.md`` Knowledge; ``document_contract.md`` "Processing")."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from datetime import date
from types import SimpleNamespace
from typing import Any

import pytest
from sqlalchemy import select

from bomesh.db.engine import transaction_scope
from bomesh.db.models import Item, ItemConcept, Tenant, User
from bomesh.document_index import ItemIndex, SemanticContextualizer
from bomesh.runtime import AppRuntime
from bomesh.services.taxonomy.assignments import replace_machine_assignments
from bomesh.services.taxonomy.classification import (
    ExtractedMetadata,
    MachineAssignment,
    SchemeResult,
)
from bomesh.services.taxonomy.profiles import write_extracted_profile
from harness import Fakes, World
from knowledge_support import Knowledge, item_url, ws_url
from taxonomy_support import C, R, S, Taxonomy, label, profile, seed_taxonomy

pytestmark = pytest.mark.asyncio


@dataclass(frozen=True, slots=True)
class Scene:
    workspace: Tenant
    admin: User
    taxonomy: Taxonomy

    def concept(self, scheme: str, notation: str) -> str:
        return f"workspaces/{self.workspace.id}/conceptSchemes/{scheme}/concepts/{notation}"

    def scheme(self, scheme: str) -> str:
        return f"workspaces/{self.workspace.id}/conceptSchemes/{scheme}"


async def _scene(world: World, sessions: Any, *, rules: tuple[R, ...] = ()) -> Scene:
    admin = await world.make_user()
    workspace = await world.make_workspace(admin)
    taxonomy = await seed_taxonomy(
        sessions,
        workspace,
        admin,
        {
            "domain": S(
                (
                    C("it", "Công nghệ thông tin"),
                    C("ai", "Trí tuệ nhân tạo", broader=("it",)),
                    C("data", "Khoa học dữ liệu", broader=("it",)),
                    C("law", "Luật"),
                ),
                name="Lĩnh vực",
                max_labels=2,
                has_primary=True,
                assign_top_concepts=False,
            ),
            "doc-type": S((C("decision", "Quyết định"), C("plan", "Kế hoạch")), max_labels=1),
            "org-unit": S(
                (C("training", "Phòng Đào tạo"), C("main", "Cơ sở chính")), purpose="authority"
            ),
            "program": S((C("de", "Chương trình Robot học"),), purpose="authority"),
        },
        rules=rules,
    )
    return Scene(workspace, admin, taxonomy)


async def _rows(sessions: Any, item: Item) -> list[ItemConcept]:
    async with transaction_scope(sessions) as session:
        return list(
            await session.scalars(select(ItemConcept).where(ItemConcept.item_id == item.id))
        )


# -- UpdateItem / read ------------------------------------------------------------------


async def test_update_item_sets_concepts_and_reads_omit_rejected(
    client, world: World, sessions
) -> None:
    scene = await _scene(world, sessions)
    collection = await world.make_collection(scene.workspace)
    document = await world.make_document(collection)
    await label(sessions, document.id, scene.taxonomy["domain"], "data", state="suggested", source="llm")
    api = await client.as_(scene.admin)

    updated = await api.patch(
        item_url(document),
        params={"updateMask": "document.concepts"},
        json={
            "document": {
                "concepts": [
                    {"concept": scene.concept("domain", "ai")},
                    {"concept": scene.concept("doc-type", "decision")},
                ]
            }
        },
    )

    assert updated.status_code == 200, updated.text
    concepts = updated.json()["document"]["concepts"]
    by_concept = {entry["concept"]: entry for entry in concepts}
    assert set(by_concept) == {scene.concept("domain", "ai"), scene.concept("doc-type", "decision")}
    ai = by_concept[scene.concept("domain", "ai")]
    assert ai["scheme"] == scene.scheme("domain")
    assert ai["source"] == "HUMAN" and ai["state"] == "ACCEPTED"
    # The only accepted label of a scheme with a primary becomes primary.
    assert ai["primary"] is True
    # The unlisted machine suggestion is rejected and no longer read.
    states = {row.concept_id: row.state for row in await _rows(sessions, document)}
    assert states[scene.taxonomy.concept("domain", "data")] == "rejected"


@pytest.mark.parametrize(
    ("concepts", "field"),
    [
        (lambda s: [{"concept": s.concept("domain", "nope")}], "document.concepts"),
        (
            lambda s: [
                {"concept": s.concept("doc-type", "decision")},
                {"concept": s.concept("doc-type", "plan")},
            ],
            "document.concepts",
        ),
        (
            lambda s: [
                {"concept": s.concept("domain", "ai"), "primary": True},
                {"concept": s.concept("domain", "data"), "primary": True},
            ],
            "document.concepts",
        ),
        (lambda s: [{"concept": s.concept("domain", "it")}], "document.concepts"),
        (lambda s: [{"concept": "workspaces/x/conceptSchemes/finance"}], "document.concepts"),
    ],
    ids=["unknown-concept", "too-many-labels", "two-primaries", "top-concept", "not-a-concept"],
)
async def test_update_item_rejects_invalid_concepts(
    client, world: World, sessions, concepts: Any, field: str
) -> None:
    scene = await _scene(world, sessions)
    collection = await world.make_collection(scene.workspace)
    document = await world.make_document(collection)

    response = await (await client.as_(scene.admin)).patch(
        item_url(document),
        params={"updateMask": "document.concepts"},
        json={"document": {"concepts": concepts(scene)}},
    )

    assert response.status_code == 400, response.text
    assert field in response.text
    assert await _rows(sessions, document) == []


async def test_missing_primary_picks_the_first_accepted_label(
    client, world: World, sessions
) -> None:
    scene = await _scene(world, sessions)
    collection = await world.make_collection(scene.workspace)
    document = await world.make_document(collection)

    response = await (await client.as_(scene.admin)).patch(
        item_url(document),
        params={"updateMask": "document.concepts"},
        json={
            "document": {
                "concepts": [
                    {"concept": scene.concept("domain", "data")},
                    {"concept": scene.concept("domain", "ai")},
                ]
            }
        },
    )

    assert response.status_code == 200, response.text
    primary = [entry["concept"] for entry in response.json()["document"]["concepts"] if entry.get("primary")]
    assert primary == [scene.concept("domain", "data")]


async def test_update_item_sets_issuance_and_applicability(
    client, world: World, sessions
) -> None:
    scene = await _scene(world, sessions)
    collection = await world.make_collection(scene.workspace)
    document = await world.make_document(collection)
    old = await world.make_document(collection, item_name="Old decision")
    api = await client.as_(scene.admin)
    old_name = f"workspaces/{scene.workspace.id}/items/{old.id}"

    response = await api.patch(
        item_url(document),
        params={"updateMask": "document.issuance,document.applicability"},
        json={
            "document": {
                "issuance": {
                    "issuer": scene.concept("org-unit", "training"),
                    "campus": scene.concept("org-unit", "main"),
                    "number": "123/QĐ-ĐHCNKT-ĐT",
                    "issueDate": "2025-08-05",
                    "effectiveDate": "2025-09-01",
                    "supersedes": [old_name],
                },
                "applicability": {
                    "level": "PROGRAM",
                    "programs": [scene.concept("program", "de")],
                    "cohorts": [2025],
                },
            }
        },
    )

    assert response.status_code == 200, response.text
    shown = response.json()["document"]
    assert shown["issuance"] == {
        "issuer": scene.concept("org-unit", "training"),
        "campus": scene.concept("org-unit", "main"),
        "number": "123/QĐ-ĐHCNKT-ĐT",
        "issueDate": "2025-08-05",
        "effectiveDate": "2025-09-01",
        "supersedes": [old_name],
    }
    assert shown["applicability"]["level"] == "PROGRAM"
    assert shown["applicability"]["programs"] == [scene.concept("program", "de")]
    assert shown["applicability"]["cohorts"] == [2025]

    wrong = await api.patch(
        item_url(document),
        params={"updateMask": "document.issuance"},
        json={"document": {"issuance": {"issuer": scene.concept("domain", "ai")}}},
    )
    assert wrong.status_code == 400
    assert "document.issuance.issuer" in wrong.text


async def test_human_fields_survive_a_later_indexing(
    client, world: World, sessions
) -> None:
    scene = await _scene(world, sessions)
    collection = await world.make_collection(scene.workspace)
    document = await world.make_document(collection)
    api = await client.as_(scene.admin)
    await api.patch(
        item_url(document),
        params={"updateMask": "document.concepts,document.issuance"},
        json={
            "document": {
                "concepts": [{"concept": scene.concept("domain", "ai")}],
                "issuance": {"number": "1/QĐ"},
            }
        },
    )
    domain = scene.taxonomy["domain"]

    async with transaction_scope(sessions) as session:
        await replace_machine_assignments(
            session,
            document.id,
            [
                SchemeResult(
                    scheme_id=domain.scheme_id,
                    scheme_code="domain",
                    scheme_version=1,
                    outcome="assigned",
                    confidence=0.97,
                    assignments=(
                        MachineAssignment(
                            concept_id=domain["data"],
                            primary=True,
                            confidence=0.97,
                            source="llm",
                            state="accepted",
                            evidence={"quote": "luật"},
                        ),
                    ),
                )
            ],
            revision_number=1,
        )
        await write_extracted_profile(
            session,
            document.id,
            scene.workspace.id,
            ExtractedMetadata(number="999/QĐ", issued_on=date(2025, 1, 2)),
            revision_number=1,
        )

    shown = (await api.get(item_url(document))).json()["document"]
    by_concept = {entry["concept"]: entry for entry in shown["concepts"]}
    ai = by_concept[scene.concept("domain", "ai")]
    assert (ai["source"], ai["state"], ai["primary"]) == ("HUMAN", "ACCEPTED", True)
    # The machine's pick next to a person's labels is only a suggestion.
    assert by_concept[scene.concept("domain", "data")]["state"] == "SUGGESTED"
    assert shown["issuance"]["number"] == "1/QĐ"
    # A person's issuance marks every field: extraction fills none of them.
    assert "issueDate" not in shown["issuance"]


# -- MergeItem ---------------------------------------------------------------------------


async def test_merge_moves_concepts_and_profile_to_the_kept_document(
    client, world: World, sessions
) -> None:
    scene = await _scene(world, sessions)
    collection = await world.make_collection(scene.workspace)
    duplicate = await world.make_document(collection, item_name="Copy")
    kept = await world.make_document(collection, item_name="Original")
    await label(sessions, duplicate.id, scene.taxonomy["domain"], "ai", primary="ai")
    await profile(
        sessions,
        duplicate.id,
        level="unit",
        applies_to=[scene.taxonomy.concept("org-unit", "training")],
        issued_on=date(2025, 8, 5),
    )
    api = await client.as_(scene.admin)

    merged = await api.post(
        item_url(duplicate, ":merge"),
        json={"targetItem": f"workspaces/{scene.workspace.id}/items/{kept.id}"},
    )

    assert merged.status_code == 200, merged.text
    shown = (await api.get(item_url(kept))).json()["document"]
    assert [entry["concept"] for entry in shown["concepts"]] == [scene.concept("domain", "ai")]
    assert shown["issuance"]["issueDate"] == "2025-08-05"
    assert shown["applicability"]["level"] == "UNIT"
    assert shown["applicability"]["units"] == [scene.concept("org-unit", "training")]
    assert await _rows(sessions, duplicate) == []


# -- Confirm / Reject --------------------------------------------------------------------


async def test_confirm_and_reject_by_filter_respect_items_update(
    client, world: World, sessions
) -> None:
    scene = await _scene(world, sessions)
    editor = await world.add_member(scene.workspace)
    editable = await world.make_collection(scene.workspace, grants={editor: "roles/collectionEditor"})
    readable = await world.make_collection(scene.workspace, grants={editor: "roles/collectionViewer"})
    mine = await world.make_document(editable)
    other = await world.make_document(editable)
    theirs = await world.make_document(readable)
    domain = scene.taxonomy["domain"]
    for document in (mine, other, theirs):
        await label(sessions, document.id, domain, "ai", state="suggested", source="llm")
    api = await client.as_(editor)
    concept = scene.concept("domain", "ai")

    confirmed = await api.post(
        f"/api/v1/{concept}:confirmAssignments",
        json={"filter": f'parentItem = "workspaces/{scene.workspace.id}/items/{editable.id}"'},
    )
    everywhere = await api.post(f"/api/v1/{concept}:rejectAssignments", json={})

    assert confirmed.status_code == 200, confirmed.text
    assert confirmed.json() == {"confirmedCount": 2}
    assert everywhere.json() == {"rejectedCount": 2}
    state = {
        document.id: (await _rows(sessions, document))[0] for document in (mine, other, theirs)
    }
    assert state[mine.id].state == state[other.id].state == "rejected"
    assert state[mine.id].reviewed_by_user_id == editor.id
    # Read access alone does not let the caller decide.
    assert state[theirs.id].state == "suggested"

    missing = await api.post(
        f"/api/v1/{scene.concept('domain', 'nope')}:confirmAssignments", json={}
    )
    assert missing.status_code == 404


# -- TestClassification / CompileClassificationPrompt -----------------------------------


class _Model:
    """The configured contextualization model: picks the label of ``pick`` from the prompt."""

    model = "configured-contextualization-model"

    def __init__(self, pick: str) -> None:
        self.pick = pick
        self.calls = 0

    async def responses(self, *, input: Any, model: str | None = None, **_: Any) -> Any:
        if isinstance(input, str):
            return SimpleNamespace(output_text="context")
        self.calls += 1
        prompt = "\n\n".join(block["text"] for block in input[0]["content"])
        match = re.search(rf"^(\S+) \|[^\n]*{re.escape(self.pick)}", prompt, re.MULTILINE)
        assert match is not None, prompt
        answer = {
            "schemes": {
                "domain": {"primary": match.group(1), "certainty": "high", "evidence": "trí tuệ nhân tạo"},
                "doc-type": {"none": True, "certainty": "low"},
            },
            "summary": "A plan for AI courses.",
            "title": "Kế hoạch",
        }
        return SimpleNamespace(output_text=json.dumps(answer, ensure_ascii=False))


def _with_model(runtime: AppRuntime, fakes: Fakes, model: _Model) -> None:
    runtime._index = ItemIndex(
        backend=fakes.index_backend,  # type: ignore[arg-type]
        embedder=fakes.embedder,
        semantic_contextualizer=SemanticContextualizer(
            model, model_name=model.model  # type: ignore[arg-type]
        ),
    )


async def test_test_classification_classifies_a_sample_without_writing(
    client, world: World, sessions, runtime: AppRuntime, fakes: Fakes
) -> None:
    scene = await _scene(world, sessions)
    model = _Model("Trí tuệ nhân tạo")
    _with_model(runtime, fakes, model)
    api = await client.as_(scene.admin)

    response = await api.post(
        f"{ws_url(scene.workspace)}/conceptSchemes:testClassification",
        json={
            "title": "Kế hoạch đào tạo trí tuệ nhân tạo",
            "text": "Số: 12/KH-ĐHCNKT-ĐT\nKế hoạch mở các học phần trí tuệ nhân tạo cho sinh viên.",
        },
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["modelCalled"] is True and model.calls == 1
    assert [a["concept"] for a in body["assignments"]] == [scene.concept("domain", "ai")]
    assert body["assignments"][0]["source"] == "LLM"
    outcomes = {o["scheme"]: o["outcome"] for o in body["outcomes"]}
    assert outcomes[scene.scheme("domain")] == "ASSIGNED"
    assert outcomes[scene.scheme("doc-type")] in {"EMPTY", "UNCERTAIN"}
    ai = [c for c in body["candidates"] if c["concept"] == scene.concept("domain", "ai")]
    assert ai and "LEXICAL" in {signal["kind"] for signal in ai[0]["signals"]}
    assert body["issuance"]["number"] == "12/KH-ĐHCNKT-ĐT"
    assert body["summary"] == "A plan for AI courses."
    async with transaction_scope(sessions) as session:
        assert list(await session.scalars(select(ItemConcept))) == []


async def test_classification_tools_need_concept_schemes_update(
    client, world: World, sessions
) -> None:
    scene = await _scene(world, sessions)
    member = await client.as_(await world.add_member(scene.workspace))
    base = f"{ws_url(scene.workspace)}/conceptSchemes"

    tested = await member.post(f"{base}:testClassification", json={"title": "x", "text": "y"})
    compiled = await member.get(f"{base}:compileClassificationPrompt")

    assert tested.status_code == 403
    assert compiled.status_code == 403


async def test_compile_classification_prompt_lists_schemes_and_rules(
    client, world: World, sessions
) -> None:
    scene = await _scene(
        world,
        sessions,
        rules=(R("de-is-data", then=("domain", "data"), when_concept=("program", "de")),),
    )

    response = await (await client.as_(scene.admin)).get(
        f"{ws_url(scene.workspace)}/conceptSchemes:compileClassificationPrompt"
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert "Trí tuệ nhân tạo" in body["prompt"] and "Quyết định" in body["prompt"]
    # Authority schemes are not asked of the model.
    assert "Chương trình Robot học" not in body["prompt"]
    assert body["rules"] == [f"workspaces/{scene.workspace.id}/conceptRules/de-is-data"]
    assert body["estimatedTokens"] > 0
