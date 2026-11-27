"""Pure taxonomy helpers: label normalization, snapshot JSON and closure rows."""

from __future__ import annotations

import json
from uuid import UUID, uuid4

from bomesh.services.taxonomy.closure import closure_rows
from bomesh.services.taxonomy.normalize import fold, normalize_label
from bomesh.services.taxonomy.snapshot import (
    ConceptView,
    GroupView,
    SchemeSnapshot,
    TaxonomySnapshot,
    from_json,
    snapshot_json,
)


def _concept(notation: str, *broader: UUID, state: str = "published", **values: object) -> ConceptView:
    return ConceptView(
        id=uuid4(),
        notation=notation,
        scheme_code="domain",
        state=state,
        pref_labels={"vi": notation.title()},
        broader=broader,
        **values,  # type: ignore[arg-type]
    )


def _scheme(*concepts: ConceptView, **values: object) -> SchemeSnapshot:
    settings: dict[str, object] = {
        "scheme_id": uuid4(),
        "code": "domain",
        "name": "Lĩnh vực",
        "purpose": "classification",
        "version": 3,
        "position": 0,
        "min_labels": 0,
        "max_labels": 3,
        "has_primary": True,
        "max_depth": 3,
        "assign_top_concepts": False,
        "section_assignments": False,
        "llm_policy": "always",
        "auto_threshold": 0.85,
        "review_threshold": 0.5,
    }
    settings.update(values)
    return SchemeSnapshot(
        concepts={concept.id: concept for concept in concepts},
        **settings,  # type: ignore[arg-type]
    )


def test_normalize_keeps_diacritics_and_fold_drops_them() -> None:
    assert normalize_label("  Khóa   Học. ") == "khóa học"
    assert normalize_label("khoa") != normalize_label("khóa")
    assert fold("khoa") == fold("Khóa") == "khoa"
    assert fold("Đào tạo") == "dao tao"
    # NFD input normalizes to the same key as NFC input.
    assert normalize_label("kho\u0301a") == normalize_label("khóa")


def test_closure_shortest_depth_with_multiple_parents() -> None:
    top = _concept("top", color="#aa0000")
    middle = _concept("middle", top.id)
    other = _concept("other", top.id)
    leaf = _concept("leaf", middle.id, other.id)
    deep = _concept("deep", leaf.id, top.id)
    draft = _concept("draft", leaf.id, state="draft")
    scheme = _scheme(top, middle, other, leaf, deep, draft)

    rows = {(a, d): depth for a, d, depth in closure_rows(scheme)}
    assert len(rows) == len(closure_rows(scheme))
    assert rows[(deep.id, deep.id)] == 0
    assert rows[(leaf.id, deep.id)] == 1
    assert rows[(middle.id, deep.id)] == 2
    assert rows[(other.id, deep.id)] == 2
    # Shortest path wins: deep → top directly.
    assert rows[(top.id, deep.id)] == 1
    assert rows[(top.id, leaf.id)] == 2
    assert all(draft.id not in pair for pair in rows)
    assert len(rows) == 5 + 2 + 3 + 4  # self rows + middle/other + leaf + deep

    assert scheme.ancestors(deep.id) == {leaf.id: 1, top.id: 1, middle.id: 2, other.id: 2}
    assert scheme.descendants(top.id)[deep.id] == 1
    assert scheme.depth(deep.id) == 4
    assert scheme.is_top(top.id) and not scheme.is_top(leaf.id)
    assert scheme.color_of(deep.id) == "#aa0000"
    assert top not in scheme.targets() and draft not in scheme.targets()
    assert TaxonomySnapshot(uuid4(), {"domain": scheme}).by_concept(leaf.id) == leaf


def test_snapshot_json_round_trip() -> None:
    top = _concept(
        "hoc-vu",
        color="#aa0000",
        alt_labels=(("vi", "Đào tạo"),),
        hidden_labels=(("vi", "hoc vu"),),
        definition="Học vụ",
        examples=("Quy chế học vụ",),
        match_patterns=("^QUY CHẾ",),
        mappings=(("isced-f-2013", "0011", None, "close"),),
    )
    child = _concept("thi-cu", top.id, replaced_by=(top.id,), state="deprecated")
    scheme = _scheme(
        top,
        child,
        groups=(GroupView(uuid4(), "rules", "Quy định", 1, True, (top.id,)),),
    )

    stored = json.loads(json.dumps(snapshot_json(scheme)))
    assert "scheme_id" in stored and "pref_labels" in stored["concepts"][0]
    assert from_json(stored) == scheme
