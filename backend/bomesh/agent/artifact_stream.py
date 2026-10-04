"""Attach the files a turn produced to the answer text that presents them."""

from __future__ import annotations

from collections.abc import Sequence

from bomesh.agent import SandboxArtifact
from bomesh.agent.protocol import (
    ARTIFACT_ANNOTATION_TYPE,
    Annotation,
    MessageItem,
    OutputText,
    ResponseContentPartDoneEvent,
    ResponseOutputItemDoneEvent,
    ResponseStreamEvent,
)

_PartKey = tuple[int, int]


class ArtifactProjection:
    """Annotate the first answer text after a file was saved with that file.

    A saved file reaches the client live as tool progress, which is not part
    of the stored conversation. The answer is: one zero-width
    ``bomesh:artifact`` annotation per produced revision, at the end of the
    first non-empty output text this sampling request completes, is what lets
    a restored conversation (web or mobile) rebuild its file cards, exactly
    as citations are rebuilt from theirs.
    """

    def __init__(self, artifacts: Sequence[SandboxArtifact]) -> None:
        self._pending = tuple(artifacts)
        self._placed: dict[_PartKey, tuple[Annotation, ...]] = {}

    @property
    def presented(self) -> tuple[SandboxArtifact, ...]:
        """The artifacts this request attached to its text."""

        return self._pending if self._placed else ()

    def project(self, event: ResponseStreamEvent) -> ResponseStreamEvent:
        """Return the event with this request's artifact annotations attached."""

        if isinstance(event, ResponseContentPartDoneEvent) and isinstance(
            event.part, OutputText
        ):
            key = (event.output_index, event.content_index)
            self._place(key, event.part)
            return event.model_copy(update={"part": self._annotated(key, event.part)})
        if isinstance(event, ResponseOutputItemDoneEvent) and isinstance(
            event.item, MessageItem
        ):
            # Providers that skip ``content_part.done`` still finish the item.
            for index, part in enumerate(event.item.content):
                if isinstance(part, OutputText):
                    self._place((event.output_index, index), part)
            content = tuple(
                self._annotated((event.output_index, index), part)
                if isinstance(part, OutputText)
                else part
                for index, part in enumerate(event.item.content)
            )
            return event.model_copy(
                update={"item": event.item.model_copy(update={"content": content})}
            )
        return event

    def _place(self, key: _PartKey, part: OutputText) -> None:
        if not self._pending or self._placed or not part.text.strip():
            return
        end = len(part.text)
        self._placed[key] = tuple(
            {
                "type": ARTIFACT_ANNOTATION_TYPE,
                "start_index": end,
                "end_index": end,
                "artifact": artifact.reference(),
            }
            for artifact in self._pending
        )

    def _annotated(self, key: _PartKey, part: OutputText) -> OutputText:
        added = tuple(
            annotation
            for annotation in self._placed.get(key, ())
            if annotation not in part.annotations
        )
        if not added:
            return part
        return part.model_copy(update={"annotations": (*part.annotations, *added)})


__all__ = ["ArtifactProjection"]
