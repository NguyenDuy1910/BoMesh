<document_profile_instructions>
  <purpose>
    Classify one enterprise document under every topic of the taxonomy that
    it is about, summarize it and name it. The topics file the document in the
    knowledge library, where people browse and filter by them; the summary
    situates every chunk of the document for retrieval; the title replaces a
    file name that is often a code, an abbreviation or a copy number.
  </purpose>

  <taxonomy_format>
    The taxonomy lists domains, each followed by its topics, one per line:
    label | name | description | keywords | synonyms | guidance | examples.
    The label (T1, T2, ...) identifies the topic in your answer. Keywords and
    synonyms are words in a title or text that mean a document belongs to the
    topic; guidance says when to use the topic and what belongs elsewhere;
    examples are titles of documents that clearly belong to it.
  </taxonomy_format>

  <classification_rules>
    Read the title and the whole document excerpt before choosing.
    Start with the topic that best describes what the document is mainly
    about. Then add every other topic that is also a real subject of the
    document, in the same domain or in another one, without a limit on how
    many: a lecture on a subject and its lab, a regulation that governs two
    processes, a report on a project and its funding. A topic is a real
    subject when a substantial part of the document is about it, enough that
    someone browsing that topic would want this document.
    A subject the document only mentions is not one of its topics: a
    condition, fee, deadline, contact or tool named in passing, a single
    shared word, a header, footer, reference list, course code or the
    organization's name.
    Prefer the most specific topic. Add a broader topic of the same domain
    only when the document is also substantially about the broader subject.
    Follow each topic's guidance on what belongs elsewhere.
    The keyword matches given with the document are hints to check, not
    answers: a match can be incidental, and a topic without a match can still
    apply. Judge every topic by what the document is about.
    Choose none when no topic fits; a wrong topic is worse than a missing one.
    Read the run note as guidance from the person who started processing.
  </classification_rules>

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
    {"topics": [{"label": "T12", "name": "the topic's name exactly as listed", "evidence": "a short phrase from the document that shows it"}], "summary": "one or two sentences", "title": "the document's title"}
    List the topics from most to least central; "topics" may be empty. Use
    only labels from the taxonomy, each with its own name. Do not return
    Markdown or any other text.
  </output_rules>
</document_profile_instructions>

<run_note>{{note}}</run_note>
<taxonomy>
{{taxonomy}}
</taxonomy>
