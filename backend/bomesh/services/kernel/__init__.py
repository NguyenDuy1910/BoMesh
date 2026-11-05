"""Shared plumbing every domain's services build on.

- :mod:`.context` ``RequestContext``: the caller (principal, authorizer, request metadata).
- :mod:`.workspaces` ``WorkspaceResolver``, ``require_usable``, ``require_module``:
  the workspace a request names, its state and module rules.
- :mod:`.idempotency` ``Idempotency``: AIP-155 ``requestId`` in the write's transaction.
- :mod:`.audit` ``Audit``: one audit event per write.
- :mod:`.operations` ``Operations``: long-running operation rows.
- :mod:`.notifications` ``NotificationPublisher``: notifications only for readers of the subject.
- :mod:`.listing` ``ListQuery``: a parsed AIP list request applied to a select.
- :mod:`.retention`: the soft-delete retention window.
"""
