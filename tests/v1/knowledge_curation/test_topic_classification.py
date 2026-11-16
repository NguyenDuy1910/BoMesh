"""Topic classification signals, ImportTopics, TestTopicClassification and the
compiled classification prompt (``api_design.md`` §5 Topic)."""

from __future__ import annotations

import re
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


async def _topics_by_display_name(scene: Scene) -> dict[str, Any]:
    admin = await scene.as_(scene.admin)
    listed = await admin.get(scene.url("topics"), params={"pageSize": 100})
    assert listed.status_code == 200, listed.text
    return {topic["displayName"]: topic for topic in listed.json()["topics"]}


def _without_topic(change: dict[str, Any]) -> dict[str, Any]:
    """An ImportTopics change without its topic name (provisional for creates in a preview)."""
    return {key: value for key, value in change.items() if key != "topic"}


async def test_import_creates_by_name_updates_skips_and_validates_only(scene: Scene) -> None:
    await _create(scene, "ops", kind="DOMAIN")
    await _create(scene, "ops-01", parentTopic=_topic(scene, "ops"), description="Old")
    admin = await scene.as_(scene.admin)
    rows = [
        {"domain": "Payments"},
        {"domain": "Payments", "topic": "Settlement", "keywords": ["napas"]},
        {
            "domain": " ops ",
            "topic": "Ops-01",
            "description": "New",
            "keywords": ["kyc"],
            "guidance": "Runbooks.",
        },
        {"domain": "Ops"},
        {"domain": "  "},
        {"domain": "payments", "topic": " SETTLEMENT "},
        {"domain": "Ops", "keywords": ["x"]},
        {"domain": "Ops", "topic": "Elsewhere", "name": "workspaces/other/topics/x"},
        {"domain": "Ops", "topic": "Wrong kind", "name": _topic(scene, "ops")},
        {"domain": "Logistics", "topic": "Shipping", "name": ""},
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
    assert applied.status_code == 200, applied.text
    assert codes_after_preview == {"ops", "ops-01"}
    result = applied.json()
    for key in ("updated", "archived", "unchangedCount", "skippedRows"):
        assert preview.json()[key] == result[key]
    # Creates get provisional names in a preview; the rest is the same.
    assert [_without_topic(change) for change in preview.json()["created"]] == [
        _without_topic(change) for change in result["created"]
    ]
    assert [_without_topic(change) for change in result["created"]] == [
        {"kind": "DOMAIN", "displayName": "Payments", "row": 1},
        {"kind": "TOPIC", "displayName": "Settlement", "domain": "Payments", "row": 2},
        {"kind": "DOMAIN", "displayName": "Logistics"},
        {"kind": "TOPIC", "displayName": "Shipping", "domain": "Logistics", "row": 10},
    ]
    assert result["updated"] == [
        {
            "topic": _topic(scene, "ops-01"),
            "kind": "TOPIC",
            "displayName": "Ops-01",
            "domain": "Ops",
            "row": 3,
            "changes": ["DESCRIPTION", "KEYWORDS", "GUIDANCE"],
        }
    ]
    assert result["unchangedCount"] == 1
    assert [row["row"] for row in result["skippedRows"]] == [5, 6, 7, 8, 9]
    topics = await _topics_by_display_name(scene)
    assert [change["topic"] for change in result["created"]] == [
        topics[display_name]["name"]
        for display_name in ("Payments", "Settlement", "Logistics", "Shipping")
    ]
    assert all(
        re.fullmatch(rf"workspaces/{scene.ws.id}/topics/t[0-9a-f]{{12}}", change["topic"])
        for change in result["created"]
    )
    assert topics["Logistics"]["kind"] == "DOMAIN"
    assert topics["Shipping"]["parentTopic"] == topics["Logistics"]["name"]
    settlement = topics["Settlement"]
    assert (settlement["parentTopic"], settlement["keywords"]) == (
        topics["Payments"]["name"],
        ["napas"],
    )
    ops = topics["Ops-01"]
    assert (ops["description"], ops["keywords"], ops["guidance"], ops["parentTopic"]) == (
        "New",
        ["kyc"],
        "Runbooks.",
        _topic(scene, "ops"),
    )

    member = await scene.as_(scene.member)
    denied = await member.post(scene.url("topics:import"), json={"rows": rows[:1]})
    assert denied.status_code == 403


async def test_import_renames_and_moves_by_name_and_skips_ambiguous_names(scene: Scene) -> None:
    await _create(scene, "hr", kind="DOMAIN", displayName="Human Resources")
    await _create(scene, "hiring", parentTopic=_topic(scene, "hr"))
    await _create(scene, "payroll", parentTopic=_topic(scene, "hr"))
    await _create(scene, "budget", parentTopic=_topic(scene, "hr"))
    await _create(scene, "fin", kind="DOMAIN", displayName="Finance")
    await _create(scene, "rep-a", parentTopic=_topic(scene, "fin"), displayName="Reports")
    await _create(scene, "rep-b", parentTopic=_topic(scene, "fin"), displayName="Reports")
    await _create(scene, "dup-a", kind="DOMAIN", displayName="Shared")
    await _create(scene, "dup-b", kind="DOMAIN", displayName="Shared")
    admin = await scene.as_(scene.admin)
    rows = [
        {"domain": "People", "name": _topic(scene, "hr"), "description": "Staff"},
        {"domain": "people", "topic": " HIRING ", "description": "Recruiting"},
        {"domain": "People", "topic": "Compensation", "name": _topic(scene, "payroll")},
        {"domain": "Finance", "topic": "Budget", "name": _topic(scene, "budget")},
        {"domain": "Finance", "topic": "reports"},
        {"domain": "shared", "topic": "Anything"},
        {"domain": "Finance", "topic": "Budget again", "name": _topic(scene, "budget")},
    ]

    response = await admin.post(scene.url("topics:import"), json={"rows": rows})

    assert response.status_code == 200, response.text
    result = response.json()
    assert result["created"] == []
    assert [_without_topic(change) for change in result["updated"]] == [
        {
            "kind": "DOMAIN",
            "displayName": "People",
            "row": 1,
            "changes": ["RENAMED", "DESCRIPTION"],
            "previousDisplayName": "Human Resources",
        },
        {
            "kind": "TOPIC",
            "displayName": "HIRING",
            "domain": "People",
            "row": 2,
            "changes": ["RENAMED", "DESCRIPTION"],
            "previousDisplayName": "Hiring",
        },
        {
            "kind": "TOPIC",
            "displayName": "Compensation",
            "domain": "People",
            "row": 3,
            "changes": ["RENAMED"],
            "previousDisplayName": "Payroll",
        },
        {"kind": "TOPIC", "displayName": "Budget", "domain": "Finance", "row": 4, "changes": ["MOVED"]},
    ]
    assert [change["topic"] for change in result["updated"]] == [
        _topic(scene, name) for name in ("hr", "hiring", "payroll", "budget")
    ]
    assert result["unchangedCount"] == 0
    skipped = {row["row"]: row["reason"] for row in result["skippedRows"]}
    assert sorted(skipped) == [5, 6, 7]
    assert "more than one topic" in skipped[5]
    assert "more than one domain" in skipped[6]
    assert "another row" in skipped[7]
    hr = (await admin.get(scene.url("topics/hr"))).json()
    assert (hr["displayName"], hr["description"]) == ("People", "Staff")
    hiring = (await admin.get(scene.url("topics/hiring"))).json()
    assert (hiring["displayName"], hiring["description"]) == ("HIRING", "Recruiting")
    payroll = (await admin.get(scene.url("topics/payroll"))).json()
    assert (payroll["displayName"], payroll["parentTopic"]) == ("Compensation", _topic(scene, "hr"))
    budget = (await admin.get(scene.url("topics/budget"))).json()
    assert budget["parentTopic"] == _topic(scene, "fin")


async def test_import_replace_archives_unmatched_topics_and_keeps_used_ones(scene: Scene) -> None:
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
            "rows": [
                {"domain": "People", "name": _topic(scene, "hr")},
                {"domain": "People", "topic": "hiring"},
            ],
            "mode": "REPLACE",
        },
    )

    assert response.status_code == 200, response.text
    result = response.json()
    assert result["archived"] == [
        {"topic": _topic(scene, "old"), "kind": "TOPIC", "displayName": "Old", "domain": "Legacy"},
        {"topic": _topic(scene, "legacy"), "kind": "DOMAIN", "displayName": "Legacy"},
    ]
    assert [_without_topic(change) for change in result["updated"]] == [
        {
            "kind": "DOMAIN",
            "displayName": "People",
            "row": 1,
            "changes": ["RENAMED"],
            "previousDisplayName": "Hr",
        },
        {
            "kind": "TOPIC",
            "displayName": "hiring",
            "domain": "People",
            "row": 2,
            "changes": ["RENAMED"],
            "previousDisplayName": "Hiring",
        },
    ]
    assert result["unchangedCount"] == 1  # payroll kept in use
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
