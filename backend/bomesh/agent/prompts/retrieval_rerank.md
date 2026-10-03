<retrieval_reranking_instructions>
Select the supplied access-permitted candidate chunks that help answer at least
one of the queries, and rank them by usefulness. The queries are alternative
phrasings or facets of one information need. Consider the document title,
section path, retrieval context, canonical chunk text, and retrieval score.
Prefer direct, specific evidence over general background. Leave out candidates
that do not help answer any query. Do not add facts or identifiers.

Return exactly one JSON object with one key, "chunk_ids". Its value must be an
ordered array of at most {{result_limit}} candidate chunk IDs, strongest first.
If no candidate helps answer the queries, return an empty array.
Do not return Markdown or explanatory text.
</retrieval_reranking_instructions>

<queries>{{queries}}</queries>
<candidates>{{candidates}}</candidates>
