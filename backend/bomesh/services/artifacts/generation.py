"""The assistant side of CreateArtifact and ReviseArtifact, run behind their operation.

Generation uses the configured agent model only (``runtime.agent_transport()``)
and retrieves evidence from the artifact's sources with the owner's
permissions as they are now. Text kinds become one Markdown revision; an
EVIDENCE_REVIEW fills each requested cell from passages of the sources (no
passage: NOT_FOUND without a model call), then writes the synthesis and
freezes the matrix as a revision. The work settles its operation: complete
with the artifact, or fail and leave the artifact FAILED (create) or back
to ACTIVE (revise). A cancelled operation's work is stopped the same way.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
from collections.abc import Sequence
from contextlib import suppress
from dataclasses import dataclass
from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession

from bomesh.agent.protocol import InputText, MessageItem, Prompt
from bomesh.agent.reducer import ResponseReducer
from bomesh.agent.transports import response_stream
from bomesh.db.engine import transaction_scope
from bomesh.db.models import Artifact, EvidenceReviewCell
from bomesh.errors import FailedPrecondition, ServiceError, Unavailable
from bomesh.iam.authorizer import ItemRef, Principal, WorkspaceAccess
from bomesh.iam.visibility import is_visible
from bomesh.knowledge import Evidence
from bomesh.services import ARTIFACT_MIME_TYPE
from bomesh.services.artifacts.artifact_store import (
    EVIDENCE_REVIEW_MIME_TYPE,
    add_revision,
    artifact_name,
    cells,
    current_revision,
    load_artifact,
    matrix_object,
    new_revision_object_key,
    set_item,
    source_ids,
    touch,
)
from bomesh.services.artifacts.support import TEXT_KINDS, ArtifactDeps
from bomesh.services.conversations.records import StoredCitation
from bomesh.services.kernel.operations import Operations, operation_name
from bomesh.services.knowledge_items.search import retrieve_passages

log = logging.getLogger(__name__)

#: Passages a prompt may carry, and how many candidates are retrieved for them.
MAX_PASSAGES = 8
_CANDIDATES = 32
_EXCERPT_CHARACTERS = 300
_PASSAGE_CHARACTERS = 1_500
_CELL_STATES = frozenset({"SUPPORTED", "PARTIAL", "NOT_FOUND"})

_KIND_INSTRUCTIONS = {
    "file": "Write the requested document.",
    "draft": "Write a well-structured draft document.",
    "study_guide": (
        "Write a study guide: the key concepts with short explanations, a summary and "
        "review questions."
    ),
    "quiz": (
        "Write a quiz: numbered multiple-choice questions with four options each, "
        "followed by an answer key."
    ),
}
_TEXT_SYSTEM = (
    "You write documents for a business knowledge workspace. Answer in Markdown only, "
    "without any preamble. Ground every factual statement in the numbered source passages "
    "when they are given and never invent facts that they do not support."
)
_CELL_SYSTEM = (
    "You assess how well source passages support one criterion for one option. Reply with "
    'one JSON object only: {"state": "SUPPORTED" | "PARTIAL" | "NOT_FOUND", '
    '"summary": "<two sentences at most>", "citations": [<numbers of the passages used>]}.'
)
_SYNTHESIS_SYSTEM = (
    "You summarize an evidence review for a decision maker in a few short Markdown "
    "paragraphs, comparing the options against the criteria. Use only the findings given."
)
_NOTHING_FOUND = "No passage of the sources addresses this criterion."


class GenerationFailed(Exception):
    """The model did not produce a usable answer."""


@dataclass(frozen=True, slots=True)
class _Passage:
    evidence: Evidence

    def citation(self) -> StoredCitation:
        evidence = self.evidence
        return StoredCitation(
            item_id=UUID(evidence.item_id),
            chunk_id=evidence.chunk_id,
            page=evidence.citation.page_start,
            title=evidence.title,
            excerpt=" ".join(evidence.content.split())[:_EXCERPT_CHARACTERS] or None,
        )


class ArtifactGenerator:
    """Runs one generation; started by the artifact service, settled here."""

    def __init__(self, deps: ArtifactDeps) -> None:
        self._deps = deps

    async def run(
        self,
        operation_id: UUID,
        workspace_id: UUID,
        artifact_id: UUID,
        *,
        instructions: str | None,
        cell_keys: Sequence[tuple[str, str]] | None,
        creating: bool,
    ) -> None:
        try:
            await self._generate(
                operation_id,
                workspace_id,
                artifact_id,
                instructions=instructions,
                cell_keys=cell_keys,
                creating=creating,
            )
        except asyncio.CancelledError:
            # A CancelOperation already ended the operation; a shutdown did not.
            await self._settle_failure(
                operation_id, workspace_id, artifact_id, creating, _interrupted()
            )
            raise
        except Exception as exc:  # noqa: BLE001 - any failure settles the operation
            log.warning(
                "artifact generation failed artifact=%s error_type=%s",
                artifact_name(workspace_id, artifact_id),
                type(exc).__name__,
            )
            error = (
                exc
                if isinstance(exc, ServiceError)
                else Unavailable("The assistant could not generate the artifact; try again.")
            )
            await self._settle_failure(operation_id, workspace_id, artifact_id, creating, error)

    async def _generate(
        self,
        operation_id: UUID,
        workspace_id: UUID,
        artifact_id: UUID,
        *,
        instructions: str | None,
        cell_keys: Sequence[tuple[str, str]] | None,
        creating: bool,
    ) -> None:
        async with transaction_scope(self._deps.sessions) as session:
            row = await load_artifact(session, workspace_id, artifact_id)
            assert row is not None
            item, artifact = row
            sources = await source_ids(session, artifact_id)
            current = await current_revision(session, artifact_id)
            title, kind, owner = item.title, artifact.kind, artifact.owner_user_id
            current_key = current.storage_key if current is not None else None
        access = WorkspaceAccess(Principal(owner), workspace_id, self._deps.runtime.authorizer_factory())
        readable = [
            value
            for value in sources
            if await is_visible(access.authorizer, access.principal, ItemRef(workspace_id, value))
        ]
        if kind == "evidence_review":
            data = await self._review(
                operation_id, workspace_id, artifact_id, access, readable, instructions, cell_keys
            )
            mime_type = EVIDENCE_REVIEW_MIME_TYPE
        else:
            previous = (
                (await self._deps.engine.read_object(current_key)).decode("utf-8", errors="replace")
                if current_key is not None and kind in TEXT_KINDS | {"file"}
                else None
            )
            text = await self._text(access, readable, kind, title, instructions, previous)
            data = text.encode()
            mime_type = ARTIFACT_MIME_TYPE
        await self._complete(
            operation_id, workspace_id, artifact_id, data, mime_type, instructions, creating=creating
        )

    # -- Text kinds ---------------------------------------------------------------------------

    async def _text(
        self,
        access: WorkspaceAccess,
        sources: Sequence[UUID],
        kind: str,
        title: str,
        instructions: str | None,
        previous: str | None,
    ) -> str:
        query = instructions or title
        passages = await self._passages(access, sources, query)
        parts = [f"{_KIND_INSTRUCTIONS[kind]}\nTitle: {title}"]
        if instructions:
            parts.append(f"Instructions:\n{instructions}")
        if previous is not None:
            parts.append(f"Revise this current version:\n{previous}")
        if passages:
            parts.append(f"Source passages:\n{_numbered(passages)}")
        return await self._complete_text(_TEXT_SYSTEM, "\n\n".join(parts))

    # -- Evidence review -----------------------------------------------------------------------

    async def _review(
        self,
        operation_id: UUID,
        workspace_id: UUID,
        artifact_id: UUID,
        access: WorkspaceAccess,
        sources: Sequence[UUID],
        instructions: str | None,
        cell_keys: Sequence[tuple[str, str]] | None,
    ) -> bytes:
        async with transaction_scope(self._deps.sessions) as session:
            artifact = await session.get(Artifact, artifact_id)
            assert artifact is not None and artifact.evidence_review is not None
            review = dict(artifact.evidence_review)
            pending = [
                (cell.option_key, cell.criterion_key)
                for cell in await cells(session, artifact_id)
                if cell.state == "generating"
                and (cell_keys is None or (cell.option_key, cell.criterion_key) in cell_keys)
            ]
        labels = {
            entry["key"]: entry.get("display_name") or entry["key"]
            for entry in [*review.get("options", []), *review.get("criteria", [])]
        }
        descriptions = {
            entry["key"]: entry.get("description") or ""
            for entry in [*review.get("options", []), *review.get("criteria", [])]
        }
        for done, (option, criterion) in enumerate(pending, start=1):
            state, summary, citations = await self._cell(
                access,
                sources,
                option=f"{labels[option]} {descriptions[option]}".strip(),
                criterion=f"{labels[criterion]} {descriptions[criterion]}".strip(),
                instructions=instructions,
            )
            async with transaction_scope(self._deps.sessions) as session:
                cell = await session.get(EvidenceReviewCell, (artifact_id, option, criterion))
                if cell is not None:
                    cell.state = state
                    cell.summary = summary
                    cell.citations = [citation.to_json() for citation in citations]
                await Operations(session).progress(operation_id, int(90 * done / len(pending)))
        async with transaction_scope(self._deps.sessions) as session:
            artifact = await session.get(Artifact, artifact_id, with_for_update=True)
            assert artifact is not None
            rows = await cells(session, artifact_id)
            findings = [
                (labels[row.option_key], labels[row.criterion_key], row.state, row.summary or "")
                for row in rows
                if row.state in ("supported", "partial")
            ]
            cited = list(
                {
                    (citation["item_id"], citation["chunk_id"]): citation
                    for row in rows
                    if row.state in ("supported", "partial")
                    for citation in row.citations
                }.values()
            )
        lines = [f"Instructions: {instructions}"] if instructions else []
        lines += [
            f"- {option} / {criterion}: {state.upper()} — {summary}"
            for option, criterion, state, summary in findings
        ]
        synthesis = (
            await self._complete_text(_SYNTHESIS_SYSTEM, "\n".join(lines))
            if findings
            else "None of the sources address the criteria of this review."
        )
        async with transaction_scope(self._deps.sessions) as session:
            artifact = await session.get(Artifact, artifact_id, with_for_update=True)
            assert artifact is not None
            artifact.evidence_review = {
                **dict(artifact.evidence_review or {}),
                "synthesis": synthesis,
                "synthesis_citations": cited,
            }
            touch(artifact)
            await session.flush()
            return matrix_object(artifact, await cells(session, artifact_id))

    async def _cell(
        self,
        access: WorkspaceAccess,
        sources: Sequence[UUID],
        *,
        option: str,
        criterion: str,
        instructions: str | None,
    ) -> tuple[str, str | None, list[StoredCitation]]:
        passages = await self._passages(access, sources, f"{option} {criterion}")
        if not passages:
            return "not_found", _NOTHING_FOUND, []
        question = f"Option: {option}\nCriterion: {criterion}"
        if instructions:
            question += f"\nInstructions: {instructions}"
        try:
            answer = await self._complete_text(
                _CELL_SYSTEM, f"{question}\n\nSource passages:\n{_numbered(passages)}"
            )
            state, summary, numbers = _cell_answer(answer)
        except GenerationFailed:
            return "failed", None, []
        cited = [passages[n - 1].citation() for n in numbers if 1 <= n <= len(passages)]
        if state != "NOT_FOUND" and not cited:
            return "failed", None, []
        return state.lower(), summary, cited

    # -- Model and retrieval -------------------------------------------------------------------

    async def _passages(
        self, access: WorkspaceAccess, sources: Sequence[UUID], query: str
    ) -> list[_Passage]:
        """Passages of the sources the owner can read now, best first."""
        if not sources:
            return []
        collections = {
            collection
            for value in sources
            if (collection := await access.authorizer.governing_collection(value)) is not None
        }
        wanted = {str(value) for value in sources}
        found = await retrieve_passages(
            self._deps.runtime.knowledge_retriever(),
            access,
            [query],
            tuple(collections),
            limit=_CANDIDATES,
        )
        return [_Passage(evidence) for evidence in found if evidence.item_id in wanted][:MAX_PASSAGES]

    async def _complete_text(self, instructions: str, text: str) -> str:
        """One request to the configured agent model; its whole output text."""
        stream = response_stream(self._deps.runtime.agent_transport())
        prompt = Prompt(
            input=(MessageItem(role="user", content=(InputText(text=text),)),),
            model=stream.model,
            instructions=instructions,
        )
        reducer = ResponseReducer()
        async for event in stream.stream(prompt):
            reducer.apply(event)
        response = reducer.response
        if response is None or response.status != "completed" or not response.output_text.strip():
            raise GenerationFailed("the model returned no answer")
        return response.output_text.strip()

    # -- Settling -------------------------------------------------------------------------------

    async def _complete(
        self,
        operation_id: UUID,
        workspace_id: UUID,
        artifact_id: UUID,
        data: bytes,
        mime_type: str,
        instructions: str | None,
        *,
        creating: bool,
    ) -> None:
        engine = self._deps.engine
        if len(data) > engine.max_content_bytes:
            raise Unavailable("The generated artifact exceeds the size limit.")
        key = new_revision_object_key(workspace_id, artifact_id)
        await engine.put_object(key, data, mime_type)
        try:
            async with transaction_scope(self._deps.sessions) as session:
                row = await load_artifact(session, workspace_id, artifact_id, for_update=True)
                assert row is not None
                item, artifact = row
                await add_revision(
                    session,
                    item,
                    artifact,
                    storage_key=key,
                    mime_type=mime_type,
                    size_bytes=len(data),
                    author="assistant",
                    creator_id=None,
                    summary=(instructions or "Generated by the assistant.")[:500],
                )
                await Operations(session).complete(
                    operation_id, result_name=artifact_name(workspace_id, artifact_id)
                )
        except FailedPrecondition:
            # Cancelled while the answer was being stored: nothing was written.
            await self._settle_failure(operation_id, workspace_id, artifact_id, creating, None)

    async def _settle_failure(
        self,
        operation_id: UUID,
        workspace_id: UUID,
        artifact_id: UUID,
        creating: bool,
        error: ServiceError | None,
    ) -> None:
        """Restore the artifact and fail the operation; never raises (the task is ending)."""
        try:
            async with transaction_scope(self._deps.sessions) as session:
                await restore_unfinished(session, workspace_id, artifact_id, creating=creating)
                if error is not None:
                    with suppress(FailedPrecondition):  # already finished: cancelled
                        await Operations(session).fail(operation_id, error)
        except Exception:  # noqa: BLE001 - the startup reconciler settles what is left
            log.exception(
                "could not settle the failed operation %s", operation_name(operation_id)
            )


async def restore_unfinished(
    session: AsyncSession, workspace_id: UUID, artifact_id: UUID, *, creating: bool
) -> None:
    """After generation stopped: a new artifact FAILED, a revised one ACTIVE again,
    and every cell still GENERATING FAILED."""
    row = await load_artifact(session, workspace_id, artifact_id, for_update=True)
    if row is None:
        return
    item, artifact = row
    if item.status == "pending":
        await set_item(session, item, artifact, status="failed" if creating else "ready")
    for cell in await cells(session, artifact_id):
        if cell.state == "generating":
            cell.state = "failed"
    touch(artifact)
    await session.flush()


def _interrupted() -> Unavailable:
    return Unavailable("The server stopped before the artifact was finished; try again.")


def _numbered(passages: Sequence[_Passage]) -> str:
    return "\n\n".join(
        f"[{number}] {passage.evidence.title}"
        + (
            f" (page {passage.evidence.citation.page_start})"
            if passage.evidence.citation.page_start
            else ""
        )
        + f"\n{passage.evidence.content[:_PASSAGE_CHARACTERS]}"
        for number, passage in enumerate(passages, start=1)
    )


def _cell_answer(text: str) -> tuple[str, str | None, list[int]]:
    match = re.search(r"\{.*\}", text, re.DOTALL)
    if match is None:
        raise GenerationFailed("the cell answer is not JSON")
    try:
        data = json.loads(match.group(0))
    except json.JSONDecodeError as exc:
        raise GenerationFailed("the cell answer is not JSON") from exc
    state = str(data.get("state", "")).upper()
    if state not in _CELL_STATES:
        raise GenerationFailed(f"unknown cell state {state!r}")
    summary = data.get("summary")
    numbers = [value for value in data.get("citations") or [] if isinstance(value, int)]
    return state, summary if isinstance(summary, str) and summary.strip() else None, numbers


__all__ = ["MAX_PASSAGES", "ArtifactGenerator", "restore_unfinished"]

