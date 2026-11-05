"""Assistant interface, conversation part (``api_design.md`` §7, ``conversation_loop.md``).

Services, one per resource (built with ``from_runtime``):
:class:`~.conversations.ConversationResourceService` (conversations and
``:converse``), :class:`~.messages.MessageService` (messages and feedback),
:class:`~.shares.ShareService`. The turn engine: :mod:`.chat` runs one
agent turn, :mod:`.turn_store` persists turns, :mod:`.sandbox_session` keeps a
conversation's sandbox state.

Cross-domain API (no permission checks; session-taking functions run in the
caller's session):

- names (:mod:`.references`, :mod:`.records`): ``parse_conversation_name``,
  ``parse_message_name``, ``conversation_name``, ``message_name``;
- conversations (:mod:`.references`): ``own_conversation_id``,
  ``conversation_codes``, ``conversation_id_by_code`` (SQL);
- messages: ``source_message_context`` (a caller-owned message's text and
  ``StoredCitation`` list);
- citations (:mod:`.citations`): ``render_citations`` / ``readable_summaries`` +
  ``citation_record`` (per-reader re-check), ``unreadable_items``
  (``AUDIENCE_CANNOT_READ_SOURCES``);
- :mod:`.queries`: SQL builders over conversation tables.
"""
