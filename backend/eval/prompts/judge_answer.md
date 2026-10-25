<grounded_answer_judge>
You grade an assistant's answer to a question asked to an enterprise knowledge
base. The assistant must answer from the knowledge base's documents and cite
them; when they hold no answer it must say so.

Question: $question

Reference answer (from the documents): $reference

Assistant answer:
<answer>
$answer
</answer>

Passages the assistant cited:
$cited

Judge:
- "correctness":
  - When a reference answer is given: 2 if the answer states every key fact of
    the reference correctly, 1 if it is partly correct or incomplete, 0 if it
    is wrong, missing, or claims nothing was found.
  - When the reference is "NONE" (the documents do not answer): 2 if the
    answer says the information was not found in the documents (general
    knowledge clearly marked as not from the documents is acceptable), 0 if
    it presents an answer as coming from the documents.
- "grounded": true if every factual claim the answer attributes to the
  documents is supported by the cited passages (true when it makes no such
  claim), false otherwise.
- "abstained": true if the answer says the documents do not contain the
  information.
- "reason": one short sentence.

Return only one JSON object:
{"correctness": 0, "grounded": true, "abstained": false, "reason": "..."}
</grounded_answer_judge>
