"""LLM-backed, chunk-specific retrieval contextualization and document classification."""

from __future__ import annotations

import asyncio
import hashlib
import html
import logging
import re
import time
import unicodedata
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from functools import lru_cache
from typing import Any

from bomesh import ModelResponseClient, model_json_object, render_prompt
from bomesh.connector.protocol import Chunk
from bomesh.document_index import ClassificationRequest, DocumentClassification, TopicCandidate

log = logging.getLogger(__name__)

_DISALLOWED_PREFIXES = ("document:", "section:", "context:", "description:")
#: A prompt prefix is treated as cached this long after a call used it (provider
#: caches live five minutes or more after their last read).
_CACHE_WARM_SECONDS = 240.0


class SemanticContextualizer:
    """Generate concise context while leaving canonical evidence untouched."""

    def __init__(
        self,
        transport: ModelResponseClient,
        *,
        model_name: str | None = None,
        max_output_tokens: int = 128,
        classification_max_output_tokens: int = 1024,
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
        # Prompt prefixes (by cache key) a call used recently, and the call that
        # is writing a cold one: parallel documents wait for it, then read it.
        self._warm: dict[str, float] = {}
        self._warming: dict[str, asyncio.Future[None]] = {}

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

        The prompt is a prefix shared by every document of the request
        (instructions, note, taxonomy), marked as a prompt-cache breakpoint and
        keyed for sticky routing, and this document's part (keyword matches,
        title, excerpt). There is no confidence threshold and no cap: the model
        picks every topic that applies, possibly none. An answer names each
        topic by its label and name; a label whose name disagrees resolves by
        the name or is dropped. An unreadable answer, or one whose topics are
        all invalid, is asked again once; a second failure raises.
        """

        normalized_document_context = document_context.strip()
        if not normalized_document_context:
            raise ValueError("document_context must not be empty")
        prompt = classification_prompt(request)
        blocks: list[dict[str, Any]] = [
            {"type": "input_text", "text": prompt.prefix, "cache_control": {"type": "ephemeral"}},
            {
                "type": "input_text",
                "text": prompt.document(title=title, document_context=normalized_document_context),
            },
        ]

        async def answer(attempt: int) -> DocumentClassification:
            response = await self._cached_call(
                prompt.cache_key,
                input=[{"role": "user", "content": blocks}],
                max_output_tokens=self._classification_max_output_tokens,
            )
            _log_usage(response, candidates=len(prompt.labels), attempt=attempt)
            return prompt.read(getattr(response, "output_text", None))

        try:
            return await answer(1)
        except ClassificationAnswerError as problem:
            # Asked again after the cached prefix and this document: only the
            # correction is new, so the retry costs little.
            retry = render_prompt("document_profile_retry", problem=str(problem))
            blocks.append({"type": "input_text", "text": retry})
            return await answer(2)

    async def _cached_call(self, cache_key: str, **params: Any) -> Any:
        """One model call on a cacheable prefix. While the prefix is cold, the
        first call writes it alone; calls arriving meanwhile wait, then read it."""

        if time.monotonic() - self._warm.get(cache_key, float("-inf")) > _CACHE_WARM_SECONDS:
            writing = self._warming.get(cache_key)
            if writing is not None:
                await asyncio.shield(writing)
            else:
                done: asyncio.Future[None] = asyncio.get_running_loop().create_future()
                self._warming[cache_key] = done
                try:
                    return await self._call(cache_key, **params)
                finally:
                    self._warming.pop(cache_key, None)
                    done.set_result(None)
        return await self._call(cache_key, **params)

    async def _call(self, cache_key: str, **params: Any) -> Any:
        response = await self._transport.responses(
            model=self._model_name, prompt_cache_key=cache_key, **self._params, **params
        )
        self._warm[cache_key] = time.monotonic()
        return response

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


class ClassificationAnswerError(ValueError):
    """The model's classification answer cannot be used (asked again once)."""


_EXAMPLE_TITLE_MAX_CHARACTERS = 200
#: Topics listed in a document's keyword matches, strongest first.
_MATCHES_MAX = 15
#: Shorter terms (``IT``, ``AI``) match inside too many unrelated words to be hints.
_TERM_MIN_CHARACTERS = 3


def _fold(value: str) -> str:
    """Compare text as people read it: one Unicode form, no case, single spaces."""
    return " ".join(unicodedata.normalize("NFC", html.unescape(value)).casefold().split())


@dataclass(frozen=True, slots=True)
class ClassificationPrompt:
    """The ``document_profile`` prompt of one :class:`ClassificationRequest`.

    ``prefix`` (instructions, note, taxonomy) is the same for every document
    of the request, so providers cache it; ``cache_key`` names it for sticky
    routing. Topics are labelled ``T1..Tn`` in taxonomy order (domains, then
    topics, by name): short labels the model copies reliably, unlike IDs.
    """

    prefix: str
    cache_key: str
    labels: Mapping[str, TopicCandidate]
    #: Folded name -> the one candidate with it; ``None`` when names collide.
    names: Mapping[str, TopicCandidate | None]
    #: Per label, the topic's name, keywords and synonyms as word-bounded patterns.
    terms: tuple[tuple[str, tuple[tuple[str, re.Pattern[str]], ...]], ...]

    def document(
        self, *, title: str | None, document_context: str, matches: str | None = None
    ) -> str:
        """This document's part of the prompt; ``matches`` replaces the computed
        keyword matches (CompileTopicClassificationPrompt's placeholder)."""

        shown = title.strip() if title and title.strip() else "(not provided)"
        return render_prompt(
            "document_profile_document",
            matches=matches if matches is not None else self.keyword_matches(shown, document_context),
            document_title=shown,
            document_context=document_context,
        )

    def keyword_matches(self, title: str, document_context: str) -> str:
        """Topics whose name, keywords or synonyms the document dwells on, as
        hints: ``T12 Name: term (title), term ×3``. A topic is listed for a title
        hit, two different terms, or one term used at least twice: a single
        mention in the text is a passing one, and a hint would make it salient."""

        folded_title, folded_text = _fold(title), _fold(document_context)
        found: list[tuple[int, int, str]] = []
        for order, (label, patterns) in enumerate(self.terms):
            hits = [
                (term, bool(pattern.search(folded_title)), len(pattern.findall(folded_text)))
                for term, pattern in patterns
            ]
            hits = [hit for hit in hits if hit[1] or hit[2]]
            if not hits:
                continue
            in_title = any(t for _, t, _ in hits)
            if not in_title and len(hits) < 2 and hits[0][2] < 2:
                continue
            score = sum(3 * t + min(n, 3) for _, t, n in hits)
            words = ", ".join(
                f"{term} (title)" if t else f"{term} ×{n}" if n > 1 else term for term, t, n in hits[:6]
            )
            found.append((-score, order, f"{label} {self.labels[label].name}: {words}"))
        if not found:
            return "(none)"
        return "\n".join(line for *_, line in sorted(found)[:_MATCHES_MAX])

    def read(self, output_text: object) -> DocumentClassification:
        """The topics and summary of one answer; raises ``ClassificationAnswerError``
        when it is unreadable or names topics none of which are valid."""

        if not isinstance(output_text, str) or not output_text.strip():
            raise ClassificationAnswerError("The answer was empty.")
        try:
            profile = model_json_object(output_text)
        except ValueError as exc:
            raise ClassificationAnswerError("The answer was not one JSON object.") from exc
        if not isinstance(profile, dict):
            raise ClassificationAnswerError("The answer was not one JSON object.")
        chosen, summary = profile.get("topics"), profile.get("summary")
        if not isinstance(chosen, list):
            raise ClassificationAnswerError('"topics" was not a list.')
        if summary is not None and not isinstance(summary, str):
            raise ClassificationAnswerError('"summary" was not text.')
        topics: dict[str, TopicCandidate] = {}
        rejected: list[str] = []
        for entry in chosen:
            candidate = self._resolve(entry)
            if candidate is None:
                rejected.append(str(entry)[:120])
            else:
                topics.setdefault(candidate.code, candidate)
        if rejected and not topics:
            raise ClassificationAnswerError(
                "These topics are not in the taxonomy or their label and name disagree: "
                + "; ".join(rejected)
            )
        if rejected:
            log.info("document classification dropped %d invalid topic(s)", len(rejected))
        return DocumentClassification(
            topics=tuple(topics.values()),
            summary=summary.strip() if summary and summary.strip() else None,
        )

    def _resolve(self, entry: object) -> TopicCandidate | None:
        """A label whose name agrees; else the topic the name alone identifies."""

        if isinstance(entry, str):
            label, name = entry.strip(), None
        elif isinstance(entry, dict):
            label = str(entry.get("label") or "").strip()
            name = entry.get("name") if isinstance(entry.get("name"), str) else None
        else:
            return None
        by_label = self.labels.get(label.upper())
        if name is None:
            return by_label
        folded = _fold(name)
        if by_label is not None and _fold(by_label.name) == folded:
            return by_label
        return self.names.get(folded)


def classification_prompt(request: ClassificationRequest) -> ClassificationPrompt:
    """The ``document_profile`` prompt for ``request``'s candidates and note."""

    return _classification_prompt(request.candidates, request.note)


@lru_cache(maxsize=16)
def _classification_prompt(
    candidates: tuple[TopicCandidate, ...], note: str | None
) -> ClassificationPrompt:
    # A candidate without a domain is a domain standing for itself.
    ordered = sorted(
        candidates,
        key=lambda c: (_fold(c.domain or c.name), c.domain is not None, _fold(c.name), c.code),
    )
    labels: dict[str, TopicCandidate] = {}
    lines: list[str] = []
    domain: str | None = None
    for index, candidate in enumerate(ordered, start=1):
        heading = candidate.domain or candidate.name
        if heading != domain:
            domain = heading
            if lines:
                lines.append("")
            lines.append(f"## Domain: {heading}")
        label = f"T{index}"
        labels[label] = candidate
        lines.append(_topic_line(label, candidate))
    prefix = render_prompt(
        "document_profile",
        note=note.strip() if note and note.strip() else "(not provided)",
        taxonomy="\n".join(lines),
    )
    names: dict[str, TopicCandidate | None] = {}
    for candidate in ordered:
        key = _fold(candidate.name)
        names[key] = None if key in names else candidate
    terms = tuple(
        (
            label,
            tuple(
                (term, re.compile(rf"(?<!\w){re.escape(_fold(term))}(?!\w)"))
                for term in dict.fromkeys(
                    t.strip() for t in (c.name, *c.keywords, *c.synonyms) if t and t.strip()
                )
                if len(_fold(term)) >= _TERM_MIN_CHARACTERS
            ),
        )
        for label, c in labels.items()
    )
    return ClassificationPrompt(
        prefix=prefix,
        cache_key="document-profile:" + hashlib.sha256(prefix.encode()).hexdigest()[:32],
        labels=labels,
        names=names,
        terms=terms,
    )


def _topic_line(label: str, candidate: TopicCandidate) -> str:
    """``label | name | description | keywords | synonyms | guidance | examples``;
    empty fields read ``-`` so every line keeps the same columns."""

    def joined(values: Sequence[str]) -> str:
        return "; ".join(v.strip() for v in values if v.strip()) or "-"

    def flat(value: str | None) -> str:
        return " ".join(value.split()) if value and value.strip() else "-"

    examples = [e[:_EXAMPLE_TITLE_MAX_CHARACTERS] for e in candidate.examples]
    return " | ".join(
        (
            label,
            flat(candidate.name),
            flat(candidate.description),
            joined(candidate.keywords),
            joined(candidate.synonyms),
            flat(candidate.guidance),
            joined(examples),
        )
    )


def _log_usage(response: Any, *, candidates: int, attempt: int) -> None:
    """Input, cached and output tokens of one classification call (cache hit rate)."""

    usage = getattr(response, "usage", None)
    if usage is None:
        return
    details = getattr(usage, "input_tokens_details", None)
    log.info(
        "document classification: %d candidates, attempt %d, input %s tokens (%s cached), output %s",
        candidates,
        attempt,
        getattr(usage, "input_tokens", "?"),
        getattr(details, "cached_tokens", 0) or 0,
        getattr(usage, "output_tokens", "?"),
    )


__all__ = [
    "ClassificationAnswerError",
    "ClassificationPrompt",
    "SemanticContextualizer",
    "classification_prompt",
]
