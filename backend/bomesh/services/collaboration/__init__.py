"""Collaboration services (``api_design.md`` §8).

Services, one per resource: :class:`~.spaces.SpaceService`,
:class:`~.members.SpaceMemberService`, :class:`~.space_content.MaterialService`,
:class:`~.space_content.AnnouncementService`, :class:`~.space_content.SpaceEventService`,
:class:`~.request_types.RequestTypeService`, :class:`~.requests.RequestService`
and :class:`~.request_messages.RequestMessageService`.

Cross-domain API (no permission check; run in the caller's session):

- :mod:`.membership`: ``await space_member_ids(session, workspace_id, space_id)``,
  ``await is_space_member(session, workspace_id, space_id, user_id)``,
  ``await member_space_ids(session, workspace_id, user_id)``,
  ``await space_id_for_code(session, workspace_id, code)`` (live),
  ``await space_codes(session, space_ids)`` (deleted included) and
  ``space_id_by_code(workspace_id, code)`` (SQL scalar subquery);
- :func:`~.requests.request_readable` (GetRequest's read rule, for notification
  re-checks);
- :func:`~.support.parse_space_name` and :func:`~.records.space_name`;
- :mod:`.queries`: SQL builders over Collaboration's tables.
"""
