"""ExportArtifact (CSV, PDF, Markdown, DOCX), PublishArtifact and the sandbox export (record_generated)."""

from __future__ import annotations

import io
import zipfile
from uuid import uuid4

import pytest
from sqlalchemy import select

from artifacts_support import Scene, artifact_id, draft, reason, review
from bomesh.db.models import Artifact, Conversation, Item
from bomesh.iam.authorizer import Principal, WorkspaceAccess
from bomesh.runtime import AppRuntime
from bomesh.services import ArtifactValidationError
from harness import Sessions, World

pytestmark = pytest.mark.asyncio

DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"


def url(name: str, suffix: str = "") -> str:
    return f"/api/v1/{name}{suffix}"


async def export(scene: Scene, name: str, mime_type: str, **params: str) -> object:
    return await scene.as_owner.get(url(name, ":export"), params={"mimeType": mime_type, **params})


# -- Export -----------------------------------------------------------------------------------


async def test_text_exports_as_markdown_pdf_and_docx(scene: Scene, runtime: AppRuntime) -> None:
    artifact = await draft(scene, runtime, "# Travel\n\n- Book economy\n")

    markdown = await export(scene, artifact["name"], "text/markdown")
    pdf = await export(scene, artifact["name"], "application/pdf")
    docx = await export(scene, artifact["name"], DOCX)
    csv = await export(scene, artifact["name"], "text/csv")

    assert markdown.status_code == 200  # type: ignore[attr-defined]
    assert markdown.content == b"# Travel\n\n- Book economy"  # type: ignore[attr-defined]
    assert pdf.content.startswith(b"%PDF-1.4") and b"(# Travel) Tj" in pdf.content  # type: ignore[attr-defined]
    assert pdf.headers["content-type"] == "application/pdf"  # type: ignore[attr-defined]
    with zipfile.ZipFile(io.BytesIO(docx.content)) as archive:  # type: ignore[attr-defined]
        assert "Book economy" in archive.read("word/document.xml").decode()
    assert csv.status_code == 400  # type: ignore[attr-defined]


async def test_an_older_revision_exports_by_name(scene: Scene, runtime: AppRuntime) -> None:
    artifact = await draft(scene, runtime, "first")
    await scene.as_owner.post(url(artifact["name"], ":commit"), json={"text": "second"})

    old = await export(scene, artifact["name"], "text/markdown", revision=f"{artifact['name']}/revisions/1")
    missing = await export(scene, artifact["name"], "text/markdown", revision="9")
    bad = await export(scene, artifact["name"], "image/png")

    assert old.content == b"first"  # type: ignore[attr-defined]
    assert missing.status_code == 404  # type: ignore[attr-defined]
    assert bad.status_code == 400  # type: ignore[attr-defined]


async def test_evidence_review_exports_and_withholds_per_reader(
    scene: Scene, runtime: AppRuntime, sessions: Sessions, world: World
) -> None:
    artifact = await review(scene, runtime, sessions, space=scene.space_name, audience="SPACE")

    csv = await export(scene, artifact["name"], "text/csv")
    markdown = await export(scene, artifact["name"], "text/markdown")
    await world.revoke(scene.reader, on=scene.handbook)
    withheld = await scene.as_reader.get(
        url(artifact["name"], ":export"), params={"mimeType": "text/markdown"}
    )

    assert csv.content.decode().splitlines()[1].startswith("plan-a,travel,SUPPORTED,Economy only.")  # type: ignore[attr-defined]
    text = markdown.content.decode()  # type: ignore[attr-defined]
    assert "## Plan A" in text and "Economy only." in text and "Plan A fits." in text
    assert withheld.status_code == 200
    assert "Economy only." not in withheld.text and "Unavailable" in withheld.text
    assert "Plan A fits." not in withheld.text


async def test_export_follows_read_access(scene: Scene, runtime: AppRuntime) -> None:
    artifact = await draft(scene, runtime)

    response = await scene.as_stranger.get(
        url(artifact["name"], ":export"), params={"mimeType": "text/markdown"}
    )

    assert response.status_code == 404


# -- Publish ------------------------------------------------------------------------------------


async def test_publish_creates_a_published_document(
    scene: Scene, runtime: AppRuntime, sessions: Sessions
) -> None:
    artifact = await draft(scene, runtime, "# Memo\n", sourceItems=[scene.item(scene.policy)])

    response = await scene.as_owner.post(
        url(artifact["name"], ":publish"),
        json={"collection": scene.item(scene.handbook), "etag": artifact["etag"]},
    )

    assert response.status_code == 200, response.text
    item = (await scene.as_owner.get(url(response.json()["item"]))).json()
    assert item["itemType"] == "DOCUMENT"
    assert item["parentItem"] == scene.item(scene.handbook)
    assert item["document"]["publicationState"] == "PUBLISHED"
    assert (await scene.as_owner.get(url(artifact["name"]))).json()["state"] == "ACTIVE"
    async with sessions() as session:
        assert await session.get(Artifact, artifact_id(response.json()["item"])) is None


async def test_publish_refuses_a_destination_whose_readers_cannot_read_the_sources(
    scene: Scene, runtime: AppRuntime
) -> None:
    artifact = await draft(scene, runtime, sourceItems=[scene.item(scene.secret)])

    response = await scene.as_owner.post(
        url(artifact["name"], ":publish"), json={"collection": scene.item(scene.handbook)}
    )

    assert response.status_code == 400
    assert reason(response) == "AUDIENCE_CANNOT_READ_SOURCES"


async def test_publish_errors(scene: Scene, runtime: AppRuntime, world: World) -> None:
    artifact = await draft(scene, runtime)
    readonly = await world.make_collection(scene.workspace, grants={scene.owner: "roles/collectionViewer"})
    shared = await draft(
        scene, runtime, sourceItems=[scene.item(scene.policy)], space=scene.space_name, audience="SPACE"
    )

    no_create = await scene.as_owner.post(url(artifact["name"], ":publish"), json={"collection": scene.item(readonly)})
    unreadable = await scene.as_reader.post(url(shared["name"], ":publish"), json={"collection": scene.item(scene.handbook)})
    document = await scene.as_owner.post(url(artifact["name"], ":publish"), json={"collection": scene.item(scene.policy)})
    hidden = await scene.as_owner.post(url(artifact["name"], ":publish"), json={"collection": scene.item(scene.board) + "x"})
    stale = await scene.as_owner.post(
        url(artifact["name"], ":publish"), json={"collection": scene.item(scene.handbook), "etag": "stale"}
    )

    assert no_create.status_code == 403
    assert unreadable.status_code == 403
    assert document.status_code == 400
    assert hidden.status_code == 400
    assert stale.status_code == 409


async def test_publish_with_request_id_creates_one_document(
    scene: Scene, runtime: AppRuntime, sessions: Sessions
) -> None:
    artifact = await draft(scene, runtime)
    params = {"requestId": str(uuid4())}
    body = {"collection": scene.item(scene.handbook)}

    first = await scene.as_owner.post(url(artifact["name"], ":publish"), params=params, json=body)
    second = await scene.as_owner.post(url(artifact["name"], ":publish"), params=params, json=body)

    assert first.json()["item"] == second.json()["item"]


async def test_publish_an_evidence_review_as_markdown(
    scene: Scene, runtime: AppRuntime, sessions: Sessions
) -> None:
    artifact = await review(scene, runtime, sessions)

    response = await scene.as_owner.post(
        url(artifact["name"], ":publish"), json={"collection": scene.item(scene.handbook)}
    )

    assert response.status_code == 200, response.text
    async with sessions() as session:
        item = await session.get(Item, artifact_id(response.json()["item"]))
    assert item is not None and item.mime_type == "text/markdown"


# -- Sandbox export during a turn -----------------------------------------------------------------


async def test_record_generated_keeps_one_file_artifact_per_conversation_file(
    scene: Scene, runtime: AppRuntime, sessions: Sessions
) -> None:
    created = await scene.as_owner.post(
        f"/api/v1/workspaces/{scene.workspace.id}/conversations",
        params={"conversationId": "chat-1"},
        json={},
    )
    assert created.status_code == 200, created.text
    async with sessions() as session:
        conversation_id = await session.scalar(
            select(Conversation.id).where(Conversation.code == "chat-1")
        )
    access = WorkspaceAccess(Principal(scene.owner.id), scene.workspace.id, runtime.authorizer_factory())
    engine = runtime.artifact_service()

    first = await engine.record_generated(
        access, conversation_id=conversation_id, file_name="out/report.csv", mime_type="", data=b"a\n1\n", summary="v1"
    )
    second = await engine.record_generated(
        access, conversation_id=conversation_id, file_name="report.csv", mime_type="text/csv", data=b"a\n2\n", summary="v2"
    )

    assert first.artifact_id == second.artifact_id
    assert (first.revision, second.revision) == (1, 2)
    assert (first.file_name, first.mime_type) == ("report.csv", "text/csv")
    artifact = (await scene.as_owner.get(url(first.name))).json()
    assert artifact["kind"] == "FILE"
    assert artifact["conversation"] == f"workspaces/{scene.workspace.id}/conversations/chat-1"
    listed = (
        await scene.as_owner.get(
            f"{scene.url}", params={"filter": f'conversation = "{artifact["conversation"]}"'}
        )
    ).json()["artifacts"]
    assert [a["name"] for a in listed] == [first.name]
    with pytest.raises(ArtifactValidationError):
        await engine.record_generated(
            access, conversation_id=None, file_name="empty.txt", mime_type="text/plain", data=b"", summary="x"
        )
    async with sessions() as session:
        kinds = list(await session.scalars(select(Artifact.kind).where(Artifact.owner_user_id == scene.owner.id)))
    assert kinds == ["file"]
