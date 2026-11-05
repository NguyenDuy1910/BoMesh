"""S3-compatible document storage: provider settings, bounded reads, signing.

Unit tests use a recording client. The live RustFS test runs only when
``TEST_RUSTFS_ENDPOINT_URL``, ``TEST_RUSTFS_ACCESS_KEY`` and
``TEST_RUSTFS_SECRET_KEY`` name a reachable server (``make services``).
"""

from __future__ import annotations

import os
import urllib.request
from pathlib import Path
from typing import Any
from uuid import uuid4

import pytest
from botocore.exceptions import ClientError
from bomesh.storage import (
    ObjectNotFoundError,
    ObjectStorageError,
    S3DocumentStorage,
    aws_s3,
)
from config import ObjectStorageConfig


class _PresigningS3Client:
    def __init__(self) -> None:
        self.operation = ""
        self.parameters: dict[str, Any] = {}
        self.expires_in = 0
        self.method = ""
        self.uploaded_body: bytes | None = None

    def generate_presigned_url(
        self,
        operation: str,
        *,
        Params: dict[str, str],
        ExpiresIn: int,
        HttpMethod: str,
    ) -> str:
        self.operation = operation
        self.parameters = Params
        self.expires_in = ExpiresIn
        self.method = HttpMethod
        return "https://documents.s3.amazonaws.com/users/user-1/documents/id/raw?signed=1"

    def put_object(self, **kwargs: Any) -> dict[str, str]:
        self.operation = "put_object"
        self.parameters = kwargs
        body = kwargs.get("Body")
        if hasattr(body, "read"):
            self.uploaded_body = body.read()
        return {"ETag": '"etag-1"'}


def _capture_session(
    monkeypatch: pytest.MonkeyPatch, client: object
) -> dict[str, Any]:
    captured: dict[str, Any] = {}

    class _Session:
        def __init__(self, **kwargs: str | None) -> None:
            captured["session_kwargs"] = kwargs

        def client(self, service: str, **kwargs: Any) -> object:
            captured["service"] = service
            captured["client_kwargs"] = kwargs
            return client

    monkeypatch.setattr(aws_s3.boto3, "Session", _Session)
    return captured


def test_s3_presigned_put_is_scoped_and_bounded() -> None:
    client = _PresigningS3Client()
    storage = S3DocumentStorage(bucket="documents", client=client)

    request = storage.presign_upload(
        "users/user 1/documents/id/raw",
        content_type="application/pdf",
        expires_seconds=600,
    )
    assert request.method == "PUT"
    assert request.headers == {"Content-Type": "application/pdf"}
    assert client.operation == "put_object"
    assert client.parameters == {
        "Bucket": "documents",
        "Key": "users/user 1/documents/id/raw",
        "ContentType": "application/pdf",
    }
    assert client.expires_in == 600
    assert client.method == "PUT"


def test_s3_put_bytes_records_object_metadata() -> None:
    client = _PresigningS3Client()
    storage = S3DocumentStorage(bucket="documents", client=client)

    stored = storage.put_bytes(
        b"raw document",
        "files/document-1/report.txt",
        content_type="text/plain",
    )

    assert client.parameters == {
        "Bucket": "documents",
        "Key": "files/document-1/report.txt",
        "Body": b"raw document",
        "ContentType": "text/plain",
    }
    assert stored.size_bytes == len(b"raw document")
    assert stored.content_type == "text/plain"
    assert stored.etag == "etag-1"


def test_s3_put_path_streams_from_a_file(tmp_path: Path) -> None:
    path = tmp_path / "report.txt"
    path.write_bytes(b"raw document")
    client = _PresigningS3Client()
    storage = S3DocumentStorage(bucket="documents", client=client)

    stored = storage.put_path(path, "files/document-1/report.txt", content_type="text/plain")

    assert client.uploaded_body == b"raw document"
    assert stored.size_bytes == len(b"raw document")


def test_aws_s3_keeps_the_standard_credential_chain(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured = _capture_session(monkeypatch, _PresigningS3Client())

    storage = S3DocumentStorage(bucket="documents", region="ap-southeast-1")

    assert storage.provider == "aws_s3"
    assert captured["session_kwargs"] == {"region_name": "ap-southeast-1"}
    assert captured["client_kwargs"]["endpoint_url"] is None
    assert captured["client_kwargs"]["config"].s3 == {"addressing_style": "auto"}


def test_signed_urls_name_storage_as_the_client_reaches_it() -> None:
    # Real boto3: signing makes no request. A phone cannot reach the backend's
    # loopback storage address, so URLs it receives must name the public host.
    storage = S3DocumentStorage(
        bucket="documents",
        provider="rustfs",
        endpoint_url="http://127.0.0.1:9000",
        public_endpoint_url="http://10.0.0.5:9000",
        access_key_id="key",
        secret_access_key="secret",
    )

    download = storage.presign_download("documents/id/page-0001.webp", expires_seconds=60)
    upload = storage.presign_upload(
        "documents/id/raw", content_type="application/pdf", expires_seconds=60
    )

    assert download.url.startswith("http://10.0.0.5:9000/documents/documents/id/page-0001.webp?")
    assert upload.url.startswith("http://10.0.0.5:9000/documents/documents/id/raw?")
    assert "%2Fus-east-1%2Fs3%2Faws4_request" in download.url
    unconfigured = S3DocumentStorage(
        bucket="documents",
        provider="rustfs",
        endpoint_url="http://127.0.0.1:9000",
        access_key_id="key",
        secret_access_key="secret",
    )
    assert unconfigured.presign_download("k", expires_seconds=60).url.startswith(
        "http://127.0.0.1:9000/documents/k?"
    )


def test_cloudflare_r2_signs_with_auto_region_and_path_style(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured = _capture_session(monkeypatch, _PresigningS3Client())

    storage = S3DocumentStorage.for_cloudflare_r2(
        bucket="documents",
        account_id="account-id",
        access_key_id="r2-access-key",
        secret_access_key="r2-secret-key",
    )

    assert storage.provider == "cloudflare_r2"
    assert captured["session_kwargs"] == {
        "region_name": "auto",
        "aws_access_key_id": "r2-access-key",
        "aws_secret_access_key": "r2-secret-key",
    }
    assert captured["client_kwargs"]["endpoint_url"] == (
        "https://account-id.r2.cloudflarestorage.com"
    )
    assert captured["client_kwargs"]["config"].s3 == {"addressing_style": "path"}


def test_rustfs_signs_with_its_keys_us_east_1_and_path_style(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured = _capture_session(monkeypatch, _PresigningS3Client())

    storage = S3DocumentStorage(
        bucket="documents",
        provider="RustFS",
        endpoint_url="http://rustfs:9000",
        access_key_id="rustfs-access",
        secret_access_key="rustfs-secret",
    )

    assert storage.provider == "rustfs"
    assert captured["session_kwargs"] == {
        "region_name": "us-east-1",
        "aws_access_key_id": "rustfs-access",
        "aws_secret_access_key": "rustfs-secret",
    }
    assert captured["client_kwargs"]["endpoint_url"] == "http://rustfs:9000"
    assert captured["client_kwargs"]["config"].signature_version == "s3v4"
    assert captured["client_kwargs"]["config"].s3 == {"addressing_style": "path"}


@pytest.mark.parametrize(
    ("arguments", "message"),
    [
        ({}, "RustFS requires an endpoint URL"),
        (
            {"endpoint_url": "http://rustfs:9000", "addressing_style": "virtual"},
            "RustFS requires path-style addressing",
        ),
    ],
)
def test_rustfs_rejects_settings_it_cannot_serve(
    arguments: dict[str, str], message: str
) -> None:
    with pytest.raises(ValueError, match=message):
        S3DocumentStorage(bucket="documents", provider="rustfs", **arguments)


def test_rustfs_configuration_shares_the_server_credentials(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    for name in ("BOMESH_S3_ADDRESSING_STYLE", "BOMESH_S3_BUCKET", "BOMESH_S3_REGION"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("BOMESH_OBJECT_STORAGE_PROVIDER", "rustfs")
    monkeypatch.setenv("BOMESH_OBJECT_STORAGE_BUCKET", "bomesh")
    monkeypatch.setenv("BOMESH_S3_ENDPOINT_URL", "http://127.0.0.1:9000")
    monkeypatch.setenv("RUSTFS_ACCESS_KEY", "rustfs-access")
    monkeypatch.setenv("RUSTFS_SECRET_KEY", "rustfs-secret")
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "unrelated-aws-key")

    config = ObjectStorageConfig.from_environment()

    assert config.provider == "rustfs"
    assert config.require_bucket() == "bomesh"
    assert config.addressing_style == "path"
    assert (config.access_key_id, config.secret_access_key) == (
        "rustfs-access",
        "rustfs-secret",
    )

    monkeypatch.delenv("RUSTFS_SECRET_KEY")
    with pytest.raises(RuntimeError, match="RUSTFS_SECRET_KEY"):
        ObjectStorageConfig.from_environment().require_bucket()


def test_aws_s3_configuration_ignores_rustfs_credentials(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("BOMESH_OBJECT_STORAGE_PROVIDER", "aws_s3")
    monkeypatch.setenv("RUSTFS_ACCESS_KEY", "rustfs-access")
    monkeypatch.setenv("RUSTFS_SECRET_KEY", "rustfs-secret")
    monkeypatch.delenv("BOMESH_S3_ADDRESSING_STYLE", raising=False)

    config = ObjectStorageConfig.from_environment()

    assert config.access_key_id is None
    assert config.secret_access_key is None
    assert config.addressing_style == "auto"


class _S3Body:
    def __init__(self, content: bytes) -> None:
        self._content = content
        self.position = 0
        self.closed = False

    def read(self, limit: int) -> bytes:
        block = self._content[self.position : self.position + limit]
        self.position += len(block)
        return block

    def close(self) -> None:
        self.closed = True


class _ReadingS3Client:
    """Serves GET only: a HEAD round trip would fail the test."""

    def __init__(self, content: bytes, *, content_length: int | None = None) -> None:
        self.body = _S3Body(content)
        self.content_length = len(content) if content_length is None else content_length
        self.get_calls = 0

    def get_object(self, **kwargs: str) -> dict[str, Any]:
        self.get_calls += 1
        return {
            "Body": self.body,
            "ContentLength": self.content_length,
            "ContentType": "application/pdf",
            "ETag": '"etag-1"',
        }


class _DeletingS3Client:
    def __init__(self, error_code: str | None = None) -> None:
        self.deleted: list[dict[str, str]] = []
        self.error_code = error_code

    def delete_object(self, **kwargs: str) -> dict[str, Any]:
        if self.error_code is not None:
            raise ClientError({"Error": {"Code": self.error_code}}, "DeleteObject")
        self.deleted.append(kwargs)
        return {}


@pytest.mark.asyncio
async def test_s3_delete_removes_the_normalized_key() -> None:
    client = _DeletingS3Client()
    storage = S3DocumentStorage(bucket="documents", client=client)

    await storage.delete("/tenants/t/items/i/raw")

    assert client.deleted == [{"Bucket": "documents", "Key": "tenants/t/items/i/raw"}]


@pytest.mark.asyncio
async def test_s3_delete_of_a_missing_key_is_not_an_error() -> None:
    storage = S3DocumentStorage(bucket="documents", client=_DeletingS3Client("NoSuchKey"))

    await storage.delete("tenants/t/items/i/raw")


@pytest.mark.asyncio
async def test_s3_delete_reports_other_failures() -> None:
    storage = S3DocumentStorage(bucket="documents", client=_DeletingS3Client("AccessDenied"))

    with pytest.raises(ObjectStorageError, match="delete failed"):
        await storage.delete("tenants/t/items/i/raw")


@pytest.mark.asyncio
async def test_s3_read_rejects_oversized_objects_without_reading_the_body() -> None:
    client = _ReadingS3Client(b"four")
    storage = S3DocumentStorage(bucket="documents", client=client)

    with pytest.raises(ObjectStorageError, match="read limit"):
        await storage.read("documents/id/raw", max_bytes=3)

    assert client.body.position == 0
    assert client.body.closed is True


@pytest.mark.asyncio
async def test_s3_read_uses_one_get_and_closes_the_stream() -> None:
    client = _ReadingS3Client(b"content")
    storage = S3DocumentStorage(bucket="documents", client=client)

    content = await storage.read("documents/id/raw", max_bytes=7)

    assert content == b"content"
    assert client.get_calls == 1
    assert client.body.closed is True


@pytest.mark.asyncio
async def test_s3_download_to_path_streams_with_get_metadata(tmp_path: Path) -> None:
    client = _ReadingS3Client(b"streamed content")
    storage = S3DocumentStorage(bucket="documents", client=client)
    destination = tmp_path / "downloaded.bin"

    stored = await storage.download_to_path("documents/id/raw", destination, max_bytes=100)

    assert destination.read_bytes() == b"streamed content"
    assert stored.size_bytes == len(b"streamed content")
    assert (stored.content_type, stored.etag) == ("application/pdf", "etag-1")
    assert client.get_calls == 1
    assert client.body.closed is True


@pytest.mark.asyncio
async def test_s3_download_to_path_rejects_a_truncated_body(tmp_path: Path) -> None:
    client = _ReadingS3Client(b"short", content_length=10)
    storage = S3DocumentStorage(bucket="documents", client=client)

    with pytest.raises(ObjectStorageError, match="size changed"):
        await storage.download_to_path("documents/id/raw", tmp_path / "out", max_bytes=100)


_LIVE_RUSTFS = {
    name: os.getenv(name)
    for name in (
        "TEST_RUSTFS_ENDPOINT_URL",
        "TEST_RUSTFS_ACCESS_KEY",
        "TEST_RUSTFS_SECRET_KEY",
    )
}


@pytest.mark.asyncio
@pytest.mark.skipif(
    not all(_LIVE_RUSTFS.values()), reason="TEST_RUSTFS_* names no RustFS server"
)
async def test_live_rustfs_round_trip(tmp_path: Path) -> None:
    storage = S3DocumentStorage(
        bucket=os.getenv("TEST_RUSTFS_BUCKET", "bomesh"),
        provider="rustfs",
        endpoint_url=_LIVE_RUSTFS["TEST_RUSTFS_ENDPOINT_URL"],
        access_key_id=_LIVE_RUSTFS["TEST_RUSTFS_ACCESS_KEY"],
        secret_access_key=_LIVE_RUSTFS["TEST_RUSTFS_SECRET_KEY"],
    )
    prefix = f"tests/{uuid4()}"
    source = tmp_path / "source.pdf"
    source.write_bytes(b"%PDF-1.7 " + b"x" * (3 * 1024 * 1024))
    try:
        written = storage.put_path(source, f"{prefix}/raw", content_type="application/pdf")
        head = await storage.head(f"{prefix}/raw")
        assert (head.size_bytes, head.content_type, head.etag) == (
            written.size_bytes,
            "application/pdf",
            written.etag,
        )
        downloaded = await storage.download_to_path(
            f"{prefix}/raw", tmp_path / "copy.pdf", max_bytes=written.size_bytes
        )
        assert (tmp_path / "copy.pdf").read_bytes() == source.read_bytes()
        assert downloaded.etag == written.etag
        with pytest.raises(ObjectStorageError, match="read limit"):
            await storage.read(f"{prefix}/raw", max_bytes=1024)
        with pytest.raises(ObjectNotFoundError):
            await storage.head(f"{prefix}/missing")

        # Browsers fetch originals and preview pages by byte range.
        ranged = urllib.request.Request(
            storage.presign_download(f"{prefix}/raw", expires_seconds=60).url,
            headers={"Range": "bytes=0-7"},
        )
        with urllib.request.urlopen(ranged) as response:
            assert (response.status, response.read()) == (206, b"%PDF-1.7")

        upload = storage.presign_upload(
            f"{prefix}/upload", content_type="text/plain", expires_seconds=60
        )
        put = urllib.request.Request(
            upload.url, data=b"browser upload", method="PUT", headers=dict(upload.headers)
        )
        with urllib.request.urlopen(put) as response:
            assert response.status == 200
        assert await storage.read(f"{prefix}/upload", max_bytes=100) == b"browser upload"

        # The bucket is private: an unsigned read is refused.
        anonymous = f"{_LIVE_RUSTFS['TEST_RUSTFS_ENDPOINT_URL']}/{storage.bucket}/{prefix}/raw"
        with pytest.raises(urllib.error.HTTPError) as refused:
            urllib.request.urlopen(anonymous)
        assert refused.value.code == 403
    finally:
        # Test-owned objects only; product storage never deletes originals.
        for key in (f"{prefix}/raw", f"{prefix}/upload"):
            storage._client.delete_object(Bucket=storage.bucket, Key=key)
        await storage.aclose()
