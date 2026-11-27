"""CLASSIFYING's deterministic stages (design ``document_contract.md`` "Processing"): patterns,
rules, priors, candidates, routing, outcomes and metadata, on an in-test taxonomy."""

from __future__ import annotations

import asyncio
from datetime import date
from uuid import UUID, uuid4

import pytest

from bomesh.document_index import DocumentClassification, SchemeAnswer
from bomesh.services.taxonomy.authority import APPLICABILITY_AUTO_THRESHOLD
from bomesh.services.taxonomy.classification import (
    AhoCorasick,
    ClassificationOptions,
    ClassificationPlan,
    DocumentInput,
    PreparedDocument,
    RuleView,
    SchemeResult,
    build_plan,
    confidence,
    decide,
    implied_concepts,
    prepare,
    route,
    validate_pattern,
)
from bomesh.services.taxonomy.classification.metadata import cohorts
from bomesh.services.taxonomy.normalize import normalize_label
from bomesh.services.taxonomy.snapshot import ConceptView, SchemeSnapshot, TaxonomySnapshot

TENANT = uuid4()


class Taxonomy:
    """A small vn-university taxonomy: D (domain), F (function), T (document-type),
    A (audience) and the org-unit / program authorities."""

    def __init__(self) -> None:
        self.ids: dict[str, UUID] = {}
        self.schemes: dict[str, SchemeSnapshot] = {}

    def concept(
        self,
        scheme: str,
        notation: str,
        name: str,
        *,
        broader: tuple[str, ...] = (),
        alt: tuple[str, ...] = (),
        patterns: tuple[str, ...] = (),
        mappings: tuple[tuple[str, str, str | None, str], ...] = (),
    ) -> ConceptView:
        concept_id = uuid4()
        self.ids[f"{scheme}:{notation}"] = concept_id
        return ConceptView(
            id=concept_id,
            notation=notation,
            scheme_code=scheme,
            state="published",
            pref_labels={"vi": name},
            alt_labels=tuple(("vi", text) for text in alt),
            match_patterns=patterns,
            broader=tuple(self.ids[f"{scheme}:{parent}"] for parent in broader),
            mappings=mappings,
        )

    def scheme(self, code: str, concepts: list[ConceptView], **settings: object) -> None:
        values: dict[str, object] = {
            "scheme_id": uuid4(),
            "code": code,
            "name": code.title(),
            "purpose": "classification",
            "version": 1,
            "position": 0,
            "min_labels": 0,
            "max_labels": 3,
            "has_primary": True,
            "max_depth": 3,
            "assign_top_concepts": False,
            "section_assignments": False,
            "llm_policy": "always",
            "auto_threshold": 0.9,
            "review_threshold": 0.5,
        }
        values.update(settings)
        self.schemes[code] = SchemeSnapshot(
            concepts={concept.id: concept for concept in concepts}, **values  # type: ignore[arg-type]
        )

    def snapshot(self) -> TaxonomySnapshot:
        return TaxonomySnapshot(tenant_id=TENANT, schemes=dict(self.schemes))


SYMBOLS = {
    "QĐ": "quyet-dinh",
    "TB": "thong-bao",
    "KH": "ke-hoach",
    "HD": "huong-dan",
    "BC": "bao-cao",
    "BB": "bien-ban",
    "TTr": "to-trinh",
}


def _taxonomy() -> Taxonomy:
    t = Taxonomy()
    t.scheme(
        "domain",
        [
            t.concept("domain", "it", "Công nghệ thông tin", alt=("CNTT",)),
            t.concept("domain", "it-ai", "Trí tuệ nhân tạo", broader=("it",), alt=("AI", "học máy")),
            t.concept("domain", "it-khdl", "Khoa học dữ liệu", broader=("it",), alt=("dữ liệu lớn",)),
            t.concept("domain", "ee", "Điện – điện tử"),
            t.concept("domain", "ee-dien-tu", "Điện tử", broader=("ee",)),
        ],
        position=0,
    )
    t.scheme(
        "function",
        [
            t.concept("function", "dt", "Đào tạo"),
            t.concept("function", "dt-do-an", "Thực tập, đồ án & khóa luận", broader=("dt",)),
            t.concept("function", "dt-hoc-lieu", "Học liệu & giảng dạy", broader=("dt",)),
            t.concept("function", "dt-thi", "Thi & đánh giá", broader=("dt",), alt=("lịch thi",)),
            t.concept("function", "ctsv", "Công tác sinh viên"),
            t.concept("function", "ctsv-hoc-bong", "Học bổng", broader=("ctsv",), alt=("miễn giảm học phí",)),
        ],
        position=1,
        min_labels=1,
        section_assignments=True,
    )
    patterns = {
        "quyet-dinh": ("Quyết định", r"/QĐ-|(?i)^\s*quyết định"),
        "thong-bao": ("Thông báo", r"/TB-|(?i)^\s*thông báo"),
        "ke-hoach": ("Kế hoạch", r"/KH-|(?i)^\s*kế hoạch"),
        "huong-dan": ("Hướng dẫn", r"/HD-|(?i)^\s*hướng dẫn"),
        "bao-cao": ("Báo cáo", r"/BC-|(?i)^\s*báo cáo"),
        "bien-ban": ("Biên bản", r"/BB-|(?i)^\s*biên bản"),
        "to-trinh": ("Tờ trình", r"/TTr-|(?i)^\s*tờ trình"),
        "do-an": ("Đồ án – khóa luận", r"(?i)^\s*đồ án|(?i)^\s*khóa luận"),
        "giao-trinh": ("Giáo trình – bài giảng", r"(?i)^\s*giáo trình|(?i)^\s*bài giảng"),
        "so-tay": ("Sổ tay", r"(?i)^\s*sổ tay"),
    }
    t.scheme(
        "document-type",
        [
            t.concept("document-type", notation, name, patterns=(pattern,))
            for notation, (name, pattern) in patterns.items()
        ],
        position=2,
        min_labels=1,
        max_labels=1,
        assign_top_concepts=True,
        llm_policy="fallback",
    )
    t.scheme(
        "audience",
        [
            t.concept("audience", "sinh-vien", "Sinh viên đại học", alt=("sinh viên",)),
            t.concept("audience", "giang-vien", "Giảng viên"),
        ],
        position=3,
        assign_top_concepts=True,
        llm_policy="fallback",
    )
    t.scheme(
        "org-unit",
        [
            t.concept(
                "org-unit",
                "truong",
                "Trường Đại học Công nghệ Kỹ thuật TP.HCM",
                alt=("ĐHCNKT", "Trường Đại học Công nghệ Kỹ thuật Thành phố Hồ Chí Minh"),
            ),
            t.concept("org-unit", "phong-dao-tao", "Phòng Đào tạo", alt=("ĐT", "PĐT")),
            t.concept("org-unit", "phong-ctsv", "Phòng Công tác Sinh viên", alt=("CTSV",)),
            t.concept("org-unit", "khoa-cntt", "Khoa Công nghệ Thông tin", alt=("Khoa CNTT",)),
            t.concept("org-unit", "phan-hieu-binh-phuoc", "Phân hiệu tại Bình Phước"),
        ],
        purpose="authority",
        llm_policy="never",
        auto_threshold=None,
        review_threshold=None,
        assign_top_concepts=True,
    )
    t.scheme(
        "program",
        [
            t.concept(
                "program",
                "p-7480203",
                "Kỹ thuật dữ liệu",
                mappings=(("org-unit", "khoa-cntt", None, "broad"), ("domain", "it-khdl", None, "close")),
            ),
        ],
        purpose="authority",
        llm_policy="never",
        auto_threshold=None,
        review_threshold=None,
        assign_top_concepts=True,
    )
    return t


def _rule(t: Taxonomy, code: str, when: str, then: str, effect: str = "implies", weight: float | None = None) -> RuleView:
    return RuleView(
        id=uuid4(),
        code=code,
        when_concept_id=t.ids[when],
        when_collection_item_id=None,
        when_source_id=None,
        then_concept_id=t.ids[then],
        effect=effect,
        weight=weight,
    )


def _rules(t: Taxonomy) -> list[RuleView]:
    return [
        _rule(t, "do-an-function", "document-type:do-an", "function:dt-do-an"),
        _rule(t, "do-an-audience", "document-type:do-an", "audience:sinh-vien"),
        _rule(t, "giao-trinh-function", "document-type:giao-trinh", "function:dt-hoc-lieu"),
        _rule(t, "giao-trinh-audience", "document-type:giao-trinh", "audience:sinh-vien", "prior", 0.7),
        # A prior on a top concept spreads over its subtree.
        _rule(t, "phong-dao-tao-dt", "org-unit:phong-dao-tao", "function:dt", "prior", 0.6),
        _rule(t, "phong-ctsv-hoc-bong", "org-unit:phong-ctsv", "function:ctsv-hoc-bong", "prior", 0.8),
    ]


def _plan(t: Taxonomy | None = None, options: ClassificationOptions | None = None) -> tuple[Taxonomy, ClassificationPlan]:
    t = t or _taxonomy()
    plan = build_plan(TENANT, "hcmute", t.snapshot(), _rules(t), options)
    assert plan is not None
    return t, plan


def _doc(title: str, head: str = "", *, sections: tuple[tuple[str, str, str], ...] = ()) -> DocumentInput:
    return DocumentInput(title=title, context=f"Document: {title}\n{head}", head=head, sections=sections)


def _prepare(plan: ClassificationPlan, doc: DocumentInput) -> PreparedDocument:
    return asyncio.run(prepare(plan, doc))


def _label(plan: ClassificationPlan, concept: UUID) -> str:
    return next(label for label, value in plan.labels.items() if value == concept)


def _task(prepared: PreparedDocument, scheme: str):
    return next(task for task in prepared.request.tasks if task.scheme == scheme)


def _result(outcome, scheme: str) -> SchemeResult:
    return next(result for result in outcome.schemes if result.scheme_code == scheme)


def _header(number: str) -> str:
    return (
        "TRƯỜNG ĐẠI HỌC CÔNG NGHỆ KỸ THUẬT\nTHÀNH PHỐ HỒ CHÍ MINH\nPHÒNG ĐÀO TẠO\n"
        "CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM\nĐộc lập - Tự do - Hạnh phúc\n"
        f"Số: {number}\nTP. Hồ Chí Minh, ngày 05 tháng 8 năm 2025\n"
    )


# --------------------------------------------------------------------------- patterns


@pytest.mark.parametrize(("symbol", "notation"), sorted(SYMBOLS.items()))
def test_document_symbol_settles_document_type(symbol: str, notation: str) -> None:
    t, plan = _plan()
    prepared = _prepare(plan, _doc("Văn bản số 12", _header(f"12/{symbol}-ĐHCNKT-ĐT") + "Về việc tổ chức"))

    rows = prepared.settled["document-type"]
    assert [row.concept_id for row in rows] == [t.ids[f"document-type:{notation}"]]
    assert rows[0].source == "rule" and rows[0].confidence == 1.0
    assert rows[0].evidence["pattern"].startswith(f"/{symbol}-")
    task = _task(prepared, "document-type")
    assert not task.ask and task.settled == (_label(plan, rows[0].concept_id),)


def test_ambiguous_patterns_ask_document_type_with_the_matched_shortlist() -> None:
    t, plan = _plan()
    prepared = _prepare(plan, _doc("Thông báo kế hoạch thi học kỳ 1", _header("5/KH-ĐHCNKT-ĐT")))

    assert "document-type" not in prepared.settled
    task = _task(prepared, "document-type")
    assert task.ask
    assert {candidate.label for candidate in task.shortlist} == {
        _label(plan, t.ids["document-type:thong-bao"]),
        _label(plan, t.ids["document-type:ke-hoach"]),
    }


def test_no_pattern_asks_document_type_with_any_label() -> None:
    _t, plan = _plan()
    prepared = _prepare(plan, _doc("Kỷ yếu hội thảo", "Nội dung kỷ yếu"))

    task = _task(prepared, "document-type")
    assert task.ask and task.shortlist == ()
    assert prepared.request.needs_model


def test_validate_pattern_accepts_re2_and_rejects_the_rest() -> None:
    assert validate_pattern(r"/QĐ-|(?i)^\s*quyết định") is None
    assert validate_pattern(r"(?i)^\s*đề cương (chi tiết )?học phần") is None
    assert validate_pattern(r"(?=abc)") is not None
    assert validate_pattern(r"(?<!x)y") is not None
    assert validate_pattern(r"(a)\1") is not None
    assert validate_pattern(r"a++") is not None
    assert validate_pattern(r"(?>a)") is not None
    assert validate_pattern("a" * 201) is not None
    assert validate_pattern("a(b") is not None
    # A literal "(?=" inside a class or escaped is fine.
    assert validate_pattern(r"[(?=]\(\?=") is None


# --------------------------------------------------------------------------- rules


def test_implies_from_a_settled_type_settles_function_and_audience() -> None:
    t, plan = _plan()
    prepared = _prepare(plan, _doc("Đồ án tốt nghiệp: hệ thống gợi ý", "ĐỒ ÁN TỐT NGHIỆP\nHệ thống gợi ý"))

    assert [row.concept_id for row in prepared.settled["document-type"]] == [t.ids["document-type:do-an"]]
    function = prepared.settled["function"]
    assert [row.concept_id for row in function] == [t.ids["function:dt-do-an"]]
    assert function[0].evidence["rule"] == "do-an-function"
    assert [row.concept_id for row in prepared.settled["audience"]] == [t.ids["audience:sinh-vien"]]
    assert not _task(prepared, "function").ask
    assert not _task(prepared, "audience").ask
    # D is still asked (always), so the model is called.
    assert _task(prepared, "domain").ask


def test_implied_concepts_is_one_hop_and_targets_only() -> None:
    t, plan = _plan()
    implied = implied_concepts(plan, plan.rules, [t.ids["document-type:do-an"]], (), None)
    assert set(implied) == {t.ids["function:dt-do-an"], t.ids["audience:sinh-vien"]}
    # Collection and source conditions.
    collection, source = uuid4(), uuid4()
    rules = [
        RuleView(uuid4(), "c", None, collection, None, t.ids["function:dt-thi"], "implies"),
        RuleView(uuid4(), "s", None, None, source, t.ids["audience:giang-vien"], "implies"),
    ]
    assert set(implied_concepts(plan.taxonomy, rules, [], (collection,), source)) == {
        t.ids["function:dt-thi"],
        t.ids["audience:giang-vien"],
    }
    assert implied_concepts(plan.taxonomy, rules, [], (), None) == {}


def test_org_unit_prior_on_a_top_concept_spreads_over_its_subtree() -> None:
    t, plan = _plan()
    # The issuer (Phòng Đào tạo) holds; its prior on the non-assignable top "dt" spreads.
    prepared = _prepare(plan, _doc("Văn bản số 7", _header("7/QĐ-ĐHCNKT-ĐT") + "Về việc tổ chức"))

    assert prepared.metadata.issuer_concept_id == t.ids["org-unit:phong-dao-tao"]
    scores = {candidate.concept_id: dict(candidate.scores) for candidate in prepared.candidates["function"]}
    for notation in ("dt-do-an", "dt-hoc-lieu", "dt-thi"):
        assert scores[t.ids[f"function:{notation}"]]["prior"] == pytest.approx(0.48)
    assert t.ids["function:dt"] not in scores  # a top concept is never a target
    shortlist = {candidate.label: dict(candidate.scores) for candidate in _task(prepared, "function").shortlist}
    assert shortlist[_label(plan, t.ids["function:dt-thi"])]["prior"] == pytest.approx(0.48)


def test_org_unit_prior_on_a_target_becomes_a_function_candidate() -> None:
    t, plan = _plan()
    head = "TRƯỜNG ĐẠI HỌC CÔNG NGHỆ KỸ THUẬT\nPHÒNG CÔNG TÁC SINH VIÊN\nSố: 3/TB-ĐHCNKT-CTSV\n"
    prepared = _prepare(plan, _doc("Thông báo học bổng", head))

    assert prepared.metadata.issuer_concept_id == t.ids["org-unit:phong-ctsv"]
    top = prepared.candidates["function"][0]
    assert top.concept_id == t.ids["function:ctsv-hoc-bong"]
    assert dict(top.scores)["prior"] == pytest.approx(0.8)
    assert dict(top.scores)["lexical"] > 0


def test_type_prior_reaches_audience_candidates() -> None:
    t, plan = _plan()
    prepared = _prepare(plan, _doc("Giáo trình Cơ sở dữ liệu", "GIÁO TRÌNH CƠ SỞ DỮ LIỆU"))

    assert [row.concept_id for row in prepared.settled["function"]] == [t.ids["function:dt-hoc-lieu"]]
    audience = _task(prepared, "audience")
    assert audience.ask and audience.shortlist == ()  # fallback: any label
    scored = {candidate.concept_id: dict(candidate.scores) for candidate in prepared.candidates["audience"]}
    assert scored[t.ids["audience:sinh-vien"]]["prior"] == pytest.approx(0.7)


def test_program_applicability_gives_a_domain_prior() -> None:
    t, plan = _plan()
    head = "Chương trình áp dụng cho sinh viên khóa 2022 ngành Kỹ thuật dữ liệu."
    prepared = _prepare(plan, _doc("Chương trình học", head))

    scored = {candidate.concept_id: dict(candidate.scores) for candidate in prepared.candidates["domain"]}
    assert scored[t.ids["domain:it-khdl"]]["prior"] == pytest.approx(0.6)


# --------------------------------------------------------------------------- lexical


def test_aho_corasick_takes_the_longest_match_within_word_boundaries() -> None:
    matcher = AhoCorasick(
        [
            ("thông tin", "info"),
            ("công nghệ thông tin", "it"),
            ("tin", "tin"),
            ("ai", "ai"),
        ]
    )
    text = normalize_label("Ngành Công nghệ Thông tin, tin học đại cương; AI và hai người")
    found = [(match.label, match.payloads) for match in matcher.find(text)]
    assert found == [("công nghệ thông tin", ("it",)), ("tin", ("tin",)), ("ai", ("ai",))]
    # "ai" inside "đại"/"hai" is not a word.
    assert [match.label for match in matcher.find("đại hai")] == []


def test_lexical_title_hits_rank_domain_candidates() -> None:
    t, plan = _plan()
    prepared = _prepare(
        plan, _doc("Nhập môn Trí tuệ nhân tạo", "Bài giảng về học máy, dữ liệu lớn và CNTT.")
    )

    ranked = [candidate.concept_id for candidate in prepared.candidates["domain"]]
    assert ranked[0] == t.ids["domain:it-ai"]
    assert t.ids["domain:it-khdl"] in ranked
    assert t.ids["domain:it"] not in ranked  # top concept, not assignable


# --------------------------------------------------------------------------- decide


def _answer(**schemes: SchemeAnswer) -> DocumentClassification:
    return DocumentClassification(schemes={code.replace("_", "-"): value for code, value in schemes.items()})


def test_confidence_routes_by_threshold() -> None:
    t, plan = _plan()
    scheme = plan.scheme("function")
    assert route(confidence("high", 2, 0), scheme) == "accepted"
    assert route(confidence("medium", 1, 1), scheme) == "suggested"
    assert route(confidence("low", 0, 5), scheme) is None


def test_decide_routes_accepted_suggested_and_below_threshold() -> None:
    t, plan = _plan()
    doc = _doc("Nhập môn Trí tuệ nhân tạo", "Bài giảng về học máy, dữ liệu lớn.")
    prepared = _prepare(plan, doc)
    ai, khdl = t.ids["domain:it-ai"], t.ids["domain:it-khdl"]

    accepted = decide(
        plan,
        prepared,
        _answer(domain=SchemeAnswer(labels=(_label(plan, ai), _label(plan, khdl)), certainty="high", evidence="trí tuệ nhân tạo")),
    )
    rows = {row.concept_id: row for row in _result(accepted, "domain").assignments}
    assert rows[ai].state == "accepted" and rows[ai].primary and rows[ai].source == "llm"
    assert rows[ai].evidence["quote"] == "trí tuệ nhân tạo"
    assert {signal["kind"] for signal in rows[ai].evidence["signals"]} == {"lexical"}
    assert _result(accepted, "domain").outcome == "assigned"

    suggested = decide(plan, prepared, _answer(domain=SchemeAnswer(labels=(_label(plan, ai),), certainty="medium")))
    assert [row.state for row in _result(suggested, "domain").assignments] == ["suggested"]

    below = decide(plan, prepared, _answer(domain=SchemeAnswer(labels=(_label(plan, ai),), certainty="low")))
    result = _result(below, "domain")
    assert result.assignments == () and result.outcome == "uncertain"


def test_none_is_empty_only_when_certain_and_allowed() -> None:
    _t, plan = _plan()
    prepared = _prepare(plan, _doc("Kỷ yếu hội thảo", "Nội dung kỷ yếu"))

    empty = decide(plan, prepared, _answer(domain=SchemeAnswer(none=True, certainty="high"), function=SchemeAnswer(none=True, certainty="high")))
    assert _result(empty, "domain").outcome == "empty"
    # F requires a label (min_labels 1): "none" leaves it uncertain.
    assert _result(empty, "function").outcome == "uncertain"

    unsure = decide(plan, prepared, _answer(domain=SchemeAnswer(none=True, certainty="medium")))
    assert _result(unsure, "domain").outcome == "uncertain"


def test_no_answer_fails_asked_schemes_but_keeps_settled_rows() -> None:
    t, plan = _plan()
    prepared = _prepare(plan, _doc("Đồ án tốt nghiệp", "ĐỒ ÁN TỐT NGHIỆP"))

    outcome = decide(plan, prepared, None)
    assert _result(outcome, "domain").outcome == "failed"
    document_type = _result(outcome, "document-type")
    assert document_type.outcome == "assigned"
    assert [(row.concept_id, row.primary, row.state) for row in document_type.assignments] == [
        (t.ids["document-type:do-an"], True, "accepted")
    ]
    assert not outcome.model_called


def test_labels_outside_the_shortlist_are_ignored() -> None:
    t, plan = _plan()
    prepared = _prepare(plan, _doc("Nhập môn Trí tuệ nhân tạo", "Bài giảng về học máy."))
    shortlist = {candidate.label for candidate in _task(prepared, "domain").shortlist}
    outside = _label(plan, t.ids["domain:ee-dien-tu"])
    assert outside not in shortlist

    outcome = decide(
        plan,
        prepared,
        _answer(domain=SchemeAnswer(labels=(outside, "Z99", _label(plan, t.ids["domain:it-ai"])), certainty="high")),
    )
    rows = _result(outcome, "domain").assignments
    assert [row.concept_id for row in rows] == [t.ids["domain:it-ai"]]
    assert rows[0].primary


def test_a_model_chosen_type_applies_its_implies_rules() -> None:
    t, plan = _plan()
    # The type's label is in the text (lexical corroboration), so the pick may be accepted.
    prepared = _prepare(plan, _doc("Hệ thống gợi ý cho thư viện", "Nội dung: đồ án – khóa luận cuối kỳ"))
    assert _task(prepared, "document-type").ask
    answer = _answer(
        document_type=SchemeAnswer(labels=(_label(plan, t.ids["document-type:do-an"]),), certainty="high"),
        function=SchemeAnswer(none=True, certainty="medium"),
        domain=SchemeAnswer(none=True, certainty="high"),
        audience=SchemeAnswer(none=True, certainty="medium"),
    )

    outcome = decide(plan, prepared, answer)
    function = _result(outcome, "function")
    implied = [row for row in function.assignments if row.source == "rule"]
    assert [row.concept_id for row in implied] == [t.ids["function:dt-do-an"]]
    assert implied[0].evidence["rule"] == "do-an-function"
    assert implied[0].state == "accepted"
    assert function.outcome == "assigned"

    # Without corroboration the type is only suggested, and so is what it implies.
    bare = _prepare(plan, _doc("Hệ thống gợi ý cho thư viện", "Nội dung báo cáo cuối kỳ"))
    implied = [row for row in _result(decide(plan, bare, answer), "function").assignments if row.source == "rule"]
    assert [(row.state, row.evidence["corroborated"]) for row in implied] == [("suggested", False)]


def test_section_labels_are_asked_for_long_documents() -> None:
    t, plan = _plan()
    sections = tuple((f"b{number}", f"Phần {number}", f"Nội dung phần {number}") for number in range(1, 4))
    prepared = _prepare(plan, _doc("Sổ tay sinh viên", "SỔ TAY SINH VIÊN", sections=sections))

    assert prepared.request.section_scheme == "function"
    assert [section.label for section in prepared.request.sections] == ["S1", "S2", "S3"]
    thi = _label(plan, t.ids["function:dt-thi"])
    answer = DocumentClassification(
        schemes={
            "function": SchemeAnswer(labels=(thi,), certainty="high"),
            "domain": SchemeAnswer(none=True, certainty="high"),
            "audience": SchemeAnswer(none=True, certainty="high"),
        },
        sections={"b2": (thi,), "unknown": (thi,)},
    )
    rows = _result(decide(plan, prepared, answer), "function").assignments
    section_rows = [row for row in rows if row.section_ref is not None]
    assert [(row.section_ref, row.evidence["section"]) for row in section_rows] == [("b2", "Phần 2")]
    assert not section_rows[0].primary


def test_rerank_restricts_the_shortlist_and_the_rewritten_concepts() -> None:
    t = _taxonomy()
    among = (t.ids["function:dt-do-an"], t.ids["function:dt-hoc-lieu"])
    _t, plan = _plan(t, ClassificationOptions(rerank={"function": among}))
    assert plan.schemes == ("function",)

    prepared = _prepare(plan, _doc("Lịch thi học kỳ", _header("9/TB-ĐHCNKT-ĐT")))
    task = _task(prepared, "function")
    assert task.ask and {candidate.label for candidate in task.shortlist} == {_label(plan, value) for value in among}
    assert prepared.request.metadata_asks == ()

    outcome = decide(
        plan,
        prepared,
        DocumentClassification(schemes={"function": SchemeAnswer(labels=(_label(plan, t.ids["function:dt-thi"]), _label(plan, among[1])), certainty="high")}),
    )
    result = _result(outcome, "function")
    assert result.replace_concepts == frozenset(among)
    assert [row.concept_id for row in result.assignments] == [among[1]]
    assert not outcome.write_profile


def test_concepts_option_restricts_a_scheme_to_a_subtree() -> None:
    t = _taxonomy()
    _t, plan = _plan(t, ClassificationOptions(concepts=(t.ids["domain:ee"],)))
    prepared = _prepare(plan, _doc("Nhập môn Trí tuệ nhân tạo", "học máy"))

    assert {candidate.concept_id for candidate in prepared.candidates["domain"]} == {t.ids["domain:ee-dien-tu"]}
    assert plan.write_profile


def test_suggest_only_writes_every_machine_row_suggested() -> None:
    t = _taxonomy()
    _t, plan = _plan(t, ClassificationOptions(suggest_only=True))
    prepared = _prepare(plan, _doc("Đồ án tốt nghiệp", "ĐỒ ÁN TỐT NGHIỆP"))

    outcome = decide(plan, prepared, _answer(domain=SchemeAnswer(labels=(_label(plan, t.ids["domain:it-ai"]),), certainty="high")))
    states = {row.state for result in outcome.schemes for row in result.assignments}
    assert states == {"suggested"}
    assert outcome.suggest_only


def test_fingerprint_changes_with_rules_and_options() -> None:
    t = _taxonomy()
    first = build_plan(TENANT, "hcmute", t.snapshot(), _rules(t), None)
    again = build_plan(TENANT, "hcmute", t.snapshot(), _rules(t), None)
    fewer = build_plan(TENANT, "hcmute", t.snapshot(), _rules(t)[1:], None)
    noted = build_plan(TENANT, "hcmute", t.snapshot(), _rules(t), ClassificationOptions(note="x"))
    assert first and again and fewer and noted
    assert first.fingerprint == again.fingerprint
    assert len({first.fingerprint, fewer.fingerprint, noted.fingerprint}) == 3
    # Letters stay unique: domain "D", document-type "DT".
    assert {scheme.code: scheme.letter for scheme in first.prompt_schemes} == {
        "domain": "D",
        "function": "F",
        "document-type": "DT",
        "audience": "A",
    }


# --------------------------------------------------------------------------- metadata


def test_metadata_is_read_from_the_nd30_layout() -> None:
    t, plan = _plan()
    head = (
        _header("123/QĐ-ĐHCNKT-ĐT")
        + "QUYẾT ĐỊNH\nVề việc ban hành Quy định đào tạo\n"
        + "Điều 1. Quy định này áp dụng cho sinh viên khóa 2022 ngành Kỹ thuật dữ liệu.\n"
        + "Điều 2. Quyết định này có hiệu lực kể từ ngày 15 tháng 8 năm 2025 và thay thế "
        + "Quyết định số 45/QĐ-ĐHCNKT-ĐT ngày 01/9/2020.\n"
    )
    metadata = _prepare(plan, _doc("Quyết định ban hành quy định", head)).metadata

    assert metadata.number == "123/QĐ-ĐHCNKT-ĐT"
    assert metadata.issued_on == date(2025, 8, 5)
    assert metadata.effective_on == date(2025, 8, 15)
    assert metadata.issuer_concept_id == t.ids["org-unit:phong-dao-tao"]
    assert metadata.level == "cohort" and metadata.cohorts == (2022,)
    assert metadata.program_ids == (t.ids["program:p-7480203"],)
    assert metadata.applicability_confidence == 0.95
    assert metadata.supersedes == ("45/QĐ-ĐHCNKT-ĐT",)
    assert metadata.found() == {"number", "issue_date", "effective_date", "issuer", "applies_to"}


def test_issuer_comes_from_the_symbol_suffix_and_the_header() -> None:
    t, plan = _plan()
    by_suffix = _prepare(plan, _doc("Thông báo", "Số: 8/TB-ĐHCNKT-ĐT\nThông báo lịch thi")).metadata
    assert by_suffix.issuer_concept_id == t.ids["org-unit:phong-dao-tao"]

    head = "TRƯỜNG ĐẠI HỌC CÔNG NGHỆ KỸ THUẬT\nKHOA CÔNG NGHỆ THÔNG TIN\nPHÂN HIỆU TẠI BÌNH PHƯỚC\nSố: 8/TB-ĐHCNKT\n"
    by_header = _prepare(plan, _doc("Thông báo", head)).metadata
    assert by_header.issuer_concept_id == t.ids["org-unit:khoa-cntt"]
    assert by_header.campus_concept_id == t.ids["org-unit:phan-hieu-binh-phuoc"]


def test_effective_from_signing_and_asks_for_missing_metadata() -> None:
    _t, plan = _plan()
    head = _header("4/QĐ-ĐHCNKT-ĐT") + "Quyết định này có hiệu lực thi hành kể từ ngày ký."
    prepared = _prepare(plan, _doc("Quyết định", head))
    assert prepared.metadata.effective_on == date(2025, 8, 5)
    assert prepared.request.metadata_asks == ("applies_to",)


def test_model_metadata_fills_only_missing_fields() -> None:
    t, plan = _plan()
    prepared = _prepare(plan, _doc("Quyết định", _header("4/QĐ-ĐHCNKT-ĐT")))
    answer = DocumentClassification(
        schemes={code: SchemeAnswer(none=True, certainty="high") for code in ("domain", "function")},
        metadata={"number": "999/QĐ-X", "applies_to": "sinh viên Khoa CNTT K23"},
    )
    metadata = decide(plan, prepared, answer).metadata
    assert metadata.number == "4/QĐ-ĐHCNKT-ĐT"
    assert metadata.unit_ids == (t.ids["org-unit:khoa-cntt"],)
    assert metadata.cohorts == (2023,) and metadata.applicability_confidence == 0.6


@pytest.mark.parametrize(
    ("text", "years"),
    [
        ("sinh viên K2022", (2022,)),
        ("sinh viên K22", (2022,)),
        ("sinh viên khóa 2022", (2022,)),
        ("sinh viên khoá 2022", (2022,)),
        ("KHÓA 2021 và K23", (2021, 2023)),
        ("mã K220, OK22", ()),
    ],
)
def test_cohorts(text: str, years: tuple[int, ...]) -> None:
    assert cohorts(text) == years


# --------------------------------------------------------------------------- corroboration


class _Signals:
    """Card scores per scheme, as ``Signals.collect`` returns them."""

    def __init__(self, scores: dict[str, dict[UUID, dict[str, float]]]) -> None:
        self.scores = scores

    async def collect(self, plan: ClassificationPlan, doc: DocumentInput, schemes) -> dict:
        return {code: values for code, values in self.scores.items() if code in schemes}


def test_card_corroborates_only_among_the_top_cards() -> None:
    t, plan = _plan()
    cards = {
        t.ids["function:dt-do-an"]: {"card": 0.9},
        t.ids["function:dt-hoc-lieu"]: {"card": 0.8},
        t.ids["function:dt-thi"]: {"card": 0.7},
        t.ids["function:ctsv-hoc-bong"]: {"card": 0.6},
    }
    prepared = asyncio.run(prepare(plan, _doc("Kỷ yếu hội thảo", "Nội dung kỷ yếu"), _Signals({"function": cards})))

    corroboration = {candidate.concept_id: candidate.corroboration for candidate in prepared.candidates["function"]}
    assert corroboration[t.ids["function:dt-thi"]] == ("card",)
    assert corroboration[t.ids["function:ctsv-hoc-bong"]] == ()


def test_model_certainty_alone_never_auto_accepts() -> None:
    """The smoke's administrative decision: the model is sure of a domain no candidate
    source supports (only a program prior); it stays a suggestion below the auto threshold,
    while a pick the card ranking corroborates may be accepted."""
    t, plan = _plan()
    head = (
        _header("1854/QĐ-ĐHCNKT-ĐT")
        + "QUYẾT ĐỊNH\nVề việc tính điểm học phần\n"
        + "Điều 1. Quy định này áp dụng cho sinh viên khóa 2022 ngành Kỹ thuật dữ liệu.\n"
    )
    signals = _Signals(
        {"domain": {t.ids["domain:it-ai"]: {"card": 0.3}, t.ids["domain:ee-dien-tu"]: {"card": 0.3}}}
    )
    prepared = asyncio.run(prepare(plan, _doc("Quyết định tính điểm học phần", head), signals))
    khdl, ai = t.ids["domain:it-khdl"], t.ids["domain:it-ai"]
    # The prior puts the program's domain first; a prior is not corroboration.
    assert prepared.candidates["domain"][0].concept_id == khdl
    assert prepared.candidates["domain"][0].corroboration == ()

    model_only = decide(plan, prepared, _answer(domain=SchemeAnswer(labels=(_label(plan, khdl),), certainty="high")))
    (row,) = _result(model_only, "domain").assignments
    assert row.state == "suggested" and row.confidence < 0.9
    assert row.evidence["corroborated"] is False

    corroborated = decide(plan, prepared, _answer(domain=SchemeAnswer(labels=(_label(plan, ai),), certainty="high")))
    (row,) = _result(corroborated, "domain").assignments
    assert row.state == "accepted" and row.confidence >= 0.9
    assert row.evidence["corroborated"] is True


# --------------------------------------------------------------------------- applicability


@pytest.mark.parametrize(
    "statement",
    [
        "Quy định này áp dụng đối với sinh viên Khoa Công nghệ Thông tin.",
        "Điều 1. Phạm vi điều chỉnh\nQuy định này điều chỉnh việc làm khóa luận của sinh viên Khoa CNTT.",
        "1. Đối tượng tham dự\n- Tất cả sinh viên được giao thực hiện khóa luận trong học kỳ 1 năm học 2025 -\n"
        "2026 của Khoa Công nghệ Thông tin.",
        "Trưởng khoa quy định việc thực hiện khóa luận cho sinh viên toàn khoa CNTT, được áp dụng\n"
        "từ học kỳ 2 năm học 2024-2025 như sau:",
    ],
)
def test_an_applicability_statement_is_explicit(statement: str) -> None:
    t, plan = _plan()
    metadata = _prepare(plan, _doc("Quy định khóa luận", _header("7/QĐ-ĐHCNKT-ĐT") + statement)).metadata

    assert metadata.level == "unit"
    assert metadata.unit_ids == (t.ids["org-unit:khoa-cntt"],)
    assert metadata.applicability_confidence >= APPLICABILITY_AUTO_THRESHOLD


def test_students_of_a_cohort_and_program_are_explicit() -> None:
    t, plan = _plan()
    head = "Kế hoạch học tập dành cho sinh viên khóa 2022 ngành Kỹ thuật dữ liệu."
    metadata = _prepare(plan, _doc("Kế hoạch học tập", head)).metadata

    assert (metadata.level, metadata.cohorts) == ("cohort", (2022,))
    assert metadata.program_ids == (t.ids["program:p-7480203"],)
    assert metadata.applicability_confidence >= APPLICABILITY_AUTO_THRESHOLD


def test_applicability_inferred_from_the_issuer_stays_weak() -> None:
    t, plan = _plan()
    head = (
        "TRƯỜNG ĐẠI HỌC CÔNG NGHỆ KỸ THUẬT\nKHOA CÔNG NGHỆ THÔNG TIN\nSố: 5/TB-ĐHCNKT\n"
        "THÔNG BÁO\nLịch bảo vệ khóa luận tốt nghiệp học kỳ 1.\n"
    )
    prepared = _prepare(plan, _doc("Thông báo lịch bảo vệ", head))
    assert prepared.metadata.applicability_confidence is None
    assert "applies_to" in prepared.request.metadata_asks

    # The model restates the issuer as the audience: kept, but never explicit.
    answer = DocumentClassification(
        schemes={code: SchemeAnswer(none=True, certainty="high") for code in ("domain", "function")},
        metadata={"applies_to": "sinh viên Khoa Công nghệ Thông tin"},
    )
    metadata = decide(plan, prepared, answer).metadata
    assert metadata.unit_ids == (t.ids["org-unit:khoa-cntt"],)
    assert metadata.applicability_confidence <= 0.6 < APPLICABILITY_AUTO_THRESHOLD


# --------------------------------------------------------------------------- number


@pytest.mark.parametrize(
    ("answered", "kept"),
    [
        ("DIGI330163", None),
        ("BM5", None),
        ("Mã HP: DIGI330163", None),
        ("25/TB-KĐĐT", "25/TB-KĐĐT"),
        ("12/2020/NĐ-CP", "12/2020/NĐ-CP"),
    ],
)
def test_a_model_number_must_have_the_nd30_form(answered: str, kept: str | None) -> None:
    _t, plan = _plan()
    prepared = _prepare(plan, _doc("Đề cương Kỹ thuật số", "ĐỀ CƯƠNG HỌC PHẦN\nMã học phần: DIGI330163"))
    assert prepared.metadata.number is None and "number" in prepared.request.metadata_asks

    answer = DocumentClassification(
        schemes={code: SchemeAnswer(none=True, certainty="high") for code in ("domain", "function")},
        metadata={"number": answered},
    )
    assert decide(plan, prepared, answer).metadata.number == kept
