"""Knowledge services, curation part: contributions, reading lists and topics.

Services (one per resource, built with ``from_runtime``):
:class:`~.contributions.ContributionService`,
:class:`~.reading_lists.ReadingListService`, :class:`~.topics.TopicService`.

Cross-domain API (no permission check beyond visibility; session-taking
functions run inside the caller's transaction):

- :func:`~.contributions.open_source_contribution` /
  :func:`~.contributions.source_revision_contribution` — REVIEW_FIRST source
  syncs (Ingestion);
- ``review_queue_count``, ``member_contributions`` (:mod:`.contributions`),
  ``topic_summaries``, ``topic_count`` (:mod:`.topics`),
  ``reading_list_summaries``, ``featured_item_ids`` (:mod:`.reading_lists`) —
  Library Home;
- :func:`~.contributions.contribution_readable` — Library notifications
  (re-checked on every read);
- :func:`~.topics.resolve_active_topics` — KnowledgeItems' ``tag_document`` validation;
- :func:`~.queries.in_review_contribution_ids` — Workspaces overview (a SQL builder).

Names: :func:`~.records.topic_name`, :func:`~.records.parse_topic` and
:func:`~.records.contribution_name` are the canonical topic and contribution names.
"""
