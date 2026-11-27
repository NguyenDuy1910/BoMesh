"""LLM-backed, chunk-specific retrieval contextualization and document classification."""

from __future__ import annotations

import asyncio
import hashlib
import json
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
from bomesh.document_index import (
    ClassificationCache,
    ClassificationRequest,
    DocumentClassification,
    ModelUsage,
    PromptConcept,
    PromptScheme,
    SchemeAnswer,
    SchemeTask,
    WindowContexts,
)

log = logging.getLogger(__name__)

_DISALLOWED_PREFIXES = ("document:", "section:", "context:", "description:")
#: Bumped when reading a stored classification answer changes meaning.
CLASSIFICATION_REUSE_VERSION = 2
#: A prompt prefix is treated as cached this long after a call used it (provider
#: caches live five minutes or more after their last read).
_CACHE_WARM_SECONDS = 240.0
#: Chunks asked for in one call: the window is sent once per batch, not once per
#: chunk, and each batch after the first reads it from the provider's cache.
CONTEXT_BATCH_CHUNKS = 8
#: A chunk's context is "normally 50-100 tokens"; longer answers are runaway.
_CONTEXT_MAX_CHARACTERS = 1_200
#: One window chunk as the model sees it (the window is bounded by its builder).
_WINDOW_CHUNK_MAX_CHARACTERS = 2_000


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
        cache: ClassificationCache | None = None,
    ) -> DocumentClassification:
        """Answer one Document's asked schemes, missing metadata, summary and title.

        The prompt is a prefix shared by every document of a run (instructions,
        note, every published scheme with its labelled concepts), sent first
        with a ``prompt_cache_key`` (sticky routing), and this document's part
        (settled facets, per asked scheme its shortlist with scores or any
        label of the scheme, sections, metadata asks, title, excerpt). The
        model answers with short labels; a label a scheme does not allow is
        dropped (``dropped``). An unreadable answer, or one whose every label
        was dropped while no scheme said none, is asked again once; a second
        failure raises.

        ``cache`` holds answers already paid for: an answer stored under this
        exact model, fingerprint (scheme versions, rules, classifier), prompt
        and document part is read instead of asking again, and a new answer is
        stored. Reuse is best effort.
        """

        normalized_document_context = document_context.strip()
        if not normalized_document_context:
            raise ValueError("document_context must not be empty")
        prompt = classification_prompt(request)
        # No cache marker: the provider caches a repeated prefix by itself
        # (implicit caching); an explicit write costs more and never paid off.
        blocks: list[dict[str, Any]] = [
            {"type": "input_text", "text": prompt.prefix},
            {
                "type": "input_text",
                "text": prompt.document(
                    request, title=title, document_context=normalized_document_context
                ),
            },
        ]
        key = self._classification_key(request.fingerprint, prompt.prefix, blocks[1]["text"])
        if cache is not None:
            reused = await _stored_answer(cache, key, prompt, request)
            if reused is not None:
                log.info("document classification: reused stored answer %s", key)
                return reused
        asked = sum(1 for task in request.tasks if task.ask)

        async def answer(attempt: int) -> tuple[DocumentClassification, str | None]:
            response = await self._cached_call(
                prompt.cache_key,
                input=[{"role": "user", "content": blocks}],
                max_output_tokens=self._classification_max_output_tokens,
            )
            _log_usage(response, schemes=asked, attempt=attempt)
            text = getattr(response, "output_text", None)
            return prompt.read(request, text), text

        try:
            classified, text = await answer(1)
        except ClassificationAnswerError as problem:
            # Asked again after the cached prefix and this document: only the
            # correction is new, so the retry costs little.
            retry = render_prompt("document_profile_retry", problem=str(problem))
            blocks.append({"type": "input_text", "text": retry})
            classified, text = await answer(2)
        if cache is not None and text:
            await _store_answer(cache, key, text)
        return classified

    def _classification_key(self, fingerprint: str, prefix: str, document: str) -> str:
        """Names everything an answer depends on: model and its parameters, the
        request's fingerprint (scheme versions, active rules, classifier), the
        prompt (instructions, note, schemes) and the document's part."""

        parts = (
            str(CLASSIFICATION_REUSE_VERSION),
            self.model_name or "",
            json.dumps(self._params, sort_keys=True),
            str(self._classification_max_output_tokens),
            fingerprint,
            prefix,
            document,
        )
        return hashlib.sha256("\x1f".join(parts).encode("utf-8")).hexdigest()[:32]

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

    async def describe_window(
        self,
        *,
        title: str | None,
        overview: str,
        window: Sequence[Chunk],
        targets: Sequence[int],
    ) -> WindowContexts:
        """Contexts for ``targets`` (``chunk_index`` values) of one window.

        One prompt prefix holds the instructions, the overview and the whole
        window; each call adds only the requested ids (at most
        :data:`CONTEXT_BATCH_CHUNKS`). The first call writes the prefix to the
        provider's cache alone, the others then read it. Ids the model left out
        or answered unusably are asked once more; a call that fails is logged
        and its ids keep their structural context.
        """

        if not window or not targets:
            return WindowContexts(contexts={}, usage=ModelUsage())
        known = {chunk.chunk_index for chunk in window}
        if unknown := [index for index in targets if index not in known]:
            raise ValueError(f"targets outside the window: {unknown}")
        prefix = render_prompt(
            "contextual_rag_window",
            document_title=title.strip() if title and title.strip() else "(not provided)",
            document_overview=overview.strip() or "(not provided)",
            window=_window_text(window),
        )
        cache_key = "chunk-context:" + hashlib.sha256(prefix.encode()).hexdigest()[:32]
        contexts: dict[int, str] = {}
        usage = ModelUsage()

        async def ask(batch: Sequence[int]) -> None:
            nonlocal usage
            suffix = render_prompt("contextual_rag_targets", chunk_ids=list(batch))
            try:
                response = await self._cached_call(
                    cache_key,
                    input=[
                        {
                            "role": "user",
                            "content": [
                                {"type": "input_text", "text": prefix},
                                {"type": "input_text", "text": suffix},
                            ],
                        }
                    ],
                    # Each context plus its JSON entry; a truncated answer is unreadable.
                    max_output_tokens=(self._max_output_tokens + 64) * len(batch),
                    # JSON mode: an answer the parser can always read (no retry for prose).
                    text={"format": {"type": "json_object"}},
                )
            except Exception as exc:  # noqa: BLE001 - enrichment is best effort
                log.warning("chunk contextualization call failed: %s", type(exc).__name__)
                return
            usage += response_usage(response)
            contexts.update(_read_contexts(getattr(response, "output_text", None), batch))

        pending = list(dict.fromkeys(targets))
        for _attempt in range(2):
            await asyncio.gather(*(ask(batch) for batch in _batches(pending)))
            pending = [index for index in pending if index not in contexts]
            if not pending:
                break
        return WindowContexts(contexts=contexts, usage=usage)


def _batches(indexes: Sequence[int]) -> list[Sequence[int]]:
    return [
        indexes[start : start + CONTEXT_BATCH_CHUNKS]
        for start in range(0, len(indexes), CONTEXT_BATCH_CHUNKS)
    ]


def _window_text(window: Sequence[Chunk]) -> str:
    """Each window chunk under its id and section: ``[12 | A > B] text``."""

    lines = []
    for chunk in window:
        section = " > ".join(value.strip() for value in chunk.section_path if value.strip())
        label = f"[{chunk.chunk_index}{f' | {section}' if section else ''}]"
        lines.append(f"{label} {chunk.chunk_text[:_WINDOW_CHUNK_MAX_CHARACTERS]}")
    return "\n\n".join(lines)


def _read_contexts(raw: object, batch: Sequence[int]) -> dict[int, str]:
    """The usable contexts of one answer: requested ids only, plain short text."""

    if not isinstance(raw, str):
        return {}
    try:
        answer = model_json_object(raw)
    except ValueError:
        log.warning("chunk contextualization answer is not a JSON object")
        return {}
    entries = answer.get("contexts") if isinstance(answer, dict) else None
    if not isinstance(entries, list):
        return {}
    requested = set(batch)
    found: dict[int, str] = {}
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        index, text = entry.get("id"), entry.get("context")
        if isinstance(index, str) and index.strip().isdigit():
            index = int(index.strip())
        if not isinstance(index, int) or isinstance(index, bool) or index not in requested:
            continue
        if not isinstance(text, str):
            continue
        normalized = " ".join(text.split())
        if (
            not normalized
            or len(normalized) > _CONTEXT_MAX_CHARACTERS
            or normalized.casefold().startswith(_DISALLOWED_PREFIXES)
        ):
            continue
        found.setdefault(index, normalized)
    return found


def response_usage(response: Any) -> ModelUsage:
    """The tokens one Responses call reported (zeros when it reported none)."""

    usage = getattr(response, "usage", None)
    if usage is None:
        return ModelUsage(calls=1)
    details = getattr(usage, "input_tokens_details", None)
    return ModelUsage(
        calls=1,
        input_tokens=int(getattr(usage, "input_tokens", 0) or 0),
        cached_tokens=int(getattr(details, "cached_tokens", 0) or 0),
        output_tokens=int(getattr(usage, "output_tokens", 0) or 0),
    )


class ClassificationAnswerError(ValueError):
    """The model's classification answer cannot be used (asked again once)."""


_EXAMPLE_MAX_CHARACTERS = 200
#: A suggested title longer than this is not a title; the prompt asks for 120.
_TITLE_MAX_CHARACTERS = 255
#: Quotes a model wraps a title in, and the end punctuation it adds.
_TITLE_QUOTES = " \"'\u201c\u201d\u2018\u2019\u00ab\u00bb"
_TITLE_END = _TITLE_QUOTES + ".\u3002"
#: A file extension the model copied from the file name.
_FILE_EXTENSION = re.compile(
    r"\.(?:pdf|docx?|xlsx?|pptx?|odt|ods|odp|rtf|txt|md|csv|tsv|html?|zip)$", re.IGNORECASE
)
_CERTAINTIES = frozenset({"high", "medium", "low"})
#: An evidence quote is short; the prompt asks for a phrase.
_EVIDENCE_MAX_CHARACTERS = 300
#: A metadata value longer than this is not one (``applies_to`` is the longest).
_METADATA_MAX_CHARACTERS = 500
#: How much of a label the model named outside its allowed set is kept for logs.
_DROPPED_MAX_CHARACTERS = 40


@dataclass(frozen=True, slots=True)
class ClassificationPrompt:
    """The ``document_profile`` prompt of a run's schemes and note.

    ``prefix`` (instructions, note, every scheme with its concepts) is the same
    for every document of the run, so providers cache it; ``cache_key`` names
    it for sticky routing. Concepts carry the request's short labels (``D12``):
    the model copies them reliably, unlike IDs. :meth:`document` renders one
    document's part and :meth:`read` reads the answer to it.
    """

    prefix: str
    cache_key: str
    schemes: Mapping[str, PromptScheme]
    #: Upper-cased label -> (scheme code, concept), across every scheme.
    labels: Mapping[str, tuple[str, PromptConcept]]

    def document(
        self, request: ClassificationRequest, *, title: str | None, document_context: str
    ) -> str:
        """This document's part of the prompt: settled facets, the schemes to
        answer (shortlist lines with their signal scores, or any label of the
        scheme), sections, metadata asks, title and excerpt."""

        return render_prompt(
            "document_profile_document",
            settled=self._settled_text(request),
            tasks=self._tasks_text(request),
            answer_keys=", ".join(f'"{task.scheme}"' for task in request.tasks if task.ask)
            or "(none)",
            sections=self._sections_text(request),
            metadata=", ".join(request.metadata_asks) or "(none)",
            document_title=title.strip() if title and title.strip() else "(not provided)",
            document_context=document_context,
        )

    def _heading(self, code: str) -> str:
        scheme = self.schemes.get(code)
        return f"{code} ({scheme.letter})" if scheme is not None else code

    def _shown(self, label: str) -> str:
        """``D12 IT › AI``: a label and the concept it names."""

        found = self.labels.get(label.upper())
        return f"{label} {_concept_path(found[1])}" if found is not None else label

    def _settled_text(self, request: ClassificationRequest) -> str:
        lines = [
            f"{self._heading(task.scheme)}: " + "; ".join(self._shown(label) for label in task.settled)
            for task in request.tasks
            if task.settled
        ]
        return "\n".join(lines) or "(none)"

    def _tasks_text(self, request: ClassificationRequest) -> str:
        lines: list[str] = []
        for task in request.tasks:
            if not task.ask:
                continue
            if not task.shortlist:
                lines.append(f"{self._heading(task.scheme)}: any label of scheme {task.scheme}")
                continue
            lines.append(f"{self._heading(task.scheme)}: choose only among these candidates")
            for candidate in task.shortlist:
                scores = ", ".join(
                    f"{kind} {score:.2f}" for kind, score in candidate.scores if score > 0
                )
                lines.append(self._shown(candidate.label) + (f" — {scores}" if scores else ""))
        return "\n".join(lines) or "(none)"

    def _sections_text(self, request: ClassificationRequest) -> str:
        if not request.sections or request.section_scheme is None:
            return "(none)"
        lines = [f"Label each section with labels of scheme {self._heading(request.section_scheme)}:"]
        for section in request.sections:
            lines.append("")
            lines.append(f"{section.label} | {_flat(section.heading)}")
            lines.append(section.text.strip())
        return "\n".join(lines)

    def read(self, request: ClassificationRequest, output_text: object) -> DocumentClassification:
        """The answer to ``request``'s document part; raises ``ClassificationAnswerError``
        when it is unreadable, or names labels for the asked schemes none of
        which is allowed while no scheme said none."""

        if not isinstance(output_text, str) or not output_text.strip():
            raise ClassificationAnswerError("The answer was empty.")
        try:
            profile = model_json_object(output_text)
        except ValueError as exc:
            raise ClassificationAnswerError("The answer was not one JSON object.") from exc
        if not isinstance(profile, dict):
            raise ClassificationAnswerError("The answer was not one JSON object.")
        summary = profile.get("summary")
        if summary is not None and not isinstance(summary, str):
            raise ClassificationAnswerError('"summary" was not text.')
        answers = profile.get("schemes", {})
        if not isinstance(answers, dict):
            raise ClassificationAnswerError('"schemes" was not an object.')
        keys = {_answer_key(key): value for key, value in answers.items() if isinstance(key, str)}
        schemes: dict[str, SchemeAnswer] = {}
        dropped: list[str] = []
        named = 0
        asked = [task for task in request.tasks if task.ask]
        omitted: list[str] = []
        for task in asked:
            entry = self._entry(task.scheme, keys)
            if entry is None:
                # Undecided, not unreadable: the scheme ends uncertain (asking again
                # rarely changes a model that chose to skip a scheme).
                omitted.append(task.scheme)
                schemes[task.scheme] = SchemeAnswer()
                continue
            schemes[task.scheme], count = self._scheme_answer(task, entry, dropped)
            named += count
        if asked and len(omitted) == len(asked):
            raise ClassificationAnswerError(
                '"schemes" answered none of the schemes to answer; use their codes as keys: '
                + ", ".join(f'"{task.scheme}"' for task in asked)
            )
        if omitted:
            log.info("document classification: no answer for scheme(s) %s", ", ".join(omitted))
        if named and not any(a.labels or a.none for a in schemes.values()):
            raise ClassificationAnswerError(
                "These labels are not allowed for their scheme: " + ", ".join(dropped)
            )
        sections = self._read_sections(request, profile.get("sections"), dropped)
        if dropped:
            log.info("document classification dropped %d label(s) not allowed", len(dropped))
        return DocumentClassification(
            schemes=schemes,
            sections=sections,
            metadata=_read_metadata(request, profile.get("metadata")),
            summary=summary.strip() if summary and summary.strip() else None,
            title=_title(profile.get("title")),
            dropped=tuple(dropped),
        )

    def _entry(self, code: str, keys: Mapping[str, object]) -> Mapping[str, Any] | None:
        """The answer object of scheme ``code``, keyed by its code, its label
        letter or its name (models copy the heading's letter too); a bare label
        list counts as ``labels``."""

        scheme = self.schemes.get(code)
        aliases = (code, *((scheme.letter, scheme.name) if scheme is not None else ()))
        for alias in aliases:
            entry = keys.get(_answer_key(alias))
            if isinstance(entry, dict):
                return entry
            if isinstance(entry, list):
                return {"labels": entry}
            if isinstance(entry, str) and entry.strip():
                return {"primary": entry}
        return None

    def _allowed(self, task: SchemeTask) -> dict[str, str]:
        """Upper-cased label -> label the model may name for ``task``'s scheme:
        its shortlist and settled labels, else every label of the scheme."""

        if task.shortlist:
            labels: Sequence[str] = (*(c.label for c in task.shortlist), *task.settled)
        else:
            scheme = self.schemes.get(task.scheme)
            labels = [c.label for c in scheme.concepts] if scheme is not None else task.settled
        return {label.upper(): label for label in labels}

    def _max_labels(self, code: str) -> int | None:
        scheme = self.schemes.get(code)
        return scheme.max_labels if scheme is not None else None

    def _scheme_answer(
        self, task: SchemeTask, entry: Mapping[str, Any], dropped: list[str]
    ) -> tuple[SchemeAnswer, int]:
        """One asked scheme's answer and how many labels it named; labels it may
        not name go to ``dropped``."""

        certainty = entry.get("certainty")
        certainty = certainty.strip().lower() if isinstance(certainty, str) else None
        if certainty not in _CERTAINTIES:
            certainty = None
        evidence = _flat(entry.get("evidence"))[:_EVIDENCE_MAX_CHARACTERS] or None
        if entry.get("none") is True:
            return SchemeAnswer(none=True, certainty=certainty, evidence=evidence), 0
        primary = entry.get("primary")
        if primary is not None and not isinstance(primary, str):
            raise ClassificationAnswerError(f'"primary" of "{task.scheme}" was not one label.')
        names: list[object] = [primary] if primary and primary.strip() else []
        for key in ("secondary", "labels"):
            listed = entry.get(key)
            if listed is None:
                continue
            if not isinstance(listed, list):
                raise ClassificationAnswerError(f'"{key}" of "{task.scheme}" was not a list.')
            names.extend(listed)
        labels = _allowed_labels(names, self._allowed(task), self._max_labels(task.scheme), dropped)
        return SchemeAnswer(labels=labels, certainty=certainty, evidence=evidence), len(names)

    def _read_sections(
        self, request: ClassificationRequest, raw: object, dropped: list[str]
    ) -> dict[str, tuple[str, ...]]:
        """Section ref -> allowed labels of the section scheme; sections the
        request did not offer and empty ones are left out."""

        code = request.section_scheme
        if not request.sections or code is None or raw is None:
            return {}
        if not isinstance(raw, list):
            raise ClassificationAnswerError('"sections" was not a list.')
        refs = {section.label.upper(): section.ref for section in request.sections}
        task = next((t for t in request.tasks if t.scheme == code), SchemeTask(code))
        allowed, limit = self._allowed(task), self._max_labels(code)
        found: dict[str, tuple[str, ...]] = {}
        for entry in raw:
            if not isinstance(entry, dict):
                continue
            section, names = entry.get("section"), entry.get("labels")
            ref = refs.get(section.strip().upper()) if isinstance(section, str) else None
            if ref is None or not isinstance(names, list):
                continue
            labels = _allowed_labels([*found.get(ref, ()), *names], allowed, limit, dropped)
            if labels:
                found[ref] = labels
        return found


def _answer_key(value: str) -> str:
    """A ``schemes`` key as compared: one Unicode form, no case, single spaces."""

    return " ".join(unicodedata.normalize("NFC", value).casefold().split())


def _allowed_labels(
    names: Sequence[object], allowed: Mapping[str, str], limit: int | None, dropped: list[str]
) -> tuple[str, ...]:
    """The allowed labels among ``names`` in order, once each, at most ``limit``."""

    labels: list[str] = []
    for name in names:
        label = allowed.get(name.strip().upper()) if isinstance(name, str) else None
        if label is None:
            dropped.append(str(name)[:_DROPPED_MAX_CHARACTERS])
        elif label not in labels:
            labels.append(label)
    return tuple(labels[:limit] if limit is not None else labels)


def _read_metadata(request: ClassificationRequest, raw: object) -> dict[str, str]:
    """The asked metadata fields the answer filled with text."""

    if not request.metadata_asks or not isinstance(raw, dict):
        return {}
    found: dict[str, str] = {}
    for name in request.metadata_asks:
        value = _flat(raw.get(name))
        if value and len(value) <= _METADATA_MAX_CHARACTERS:
            found[name] = value
    return found


def _flat(value: object) -> str:
    """Text on one line; ``""`` for anything that is not text."""

    return " ".join(value.split()) if isinstance(value, str) else ""


def _title(value: object) -> str | None:
    """The answer's title, tidied; ``None`` when it is missing or unusable.

    A title is a suggestion beside the labels, so a bad one is dropped
    rather than asked again.
    """

    if not isinstance(value, str):
        return None
    title = " ".join(value.split()).strip(_TITLE_QUOTES)
    title = _FILE_EXTENSION.sub("", title).rstrip(_TITLE_END)
    if not title or len(title) > _TITLE_MAX_CHARACTERS:
        return None
    return title


def classification_prompt(request: ClassificationRequest) -> ClassificationPrompt:
    """The ``document_profile`` prompt of ``request``'s schemes and note."""

    return _classification_prompt(request.schemes, request.note)


@lru_cache(maxsize=16)
def _classification_prompt(
    schemes: tuple[PromptScheme, ...], note: str | None
) -> ClassificationPrompt:
    prefix = render_prompt(
        "document_profile",
        note=note.strip() if note and note.strip() else "(not provided)",
        schemes="\n\n".join(_scheme_block(scheme) for scheme in schemes) or "(none)",
    )
    return ClassificationPrompt(
        prefix=prefix,
        cache_key="document-profile:" + hashlib.sha256(prefix.encode()).hexdigest()[:32],
        schemes={scheme.code: scheme for scheme in schemes},
        labels={
            concept.label.upper(): (scheme.code, concept)
            for scheme in schemes
            for concept in scheme.concepts
        },
    )


def _scheme_block(scheme: PromptScheme) -> str:
    """``## D — Domain (domain): choose 1..3, one primary`` and one line per concept."""

    count = (
        f"{scheme.min_labels}..{scheme.max_labels}"
        if scheme.max_labels is not None
        else f"{scheme.min_labels} or more"
    )
    primary = ", one primary" if scheme.has_primary else ""
    heading = f"## {scheme.letter} — {_flat(scheme.name)} ({scheme.code}): choose {count}{primary}"
    return "\n".join((heading, *(_concept_line(concept) for concept in scheme.concepts)))


def _concept_path(concept: PromptConcept) -> str:
    name = _flat(concept.name)
    return f"{_flat(concept.path)} › {name}" if concept.path.strip() else name


def _concept_line(concept: PromptConcept) -> str:
    """``label | path › name | definition | scope note | alt labels | examples``;
    empty fields read ``-`` so every line keeps the same columns."""

    def joined(values: Sequence[str]) -> str:
        return "; ".join(text for text in (_flat(v) for v in values) if text) or "-"

    return " | ".join(
        (
            concept.label,
            _concept_path(concept),
            _flat(concept.definition) or "-",
            _flat(concept.scope_note) or "-",
            joined(concept.alt_labels),
            joined([example[:_EXAMPLE_MAX_CHARACTERS] for example in concept.examples]),
        )
    )


def _log_usage(response: Any, *, schemes: int, attempt: int) -> None:
    """Input, cached and output tokens of one classification call (cache hit rate)."""

    usage = getattr(response, "usage", None)
    if usage is None:
        return
    details = getattr(usage, "input_tokens_details", None)
    log.info(
        "document classification: %d asked scheme(s), attempt %d, input %s tokens (%s cached), output %s",
        schemes,
        attempt,
        getattr(usage, "input_tokens", "?"),
        getattr(details, "cached_tokens", 0) or 0,
        getattr(usage, "output_tokens", "?"),
    )


async def _stored_answer(
    cache: ClassificationCache,
    key: str,
    prompt: ClassificationPrompt,
    request: ClassificationRequest,
) -> DocumentClassification | None:
    """The stored answer under ``key`` read against ``request``; ``None`` to ask the model."""

    try:
        stored = await cache.get(key)
    except Exception as exc:  # noqa: BLE001 - reuse is best effort
        log.warning("stored classification %s unavailable: %s", key, type(exc).__name__)
        return None
    if stored is None:
        return None
    try:
        return prompt.read(request, stored)
    except ClassificationAnswerError:
        log.warning("stored classification %s is unreadable; asking again", key)
        return None


async def _store_answer(cache: ClassificationCache, key: str, answer: str) -> None:
    try:
        await cache.put(key, answer)
    except Exception as exc:  # noqa: BLE001 - reuse is best effort
        log.warning("could not store classification %s: %s", key, type(exc).__name__)


__all__ = [
    "CLASSIFICATION_REUSE_VERSION",
    "ClassificationAnswerError",
    "ClassificationPrompt",
    "SemanticContextualizer",
    "classification_prompt",
]
