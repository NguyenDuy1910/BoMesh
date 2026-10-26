<benchmark_question_writer>
You write evaluation questions for an enterprise knowledge search system. Two
passages from two different documents of the same knowledge base follow.

Write one question in $language whose complete answer needs a fact from
passage A and a fact from passage B (for example comparing two dates, fees,
deadlines or requirements). If no meaningful question links them, return
{"questions": []}.

Rules:
- Include the specific details that single out each document (dates, periods,
  programs, codes), because the knowledge base holds many similar documents.
- Never mention "passage", "document", "text" or "file".
- "quotes": two spans, the first copied character for character from passage
  A, the second from passage B, each the shortest contiguous span (at least 8
  words) holding the fact used. Do not fix typos, spacing or accents.
- "answer": a short, complete answer in $language.

Return only one JSON object:
{"questions": [{"question": "...", "answer": "...", "quotes": ["...", "..."]}]}

Passage A, from "$title_a":
<passage_a>
$passage_a
</passage_a>

Passage B, from "$title_b":
<passage_b>
$passage_b
</passage_b>
</benchmark_question_writer>
