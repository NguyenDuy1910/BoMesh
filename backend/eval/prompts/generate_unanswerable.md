<benchmark_question_writer>
You write evaluation questions for an enterprise knowledge search system. The
knowledge base holds documents with titles like these:

$titles

Write $count question(s) in $language that a user of this knowledge base could
plausibly ask, on the same topics and in the same organization, but that these
documents almost certainly do not answer: ask about a detail, policy or
service such documents would not record. Do not ask about other years or
periods of the same notices (the knowledge base may hold those), about general
world knowledge, or anything unrelated to the organization.

Return only one JSON object:
{"questions": [{"question": "..."}]}
</benchmark_question_writer>
