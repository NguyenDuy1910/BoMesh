"""Authenticated encryption for persisted Integration Connection credentials."""

from __future__ import annotations

import base64
import json
import os
from collections.abc import Mapping
from datetime import datetime
from typing import Any
from uuid import UUID

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from bomesh.db.models import IntegrationCredential
from bomesh.identity import PERSISTED_IDENTITY_NAMESPACE
from bomesh.services import ControlPlaneValidationError

#: Written in place of a secret that was revoked. An empty envelope decrypts to
#: nothing, so every reader treats it as "no credential is configured".
CLEARED_PAYLOAD = ""


class IntegrationCredentialService:
    """Encrypt and decrypt secrets with Connection-bound associated data."""

    def __init__(self, session: AsyncSession, encryption_key: str) -> None:
        self._session = session
        self._key = self._decode_key(encryption_key)

    async def store(
        self,
        integration_connection_id: UUID,
        *,
        credential_type: str,
        payload: Mapping[str, Any],
        expires_at: datetime | None = None,
        key_version: str | None = None,
    ) -> IntegrationCredential:
        normalized_type = credential_type.strip().casefold()
        if not normalized_type or len(normalized_type) > 64:
            raise ControlPlaneValidationError("credential type is invalid")
        encoded = json.dumps(
            dict(payload), sort_keys=True, separators=(",", ":")
        ).encode("utf-8")
        if encoded == b"{}":
            raise ControlPlaneValidationError("integration credentials must not be empty")
        nonce = os.urandom(12)
        encrypted = AESGCM(self._key).encrypt(
            nonce, encoded, self._associated_data(integration_connection_id)
        )
        envelope = base64.urlsafe_b64encode(nonce + encrypted).decode("ascii")
        record = await self._session.scalar(
            select(IntegrationCredential)
            .where(IntegrationCredential.integration_connection_id == integration_connection_id)
            .with_for_update()
        )
        if record is None:
            record = IntegrationCredential(
                integration_connection_id=integration_connection_id,
                credential_type=normalized_type,
                encrypted_payload=envelope,
                expires_at=expires_at,
                key_version=key_version,
            )
            self._session.add(record)
        else:
            record.credential_type = normalized_type
            record.encrypted_payload = envelope
            record.expires_at = expires_at
            record.key_version = key_version
        await self._session.flush()
        return record

    async def clear(self, integration_connection_id: UUID) -> None:
        """Destroy one connection's secret while keeping the record of it.

        Disconnecting must leave no usable token behind, so the ciphertext is
        overwritten rather than tombstoned — a row that still holds a decryptable
        grant is not revoked in any sense that matters. The record itself stays,
        because when a credential was cleared is audit history, and because the
        Connection and its sources stay so reconnecting resumes them.
        """

        record = await self._session.scalar(
            select(IntegrationCredential)
            .where(
                IntegrationCredential.integration_connection_id
                == integration_connection_id
            )
            .with_for_update()
        )
        if record is None:
            return
        record.encrypted_payload = CLEARED_PAYLOAD
        record.expires_at = None
        record.key_version = None
        await self._session.flush()

    async def resolve(self, integration_connection_id: UUID) -> dict[str, Any]:
        record = await self._session.scalar(
            select(IntegrationCredential).where(
                IntegrationCredential.integration_connection_id == integration_connection_id
            )
        )
        if record is None or record.encrypted_payload == CLEARED_PAYLOAD:
            raise LookupError("integration credentials are not configured")
        try:
            envelope = base64.urlsafe_b64decode(record.encrypted_payload.encode("ascii"))
            nonce, ciphertext = envelope[:12], envelope[12:]
            plaintext = AESGCM(self._key).decrypt(
                nonce, ciphertext, self._associated_data(integration_connection_id)
            )
            payload = json.loads(plaintext)
        except Exception as exc:
            raise RuntimeError("integration credentials could not be decrypted") from exc
        if not isinstance(payload, dict):
            raise RuntimeError("integration credential payload is invalid")
        return payload

    @staticmethod
    def _decode_key(value: str) -> bytes:
        normalized = value.strip()
        if not normalized:
            raise RuntimeError("BOMESH_INTEGRATION_ENCRYPTION_KEY is required")
        padded = normalized + "=" * (-len(normalized) % 4)
        try:
            key = base64.b64decode(
                padded.encode("ascii"),
                altchars=b"-_",
                validate=True,
            )
        except Exception as exc:
            raise RuntimeError(
                "BOMESH_INTEGRATION_ENCRYPTION_KEY must be URL-safe base64"
            ) from exc
        if len(key) != 32:
            raise RuntimeError(
                "BOMESH_INTEGRATION_ENCRYPTION_KEY must decode to exactly 32 bytes"
            )
        return key

    @staticmethod
    def _associated_data(integration_connection_id: UUID) -> bytes:
        # Associated data is part of every stored ciphertext: it keeps the
        # persisted namespace (see ``bomesh.identity``), whatever the product
        # is called, or credentials encrypted before a rename become unreadable.
        return (
            f"{PERSISTED_IDENTITY_NAMESPACE}:plugin-credential:{integration_connection_id}"
        ).encode("ascii")


__all__ = ["CLEARED_PAYLOAD", "IntegrationCredentialService"]
