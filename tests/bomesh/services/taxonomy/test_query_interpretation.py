"""Query mapping over a published taxonomy (``conversation_loop.md`` "Knowledge retrieval"), no database."""

from __future__ import annotations

from uuid import uuid4

from bomesh.services.taxonomy.query import interpret, label_index
from bomesh.services.taxonomy.snapshot import (
    ConceptView,
    GroupView,
    SchemeSnapshot,
    TaxonomySnapshot,
)


def _concept(scheme: str, notation: str, pref: str, *alt: str, hidden: tuple[str, ...] = (), broader=()) -> ConceptView:
    return ConceptView(
        id=uuid4(),
        notation=notation,
        scheme_code=scheme,
        state="published",
        pref_labels={"vi": pref},
        alt_labels=tuple(("vi", text) for text in alt),
        hidden_labels=tuple(("vi", text) for text in hidden),
        broader=tuple(broader),
    )


def _scheme(code: str, position: int, concepts, groups=(), purpose="classification") -> SchemeSnapshot:
    return SchemeSnapshot(
        scheme_id=uuid4(),
        code=code,
        name=code,
        purpose=purpose,
        version=1,
        position=position,
        min_labels=0,
        max_labels=None,
        has_primary=False,
        max_depth=3,
        assign_top_concepts=True,
        section_assignments=False,
        llm_policy="always" if purpose == "classification" else "never",
        auto_threshold=None,
        review_threshold=None,
        concepts={concept.id: concept for concept in concepts},
        groups=tuple(groups),
    )


def _taxonomy():
    types = [
        _concept("document-type", "do-an-khoa-luan", "Đồ án – khóa luận", "khóa luận"),
        _concept("document-type", "quy-che", "Quy chế"),
        _concept("document-type", "quy-dinh", "Quy định"),
        _concept("document-type", "huong-dan", "Hướng dẫn"),
        _concept("document-type", "bieu-mau", "Biểu mẫu – đơn", "mẫu"),
        _concept("document-type", "thong-bao", "Thông báo", hidden=("hạn nộp",)),
    ]
    group = GroupView(uuid4(), "quy-pham", "Quy phạm", 0, True, tuple(c.id for c in types[1:4]))
    dt = _concept("function", "dt", "Đào tạo")
    function = [dt, _concept("function", "dt-do-an", "Thực tập, đồ án & khóa luận", "khóa luận", broader=(dt.id,))]
    it = _concept("domain", "it", "Công nghệ thông tin")
    domain = [it, _concept("domain", "it-tgmt", "Thị giác máy tính", "nhận diện khuôn mặt", broader=(it.id,))]
    units = [_concept("org-unit", "khoa-co-khi", "Khoa Cơ khí")]
    taxonomy = TaxonomySnapshot(
        tenant_id=uuid4(),
        schemes={
            "domain": _scheme("domain", 0, domain),
            "function": _scheme("function", 1, function),
            "document-type": _scheme("document-type", 2, types, (group,)),
            "org-unit": _scheme("org-unit", 10, units, purpose="authority"),
        },
    )
    notation = {c.id: c.notation for c in (*types, *function, *domain, *units)}
    return label_index(taxonomy), notation


def _read(query: str):
    index, notation = _taxonomy()
    result = interpret(index, query)
    terms = [(t.text, t.scheme, [notation[c] for c in t.concepts]) for t in result.terms]
    ambiguities = [
        (a.text, [(o.scheme, [notation[c] for c in o.concepts]) for o in a.options])
        for a in result.ambiguities
    ]
    return terms, ambiguities, {notation[c] for c in result.authorities}, result.asks_history


def test_acceptance_readings() -> None:
    assert _read("tìm khóa luận về nhận diện khuôn mặt")[:2] == (
        [("khóa luận", "document-type", ["do-an-khoa-luan"]), ("nhận diện khuôn mặt", "domain", ["it-tgmt"])],
        [],
    )
    assert _read("quy định làm khóa luận")[:2] == (
        [
            ("quy định", "document-type", ["huong-dan", "quy-che", "quy-dinh"]),
            ("khóa luận", "function", ["dt-do-an"]),
        ],
        [],
    )
    assert _read("hạn nộp khóa luận")[0][0] == ("hạn nộp", "document-type", ["thong-bao"])
    assert _read("mẫu bìa khóa luận")[0][0] == ("mẫu", "document-type", ["bieu-mau"])
    assert _read("khóa luận")[:2] == (
        [],
        [("khóa luận", [("function", ["dt-do-an"]), ("document-type", ["do-an-khoa-luan"])])],
    )


def test_longest_match_folding_authorities_and_history() -> None:
    # The pref label "Đồ án – khóa luận" wins over its nested "khóa luận".
    assert _read("đồ án khóa luận")[0] == [("đồ án khóa luận", "document-type", ["do-an-khoa-luan"])]
    # Mostly unaccented queries match folded labels; diacritics stay distinct otherwise.
    assert _read("quy dinh lam khoa luan")[0] == [
        ("quy dinh", "document-type", ["huong-dan", "quy-che", "quy-dinh"]),
        ("khoa luan", "function", ["dt-do-an"]),
    ]
    assert _read("khoa luận về quy định")[0] == [
        ("quy định", "document-type", ["huong-dan", "quy-che", "quy-dinh"])
    ]
    # A group's own name expands too; authority labels are recorded, never terms.
    assert _read("quy phạm khoa cơ khí")[:3] == (
        [("quy phạm", "document-type", ["huong-dan", "quy-che", "quy-dinh"])],
        [],
        {"khoa-co-khi"},
    )
    assert _read("lịch sử quy chế")[3] is True
    assert _read("quy chế")[3] is False
