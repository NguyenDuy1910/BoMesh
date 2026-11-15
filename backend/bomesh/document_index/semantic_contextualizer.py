"""LLM-backed, chunk-specific retrieval contextualization and document classification."""

from __future__ import annotations

from collections.abc import Sequence

from bomesh import ModelResponseClient, model_json_object, render_prompt
from bomesh.connector.protocol import Chunk
from bomesh.document_index import ClassificationRequest, DocumentClassification

_DISALLOWED_PREFIXES = ("document:", "section:", "context:", "description:")


class SemanticContextualizer:
    """Generate concise context while leaving canonical evidence untouched."""

    def __init__(
        self,
        transport: ModelResponseClient,
        *,
        model_name: str | None = None,
        max_output_tokens: int = 128,
        classification_max_output_tokens: int = 512,
        reasoning_effort: str | None = "none",
    ) -> None:
        if max_output_tokens < 1 or classification_max_output_tokens < 1:
            raise ValueError("max_output_tokens must be at least one")
        self._transport = transport
        self._model_name = model_name
        self._max_output_tokens = max_output_tokens
        self._classification_max_output_tokens = classification_max_output_tokens
        # A reasoning model would otherwise spend the small output budget on
        # reasoning and return no text; ``None`` omits the parameter.
        self._params: dict[str, object] = {"temperature": 0}
        if reasoning_effort is not None:
            self._params["reasoning"] = {"effort": reasoning_effort}

    @property
    def model_name(self) -> str | None:
        """Return the configured model identity used for index freshness."""

        return self._model_name or self._transport.model

    async def classify(
        self,
        *,
        document_context: str,
        request: ClassificationRequest,
        title: str | None = None,
    ) -> DocumentClassification:
        """Choose the candidate topics that apply to one Document, and summarize it.

        One model call. There is no confidence threshold: the model picks the
        topics that apply, possibly none. Codes outside the candidates are
        dropped; a response that is not the expected JSON object raises.
        """

        normalized_document_context = document_context.strip()
        if not normalized_document_context:
            raise ValueError("document_context must not be empty")
        prompt = classification_prompt(
            request, title=title, document_context=normalized_document_context
        )
        response = await self._transport.responses(
            model=self._model_name,
            input=prompt,
            max_output_tokens=self._classification_max_output_tokens,
            **self._params,
        )
        value = getattr(response, "output_text", None)
        if not isinstance(value, str) or not value.strip():
            raise ValueError("classification response does not contain text")
        profile = model_json_object(value)
        if not isinstance(profile, dict):
            raise ValueError("classification response must be a JSON object")
        codes = profile.get("topics")
        summary = profile.get("summary")
        if not isinstance(codes, list) or not all(isinstance(code, str) for code in codes):
            raise ValueError("classification topics must be a list of codes")
        if summary is not None and not isinstance(summary, str):
            raise ValueError("classification summary must be text")
        by_code = {candidate.code: candidate for candidate in request.candidates}
        return DocumentClassification(
            topics=tuple(
                by_code[code] for code in dict.fromkeys(codes) if code in by_code
            ),
            summary=summary.strip() if summary and summary.strip() else None,
        )

    async def describe(
        self,
        chunk: Chunk,
        *,
        document_context: str,
        title: str | None = None,
        section_path: Sequence[str] = (),
    ) -> str | None:
        normalized_document_context = document_context.strip()
        if not normalized_document_context:
            raise ValueError("document_context must not be empty")
        prompt = render_prompt(
            "contextual_rag",
            document_title=title.strip() if title and title.strip() else "(not provided)",
            section_path=(
                " > ".join(value.strip() for value in section_path if value.strip())
                or "(not provided)"
            ),
            document_context=normalized_document_context,
            chunk_text=chunk.chunk_text,
        )
        response = await self._transport.responses(
            model=self._model_name,
            input=prompt,
            max_output_tokens=self._max_output_tokens,
            **self._params,
        )
        value = getattr(response, "output_text", None)
        if not isinstance(value, str):
            raise ValueError("contextualization response does not contain text")
        normalized = value.strip()
        if not normalized:
            return None
        if normalized.casefold().startswith(_DISALLOWED_PREFIXES):
            raise ValueError("contextualization response contains a structural prefix")
        return normalized


_EXAMPLE_TITLE_MAX_CHARACTERS = 200


def classification_prompt(
    request: ClassificationRequest, *, title: str | None, document_context: str
) -> str:
    """The ``document_profile`` prompt for one document: candidates with their signals."""

    return render_prompt(
        "document_profile",
        document_title=title.strip() if title and title.strip() else "(not provided)",
        note=request.note.strip() if request.note and request.note.strip() else "(not provided)",
        candidates=[
            {
                key: value
                for key, value in (
                    ("code", candidate.code),
                    ("name", candidate.name),
                    ("domain", candidate.domain),
                    ("description", candidate.description),
                    ("keywords", list(candidate.keywords)),
                    ("synonyms", list(candidate.synonyms)),
                    ("guidance", candidate.guidance),
                    (
                        "examples",
                        [example[:_EXAMPLE_TITLE_MAX_CHARACTERS] for example in candidate.examples],
                    ),
                )
                if value
            }
            for candidate in request.candidates
        ],
        document_context=document_context,
    )


__all__ = ["SemanticContextualizer", "classification_prompt"]
