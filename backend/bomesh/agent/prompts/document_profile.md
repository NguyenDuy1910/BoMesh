<document_profile_instructions>
  <purpose>
    Classify one document of a knowledge library under the concept schemes
    listed below, find the issuance facts asked for, summarize it and name
    it. The labels file the document in the library, where people browse and
    filter by them; the facts say who issued it, when, and whom it applies
    to; the summary situates every chunk of the document for retrieval; the
    title replaces a file name that is often a code, an abbreviation or a
    copy number.
  </purpose>

  <schemes_format>
    Each scheme starts with a heading: "## letter — name (code): choose
    min..max", plus ", one primary" when the scheme has a primary label. Its
    concepts follow, one per line:
    label | path › name | definition | scope note | alt labels | examples.
    The label (for example D12) identifies the concept in your answer; the
    path names its broader concepts; the scope note says when to use the
    concept and what belongs elsewhere; alt labels are other words for it;
    examples are titles of documents that clearly belong to it.
  </schemes_format>

  <document_part>
    After this prefix comes one document's part: the settled facets (labels
    rules already decided, as context, never to be answered), the schemes to
    answer, the sections to label, the metadata to find, the title and the
    document excerpt. For a scheme listed with candidates, choose only among
    those candidates; their scores are signals to check, not answers
    (lexical: the concept's words appear in the text; card: the text is
    similar to the concept's description; knn: similar reviewed documents
    carry it; prior: a rule makes it likely). For a scheme listed as "any
    label of scheme", choose among all of its concepts above.
  </document_part>

  <classification_rules>
    Read the title and the whole excerpt before choosing.
    For each scheme to answer, the primary label is what the document is
    mainly about; secondary labels are other real subjects, up to the
    scheme's maximum. A subject is real when a substantial part of the
    document is about it, enough that someone browsing that concept would
    want this document. A subject only mentioned in passing is not a label:
    a condition, fee, deadline, contact or tool named in passing, a single
    shared word, a header, footer, reference list, course code or the
    organization's name.
    Prefer the most specific concept; add a broader one only when the
    document is also substantially about the broader subject. Follow each
    concept's scope note: when it says a kind of document belongs elsewhere
    or is excluded, never choose that concept for such a document, however
    close its words are.
    A domain (field of knowledge) scheme such as D applies only when the
    content itself is professional or disciplinary knowledge, including a
    program's curriculum or a course syllabus. Never choose a domain from the unit that
    issued the document: an administrative notice of a faculty is not about
    that faculty's field. Administrative documents (decisions, regulations,
    notices, plans, forms and minutes about admissions, enrolment, grading,
    exams, thesis or graduation procedures, fees or schedules) carry no
    domain even when they name a faculty, a program or words such as
    assessment or curriculum: answer the domain scheme with "none" and high
    certainty. A thesis, report, article or syllabus itself is knowledge
    and keeps its domain.
    Never invent concepts or labels: use only the labels allowed for the
    scheme. Choose none when nothing fits; a wrong label is worse than a
    missing one.
    Certainty is high when the document plainly states it, medium when it is
    strongly implied, low when it is a guess.
    When sections are listed, give each section the labels of the named
    scheme that fit that section, by the same rules; leave out a section
    nothing fits.
    Read the run note as guidance from the person who started processing.
  </classification_rules>

  <metadata_rules>
    Find only the fields asked for, and only when the document states them:
    number is the administrative document's number and symbol as printed
    after "Số:" (for example "123/QĐ-ĐHCNKT-ĐT"), never a course, form or
    file code such as "DIGI330163" or "BM5"; issue_date and effective_date
    are dates as YYYY-MM-DD; issuer is the issuing unit's name as printed;
    applies_to is the phrase that says whom the document applies to (for
    example "sinh viên khóa 2025 ngành Kỹ thuật dữ liệu"), never inferred
    from the issuing unit. Leave out a field the document does not state;
    never guess.
  </metadata_rules>

  <summary_rules>
    Write one or two factual sentences in the document's own language: what
    kind of document it is (for example a lecture, regulation, notice, form,
    report, plan or contract) and what it covers. Keep the important names,
    identifiers, periods, programs, units and business terms the source
    supports. Do not add outside knowledge, opinions or advice, and do not
    begin with words like "This document".
  </summary_rules>

  <title_rules>
    Write the title a librarian would file the document under, in the
    document's own language. When the document states its own title (on its
    cover, first heading or subject line), use that title, keeping its words
    and fixing only case, spacing, missing diacritics and broken characters.
    Otherwise name the kind of document and its subject. Keep a number,
    unit, program or year that tells it apart from similar documents. The
    given document title is usually a file name: use it only for what the
    document confirms, and drop its extension, underscores, dots between
    words, "Signed", "final", "copy" and copy numbers such as "(5)". At most
    120 characters, no quotation marks and no trailing period.
  </title_rules>

  <output_rules>
    Return exactly one JSON object:
    {"schemes": {"domain": {"primary": "D12", "secondary": ["D3"], "certainty": "high", "evidence": "a short quote from the document"}, "audience": {"none": true, "certainty": "medium"}}, "sections": [{"section": "S2", "labels": ["F7"]}], "metadata": {"number": "…", "issue_date": "YYYY-MM-DD"}, "summary": "one or two sentences", "title": "the document's title"}
    The keys of "schemes" are the scheme codes listed in answer_keys (the
    word in parentheses of a scheme heading, such as "domain"), never the
    label letters. Answer every key listed there, and no other scheme: when
    nothing fits a scheme, or a scheme says "any label", still answer it,
    with "none": true if no label applies. A scheme without a primary label
    may list its labels as "labels": [...] instead. Omit "sections" and
    "metadata" when none were asked. Do not return Markdown or any other
    text.
  </output_rules>
</document_profile_instructions>

<run_note>{{note}}</run_note>
<schemes>
{{schemes}}
</schemes>
