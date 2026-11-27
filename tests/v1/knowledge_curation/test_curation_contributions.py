"""Contributions: create/analyze, read visibility, decisions and the approval effects."""

from __future__ import annotations

from typing import Any
from uuid import uuid4

import pytest
from sqlalchemy import func, select

from bomesh.db.models import (
    Contribution,
    IngestionRun,
    IngestionRunItem,
    ItemRevision,
    ItemConcept,
    Notification,
)
from bomesh.services.knowledge_items.item_store import ItemService
from bomesh.services.taxonomy.names import concept_name
from curation_support import Scene, error_reason, item_name
from taxonomy_support import C, publish_scheme

pytestmark = pytest.mark.asyncio


def _url(scene: Scene, contribution: dict[str, Any], suffix: str = "") -> str:
    return f"/api/v1/{contribution['name']}{suffix}"


async def _count(scene: Scene, statement: Any) -> int:
    async with scene.sessions() as session:
        return int(await session.scalar(statement) or 0)


# -- Create and analysis ---------------------------------------------------------------


async def test_create_analyzes_into_review_and_notifies_reviewers(scene: Scene) -> None:
    candidate = await scene.candidate()

    body = await scene.submit(candidate, note="Please add")

    assert body["state"] == "IN_REVIEW"
    assert (body["kind"], body["origin"]) == ("NEW_DOCUMENT", "MEMBER")
    assert body["contributor"] == f"workspaces/{scene.ws.id}/members/{scene.member.id}"
    assert body["targetCollection"] == item_name(scene.kb)
    assert [e["kind"] for e in body["events"]] == ["SUBMITTED", "ANALYZED"]
    assert "documentType" not in body["suggestions"]
    assert body["audienceSummary"] == "Readers of Handbook"
    recipients = await _count(
        scene,
        select(func.count()).where(
            Notification.recipient_user_id == scene.reviewer.id,
            Notification.kind == "contribution_submitted",
        ),
    )
    assert recipients == 1


async def test_create_flags_duplicates_formats_and_personal_data(scene: Scene) -> None:
    published = await scene.world.make_document(scene.kb, item_name="Pricing policy jane@example.com")
    await scene.set_content(published, size=100)
    same = await scene.candidate(item_name="Pricing policy jane@example.com", size=100)
    exe = await scene.candidate(item_name="Tool", file_name="tool.exe")

    duplicate = await scene.submit(same)
    unsupported = await scene.submit(exe)

    assert {f["kind"] for f in duplicate["flags"]} == {"DUPLICATE", "PERSONAL_DATA"}
    assert {f.get("relatedItem") for f in duplicate["flags"]} == {item_name(published), None}
    assert set(duplicate["suggestions"]) <= {
        "collection",
        "collectionConfidence",
        "summary",
        "summaryConfidence",
        "title",
    }
    assert [f["kind"] for f in unsupported["flags"]] == ["UNSEARCHABLE_FORMAT"]


async def test_related_item_is_hidden_from_callers_who_cannot_read_it(scene: Scene) -> None:
    secret = await scene.world.make_collection(scene.ws, item_name="Secret")
    hidden = await scene.world.make_document(secret, item_name="Plan")
    await scene.set_content(hidden)
    body = await scene.submit(await scene.candidate(item_name="Plan"))

    assert body["flags"] == [{"kind": "DUPLICATE"}]
    admin = await scene.as_(scene.admin)
    seen = (await admin.get(_url(scene, body))).json()
    assert seen["flags"] == [{"kind": "DUPLICATE", "relatedItem": item_name(hidden)}]


async def test_create_rejects_bad_candidates_and_targets(scene: Scene) -> None:
    api = await scene.as_(scene.member)
    other_personal = await scene.world.make_collection(scene.ws, personal_for=scene.outsider)
    foreign = await scene.candidate(owner=scene.outsider, personal=other_personal)
    in_kb = await scene.world.make_document(scene.kb)
    closed = await scene.world.make_collection(scene.ws, grants={scene.member: "roles/collectionViewer"})
    candidate = await scene.candidate()

    async def post(**body: Any) -> Any:
        return await api.post(scene.url("contributions"), json=body)

    unreadable = await post(item=item_name(foreign))
    assert unreadable.status_code == 403
    not_personal = await post(item=item_name(in_kb))
    assert not_personal.status_code == 400
    assert not_personal.json()["error"]["status"] == "FAILED_PRECONDITION"
    no_contributions = await post(item=item_name(candidate), targetCollection=item_name(closed))
    assert no_contributions.json()["error"]["status"] == "FAILED_PRECONDITION"
    not_collection = await post(item=item_name(candidate), targetCollection=item_name(in_kb))
    assert not_collection.json()["error"]["status"] == "INVALID_ARGUMENT"
    no_replaced = await post(item=item_name(candidate), kind="NEW_REVISION")
    assert no_replaced.json()["error"]["status"] == "INVALID_ARGUMENT"

    await scene.submit(candidate)
    again = await post(item=item_name(candidate))
    assert (again.status_code, error_reason(again)) == (400, "CONTRIBUTION_OPEN")


async def test_pending_candidate_is_failed_precondition(scene: Scene) -> None:
    """A candidate still awaiting its upload (contentState PENDING) cannot be contributed."""
    async with scene.sessions.begin() as session:
        candidate = await ItemService(session).create_document(
            workspace_id=scene.personal.tenant_id,
            parent=scene.personal,
            item_name="Draft",
            mime_type="application/pdf",
            size_bytes=100,
            file_name="draft.pdf",
            created_by_user_id=scene.member.id,
            uploader_user_id=scene.member.id,
        )
    api = await scene.as_(scene.member)
    response = await api.post(scene.url("contributions"), json={"item": item_name(candidate)})
    assert response.json()["error"]["status"] == "FAILED_PRECONDITION"


async def test_create_requires_membership_and_is_idempotent(scene: Scene) -> None:
    candidate = await scene.candidate()
    stranger = await scene.world.make_user()
    denied = await (await scene.as_(stranger)).post(
        scene.url("contributions"), json={"item": item_name(candidate)}
    )
    assert denied.status_code == 403

    api = await scene.as_(scene.member)
    request_id = str(uuid4())
    first = await api.post(
        scene.url("contributions"), params={"requestId": request_id}, json={"item": item_name(candidate)}
    )
    second = await api.post(
        scene.url("contributions"), params={"requestId": request_id}, json={"item": item_name(candidate)}
    )
    assert first.json()["name"] == second.json()["name"]


async def test_new_revision_targets_the_governing_collection(scene: Scene) -> None:
    replaced = await scene.world.make_document(scene.kb, item_name="Handbook v1")
    other = await scene.world.make_collection(scene.ws, grants={scene.member: "roles/collectionViewer"})
    candidate = await scene.candidate()
    api = await scene.as_(scene.member)

    wrong = await api.post(
        scene.url("contributions"),
        json={
            "item": item_name(candidate),
            "kind": "NEW_REVISION",
            "replacesItem": item_name(replaced),
            "targetCollection": item_name(other),
        },
    )
    assert wrong.json()["error"]["status"] == "INVALID_ARGUMENT"
    body = (
        await api.post(
            scene.url("contributions"),
            json={"item": item_name(candidate), "kind": "NEW_REVISION", "replacesItem": item_name(replaced)},
        )
    ).json()
    assert body["targetCollection"] == item_name(scene.kb)
    assert body["replacesItem"] == item_name(replaced)


async def test_new_revision_of_another_file_class_is_item_type_mismatch(scene: Scene) -> None:
    replaced = await scene.world.make_document(
        scene.kb, item_name="Handbook.md", mime_type="text/markdown"
    )
    candidate = await scene.candidate()
    api = await scene.as_(scene.member)

    response = await api.post(
        scene.url("contributions"),
        json={"item": item_name(candidate), "kind": "NEW_REVISION", "replacesItem": item_name(replaced)},
    )

    assert response.json()["error"]["status"] == "FAILED_PRECONDITION"
    assert error_reason(response) == "ITEM_TYPE_MISMATCH"


# -- Read ------------------------------------------------------------------------------


async def test_get_is_for_the_contributor_and_reviewers_only(scene: Scene) -> None:
    body = await scene.submit(await scene.candidate())

    for user in (scene.member, scene.reviewer, scene.admin):
        response = await (await scene.as_(user)).get(_url(scene, body))
        assert response.status_code == 200
    outsider = await (await scene.as_(scene.outsider)).get(_url(scene, body))
    assert outsider.status_code == 403
    basic = (await (await scene.as_(scene.member)).get(_url(scene, body), params={"view": "BASIC"})).json()
    assert "events" not in basic
    missing = await (await scene.as_(scene.member)).get(scene.url(f"contributions/{uuid4()}"))
    assert missing.status_code == 404


async def test_review_badge_total_size_counts_every_visible_match(scene: Scene) -> None:
    """The shell badge: ``pageSize=1&filter=state = "IN_REVIEW"``; ``totalSize`` counts all."""
    for state in ("in_review", "in_review", "in_review", "approved", "changes_requested"):
        await scene.world.make_contribution(
            await scene.candidate(), contributor=scene.member, target=scene.kb, state=state
        )
    elsewhere = await scene.world.make_collection(scene.ws, item_name="Elsewhere")
    other_personal = await scene.world.make_collection(scene.ws, personal_for=scene.outsider)
    for _ in range(2):
        await scene.world.make_contribution(
            await scene.candidate(owner=scene.outsider, personal=other_personal),
            contributor=scene.outsider,
            target=elsewhere,
        )
    badge = {"pageSize": 1, "filter": 'state = "IN_REVIEW"'}

    async def count(user: Any) -> tuple[int, int]:
        body = (await (await scene.as_(user)).get(scene.url("contributions"), params=badge)).json()
        return len(body["contributions"]), body["totalSize"]

    assert await count(scene.reviewer) == (1, 3)
    assert await count(scene.member) == (1, 3)
    assert await count(scene.outsider) == (1, 2)
    assert await count(scene.admin) == (1, 5)


async def test_list_filters_orders_and_pages(scene: Scene) -> None:
    first = await scene.submit(await scene.candidate())
    second = await scene.submit(await scene.candidate())
    other_personal = await scene.world.make_collection(scene.ws, personal_for=scene.outsider)
    foreign = await scene.candidate(owner=scene.outsider, personal=other_personal)
    outsider = await scene.as_(scene.outsider)
    await outsider.post(
        scene.url("contributions"), json={"item": item_name(foreign), "targetCollection": item_name(scene.kb)}
    )

    member = await scene.as_(scene.member)
    mine = (await member.get(scene.url("contributions"))).json()
    assert [c["name"] for c in mine["contributions"]] == [second["name"], first["name"]]
    assert mine["totalSize"] == 2
    reviewer = await scene.as_(scene.reviewer)
    assert (await reviewer.get(scene.url("contributions"))).json()["totalSize"] == 3

    page = (await reviewer.get(scene.url("contributions"), params={"pageSize": 2, "orderBy": "createTime"})).json()
    assert len(page["contributions"]) == 2 and page["nextPageToken"]
    rest = (
        await reviewer.get(
            scene.url("contributions"),
            params={"pageSize": 2, "orderBy": "createTime", "pageToken": page["nextPageToken"]},
        )
    ).json()
    assert len(rest["contributions"]) == 1 and "nextPageToken" not in rest

    me = f'contributor = "workspaces/{scene.ws.id}/members/me" AND state = IN_REVIEW'
    filtered = (await reviewer.get(scene.url("contributions"), params={"filter": me})).json()
    assert filtered["totalSize"] == 0
    in_kb = f'targetCollection = "{item_name(scene.kb)}" AND kind = NEW_DOCUMENT'
    assert (await reviewer.get(scene.url("contributions"), params={"filter": in_kb})).json()["totalSize"] == 3

    secret = await scene.world.make_collection(scene.ws)
    denied = await member.get(
        scene.url("contributions"), params={"filter": f'targetCollection = "{item_name(secret)}"'}
    )
    assert denied.status_code == 403
    bad = await member.get(scene.url("contributions"), params={"orderBy": "note"})
    assert bad.status_code == 400


async def test_queues_page_and_count_on_the_candidates_title_and_processing(scene: Scene) -> None:
    processed = await scene.candidate(item_name="Thông tư tuyển sinh 2024")
    waiting = await scene.candidate(item_name="Quy chế đào tạo")
    ready = await scene.submit(processed)
    pending = await scene.submit(waiting)
    await scene.mark_processed(processed)
    reviewer = await scene.as_(scene.reviewer)

    async def names(filter: str) -> list[str]:
        body = (await reviewer.get(scene.url("contributions"), params={"filter": filter})).json()
        return [c["name"] for c in body.get("contributions", [])]

    listed = {
        c["name"]: c
        for c in (await reviewer.get(scene.url("contributions"))).json()["contributions"]
    }
    assert listed[ready["name"]]["itemDisplayName"] == "Thông tư tuyển sinh 2024"
    # `mark_processed` records no processing version, so the processed candidate reads OUTDATED.
    assert listed[ready["name"]]["itemIndexingState"] == "OUTDATED"
    assert listed[pending["name"]]["itemIndexingState"] == "PENDING"
    review = (
        '(state = "IN_REVIEW" OR state = "ANALYZING") AND (kind = NEW_REVISION'
        " OR itemIndexingState = SUCCEEDED OR itemIndexingState = OUTDATED"
        " OR itemIndexingState = UNSUPPORTED)"
    )
    assert await names(review) == [ready["name"]]
    to_process = (
        'state = "IN_REVIEW" AND (itemIndexingState = PENDING OR itemIndexingState = FAILED)'
    )
    assert await names(to_process) == [pending["name"]]
    assert await names('itemDisplayName = "*TUY*"') == [ready["name"]]
    batch = f'item = "{item_name(waiting)}" OR item = "{item_name(scene.kb)}"'
    assert await names(batch) == [pending["name"]]
    both = f'name = "{ready["name"]}" OR name = "{pending["name"]}"'
    assert sorted(await names(both)) == sorted([ready["name"], pending["name"]])
    assert await names(f'name = "{ready["name"]}"') == [ready["name"]]
    foreign = await reviewer.get(
        scene.url("contributions"),
        params={"filter": f'name = "workspaces/{uuid4()}/contributions/{uuid4()}"'},
    )
    assert foreign.status_code == 400
    bad = await reviewer.get(
        scene.url("contributions"), params={"filter": "itemIndexingState = DONE"}
    )
    assert bad.status_code == 400


async def test_a_closed_contribution_hides_the_candidates_title_from_its_reviewer(scene: Scene) -> None:
    candidate = await scene.candidate(item_name="Payroll draft")
    body = await scene.submit(candidate)
    reviewer = await scene.as_(scene.reviewer)
    rejected = await reviewer.post(_url(scene, body, ":reject"), json={"message": "Out of scope"})
    assert rejected.status_code == 200, rejected.text
    member = await scene.as_(scene.member)

    seen = (await reviewer.get(_url(scene, body))).json()
    own = (await member.get(_url(scene, body))).json()
    searched = await reviewer.get(
        scene.url("contributions"), params={"filter": 'itemDisplayName = "*Payroll*"'}
    )

    # Closed, the reviewer exception no longer lets the reviewer read the candidate (§6.4).
    assert "itemDisplayName" not in seen and "itemIndexingState" not in seen
    assert (own["itemDisplayName"], own["itemIndexingState"]) == ("Payroll draft", "PENDING")
    assert searched.json().get("totalSize", 0) == 0


# -- Decisions -------------------------------------------------------------------------


async def test_approve_moves_publishes_tags_and_never_ingests(scene: Scene) -> None:
    domain = await publish_scheme(
        scene.sessions,
        scene.ws.id,
        scene.admin.id,
        "domain",
        [C("hr", "Nhân sự"), C("it", "Công nghệ thông tin")],
        has_primary=True,
    )
    candidate = await scene.candidate()
    body = await scene.submit(candidate)
    reviewer = await scene.as_(scene.reviewer)

    stale = await reviewer.post(_url(scene, body, ":approve"), json={"etag": "stale"})
    assert stale.status_code == 409
    missing = await reviewer.post(_url(scene, body, ":approve"), json={})
    assert missing.status_code == 400
    member = await scene.as_(scene.member)
    denied = await member.post(_url(scene, body, ":approve"), json={"etag": body["etag"]})
    assert denied.status_code == 403
    unprocessed = await reviewer.post(_url(scene, body, ":approve"), json={"etag": body["etag"]})
    assert unprocessed.json()["error"]["status"] == "FAILED_PRECONDITION"
    assert error_reason(unprocessed) == "CANDIDATE_NOT_PROCESSED"
    await scene.mark_processed(candidate)

    blank = await reviewer.post(_url(scene, body, ":approve"), json={"etag": body["etag"], "title": "  "})
    assert blank.json()["error"]["status"] == "INVALID_ARGUMENT"
    file_name = (await scene.item(candidate.id)).file_name

    approved = await reviewer.post(
        _url(scene, body, ":approve"),
        json={
            "etag": body["etag"],
            "concepts": [
                concept_name(scene.ws.id, "domain", "it"),
                concept_name(scene.ws.id, "domain", "hr"),
            ],
            "summary": "The handbook",
            "title": " Employee handbook 2026 ",
        },
    )
    assert approved.status_code == 200, approved.text
    assert approved.json()["state"] == "APPROVED"
    assert approved.json()["decision"]["reviewer"].endswith(str(scene.reviewer.id))
    item = await scene.item(candidate.id)
    assert (item.parent_item_id, item.is_published, item.description, item.item_name) == (
        scene.kb.id,
        True,
        "The handbook",
        "Employee handbook 2026",
    )
    assert item.file_name == file_name
    async with scene.sessions() as session:
        rows = (
            await session.execute(
                select(ItemConcept.concept_id, ItemConcept.is_primary).where(
                    ItemConcept.item_id == candidate.id,
                    ItemConcept.state == "accepted",
                    ItemConcept.source == "human",
                )
            )
        ).all()
    assert set(rows) == {(domain["it"], True), (domain["hr"], False)}
    assert await _count(scene, select(func.count()).select_from(IngestionRun)) == 0
    notified = await _count(
        scene,
        select(func.count()).where(
            Notification.recipient_user_id == scene.member.id,
            Notification.kind == "contribution_reviewed",
        ),
    )
    assert notified == 1

    again = await reviewer.post(
        _url(scene, body, ":approve"), json={"etag": approved.json()["etag"]}
    )
    assert again.json()["error"]["status"] == "FAILED_PRECONDITION"


async def test_approve_without_target_needs_one(scene: Scene) -> None:
    candidate = await scene.candidate()
    await scene.mark_processed(candidate)
    api = await scene.as_(scene.member)
    body = (await api.post(scene.url("contributions"), json={"item": item_name(candidate)})).json()
    admin = await scene.as_(scene.admin)
    response = await admin.post(_url(scene, body, ":approve"), json={"etag": body["etag"]})
    assert response.json()["error"]["status"] == "INVALID_ARGUMENT"
    approved = await admin.post(
        _url(scene, body, ":approve"),
        json={"etag": body["etag"], "targetCollection": item_name(scene.kb)},
    )
    assert approved.json()["state"] == "APPROVED"


async def test_approved_new_revision_appends_a_revision_and_deletes_the_candidate(
    scene: Scene,
) -> None:
    replaced = await scene.world.make_document(scene.kb, item_name="Handbook")
    await scene.set_content(replaced)
    candidate = await scene.candidate(item_name="Handbook")
    api = await scene.as_(scene.member)
    body = (
        await api.post(
            scene.url("contributions"),
            json={"item": item_name(candidate), "kind": "NEW_REVISION", "replacesItem": item_name(replaced)},
        )
    ).json()
    reviewer = await scene.as_(scene.reviewer)

    approved = await reviewer.post(_url(scene, body, ":approve"), json={"etag": body["etag"]})

    assert approved.json()["state"] == "APPROVED", approved.text
    revisions = await _count(
        scene, select(func.count()).where(ItemRevision.item_id == replaced.id)
    )
    assert revisions == 2
    assert (await scene.item(candidate.id)).deleted_at is not None
    shown = (await scene.item(replaced.id)).current_revision
    assert shown is not None and candidate.current_revision is not None
    assert shown.content_id == candidate.current_revision.content_id


async def test_new_revision_approval_fails_when_the_document_moved(scene: Scene) -> None:
    replaced = await scene.world.make_document(scene.kb)
    candidate = await scene.candidate()
    api = await scene.as_(scene.member)
    body = (
        await api.post(
            scene.url("contributions"),
            json={"item": item_name(candidate), "kind": "NEW_REVISION", "replacesItem": item_name(replaced)},
        )
    ).json()
    elsewhere = await scene.world.make_collection(scene.ws)
    await scene.set_item(replaced, parent_item_id=elsewhere.id)

    admin = await scene.as_(scene.admin)
    response = await admin.post(_url(scene, body, ":approve"), json={"etag": body["etag"]})
    assert (response.status_code, error_reason(response)) == (400, "TARGET_MOVED")


async def test_request_changes_resubmit_and_stale_approval(scene: Scene) -> None:
    body = await scene.submit(await scene.candidate())
    reviewer = await scene.as_(scene.reviewer)
    member = await scene.as_(scene.member)

    changes = await reviewer.post(_url(scene, body, ":requestChanges"), json={"message": "Add a date"})
    assert changes.json()["state"] == "CHANGES_REQUESTED"
    assert changes.json()["decision"]["message"] == "Add a date"
    early = await member.post(_url(scene, body, ":approve"), json={"etag": changes.json()["etag"]})
    assert early.status_code == 403
    outsider = await scene.as_(scene.outsider)
    assert (await outsider.post(_url(scene, body, ":resubmit"), json={"changeSummary": "x"})).status_code == 403

    replacement = await scene.candidate()
    resubmitted = await member.post(
        _url(scene, body, ":resubmit"),
        json={"changeSummary": "Dated", "item": item_name(replacement)},
    )
    assert resubmitted.json()["state"] == "IN_REVIEW", resubmitted.text
    assert resubmitted.json()["item"] == item_name(replacement)
    assert resubmitted.json()["etag"] != changes.json()["etag"]
    assert [e["kind"] for e in resubmitted.json()["events"]][-2:] == ["RESUBMITTED", "ANALYZED"]

    stale = await reviewer.post(_url(scene, body, ":approve"), json={"etag": changes.json()["etag"]})
    assert stale.status_code == 409
    again = await member.post(_url(scene, body, ":resubmit"), json={"changeSummary": "x"})
    assert again.json()["error"]["status"] == "FAILED_PRECONDITION"


async def test_reject_withdraw_and_delete(scene: Scene) -> None:
    rejected = await scene.submit(await scene.candidate())
    withdrawn = await scene.submit(await scene.candidate())
    reviewer = await scene.as_(scene.reviewer)
    member = await scene.as_(scene.member)

    open_delete = await member.delete(_url(scene, rejected))
    assert open_delete.json()["error"]["status"] == "FAILED_PRECONDITION"
    assert (await member.post(_url(scene, rejected, ":reject"), json={"message": "no"})).status_code == 403
    response = await reviewer.post(_url(scene, rejected, ":reject"), json={"message": "Out of scope"})
    assert response.json()["state"] == "REJECTED"
    assert (await reviewer.post(_url(scene, withdrawn, ":withdraw"), json={})).status_code == 403
    withdrawal = await member.post(_url(scene, withdrawn, ":withdraw"), json={"etag": withdrawn["etag"]})
    assert withdrawal.json()["state"] == "WITHDRAWN"
    terminal = await member.post(_url(scene, withdrawn, ":withdraw"), json={})
    assert terminal.json()["error"]["status"] == "FAILED_PRECONDITION"

    assert (await reviewer.delete(_url(scene, rejected))).status_code == 403
    stale = await member.delete(_url(scene, rejected), params={"etag": "stale"})
    assert stale.status_code == 409
    deleted = await member.delete(_url(scene, rejected))
    assert deleted.status_code == 200 and deleted.json() == {}
    assert (await member.get(_url(scene, rejected))).status_code == 404
    rows = await _count(scene, select(func.count()).select_from(Contribution).where(Contribution.deleted_at.is_(None)))
    assert rows == 1


async def test_open_candidate_cannot_be_deleted_or_moved(scene: Scene) -> None:
    candidate = await scene.candidate()
    await scene.submit(candidate)
    member = await scene.as_(scene.member)
    response = await member.delete(f"/api/v1/{item_name(candidate)}")
    assert (response.status_code, error_reason(response)) == (400, "CONTRIBUTION_OPEN")


# -- Processing before review ----------------------------------------------------------


async def _process(scene: Scene, user: Any, *items: Any) -> Any:
    api = await scene.as_(user)
    return await api.post(
        scene.url("ingestionRuns"),
        json={"selector": {"items": [item_name(item) for item in items]}},
    )


async def _run_items(scene: Scene, response: Any) -> set[Any]:
    run_id = response.json()["name"].rsplit("/", 1)[1]
    async with scene.sessions() as session:
        return set(
            await session.scalars(
                select(IngestionRunItem.item_id).where(IngestionRunItem.run_id == run_id)
            )
        )


async def test_deciders_process_an_open_candidate_others_cannot(scene: Scene) -> None:
    candidate = await scene.candidate()
    body = await scene.submit(candidate)
    second = await scene.candidate()
    await scene.submit(second)
    # Only contributions.review on the target: no ingestionRuns.create anywhere.
    decider = await scene.world.add_member(scene.ws)
    role = await scene.world.make_role(scene.ws, "contributionReviewer", ["contributions.review"])
    await scene.world.grant(decider, role, on=scene.kb)
    other = await scene.world.make_document(scene.personal, creator=scene.member)

    # Non-deciders, and other documents of the contributor's personal collection.
    assert (await _process(scene, scene.outsider, candidate)).status_code == 403
    assert (await _process(scene, decider, candidate, other)).status_code == 403
    for user, item in ((scene.reviewer, candidate), (decider, second)):
        response = await _process(scene, user, item)
        assert response.status_code == 200, response.text
        assert await _run_items(scene, response) == {item.id}

    reviewer = await scene.as_(scene.reviewer)
    await reviewer.post(_url(scene, body, ":reject"), json={"message": "Out of scope"})
    # A closed contribution's candidate is the contributor's own again.
    assert (await _process(scene, scene.reviewer, candidate)).status_code == 403
    assert (await _process(scene, decider, candidate)).status_code == 403


async def test_approve_needs_a_processed_new_document_candidate(scene: Scene) -> None:
    reviewer = await scene.as_(scene.reviewer)
    failed = await scene.candidate()
    failed_body = await scene.submit(failed)
    await scene.mark_processed(failed, index_status="failed")
    unsupported = await scene.candidate(file_name="archive.bin")
    unsupported_body = await scene.submit(unsupported)
    await scene.mark_processed(unsupported, index_status="unsupported")

    refused = await reviewer.post(
        _url(scene, failed_body, ":approve"), json={"etag": failed_body["etag"]}
    )
    accepted = await reviewer.post(
        _url(scene, unsupported_body, ":approve"), json={"etag": unsupported_body["etag"]}
    )

    assert (refused.status_code, error_reason(refused)) == (400, "CANDIDATE_NOT_PROCESSED")
    assert (await reviewer.get(_url(scene, failed_body))).json()["state"] == "IN_REVIEW"
    assert (await scene.item(failed.id)).parent_item_id == scene.personal.id
    assert accepted.json()["state"] == "APPROVED", accepted.text
    assert await _count(scene, select(func.count()).select_from(IngestionRun)) == 0
