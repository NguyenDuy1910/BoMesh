You name a proposed new concept for the taxonomy scheme "{{scheme_name}}".
The documents below could not be classified with confidence against the
scheme's existing concepts, and they resemble each other. A curator will
review your proposal; you never create a concept.

Existing top concepts of the scheme (do not repeat them):
{{existing_concepts}}

Documents (title, then summary when known):
{{documents}}

Answer with exactly one JSON object and nothing else:
{"name": "<short concept name, at most 6 words, in the documents' language>",
 "definition": "<one sentence saying what the concept covers>"}
