"""Delivery of password-reset emails (``auth_contract.md`` § Password reset).

The deployment has no mail transport configured yet, so the runtime uses
:class:`UnconfiguredPasswordResetMailer`. A real adapter implements
:class:`PasswordResetMailer`, builds the reset link from the token and queues
delivery; it must never log the token and never raise for an undeliverable
address, because SendPasswordReset answers the same whether or not an account
exists.
"""

from __future__ import annotations

from datetime import datetime
from typing import Protocol


class PasswordResetMailer(Protocol):
    """Send one reset email carrying a single-use token."""

    async def send_password_reset(
        self, *, email: str, reset_token: str, expires_at: datetime
    ) -> None: ...


class UnconfiguredPasswordResetMailer:
    """Sends nothing: no mail transport is configured in this deployment."""

    async def send_password_reset(
        self, *, email: str, reset_token: str, expires_at: datetime
    ) -> None:
        return None


__all__ = ["PasswordResetMailer", "UnconfiguredPasswordResetMailer"]
