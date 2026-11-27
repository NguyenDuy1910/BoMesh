"""The deterministic stages of CLASSIFYING (design ``document_contract.md`` "Processing").

Candidates, rules, patterns, metadata, calibration, routing, ``prepare`` (the
per-Document request) and ``decide`` (answer → per-scheme results). The one
model call lives in ``bomesh.document_index``; writes in ``assignments.py`` and
``profiles.py``.
"""

from __future__ import annotations

from .aho import AhoCorasick, Match
from .calibration import (
    CLASSIFIER_VERSION,
    DEFAULT_AUTO_THRESHOLD,
    DEFAULT_REVIEW_THRESHOLD,
    SHORTLIST_SIZE,
    confidence,
    route,
)
from .metadata import ExtractedMetadata, extract_metadata
from .patterns import validate_pattern
from .pipeline import (
    ClassificationOptions,
    ClassificationOutcome,
    ClassificationPlan,
    DocumentInput,
    MachineAssignment,
    PreparedDocument,
    SchemeResult,
    ScoredCandidate,
    build_plan,
    decide,
    document_input,
    load_plan,
    pattern_hits,
    pattern_text,
    prepare,
    scheme_patterns,
)
from .rules import RuleView, implied_concepts, load_rules
from .signals import Signals

__all__ = [
    "CLASSIFIER_VERSION",
    "DEFAULT_AUTO_THRESHOLD",
    "DEFAULT_REVIEW_THRESHOLD",
    "SHORTLIST_SIZE",
    "AhoCorasick",
    "ClassificationOptions",
    "ClassificationOutcome",
    "ClassificationPlan",
    "DocumentInput",
    "ExtractedMetadata",
    "MachineAssignment",
    "Match",
    "PreparedDocument",
    "RuleView",
    "SchemeResult",
    "ScoredCandidate",
    "Signals",
    "build_plan",
    "confidence",
    "decide",
    "document_input",
    "extract_metadata",
    "implied_concepts",
    "load_plan",
    "load_rules",
    "pattern_hits",
    "pattern_text",
    "prepare",
    "route",
    "scheme_patterns",
    "validate_pattern",
]
