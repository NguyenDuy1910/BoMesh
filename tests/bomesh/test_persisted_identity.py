"""Identities BoMesh derives are stored, so they must not change with its name.

Each expected value below was produced before the product was renamed and is
held by real rows: a different value means existing users lose their files,
connector syncs duplicate every document, or stored credentials stop
decrypting.
"""

from __future__ import annotations

import base64
import json
import os
from types import SimpleNamespace
from uuid import UUID

import pytest
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from bomesh.services.ingestion.credentials import IntegrationCredentialService
from bomesh.services.knowledge_items.item_store import artifact_collection_id, personal_collection_id

TENANT = UUID("00000000-0000-0000-0000-000000000001")
USER = UUID("d9dd5362-b584-45c7-8120-dcace0f36dfd")


def test_a_users_personal_collection_keeps_its_id() -> None:
    assert personal_collection_id(TENANT, USER) == UUID(
        "a50ad8ae-338f-579a-8524-26de818ee71d"
    )


def test_derived_identities_keep_the_original_namespace() -> None:
    # Values computed from the pre-rename "bothesis:" names.
    from uuid import NAMESPACE_URL, uuid5

    assert artifact_collection_id(TENANT, USER) == uuid5(
        NAMESPACE_URL, f"bothesis:artifact-collection:{TENANT}:{USER}"
    )


@pytest.mark.asyncio
async def test_a_credential_stored_before_the_rename_still_decrypts() -> None:
    key = AESGCM.generate_key(bit_length=256)
    connection = UUID("22222222-2222-2222-2222-222222222222")
    nonce = os.urandom(12)
    sealed = AESGCM(key).encrypt(
        nonce,
        json.dumps({"token": "secret"}).encode(),
        f"bothesis:plugin-credential:{connection}".encode("ascii"),
    )
    record = SimpleNamespace(
        encrypted_payload=base64.urlsafe_b64encode(nonce + sealed).decode("ascii")
    )

    class _Session:
        async def scalar(self, _statement: object) -> object:
            return record

    service = IntegrationCredentialService(
        _Session(),  # type: ignore[arg-type]
        base64.urlsafe_b64encode(key).decode("ascii"),
    )
    assert await service.resolve(connection) == {"token": "secret"}
