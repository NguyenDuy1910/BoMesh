"""The agent's resource read: a document's Structured Document as Markdown.

A processed document is read from its stored Structured Document and never
parsed again; one without parses its original once, never converting it.
"""

from __future__ import annotations

from io import BytesIO
from typing import Any
from uuid import UUID

import docx
import pytest
from docling_core.types.doc import DocItemLabel, DoclingDocument, ImageRef, Size

from bomesh.agent import ResourceRef
from bomesh.document_structure import StructureManifest
from bomesh.iam.authorizer import Authorizer, Principal, WorkspaceAccess
from bomesh.runtime import AppRuntime
from bomesh.services.agent_runtime.item_resource_resolver import ItemResourceResolver
from harness import World
from knowledge_support import Knowledge, upload

pytestmark = pytest.mark.asyncio

DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"


def _resolver(runtime: AppRuntime, knowledge: Knowledge, user: Any, workspace: Any) -> ItemResourceResolver:
    return ItemResourceResolver(
        runtime.sessions(),
        access=WorkspaceAccess(Principal(user.id), workspace.id, Authorizer(knowledge.sessions)),
        structures=runtime.structure_store(),
        originals=runtime.original_parser(),
        max_read_characters=10_000,
    )


def _ref(item_id: UUID) -> ResourceRef:
    return ResourceRef(id=str(item_id), name="document", mime_type="application/octet-stream")


async def test_a_processed_document_is_read_from_its_structure(
    world: World, knowledge: Knowledge, runtime: AppRuntime, monkeypatch: pytest.MonkeyPatch
) -> None:
    admin = await world.make_user()
    workspace = await world.make_workspace(admin)
    collection = await world.make_collection(workspace)
    document = await world.make_document(collection)
    structure = DoclingDocument(name="plan")
    structure.add_heading("Budget", level=1)
    structure.add_text(label=DocItemLabel.TEXT, text="Travel takes most of it.")
    structure.add_picture(
        image=ImageRef(mimetype="image/png", dpi=72, size=Size(width=64, height=64), uri=f"{'a' * 64}.png")
    )
    await knowledge.store_structure(document, structure)

    async def never(*args: Any, **kwargs: Any) -> Any:
        raise AssertionError("a processed document is never parsed again")

    monkeypatch.setattr(runtime.structure_store(), "ensure", never)
    resolver = _resolver(runtime, knowledge, admin, workspace)

    text = await resolver.read(_ref(document.id), max_characters=10_000)
    clipped = await resolver.read(_ref(document.id), max_characters=10)

    assert text == "## Budget\n\nTravel takes most of it.\n\n<!-- image -->"
    assert clipped == "## Budget…"


async def test_an_unprocessed_document_is_parsed_once_without_conversion(
    client, world: World, knowledge: Knowledge, runtime: AppRuntime, monkeypatch: pytest.MonkeyPatch
) -> None:
    admin = await world.make_user()
    workspace = await world.make_workspace(admin)
    collection = await world.make_collection(workspace)
    word = docx.Document()
    word.add_paragraph("Twelve days of leave a year.")
    data = BytesIO()
    word.save(data)
    response = await upload(
        await client.as_(admin), collection, data=data.getvalue(), file_name="leave.docx", mime_type=DOCX
    )
    assert response.status_code == 200, response.text
    document_id = UUID(response.json()["name"].rsplit("/", 1)[1])
    structures = runtime.structure_store()
    calls: list[dict[str, Any]] = []
    original = structures.ensure

    async def recorded(*args: Any, **kwargs: Any) -> Any:
        calls.append(kwargs)
        return await original(*args, **kwargs)

    monkeypatch.setattr(structures, "ensure", recorded)
    resolver = _resolver(runtime, knowledge, admin, workspace)

    first = await resolver.read(_ref(document_id), max_characters=10_000)
    second = await resolver.read(_ref(document_id), max_characters=10_000)

    assert first == second == "Twelve days of leave a year."
    assert len(calls) == 1 and calls[0]["convert"] is False
    revision = (await knowledge.row(document_id)).current_revision
    assert revision is not None and StructureManifest.parse(revision.exports) is not None
