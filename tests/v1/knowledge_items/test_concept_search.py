"""SearchItems and agent retrieval over the faceted taxonomy (``conversation_loop.md`` "Knowledge retrieval"; ``api_design.md`` SearchItems).

A subset of the university template: T (document-type) with the ``quy-pham``
query-expansion group, F (function), D (domain) and the org-unit/program
authority schemes. A CNTT student of cohort 2022 searches; the fake index ranks
by query-term overlap. Filters and facets over ``document.concepts`` are
hierarchical through ``concept_closure``.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

import pytest

from bomesh.agent.models import AgentContext, CitationReferences
from bomesh.db.engine import transaction_scope
from bomesh.db.models import Item, ItemClassification
from bomesh.services.agent_runtime.knowledge_search import AgentKnowledgeSearchService
from harness import World
from knowledge_support import Knowledge, item_name, ws_url
from taxonomy_support import C, G, Published, affiliate, label, profile, publish_scheme

pytestmark = pytest.mark.asyncio


@dataclass
class Campus:
    workspace: object
    student: object
    handbook: Item
    domain: Published
    function: Published
    types: Published
    units: Published
    programs: Published

    def concept(self, scheme: Published, notation: str) -> str:
        return f"workspaces/{self.workspace.id}/conceptSchemes/{scheme.code}/concepts/{notation}"

    def scheme(self, scheme: Published) -> str:
        return f"workspaces/{self.workspace.id}/conceptSchemes/{scheme.code}"


async def _campus(world: World, knowledge: Knowledge) -> Campus:
    admin = await world.make_user()
    workspace = await world.make_workspace(admin)
    student = await world.add_member(workspace)
    handbook = await world.make_collection(
        workspace, item_name="Văn bản", grants={student: "roles/collectionViewer"}
    )
    sessions = knowledge.sessions
    publish = lambda code, concepts, **kw: publish_scheme(  # noqa: E731
        sessions, workspace.id, admin.id, code, concepts, **kw
    )
    domain = await publish(
        "domain",
        [
            C("it", "Công nghệ thông tin", color="#1e88e5"),
            C("ee", "Điện – điện tử", color="#f4511e"),
            C("it-ai", "Trí tuệ nhân tạo", broader=("it",)),
            C(
                "it-thi-giac-may-tinh",
                "Thị giác máy tính",
                alt=("nhận diện khuôn mặt",),
                broader=("it-ai",),
            ),
            C("kien-truc-may-tinh", "Kiến trúc máy tính", broader=("it", "ee")),
        ],
        name="Lĩnh vực",
        position=0,
        assign_top_concepts=False,
    )
    function = await publish(
        "function",
        [
            C("dt", "Đào tạo"),
            C("dt-do-an", "Thực tập, đồ án & khóa luận", alt=("khóa luận",), broader=("dt",)),
            C("dt-hoc-vu", "Học vụ", broader=("dt",)),
        ],
        name="Nghiệp vụ",
        position=1,
        assign_top_concepts=False,
    )
    types = await publish(
        "document-type",
        [
            C("do-an-khoa-luan", "Đồ án – khóa luận", alt=("khóa luận",)),
            C("quy-che", "Quy chế"),
            C("quy-dinh", "Quy định"),
            C("huong-dan", "Hướng dẫn"),
            C("bieu-mau", "Biểu mẫu – đơn", alt=("mẫu",)),
            C("thong-bao", "Thông báo", hidden=("hạn nộp",), time_sensitive=True),
        ],
        name="Loại tài liệu",
        position=2,
        max_depth=1,
        groups=[G("quy-pham", "Quy phạm", ("quy-che", "quy-dinh", "huong-dan"), True)],
    )
    units = await publish(
        "org-unit",
        [
            C("truong", "Trường Đại học"),
            C("khoa-cntt", "Khoa Công nghệ thông tin", broader=("truong",)),
            C("khoa-co-khi", "Khoa Cơ khí", broader=("truong",)),
        ],
        purpose="authority",
        position=10,
    )
    programs = await publish(
        "program",
        [
            C("nganh-cntt", "Ngành CNTT", mappings=(("org-unit", "khoa-cntt", "broad"),)),
            C("nganh-co-khi", "Ngành Cơ khí", mappings=(("org-unit", "khoa-co-khi", "broad"),)),
        ],
        purpose="authority",
        position=11,
    )
    await affiliate(sessions, workspace.id, student.id, [programs["nganh-cntt"]], cohort=2022)
    return Campus(workspace, student, handbook, domain, function, types, units, programs)


async def _doc(
    world: World, knowledge: Knowledge, campus: Campus, name: str, text: str
) -> Item:
    document = await world.make_document(campus.handbook, item_name=name)
    await knowledge.index(document, [text])
    return document


async def _search(client, campus: Campus, **body) -> dict:
    api = await client.as_(campus.student)
    response = await api.post(f"{ws_url(campus.workspace)}/items:search", json=body)
    assert response.status_code == 200, response.text
    return response.json()


def _names(body: dict) -> list[str]:
    return [result["item"]["name"] for result in body.get("results", [])]


def _read(body: dict) -> set[tuple[str, str]]:
    return {(entry["concept"], entry["text"]) for entry in body["interpretation"].get("concepts", [])}


async def _thesis_library(world: World, knowledge: Knowledge, campus: Campus) -> dict[str, Item]:
    s = knowledge.sessions
    today = datetime.now(UTC).date()
    docs = {
        "rules": await _doc(world, knowledge, campus, "Quy định khóa luận", "quy định làm khóa luận tốt nghiệp toàn trường"),
        "cntt": await _doc(world, knowledge, campus, "Hướng dẫn CNTT", "hướng dẫn làm khóa luận khoa công nghệ thông tin"),
        "co-khi": await _doc(world, knowledge, campus, "Hướng dẫn Cơ khí", "hướng dẫn làm khóa luận khoa cơ khí"),
        "notice-new": await _doc(world, knowledge, campus, "Thông báo đợt 2", "thông báo hạn nộp khóa luận"),
        "notice-mid": await _doc(world, knowledge, campus, "Thông báo đợt 1", "thông báo hạn nộp khóa luận"),
        "notice-old": await _doc(world, knowledge, campus, "Thông báo cũ", "thông báo hạn nộp khóa luận"),
        "cover": await _doc(world, knowledge, campus, "Mẫu bìa", "mẫu bìa khóa luận tốt nghiệp"),
        "thesis": await _doc(world, knowledge, campus, "Khóa luận nhận diện", "khóa luận nhận diện khuôn mặt bằng học sâu"),
    }
    for key, kind in (("rules", "quy-dinh"), ("cntt", "huong-dan"), ("co-khi", "huong-dan"), ("cover", "bieu-mau")):
        await label(s, docs[key].id, campus.types, kind)
        await label(s, docs[key].id, campus.function, "dt-do-an")
    for key in ("notice-new", "notice-mid", "notice-old"):
        await label(s, docs[key].id, campus.types, "thong-bao")
        await label(s, docs[key].id, campus.function, "dt-do-an")
    await label(s, docs["thesis"].id, campus.types, "do-an-khoa-luan")
    await label(s, docs["thesis"].id, campus.domain, "it-thi-giac-may-tinh")
    await profile(s, docs["rules"].id, level="institution")
    await profile(s, docs["cntt"].id, level="unit", applies_to=[campus.units["khoa-cntt"]])
    await profile(s, docs["co-khi"].id, level="unit", applies_to=[campus.units["khoa-co-khi"]])
    for key, age in (("notice-new", 10), ("notice-mid", 100), ("notice-old", 400)):
        await profile(s, docs[key].id, issued_on=today - timedelta(days=age))
    return docs


async def test_acceptance_queries_of_a_cntt_student(client, world: World, knowledge: Knowledge) -> None:
    campus = await _campus(world, knowledge)
    docs = await _thesis_library(world, knowledge, campus)
    name = {key: item_name(document) for key, document in docs.items()}
    t, f, d = campus.types, campus.function, campus.domain

    subject_search = await _search(client, campus, query="tìm khóa luận về nhận diện khuôn mặt")
    rules = await _search(client, campus, query="quy định làm khóa luận")
    deadline = await _search(client, campus, query="hạn nộp khóa luận")
    cover = await _search(client, campus, query="mẫu bìa khóa luận")
    bare = await _search(client, campus, query="khóa luận")

    # Rule 2: a D term and no T term → the shared label is T.
    assert _read(subject_search) == {
        (campus.concept(t, "do-an-khoa-luan"), "khóa luận"),
        (campus.concept(d, "it-thi-giac-may-tinh"), "nhận diện khuôn mặt"),
    }
    assert _names(subject_search)[0] == name["thesis"]
    # Expansion of the quy-pham group; rule 1 sends "khóa luận" to F.
    assert _read(rules) == {
        (campus.concept(t, "quy-che"), "quy định"),
        (campus.concept(t, "quy-dinh"), "quy định"),
        (campus.concept(t, "huong-dan"), "quy định"),
        (campus.concept(f, "dt-do-an"), "khóa luận"),
    }
    assert {name["rules"], name["cntt"]} <= set(_names(rules))
    assert name["co-khi"] not in _names(rules)  # explicitly another faculty's
    assert _names(rules).index(name["cntt"]) < _names(rules).index(name["notice-new"])
    # "hạn nộp" is a hiddenLabel of the time-sensitive Thông báo: newest first.
    assert (campus.concept(t, "thong-bao"), "hạn nộp") in _read(deadline)
    assert _names(deadline)[:3] == [name["notice-new"], name["notice-mid"], name["notice-old"]]
    assert _read(cover) == {
        (campus.concept(t, "bieu-mau"), "mẫu"),
        (campus.concept(f, "dt-do-an"), "khóa luận"),
    }
    assert _names(cover)[0] == name["cover"]
    # Bare "khóa luận" is ambiguous: one group per reading, in scheme tab order.
    interpretation = bare["interpretation"]
    assert "concepts" not in interpretation
    (ambiguity,) = interpretation["ambiguities"]
    assert ambiguity["text"] == "khóa luận"
    assert [(o["scheme"], o["concepts"], o["displayName"]) for o in ambiguity["options"]] == [
        (campus.scheme(f), [campus.concept(f, "dt-do-an")], "Nghiệp vụ: Thực tập, đồ án & khóa luận"),
        (campus.scheme(t), [campus.concept(t, "do-an-khoa-luan")], "Loại tài liệu: Đồ án – khóa luận"),
    ]
    assert ambiguity["options"][1]["filter"] == f'document.concepts:"{campus.concept(t, "do-an-khoa-luan")}"'
    groups = {group["option"]: [r["item"]["name"] for r in group["results"]] for group in interpretation["groups"]}
    assert list(groups) == [option["displayName"] for option in ambiguity["options"]]
    assert groups["Loại tài liệu: Đồ án – khóa luận"][0] == name["thesis"]
    assert len(groups["Nghiệp vụ: Thực tập, đồ án & khóa luận"]) == 5
    assert name["thesis"] not in groups["Nghiệp vụ: Thực tập, đồ án & khóa luận"]
    assert name["co-khi"] not in {n for names in groups.values() for n in names} | set(_names(bare))


async def test_ambiguity_groups_hold_only_documents_of_their_option(
    client, world: World, knowledge: Knowledge
) -> None:
    campus = await _campus(world, knowledge)
    docs = await _thesis_library(world, knowledge, campus)
    s = knowledge.sessions
    # Text that matches the query well, labels of neither option.
    syllabus = await _doc(world, knowledge, campus, "Đề cương Kỹ thuật số", "khóa luận khóa luận đề cương học phần")
    template = await _doc(world, knowledge, campus, "Template NCKH", "khóa luận khóa luận mẫu đề tài nghiên cứu")
    await label(s, syllabus.id, campus.domain, "kien-truc-may-tinh")
    await label(s, syllabus.id, campus.function, "dt-hoc-vu")

    bare = await _search(client, campus, query="khóa luận")

    groups = {
        group["option"]: [r["item"]["name"] for r in group["results"]]
        for group in bare["interpretation"]["groups"]
    }
    assert groups["Loại tài liệu: Đồ án – khóa luận"] == [item_name(docs["thesis"])]
    function_group = set(groups["Nghiệp vụ: Thực tập, đồ án & khóa luận"])
    assert function_group and item_name(docs["thesis"]) not in function_group
    for outsider in (syllabus, template):
        assert item_name(outsider) not in function_group | set(groups["Loại tài liệu: Đồ án – khóa luận"])
    # The main results still read the text: both are found there.
    assert {item_name(syllabus), item_name(template)} <= set(_names(bare))


async def test_the_query_naming_a_faculty_keeps_its_documents(
    client, world: World, knowledge: Knowledge
) -> None:
    campus = await _campus(world, knowledge)
    docs = await _thesis_library(world, knowledge, campus)

    named = await _search(client, campus, query="khóa luận khoa cơ khí")

    assert item_name(docs["co-khi"]) in _names(named)


async def test_an_extracted_low_confidence_scope_is_not_excluded(
    client, world: World, knowledge: Knowledge
) -> None:
    campus = await _campus(world, knowledge)
    unsure = await _doc(world, knowledge, campus, "Hướng dẫn", "hướng dẫn làm khóa luận cơ khí")
    sure = await _doc(world, knowledge, campus, "Hướng dẫn 2", "hướng dẫn làm khóa luận cơ khí năm nay")
    other = campus.units["khoa-co-khi"]
    await profile(knowledge.sessions, unsure.id, level="unit", applies_to=[other], source="extracted", confidence=0.6)
    await profile(knowledge.sessions, sure.id, level="unit", applies_to=[other], source="extracted", confidence=0.95)

    found = _names(await _search(client, campus, query="hướng dẫn làm khóa luận"))

    assert item_name(unsure) in found
    assert item_name(sure) not in found


async def test_agent_retrieval_reads_queries_and_groups_evidence(
    runtime, world: World, knowledge: Knowledge
) -> None:
    campus = await _campus(world, knowledge)
    docs = await _thesis_library(world, knowledge, campus)
    context = AgentContext(
        user_id=str(campus.student.id),
        tenant_id=str(campus.workspace.id),
        collection_item_ids=(str(campus.handbook.id),),
    )
    retriever = runtime.knowledge_retriever()

    rules = await retriever.search_interpreted(["quy định làm khóa luận"], limit=5, ctx=context)
    bare = await retriever.search_interpreted(["khóa luận"], limit=4, ctx=context)
    result = await AgentKnowledgeSearchService(retriever, result_limit=4).search(
        {"queries": ["khóa luận"]}, context=context, references=CitationReferences(), call_id="call-1"
    )

    assert str(docs["co-khi"].id) not in {item.item_id for item in rules.evidence}
    assert rules.interpretations[0].concepts == (
        '"quy định" → Loại tài liệu: Hướng dẫn / Quy chế / Quy định',
        '"khóa luận" → Nghiệp vụ: Thực tập, đồ án & khóa luận',
    )
    (reading,) = bare.interpretations
    assert reading.ambiguity == "khóa luận"
    assert reading.options == ("Nghiệp vụ: Thực tập, đồ án & khóa luận", "Loại tài liệu: Đồ án – khóa luận")
    assert {item.group for item in bare.evidence} == set(reading.options)
    assert [item.item_id for item in bare.evidence if item.group == reading.options[1]][0] == str(docs["thesis"].id)
    assert '"khóa luận" has several readings' in result.content
    assert "Reading: Loại tài liệu: Đồ án – khóa luận" in result.content


async def _facet_world(world: World, knowledge: Knowledge):
    campus = await _campus(world, knowledge)
    s = knowledge.sessions
    hidden = await world.make_collection(campus.workspace, item_name="Hidden")
    both = await world.make_document(campus.handbook, item_name="Both")
    hardware = await world.make_document(campus.handbook, item_name="Hardware")
    vision = await world.make_document(campus.handbook, item_name="Vision")
    notice = await world.make_document(campus.handbook, item_name="Notice")
    pending = await world.make_document(campus.handbook, item_name="Pending")
    secret = await world.make_document(hidden, item_name="Secret")
    await label(s, both.id, campus.domain, "kien-truc-may-tinh", "it-ai")
    await label(s, hardware.id, campus.domain, "kien-truc-may-tinh")
    await label(s, vision.id, campus.domain, "it-thi-giac-may-tinh")
    await label(s, vision.id, campus.types, "quy-dinh")
    await label(s, notice.id, campus.types, "thong-bao")
    await label(s, notice.id, campus.domain, "it-ai")
    await label(s, pending.id, campus.domain, "it-ai", state="suggested", source="llm")
    await label(s, secret.id, campus.domain, "it-ai")
    await profile(s, vision.id, level="unit", applies_to=[campus.units["khoa-cntt"]], issuer=campus.units["khoa-cntt"])
    await profile(s, notice.id, level="program", applies_to=[campus.programs["nganh-co-khi"]])
    return campus, {"both": both, "hardware": hardware, "vision": vision, "notice": notice, "pending": pending}


def _counts(body: dict, position: int = 0) -> dict[str, int]:
    return {value["value"]: value["documentCount"] for value in body["facets"][position].get("values") or []}


async def test_concept_filters_are_hierarchical_or_within_and_across_schemes(
    client, world: World, knowledge: Knowledge
) -> None:
    campus, docs = await _facet_world(world, knowledge)
    d, t = campus.domain, campus.types
    names = {key: item_name(document) for key, document in docs.items()}

    it = await _search(client, campus, filter=f'document.concepts:"{campus.concept(d, "it")}"')
    ee = await _search(client, campus, filter=f'document.concepts:"{campus.concept(d, "ee")}"')
    either = await _search(
        client,
        campus,
        filter=(
            f'(document.concepts:"{campus.concept(d, "it-thi-giac-may-tinh")}" OR '
            f'document.concepts:"{campus.concept(d, "kien-truc-may-tinh")}") AND '
            f'document.concepts:"{campus.concept(t, "quy-dinh")}"'
        ),
    )
    suggested = await _search(client, campus, filter=f'document.suggestedConcepts:"{campus.concept(d, "it")}"')
    labeled = await _search(client, campus, filter="document.concepts:*")

    assert set(_names(it)) == {names["both"], names["hardware"], names["vision"], names["notice"]}
    assert set(_names(ee)) == {names["both"], names["hardware"]}
    assert _names(either) == [names["vision"]]
    assert _names(suggested) == [names["pending"]]
    assert names["pending"] not in _names(labeled)


async def test_concept_facets_count_each_document_once_per_value(
    client, world: World, knowledge: Knowledge
) -> None:
    campus, _ = await _facet_world(world, knowledge)
    d, t = campus.domain, campus.types
    domain_facet = {"field": "document.concepts", "prefixes": [campus.scheme(d)], "limit": 50}
    type_facet = {"field": "document.concepts", "prefixes": [campus.scheme(t)], "limit": 50}

    every = await _search(client, campus, facetSpecs=[domain_facet, type_facet])
    notices = await _search(
        client,
        campus,
        filter=f'document.concepts:"{campus.concept(t, "thong-bao")}"',
        facetSpecs=[domain_facet, type_facet],
    )
    suggestions = await _search(client, campus, facetSpecs=[{"field": "document.suggestedConcepts"}])

    # "Both" carries kien-truc-may-tinh (under it and ee) and it-ai (under it): IT counts it
    # once. The hidden collection's document never counts; neither does a suggestion.
    assert _counts(every) == {
        campus.concept(d, "it"): 4,
        campus.concept(d, "it-ai"): 3,
        campus.concept(d, "ee"): 2,
        campus.concept(d, "kien-truc-may-tinh"): 2,
        campus.concept(d, "it-thi-giac-may-tinh"): 1,
    }
    assert _counts(every, 1) == {campus.concept(t, "quy-dinh"): 1, campus.concept(t, "thong-bao"): 1}
    assert every["facets"][0]["values"][0]["displayName"] == "Công nghệ thông tin"
    # Disjunctive per scheme: the type facet ignores the type choice, the domain facet keeps it.
    assert _counts(notices) == {campus.concept(d, "it"): 1, campus.concept(d, "it-ai"): 1}
    assert _counts(notices, 1) == _counts(every, 1)
    assert _counts(suggestions) == {campus.concept(d, "it"): 1, campus.concept(d, "it-ai"): 1}


async def test_issuance_and_applicability_filters(client, world: World, knowledge: Knowledge) -> None:
    campus, docs = await _facet_world(world, knowledge)
    u, p = campus.units, campus.programs
    names = {key: item_name(document) for key, document in docs.items()}

    school = await _search(client, campus, filter=f'document.applicability.units:"{campus.concept(u, "truong")}"')
    program = await _search(client, campus, filter=f'document.applicability.programs:"{campus.concept(p, "nganh-co-khi")}"')
    issued = await _search(client, campus, filter=f'document.issuance.issuer = "{campus.concept(u, "khoa-cntt")}"')
    api = await client.as_(campus.student)
    wrong = await api.post(
        f"{ws_url(campus.workspace)}/items:search",
        json={"filter": f'document.applicability.units:"{campus.concept(p, "nganh-co-khi")}"'},
    )
    bad_prefix = await api.post(
        f"{ws_url(campus.workspace)}/items:search",
        json={"facetSpecs": [{"field": "itemType", "prefixes": [campus.scheme(campus.domain)]}]},
    )

    assert _names(school) == [names["vision"]]
    assert _names(program) == [names["notice"]]
    assert _names(issued) == [names["vision"]]
    assert wrong.status_code == 400, wrong.text
    assert bad_prefix.status_code == 400, bad_prefix.text


async def test_scheme_level_concept_and_uncertain_filters(
    client, world: World, knowledge: Knowledge
) -> None:
    campus, docs = await _facet_world(world, knowledge)
    plain = await world.make_document(campus.handbook, item_name="Plain")
    d, t, f = campus.domain, campus.types, campus.function
    async with transaction_scope(knowledge.sessions) as session:
        for document, scheme in ((docs["pending"], t), (docs["hardware"], t), (docs["both"], f)):
            session.add(
                ItemClassification(item_id=document.id, scheme_id=scheme.scheme_id, outcome="uncertain")
            )
        # Decided empty is not the pool.
        session.add(ItemClassification(item_id=plain.id, scheme_id=t.scheme_id, outcome="empty"))
    names = {key: item_name(document) for key, document in docs.items()}
    names["plain"] = item_name(plain)
    every = set(names.values())

    async def found(filter_text: str, **body) -> set[str]:
        return set(_names(await _search(client, campus, filter=filter_text, **body)))

    has_domain = await found(f'document.concepts:"{campus.scheme(d)}"')
    lacks_type = await found(f'NOT document.concepts:"{campus.scheme(t)}"')
    suggested = await found(f'document.suggestedConcepts:"{campus.scheme(d)}"')
    uncertain = await found(f'document.uncertainSchemes:"{campus.scheme(t)}"')
    certain = await found(f'NOT document.uncertainSchemes:"{campus.scheme(t)}"')
    pool = await found("document.uncertainSchemes:*")
    api = await client.as_(campus.student)
    listed = await api.get(
        f"{ws_url(campus.workspace)}/items",
        params={"filter": f'itemKind = DOCUMENT AND NOT document.concepts:"{campus.scheme(d)}"'},
    )
    facets = await _search(
        client,
        campus,
        filter=f'document.concepts:"{campus.scheme(t)}" AND document.concepts:"{campus.scheme(d)}"',
        facetSpecs=[
            {"field": "document.concepts", "prefixes": [campus.scheme(d)], "limit": 50},
            {"field": "document.uncertainSchemes"},
        ],
    )
    pool_facet = await _search(client, campus, facetSpecs=[{"field": "document.uncertainSchemes"}])
    bad = await api.post(
        f"{ws_url(campus.workspace)}/items:search",
        json={"filter": f'document.uncertainSchemes:"{campus.concept(t, "quy-dinh")}"'},
    )

    assert has_domain == {names["both"], names["hardware"], names["vision"], names["notice"]}
    assert lacks_type == every - {names["vision"], names["notice"]}
    assert suggested == {names["pending"]}
    assert uncertain == {names["pending"], names["hardware"]}
    assert certain == every - uncertain
    assert pool == {names["pending"], names["hardware"], names["both"]}
    assert listed.status_code == 200, listed.text
    assert {item["name"] for item in listed.json()["items"]} == {names["pending"], names["plain"]}
    # The domain facet ignores the domain-scheme restriction and keeps the type one.
    assert _counts(facets) == {
        campus.concept(d, "it"): 2,
        campus.concept(d, "it-ai"): 2,
        campus.concept(d, "it-thi-giac-may-tinh"): 1,
    }
    assert _counts(facets, 1) == {}
    assert {
        value["value"]: (value["displayName"], value["documentCount"])
        for value in pool_facet["facets"][0]["values"]
    } == {campus.scheme(t): ("Loại tài liệu", 2), campus.scheme(f): ("Nghiệp vụ", 1)}
    assert bad.status_code == 400, bad.text
