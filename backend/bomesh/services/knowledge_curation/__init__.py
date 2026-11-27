"""Knowledge services, curation part: contributions.

Services (one per resource, built with ``from_runtime``):
:class:`~.contributions.ContributionService`. The workspace taxonomy lives in
:mod:`bomesh.services.taxonomy`.

Cross-domain API (no permission check beyond visibility; session-taking
functions run inside the caller's transaction):

- :func:`~.contributions.open_source_contribution` /
  :func:`~.contributions.source_revision_contribution` — REVIEW_FIRST source
  syncs (Ingestion);
- ``review_queue_statement``, ``member_contributions`` (:mod:`.contributions`) —
  Library Home;
- :func:`~.contributions.readable_contributions` — Library notifications
  (SQL, re-checked on every read);
- :func:`~.queries.in_review_contribution_ids` — Workspaces overview (a SQL builder).

Names: :func:`~.records.contribution_name` is the canonical contribution name.
"""
