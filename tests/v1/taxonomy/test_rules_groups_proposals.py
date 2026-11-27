"""Concept rules, concept groups and concept proposals through the API."""

from __future__ import annotations

from typing import Any
from uuid import UUID

import pytest

from bomesh.db.models import Concept, ConceptProposal, ConceptProposalItem
from taxonomy_scene import TaxonomyScene

pytestmark = pytest.mark.asyncio


def _fields(response: Any) -> list[str]:
    assert response.status_code == 400, response.text
    error = response.json()["error"]
    assert error["status"] == "INVALID_ARGUMENT", error
    return [violation["field"] for detail in error["details"] for violation in detail.get("fieldViolations", ())]


async def _taxonomy(tx: TaxonomyScene) -> None:
    await tx.scheme("domain", assignTopConcepts=False)
    await tx.concept("domain", "it")
    await tx.concept("domain", "ai", broader=["it"])
    await tx.scheme("type")
    await tx.concept("type", "qd", "Quyết định")
    await tx.published("domain")
    await tx.published("type")


async def test_rule_crud_and_validation(tx: TaxonomyScene) -> None:
    await _taxonomy(tx)
    url = tx.url("conceptRules")
    qd, ai, it = (
        tx.concept_name("type", "qd"),
        tx.concept_name("domain", "ai"),
        tx.concept_name("domain", "it"),
    )
    collection = await tx.world.make_collection(tx.ws)

    created = await tx.ok(
        await tx.api.post(
            url, params={"conceptRuleId": "qd-ai"}, json={"when": {"concept": qd}, "then": ai, "effect": "IMPLIES"}
        )
    )

    assert created["name"] == f"workspaces/{tx.ws.id}/conceptRules/qd-ai"
    assert (created["when"]["concept"], created["then"], created["effect"]) == (qd, ai, "IMPLIES")
    assert created["creator"] == f"workspaces/{tx.ws.id}/members/{tx.admin.id}"
    # Exactly one condition.
    both = await tx.api.post(
        url,
        params={"conceptRuleId": "both"},
        json={"when": {"concept": qd, "collection": f"workspaces/{tx.ws.id}/items/{collection.id}"}, "then": ai, "effect": "IMPLIES"},
    )
    assert _fields(both) == ["when"]
    none = await tx.api.post(url, params={"conceptRuleId": "none"}, json={"then": ai, "effect": "IMPLIES"})
    assert _fields(none) == ["when"]
    # IMPLIES names an assignable concept: the scheme does not assign top concepts.
    top = await tx.api.post(
        url, params={"conceptRuleId": "top"}, json={"when": {"concept": qd}, "then": it, "effect": "IMPLIES"}
    )
    assert _fields(top) == ["then"]
    self_rule = await tx.api.post(
        url, params={"conceptRuleId": "self"}, json={"when": {"concept": ai}, "then": ai, "effect": "PRIOR", "weight": 0.5}
    )
    assert _fields(self_rule) == ["then"]
    no_weight = await tx.api.post(
        url, params={"conceptRuleId": "prior"}, json={"when": {"concept": qd}, "then": ai, "effect": "PRIOR"}
    )
    assert _fields(no_weight) == ["weight"]
    implies_weight = await tx.api.post(
        url,
        params={"conceptRuleId": "iw"},
        json={"when": {"concept": qd}, "then": ai, "effect": "IMPLIES", "weight": 0.3},
    )
    assert _fields(implies_weight) == ["weight"]
    duplicate = await tx.api.post(
        url, params={"conceptRuleId": "dup"}, json={"when": {"concept": qd}, "then": ai, "effect": "IMPLIES"}
    )
    assert duplicate.status_code == 200
    taken = await tx.api.post(
        url, params={"conceptRuleId": "qd-ai"}, json={"when": {"concept": qd}, "then": ai, "effect": "IMPLIES"}
    )
    assert taken.status_code == 409
    prior = await tx.ok(
        await tx.api.post(
            url,
            params={"conceptRuleId": "collection-prior"},
            json={
                "when": {"collection": f"workspaces/{tx.ws.id}/items/{collection.id}"},
                "then": ai,
                "effect": "PRIOR",
                "weight": 0.4,
            },
        )
    )
    assert (prior["when"]["collection"], prior["weight"]) == (f"workspaces/{tx.ws.id}/items/{collection.id}", 0.4)

    listed = await tx.ok(await tx.api.get(url))
    assert [rule["name"].rsplit("/", 1)[1] for rule in listed["conceptRules"]] == ["collection-prior", "dup", "qd-ai"]
    implies = await tx.ok(await tx.api.get(url, params={"filter": 'effect = "IMPLIES"'}))
    assert [rule["name"].rsplit("/", 1)[1] for rule in implies["conceptRules"]] == ["dup", "qd-ai"]
    got = await tx.ok(await tx.api.get(f"{url}/qd-ai"))
    assert got == created

    updated = await tx.ok(
        await tx.api.patch(
            f"{url}/collection-prior",
            params={"updateMask": "weight"},
            json={"weight": 0.7, "etag": prior["etag"]},
        )
    )
    assert updated["weight"] == 0.7
    stale = await tx.api.patch(
        f"{url}/collection-prior", params={"updateMask": "weight"}, json={"weight": 0.1, "etag": prior["etag"]}
    )
    assert stale.status_code == 409
    stale_delete = await tx.api.delete(f"{url}/dup", params={"etag": "W/\"stale\""})
    assert stale_delete.status_code == 409
    assert (await tx.api.delete(f"{url}/dup")).status_code == 200
    assert (await tx.api.get(f"{url}/dup")).status_code == 404
    actions = await tx.audit_actions()
    assert {"CreateConceptRule", "UpdateConceptRule", "DeleteConceptRule"} <= set(actions)

    member = tx.member_api
    denied = [
        await member.get(url),
        await member.get(f"{url}/qd-ai"),
        await member.post(url, params={"conceptRuleId": "m"}, json={"when": {"concept": qd}, "then": ai, "effect": "IMPLIES"}),
        await member.delete(f"{url}/qd-ai"),
    ]
    assert [response.status_code for response in denied] == [403] * 4


async def test_group_crud_with_query_expansion(tx: TaxonomyScene) -> None:
    await _taxonomy(tx)
    url = tx.url("conceptSchemes/domain/groups")
    it, ai = tx.concept_name("domain", "it"), tx.concept_name("domain", "ai")

    created = await tx.ok(
        await tx.api.post(
            url,
            params={"groupId": "eng"},
            json={"displayName": "Kỹ thuật", "members": [ai, it], "queryExpansion": True, "position": 2},
        )
    )

    assert created["name"] == f"workspaces/{tx.ws.id}/conceptSchemes/domain/groups/eng"
    assert (created["members"], created["queryExpansion"], created["position"]) == ([ai, it], True, 2)
    assert _fields(await tx.api.post(url, params={"groupId": "bad"}, json={"displayName": "B", "members": [tx.concept_name("domain", "nope")]})) == ["members[0]"]
    assert _fields(await tx.api.post(url, params={"groupId": "other"}, json={"displayName": "B", "members": [tx.concept_name("type", "qd")]})) == ["members[0]"]
    assert _fields(await tx.api.post(url, params={"groupId": "noname"}, json={})) == ["displayName"]
    assert (await tx.api.post(url, params={"groupId": "eng"}, json={"displayName": "Again"})).status_code == 409
    await tx.ok(await tx.api.post(url, params={"groupId": "first"}, json={"displayName": "Đầu", "position": 1}))
    listed = await tx.ok(await tx.api.get(url))
    assert [group["name"].rsplit("/", 1)[1] for group in listed["conceptGroups"]] == ["first", "eng"]

    updated = await tx.ok(
        await tx.api.patch(
            f"{url}/eng",
            params={"updateMask": "members,queryExpansion"},
            json={"members": [it], "queryExpansion": False, "etag": created["etag"]},
        )
    )
    assert (updated["members"], updated["queryExpansion"], updated["displayName"]) == ([it], False, "Kỹ thuật")
    stale = await tx.api.patch(
        f"{url}/eng", params={"updateMask": "position"}, json={"position": 5, "etag": created["etag"]}
    )
    assert stale.status_code == 409
    # Groups are part of the working copy: the next publish reports them.
    scheme = await tx.ok(await tx.api.get(tx.url("conceptSchemes/domain")))
    assert scheme["unpublishedChanges"] >= 1
    version = await tx.published("domain")
    assert {change.get("group") for change in version["changes"] if change["kind"] == "GROUPS"} == {
        f"workspaces/{tx.ws.id}/conceptSchemes/domain/groups/eng",
        f"workspaces/{tx.ws.id}/conceptSchemes/domain/groups/first",
    }

    assert (await tx.member_api.get(f"{url}/eng")).status_code == 200
    assert (await tx.member_api.post(url, params={"groupId": "m"}, json={"displayName": "M"})).status_code == 403
    assert (await tx.member_api.delete(f"{url}/eng")).status_code == 403
    assert (await tx.api.delete(f"{url}/eng", params={"etag": updated["etag"]})).status_code == 200
    assert (await tx.api.get(f"{url}/eng")).status_code == 404
    assert {"CreateConceptGroup", "UpdateConceptGroup", "DeleteConceptGroup"} <= set(await tx.audit_actions())


async def _proposal(tx: TaxonomyScene, **values: Any) -> UUID:
    evidence = values.pop("evidence", ())
    async with tx.sessions.begin() as session:
        proposal = ConceptProposal(tenant_id=tx.ws.id, **values)
        session.add(proposal)
        await session.flush()
        for item_id in evidence:
            session.add(ConceptProposalItem(proposal_id=proposal.id, item_id=item_id))
        return proposal.id


async def test_proposals_accept_and_reject(tx: TaxonomyScene) -> None:
    await _taxonomy(tx)
    it_id, ai_id = await tx.concept_id("domain", "it"), await tx.concept_id("domain", "ai")
    async with tx.sessions.begin() as session:
        domain_id = (await session.get(Concept, it_id)).scheme_id
    docs = [await tx.document(), await tx.document()]
    new_id = await _proposal(
        tx,
        scheme_id=domain_id,
        kind="new_concept",
        proposal_name="Học máy",
        definition="Học từ dữ liệu.",
        broader_concept_id=it_id,
        origin="cluster",
        evidence=docs,
    )
    label_id = await _proposal(
        tx, scheme_id=domain_id, kind="label", proposal_name="TTNT", target_concept_id=ai_id, origin="correction"
    )
    rejected_id = await _proposal(tx, scheme_id=domain_id, kind="new_concept", proposal_name="Rác", origin="member")
    url = tx.url("conceptProposals")

    listed = await tx.ok(await tx.api.get(url))
    assert {proposal["name"].rsplit("/", 1)[1] for proposal in listed["conceptProposals"]} == {
        str(new_id),
        str(label_id),
        str(rejected_id),
    }
    new = await tx.ok(await tx.api.get(f"{url}/{new_id}"))
    assert (new["kind"], new["state"], new["origin"], new["suggestedBroader"]) == (
        "NEW_CONCEPT",
        "OPEN",
        "CLUSTER",
        tx.concept_name("domain", "it"),
    )
    assert sorted(name.rsplit("/", 1)[1] for name in new["evidence"]) == sorted(str(doc) for doc in docs)

    # NEW_CONCEPT → a DRAFT concept; the proposal keeps its evidence.
    assert _fields(await tx.api.post(f"{url}/{new_id}:accept", json={})) == ["conceptId"]
    accepted = await tx.ok(
        await tx.api.post(
            f"{url}/{new_id}:accept",
            json={"conceptId": "ml", "concept": {"scopeNote": "Không gồm thống kê."}},
        )
    )
    assert (accepted["state"], accepted["concept"]) == ("ACCEPTED", tx.concept_name("domain", "ml"))
    assert accepted["decider"] == f"users/{tx.admin.id}" and "decideTime" in accepted
    assert sorted(name.rsplit("/", 1)[1] for name in accepted["evidence"]) == sorted(str(doc) for doc in docs)
    ml = await tx.ok(await tx.api.get(tx.url("conceptSchemes/domain/concepts/ml")))
    assert (ml["state"], ml["prefLabels"], ml["definition"], ml["scopeNote"], ml["broader"]) == (
        "DRAFT",
        [{"languageCode": "vi", "text": "Học máy"}],
        "Học từ dữ liệu.",
        "Không gồm thống kê.",
        [tx.concept_name("domain", "it")],
    )
    again = await tx.api.post(f"{url}/{new_id}:accept", json={"conceptId": "ml2"})
    assert again.status_code == 400 and again.json()["error"]["status"] == "FAILED_PRECONDITION"

    # LABEL → an altLabel on the target's working copy.
    label = await tx.ok(await tx.api.post(f"{url}/{label_id}:accept", json={"labelKind": "ALT"}))
    assert (label["state"], label["targetConcept"]) == ("ACCEPTED", tx.concept_name("domain", "ai"))
    ai = await tx.ok(await tx.api.get(tx.url("conceptSchemes/domain/concepts/ai")))
    assert ai["altLabels"] == [{"languageCode": "vi", "text": "TTNT"}]
    assert (await tx.ok(await tx.api.get(tx.url("conceptSchemes/domain"))))["unpublishedChanges"] >= 2

    # Members never decide.
    assert (await tx.member_api.get(url)).status_code == 403
    assert (await tx.member_api.post(f"{url}/{rejected_id}:reject", json={})).status_code == 403

    rejected = await tx.ok(await tx.api.post(f"{url}/{rejected_id}:reject", json={}))
    assert (rejected["state"], rejected.get("concept")) == ("REJECTED", None)
    late = await tx.api.post(f"{url}/{rejected_id}:accept", json={"conceptId": "rac"})
    assert late.status_code == 400 and late.json()["error"]["status"] == "FAILED_PRECONDITION"
    open_only = await tx.ok(await tx.api.get(url, params={"filter": 'state = "OPEN"'}))
    assert open_only["conceptProposals"] == []
    assert {"AcceptConceptProposal", "RejectConceptProposal"} <= set(await tx.audit_actions())
    assert (await tx.api.get(f"{url}/not-a-uuid")).status_code == 400
