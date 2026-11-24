"""Knowledge services, curation part: contributions, topics and topic corrections.

Services (one per resource, built with ``from_runtime``):
:class:`~.contributions.ContributionService`, :class:`~.topics.TopicService`,
:class:`~.topic_assignments.TopicAssignmentService` (ConfirmTopicAssignments,
TopicCorrections).

Cross-domain API (no permission check beyond visibility; session-taking
functions run inside the caller's transaction):

- :func:`~.contributions.open_source_contribution` /
  :func:`~.contributions.source_revision_contribution` — REVIEW_FIRST source
  syncs (Ingestion);
- ``review_queue_statement``, ``member_contributions`` (:mod:`.contributions`),
  ``topic_summaries``, ``topic_count_statement`` (:mod:`.topics`) — Library Home;
- :func:`~.contributions.readable_contributions` — Library notifications
  (SQL, re-checked on every read);
- :func:`~.topics.resolve_active_topics` — KnowledgeItems' ``tag_document`` validation;
- :func:`~.topic_assignments.assistant_topic_ids` /
  :func:`~.topic_assignments.record_topic_correction` — KnowledgeItems' UpdateItem
  ``document.topics`` records a TopicCorrection;
- :func:`~.queries.in_review_contribution_ids` — Workspaces overview (a SQL builder).

Names: :func:`~.records.topic_name`, :func:`~.records.parse_topic` and
:func:`~.records.contribution_name` are the canonical topic and contribution names.
"""
