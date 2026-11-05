"""Issue and verify the HS256 bearer token of an access session.

A token names one session and its user, never a workspace, role or
permission: authority is resolved per request (``auth_contract.md``).
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import json
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import NoReturn
from uuid import UUID, uuid4

from bomesh.errors import Unauthenticated

_HEADER = {"alg": "HS256", "typ": "JWT"}


@dataclass(frozen=True, slots=True)
class AccessTokenClaims:
    """Verified claims; trusted only once the session row confirms them."""

    session_id: UUID
    user_id: UUID
    token_version: int
    issued_at: datetime
    expires_at: datetime


class JwtTokenService:
    """Own the signing secret; callers only issue and verify."""

    def __init__(
        self,
        *,
        secret: str | None,
        issuer: str,
        audience: str,
        expires_in_seconds: int,
    ) -> None:
        self._secret = secret.encode("utf-8") if secret else None
        self._issuer = issuer
        self._audience = audience
        self._expires_in_seconds = expires_in_seconds

    @property
    def expires_in_seconds(self) -> int:
        return self._expires_in_seconds

    def issue(
        self,
        *,
        session_id: UUID,
        user_id: UUID,
        token_version: int,
        expires_at: datetime,
    ) -> str:
        """Sign a token for one live access session, expiring with it."""
        secret = self._secret_or_error()
        payload = {
            "iss": self._issuer,
            "aud": self._audience,
            "sub": f"session:{session_id}",
            "session_id": str(session_id),
            "user_id": str(user_id),
            "token_version": token_version,
            "iat": int(time.time()),
            "exp": int(expires_at.timestamp()),
            "jti": str(uuid4()),
        }
        signing_input = f"{_encode_json(_HEADER)}.{_encode_json(payload)}"
        signature = hmac.new(secret, signing_input.encode("ascii"), hashlib.sha256).digest()
        return f"{signing_input}.{_encode_segment(signature)}"

    def verify(self, token: str) -> AccessTokenClaims:
        """Check signature, issuer, audience and expiry; UNAUTHENTICATED otherwise."""
        secret = self._secret_or_error()
        parts = token.split(".")
        if len(parts) != 3 or not all(parts):
            raise Unauthenticated("The access token is malformed.")
        encoded_header, encoded_payload, encoded_signature = parts
        try:
            header = _decode_json(encoded_header)
            payload = _decode_json(encoded_payload)
            signature = _decode_segment(encoded_signature)
        except (UnicodeDecodeError, ValueError, binascii.Error) as exc:
            raise Unauthenticated("The access token is malformed.") from exc
        if header != _HEADER:
            raise Unauthenticated("The access token uses an unsupported algorithm.")
        expected = hmac.new(
            secret, f"{encoded_header}.{encoded_payload}".encode("ascii"), hashlib.sha256
        ).digest()
        if not hmac.compare_digest(signature, expected):
            raise Unauthenticated("The access token signature is invalid.")
        return _claims(payload, issuer=self._issuer, audience=self._audience)

    def _secret_or_error(self) -> bytes:
        if self._secret is None or len(self._secret) < 32:
            raise RuntimeError("BOMESH_AUTH_JWT_SECRET must contain at least 32 bytes")
        return self._secret


def _claims(payload: dict[str, object], *, issuer: str, audience: str) -> AccessTokenClaims:
    if payload.get("iss") != issuer or payload.get("aud") != audience:
        raise Unauthenticated("The access token issuer or audience is invalid.")
    session_id = _uuid_claim(payload, "session_id")
    user_id = _uuid_claim(payload, "user_id")
    if payload.get("sub") != f"session:{session_id}":
        raise Unauthenticated("The access token subject is invalid.")
    token_version = _int_claim(payload, "token_version")
    issued_at = _int_claim(payload, "iat")
    expires_at = _int_claim(payload, "exp")
    now = int(time.time())
    if token_version < 1 or issued_at > now + 60 or expires_at <= issued_at:
        raise Unauthenticated("The access token claims are invalid.")
    if expires_at <= now:
        raise Unauthenticated("The access token has expired.")
    return AccessTokenClaims(
        session_id=session_id,
        user_id=user_id,
        token_version=token_version,
        issued_at=datetime.fromtimestamp(issued_at, UTC),
        expires_at=datetime.fromtimestamp(expires_at, UTC),
    )


def _uuid_claim(payload: dict[str, object], name: str) -> UUID:
    value = payload.get(name)
    try:
        return UUID(value) if isinstance(value, str) else _invalid(name)
    except ValueError:
        return _invalid(name)


def _int_claim(payload: dict[str, object], name: str) -> int:
    value = payload.get(name)
    if isinstance(value, bool) or not isinstance(value, int):
        return _invalid(name)
    return value


def _invalid(name: str) -> NoReturn:
    raise Unauthenticated(f"The access token claim '{name}' is invalid.")


def _encode_json(value: dict[str, object]) -> str:
    return _encode_segment(json.dumps(value, separators=(",", ":"), sort_keys=True).encode())


def _encode_segment(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def _decode_json(value: str) -> dict[str, object]:
    decoded = json.loads(_decode_segment(value).decode("utf-8"))
    if not isinstance(decoded, dict):
        raise ValueError("JWT segment must contain an object")
    return decoded


def _decode_segment(value: str) -> bytes:
    padding = "=" * (-len(value) % 4)
    return base64.b64decode(value + padding, altchars=b"-_", validate=True)


__all__ = ["AccessTokenClaims", "JwtTokenService"]
