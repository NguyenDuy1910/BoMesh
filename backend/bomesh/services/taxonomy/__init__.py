"""The faceted (SKOS) taxonomy: normalization, published snapshots and closure.

Labels and metadata of Documents: :mod:`.assignments` (``item_concepts``,
``item_classifications``) and :mod:`.profiles` (``document_profiles``,
``document_applicability``, ``document_supersessions``). Import them from
their modules: they depend on the classification engine and curation access,
which would make eager package imports circular.

The query side: :mod:`.query` (label index and query interpretation),
:mod:`.ranking` (facet matching, applicability, boosts; SearchItems and agent
retrieval), :mod:`.retrieval` (the agent retriever's ranking), :mod:`.authority`
(org-unit/program schemes). Import them from their modules too.

Management (``api_design.md`` ConceptScheme and Concept): :mod:`.schemes`, :mod:`.concepts`,
:mod:`.groups`, :mod:`.rules`, :mod:`.proposals`, :mod:`.shared_labels`,
:mod:`.imports`, :mod:`.export`, :mod:`.templates` (fork diff/apply),
:mod:`.publish` (versions; the pure :mod:`.validation` and :mod:`.changes`),
resource names in :mod:`.names`. Import them from their modules as well.
"""
