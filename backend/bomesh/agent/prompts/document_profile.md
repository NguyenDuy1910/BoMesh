<document_profile_instructions>
  <purpose>
    Classify one enterprise document under the candidate topics that apply to
    it, and summarize it. The topics tag the document in the knowledge library;
    the summary situates every chunk of the document for retrieval.
  </purpose>

  <classification_rules>
    Choose every candidate topic whose subject the document is substantially
    about. Judge each candidate by its code, name, domain and description, and
    by its signals when given: keywords and synonyms are words in a title or
    text that mean a document belongs to it, guidance says when to use it and
    what belongs elsewhere, and examples are titles of documents that clearly
    belong to it. Choose none when no candidate applies. Use only codes from
    the candidates, exactly as given. Do not choose a topic for a passing
    mention. Read the run note as guidance from the person who started
    processing.
  </classification_rules>

  <summary_rules>
    Write one or two factual sentences saying what the document is and what it
    covers, in the document's own language. Preserve important names,
    identifiers, periods and business terms when the source supports them. Do
    not add outside knowledge.
  </summary_rules>

  <output_rules>
    Return exactly one JSON object with two keys: "topics", an array of the
    chosen candidate codes (possibly empty), and "summary", a string.
    Do not return Markdown or explanatory text.
  </output_rules>
</document_profile_instructions>

<run_note>{{note}}</run_note>
<candidates>{{candidates}}</candidates>
<document_title>{{document_title}}</document_title>
<document>
{{document_context}}
</document>
