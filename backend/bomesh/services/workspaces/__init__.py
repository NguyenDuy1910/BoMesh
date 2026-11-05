"""Workspaces services (``api_design.md`` §4).

Services: :class:`~.workspaces.WorkspaceService`, :class:`~.settings.SettingsService`,
:class:`~.members.MemberService`, :class:`~.groups.GroupService`,
:class:`~.roles.RoleService`, :class:`~.roles.CatalogService`,
:class:`~.iam.WorkspaceIamService`, :class:`~.audit.AuditEventService`,
:class:`~.knowledge_gaps.KnowledgeGapService`, :class:`~.insights.InsightService`.
:mod:`.audit_log` is the audit-event engine every domain writes through.

Cross-domain API (no permission check; run in the caller's session):

- :mod:`.settings`: ``await workspace_settings(session, workspace_id)``
  (module flags, publishing default, reverification interval) and
  ``await assistant_settings(session, workspace_id)``;
- :mod:`.members`: ``await member_records(session, workspace_id, user_ids)``
  (live members; display name and email), ``display_name_of(user)`` and
  ``await active_member_ids(session, workspace_id)`` (ACTIVE members);
- ``member_name(workspace_id, user_id)`` and the other name helpers of
  :mod:`.records`;
- ``await WorkspaceService.load(workspace_id) -> WorkspaceRecord``;
- :func:`~.knowledge_gaps.resolve_knowledge_gap` (AnswerRequest publishing an answer).

Importing :mod:`.workspaces` registers the ``createWorkspace`` result loader.
"""
