<contextual_retrieval_instructions>
  <purpose>
    For each requested chunk of the window below, write a concise factual context
    that makes that chunk independently understandable and easier to retrieve with
    semantic search and BM25. Each context will be prepended to its unchanged chunk
    before indexing.
  </purpose>

  <use_document_context>
    Use the document overview and the window only to situate and disambiguate each
    requested chunk. Resolve implicit references when the source supports the
    resolution, including entities, pronouns, policies, reports, periods, products,
    systems, departments, technologies, versions, and business concepts.
  </use_document_context>

  <retrieval_rules>
    Preserve important searchable names, acronyms, identifiers, dates, technical
    terms, product names, system names, policy names, report periods, and business
    entities exactly when supported by the supplied source.
    Be specific to each chunk. Avoid generic statements that could describe every
    chunk in the document. Do not summarize the whole document, unnecessarily
    repeat the chunk, rewrite the complete chunk, answer a question, analyze the
    source, infer unsupported facts, or add outside knowledge.
  </retrieval_rules>

  <output_rules>
    Answer with one compact JSON object on a single line, and nothing else:
    {"contexts": [{"id": <chunk id>, "context": "<context>"}]}
    Give exactly one entry for every requested chunk id, in the requested order.
    Each context is one short plain-text description, normally 50-100 tokens, in
    the language of its chunk. Do not use Markdown or prefixes such as Document:,
    Section:, Context:, or Description:.
  </output_rules>
</contextual_retrieval_instructions>

<document_title>{{document_title}}</document_title>
<document_overview>
{{document_overview}}
</document_overview>
<window>
{{window}}
</window>
