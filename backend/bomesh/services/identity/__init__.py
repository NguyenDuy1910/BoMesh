"""Identity services (``api_design.md`` §3, ``auth_contract.md``).

Services, one per resource: :class:`~.users.UserService` (``users``),
:class:`~.preferences.UserPreferencesService` (``users/{user}/preferences``),
:class:`~.sessions.SessionService` (``sessions``) and
:class:`~.password_reset.PasswordResetService`. Authentication building blocks:
:mod:`.auth` (credential checks), :mod:`.access_session` and :mod:`.jwt_tokens`
(bearer sessions), :mod:`.identity_store`, :mod:`.passwords`, :mod:`.google`,
:mod:`.reset_tokens` and :mod:`.password_reset_mail`.

Cross-domain API (:mod:`.directory`; run in the caller's session, never authorize):

- ``await get_user_record(session, user_id) -> UserRecord`` (NOT_FOUND if absent)
- ``await get_user_records(session, user_ids) -> dict[UUID, UserRecord]``
- ``await lookup_user(session, email) -> UserRecord | None`` (exact, case-insensitive)
- ``display_name(user: User | UserRecord) -> str`` and
  ``await display_names(session, user_ids) -> dict[UUID, str]``: display name,
  else username, else email.
"""
