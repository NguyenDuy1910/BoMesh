"""Topic classification signals, ImportTopics, TestTopicClassification and the
compiled classification prompt (``api_design.md`` §5 Topic)."""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest
from sqlalchemy import select

from bomesh.db.models import IngestionSource, IntegrationConnection, ItemTopic, Topic
from bomesh.document_index import ItemIndex, SemanticContextualizer
from bomesh.runtime import AppRuntime
from curation_support import Scene, item_name
from harness import Fakes

pytestmark = pytest.mark.asyncio


class _ProfileTransport:
    """The configured contextualization model, answering CLASSIFYING prompts."""

    model = "configured-contextualization-model"

    def __init__(self, answer: str) -> None:
        self.answer = answer
        self.prompts: list[str] = []

    async def responses(self, *, input: str, model: str | None = None, **_: Any) -> Any:
        self.prompts.append(input)
        return SimpleNamespace(output_text=self.answer)


def _with_model(runtime: AppRuntime, fakes: Fakes, answer: str) -> _ProfileTransport:
    transport = _ProfileTransport(answer)
    runtime._index = ItemIndex(
        backend=fakes.index_backend,  # type: ignore[arg-type]
        embedder=fakes.embedder,
        semantic_contextualizer=SemanticContextualizer(transport, model_name=transport.model),  # type: ignore[arg-type]
    )
    return transport


def _topic(scene: Scene, code: str) -> str:
    return f"workspaces/{scene.ws.id}/topics/{code}"


async def _create(scene: Scene, code: str, **body: Any) -> Any:
    admin = await scene.as_(scene.admin)
    return await admin.post(
        scene.url("topics"), params={"topicId": code}, json={"displayName": code.title(), **body}
    )


async def _source(scene: Scene, code: str) -> None:
    async with scene.sessions.begin() as session:
        connection_id = await _connection(scene, session)
        session.add(
            IngestionSource(
                tenant_id=scene.ws.id,
                code=code,
                integration_connection_id=connection_id,
                target_item_id=scene.kb.id,
                display_name=code,
            )
        )


async def _connection(scene: Scene, session: Any) -> Any:
    connection = IntegrationConnection(
        tenant_id=scene.ws.id,
        code="drive",
        connector_key="confluence",
        display_name="Drive",
        status="active",
    )
    session.add(connection)
    await session.flush()
    return connection.id


async def test_topic_signals_round_trip_and_validate(scene: Scene) -> None:
    domain = (await _create(scene, "finance", kind="DOMAIN")).json()
    example = await scene.world.make_document(scene.kb, title="Chargeback runbook 2024")
    created = await _create(
        scene,
        "chargebacks",
        parentTopic=domain["name"],
        keywords=[" chargeback ", "Chargeback", "dispute"],
        synonyms=["hoàn tiền"],
        guidance="Card disputes only; refunds belong to Payments.",
        examples=[item_name(example)],
        rules=[{"collection": item_name(scene.kb)}],
    )

    assert created.status_code == 200, created.text
    body = created.json()
    assert body["keywords"] == ["chargeback", "dispute"]
    assert body["synonyms"] == ["hoàn tiền"]
    assert body["guidance"] == "Card disputes only; refunds belong to Payments."
    assert body["examples"] == [item_name(example)]
    assert body["rules"] == [{"collection": item_name(scene.kb)}]

    admin = await scene.as_(scene.admin)
    updated = await admin.patch(
        scene.url("topics/chargebacks"),
        params={"updateMask": "keywords,rules"},
        json={"keywords": ["napas"], "rules": [], "etag": body["etag"]},
    )
    assert updated.status_code == 200, updated.text
    assert (updated.json()["keywords"], updated.json()["rules"]) == (["napas"], [])
    assert updated.json()["guidance"] == body["guidance"]

    domain_keywords = await admin.patch(
        scene.url("topics/finance"), params={"updateMask": "keywords"}, json={"keywords": ["x"]}
    )
    both = await _create(
        scene,
        "both",
        parentTopic=domain["name"],
        rules=[{"collection": item_name(scene.kb), "source": f"workspaces/{scene.ws.id}/sources/s"}],
    )
    unknown_source = await _create(
        scene,
        "unknown-source",
        parentTopic=domain["name"],
        rules=[{"source": f"workspaces/{scene.ws.id}/sources/missing"}],
    )
    not_document = await _create(
        scene, "not-document", parentTopic=domain["name"], examples=[item_name(scene.kb)]
    )
    hidden = await scene.world.make_collection(scene.ws, title="Board")
    secret = await scene.world.make_document(hidden, title="Board minutes")
    reviewer = await scene.as_(scene.reviewer)
    hidden_example = await reviewer.post(
        scene.url("topics"),
        params={"topicId": "hidden-example"},
        json={"displayName": "Hidden", "parentTopic": domain["name"], "examples": [item_name(secret)]},
    )

    assert domain_keywords.status_code == 400
    assert both.status_code == 400
    assert unknown_source.status_code == 400
    assert not_document.status_code == 400
    assert hidden_example.status_code == 403


async def test_examples_are_filtered_to_what_the_reader_sees(scene: Scene) -> None:
    hidden = await scene.world.make_collection(scene.ws, title="Board")
    secret = await scene.world.make_document(hidden, title="Board minutes")
    visible = await scene.world.make_document(scene.kb, title="Handbook page")
    await _create(scene, "governance", examples=[item_name(secret), item_name(visible)])

    member = await scene.as_(scene.member)
    seen = await member.get(scene.url("topics/governance"))
    admin_view = await (await scene.as_(scene.admin)).get(scene.url("topics/governance"))

    assert seen.json()["examples"] == [item_name(visible)]
    assert admin_view.json()["examples"] == [item_name(secret), item_name(visible)]


async def test_import_creates_updates_skips_and_validates_only(scene: Scene) -> None:
    await _create(scene, "ops", kind="DOMAIN")
    await _create(scene, "ops-01", parentTopic=_topic(scene, "ops"), description="Old")
    admin = await scene.as_(scene.admin)
    rows = [
        {"code": "PAY", "name": "Payments"},
        {"code": "pay-01", "name": "Settlement", "parentCode": "PAY", "keywords": ["napas"]},
        {"code": "ops-01", "name": "Ops-01", "description": "New", "guidance": "Runbooks."},
        {"code": "ops", "name": "Ops"},
        {"code": "bad code!", "name": "Bad"},
        {"code": "pay-02", "name": "Orphan", "parentCode": "nowhere"},
        {"code": "pay", "name": "Again"},
        {"code": "dom-kw", "name": "Domain with keywords", "keywords": ["x"]},
    ]

    preview = await admin.post(
        scene.url("topics:import"), json={"rows": rows, "validateOnly": True}
    )
    async with scene.sessions() as session:
        codes_after_preview = set(
            await session.scalars(select(Topic.code).where(Topic.tenant_id == scene.ws.id))
        )
    applied = await admin.post(scene.url("topics:import"), json={"rows": rows})

    assert preview.status_code == 200, preview.text
    assert preview.json() == applied.json()
    assert codes_after_preview == {"ops", "ops-01"}
    result = applied.json()
    assert result["created"] == [_topic(scene, "pay"), _topic(scene, "pay-01")]
    assert result["updated"] == [_topic(scene, "ops-01")]
    assert result["unchangedCount"] == 1
    assert [row["row"] for row in result["skippedRows"]] == [5, 6, 7, 8]
    settlement = (await admin.get(scene.url("topics/pay-01"))).json()
    assert (settlement["parentTopic"], settlement["keywords"]) == (_topic(scene, "pay"), ["napas"])
    ops = (await admin.get(scene.url("topics/ops-01"))).json()
    assert (ops["description"], ops["guidance"], ops["parentTopic"]) == (
        "New",
        "Runbooks.",
        _topic(scene, "ops"),
    )

    member = await scene.as_(scene.member)
    denied = await member.post(scene.url("topics:import"), json={"rows": rows[:1]})
    assert denied.status_code == 403


async def test_import_replace_archives_unused_topics_and_keeps_used_ones(scene: Scene) -> None:
    await _create(scene, "hr", kind="DOMAIN")
    await _create(scene, "hiring", parentTopic=_topic(scene, "hr"))
    await _create(scene, "payroll", parentTopic=_topic(scene, "hr"))
    await _create(scene, "legacy", kind="DOMAIN")
    await _create(scene, "old", parentTopic=_topic(scene, "legacy"))
    document = await scene.world.make_document(scene.kb)
    async with scene.sessions.begin() as session:
        payroll = await session.scalar(
            select(Topic).where(Topic.tenant_id == scene.ws.id, Topic.code == "payroll")
        )
        assert payroll is not None
        session.add(ItemTopic(item_id=document.id, topic_id=payroll.id))
    admin = await scene.as_(scene.admin)

    response = await admin.post(
        scene.url("topics:import"),
        json={
            "rows": [{"code": "hr", "name": "People"}, {"code": "hiring", "name": "Hiring"}],
            "mode": "REPLACE",
        },
    )

    assert response.status_code == 200, response.text
    result = response.json()
    assert set(result["archived"]) == {_topic(scene, "old"), _topic(scene, "legacy")}
    assert result["updated"] == [_topic(scene, "hr")]
    assert result["unchangedCount"] == 2  # hiring unchanged; payroll kept in use
    states = {
        topic["name"]: topic["state"]
        for topic in (
            await admin.get(scene.url("topics"), params={"showDeleted": "true"})
        ).json()["topics"]
    }
    assert states[_topic(scene, "payroll")] == "ACTIVE"
    assert states[_topic(scene, "old")] == "DELETED"


async def test_classification_test_uses_rules_before_the_model(
    scene: Scene, runtime: AppRuntime, fakes: Fakes
) -> None:
    folder = await scene.world.make_collection(scene.ws, scene.kb, title="Chargebacks")
    await _create(scene, "chargebacks", rules=[{"collection": item_name(scene.kb)}])
    await _create(scene, "payments", keywords=["napas"], guidance="Settlement files.")
    transport = _with_model(runtime, fakes, '{"topics": ["payments"], "summary": "A NAPAS file."}')
    admin = await scene.as_(scene.admin)

    by_rule = await admin.post(
        scene.url("topics:testClassification"),
        json={"title": "Dispute 42", "collection": item_name(folder)},
    )
    by_model = await admin.post(
        scene.url("topics:testClassification"),
        json={
            "title": "NAPAS settlement",
            "text": "Daily file",
            "topics": [{"name": _topic(scene, "payments"), "guidance": "Unsaved guidance."}],
        },
    )

    assert by_rule.status_code == 200, by_rule.text
    assert by_rule.json() == {
        "results": [{"topic": _topic(scene, "chargebacks"), "reason": "RULE"}]
    }
    assert by_model.status_code == 200, by_model.text
    assert by_model.json() == {
        "results": [{"topic": _topic(scene, "payments"), "reason": "ASSISTANT"}],
        "summary": "A NAPAS file.",
    }
    [prompt] = transport.prompts
    assert "Unsaved guidance." in prompt
    assert "Settlement files." not in prompt
    assert "napas" in prompt and "Daily file" in prompt

    member = await scene.as_(scene.member)
    denied = await member.post(scene.url("topics:testClassification"), json={"title": "x"})
    assert denied.status_code == 403


async def test_classification_test_without_a_model_or_rule_fails(scene: Scene) -> None:
    await _create(scene, "payments")
    admin = await scene.as_(scene.admin)

    response = await admin.post(scene.url("topics:testClassification"), json={"title": "x"})

    assert response.status_code == 400
    assert response.json()["error"]["status"] == "FAILED_PRECONDITION"


async def test_compiled_prompt_shows_signals_and_rules(scene: Scene) -> None:
    await _source(scene, "drive-hr")
    example = await scene.world.make_document(scene.kb, title="Offer letter template")
    await _create(
        scene,
        "hiring",
        keywords=["offer"],
        guidance="Recruiting, not payroll.",
        examples=[item_name(example)],
        rules=[{"source": f"workspaces/{scene.ws.id}/sources/drive-hr"}],
    )
    admin = await scene.as_(scene.admin)

    response = await admin.get(scene.url("topics:compileClassificationPrompt"))

    assert response.status_code == 200, response.text
    body = response.json()
    assert "Recruiting, not payroll." in body["prompt"]
    assert "Offer letter template" in body["prompt"] and '"offer"' in body["prompt"]
    assert body["rules"] == [
        {
            "topic": _topic(scene, "hiring"),
            "rule": {"source": f"workspaces/{scene.ws.id}/sources/drive-hr"},
        }
    ]
    assert body["estimatedTokens"] > 0
    member = await scene.as_(scene.member)
    assert (await member.get(scene.url("topics:compileClassificationPrompt"))).status_code == 403
