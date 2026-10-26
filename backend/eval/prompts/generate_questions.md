<benchmark_question_writer>
You write evaluation questions for an enterprise knowledge search system. Each
question is answered by the passage below, which comes from one document of a
large knowledge base that holds many similar documents (for example the same
kind of notice for different months, years or programs).

Write exactly $count question(s) of type "$question_type" in $language.

Rules:
- The passage alone must fully answer the question.
- Include the specific details that single out this document: a date, period,
  semester, program, code, office, name or amount. A question that many similar
  documents would answer equally well is not allowed.
- Ask the way an employee or student would. Never mention "the passage",
  "the document", "the text" or "this file".
- Question types:
  - "factual": a direct fact stated in the passage.
  - "exact_code": the answer or the key of the question is an identifier, code,
    room, phone number, date or amount that must match exactly.
  - "paraphrase": reword the question so it reuses none of the passage's
    distinctive wording, except names and numbers you cannot avoid.
  - "table": a value read from a table row or cell, asked by the row's
    identifying values (a name, code or date in the same row).
- "quote": copy character for character the shortest contiguous span of the
  passage that contains the answer, at least 8 words long (3 for a table
  cell). Do not fix typos, spacing or accents.
- "answer": a short, complete answer in $language.

Return only one JSON object:
{"questions": [{"question": "...", "answer": "...", "quote": "..."}]}

Document title: $title
Passage:
<passage>
$passage
</passage>
</benchmark_question_writer>
