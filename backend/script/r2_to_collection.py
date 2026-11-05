#!/usr/bin/env python3
"""Load the crawled R2 corpus into one workspace collection, file by file.

``ute_lib.py`` mirrors website files into R2 under ``R2_PREFIX``. This script
creates one KNOWLEDGE document Item per object under a COLLECTION Item through
the media upload (``CreateItemMedia``,
``POST /upload/api/v1/workspaces/{w}/items``, multipart ``metadata`` + ``file``).
Creating a document never processes it: every file lands PENDING. With
``--process`` the script then starts ONE Ingestion Run over the collection's
PENDING and OUTDATED documents (``CreateIngestionRun`` with
``selector.ancestor``), which parses, chunks, contextualizes, embeds, indexes
and cites them. No archive is built; authorization, limits and lifecycle are
the API's own.

Re-running is safe: each document's ``requestId`` (AIP-155) derives from its R2
path, so a file already created is replayed, not duplicated, and a file whose
bytes changed since is reported as a conflict (``REQUEST_ID_REUSED``).

    cd backend
    uv run python script/r2_to_collection.py --dry-run
    uv run python script/r2_to_collection.py --email admin1@gamil.com --password ...

Reads R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET and
R2_PREFIX (default ``raw``) from the root ``.env``, like ``ute_lib.py``. The
account needs ``items.create`` on the collection (workspace admin when the root
collection does not exist yet) and ``ingestionRuns.create`` for ``--process``.
``manifest.csv`` maps every R2 key to its Item and source URL; ``skipped.csv``
says why an object was left out.
"""

from __future__ import annotations

import argparse
import csv
import json
import mimetypes
import os
import sys
import threading
import time
import unicodedata
import uuid
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any
from urllib.parse import unquote

import boto3
import httpx
from botocore.config import Config
from dotenv import load_dotenv

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))
load_dotenv(BACKEND_ROOT.parent / ".env", override=False)

from bomesh.connector.file import FinxFileExtensions
from bomesh.connector.file.archive import is_archive_name
from bomesh.services import DEFAULT_MAX_UPLOAD_BYTES

_MIB = 1024 * 1024
#: The API's Document name limit.
_MAX_NAME_LENGTH = 240
_ATTEMPTS = 4
_RETRYABLE_STATUS = frozenset({429, 500, 502, 503, 504})
DEFAULT_OUTPUT = BACKEND_ROOT.parent / ".cache" / "r2-knowledge"
MANIFEST_FIELDS = [
    "r2_key", "path", "name", "size_bytes", "source_url",
    "result", "item", "error",
]


@dataclass(frozen=True, slots=True)
class SourceObject:
    key: str
    #: Decoded, NFC-normalized path below the prefix: the file's identity.
    path: str
    name: str
    size: int


@dataclass(frozen=True, slots=True)
class Skipped:
    key: str
    size: int
    reason: str


def _parse_args() -> argparse.Namespace:
    upload_limit = int(
        os.getenv("BOMESH_DOCUMENT_MAX_UPLOAD_BYTES") or DEFAULT_MAX_UPLOAD_BYTES
    )
    parser = argparse.ArgumentParser(
        description="Create one knowledge Document per R2 object in a workspace Collection."
    )
    parser.add_argument("--prefix", default=os.getenv("R2_PREFIX", "raw"))
    parser.add_argument(
        "--api",
        default=os.getenv("BOMESH_API_URL")
        or f"http://127.0.0.1:{os.getenv('BOMESH_PORT', '8000')}",
        help="API base URL (default: the local API)",
    )
    parser.add_argument("--email", default=os.getenv("BOMESH_EMAIL"))
    parser.add_argument("--password", default=os.getenv("BOMESH_PASSWORD"))
    parser.add_argument(
        "--token", default=os.getenv("BOMESH_TOKEN"), help="Bearer token instead of a password"
    )
    parser.add_argument(
        "--workspace-id",
        default=os.getenv("BOMESH_WORKSPACE"),
        help="Target workspace ID (default: BOMESH_WORKSPACE, else the caller's only workspace)",
    )
    target = parser.add_mutually_exclusive_group()
    target.add_argument("--collection-id", help="Existing COLLECTION item ID")
    target.add_argument(
        "--collection-title",
        default="UTE Knowledge",
        help="Root collection to use, created when absent (default: %(default)s)",
    )
    parser.add_argument(
        "--max-upload-mb",
        type=float,
        default=upload_limit / _MIB,
        help="Skip files above this size; defaults to the server upload limit",
    )
    parser.add_argument("--limit", type=int, help="Ingest at most this many files")
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--dry-run", action="store_true", help="Plan only; no API calls")
    parser.add_argument(
        "--process",
        action="store_true",
        help="After loading, start one Ingestion Run for the collection's pending documents",
    )
    return parser.parse_args()


# -- R2 ------------------------------------------------------------------------


def _r2_client() -> Any:
    return boto3.client(
        "s3",
        endpoint_url=f"https://{os.environ['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com",
        aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
        region_name="auto",
        config=Config(
            signature_version="s3v4",
            retries={"max_attempts": 5, "mode": "standard"},
            max_pool_connections=32,
        ),
    )


def _list_objects(client: Any, bucket: str, prefix: str) -> list[dict[str, Any]]:
    objects: list[dict[str, Any]] = []
    paginator = client.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=bucket, Prefix=prefix):
        objects.extend(page.get("Contents", []))
    return sorted(objects, key=lambda item: item["Key"])


def _relative_path(key: str, prefix: str) -> str:
    """The object's path below the prefix, decoded and NFC-normalized.

    The crawler keys objects by raw URL path, so names arrive percent-encoded
    and in more than one Unicode form; normalized, the same file under two
    spellings is recognized as one.
    """

    relative = key[len(prefix):] if key.startswith(prefix) else key
    relative = unicodedata.normalize("NFC", unquote(relative))
    parts = [part.strip() for part in relative.split("/")]
    return "/".join(part for part in parts if part not in {"", ".", ".."})


def _document_name(path: str) -> str:
    """The file name, shortened to the API limit with its extension kept."""

    name = PurePosixPath(path).name.replace("\\", "_")
    if len(name) <= _MAX_NAME_LENGTH:
        return name
    suffix = PurePosixPath(name).suffix
    return name[: _MAX_NAME_LENGTH - len(suffix)].rstrip() + suffix


def _classify(
    objects: list[dict[str, Any]], *, prefix: str, max_upload_bytes: int
) -> tuple[list[SourceObject], list[Skipped]]:
    files: list[SourceObject] = []
    skipped: list[Skipped] = []
    seen: set[str] = set()
    for item in objects:
        key, size = item["Key"], int(item["Size"])
        if key.endswith("/"):
            continue
        path = _relative_path(key, prefix)
        name = _document_name(path) if path else ""
        extension = PurePosixPath(name).suffix.casefold()
        reason = None
        if not name:
            reason = "no file name"
        elif size < 1:
            reason = "empty file"
        elif size > max_upload_bytes:
            reason = "larger than one upload"
        elif extension not in FinxFileExtensions.KNOWLEDGE_EXTENSIONS and not is_archive_name(name):
            reason = f"unsupported file type ({extension or 'no extension'})"
        elif path.casefold() in seen:
            reason = "duplicate path"
        if reason is not None:
            skipped.append(Skipped(key, size, reason))
            continue
        seen.add(path.casefold())
        files.append(SourceObject(key, path, name, size))
    return files, skipped


def _download(client: Any, bucket: str, source: SourceObject) -> tuple[bytes, str]:
    """One object's bytes, and the source URL the crawler recorded for it."""

    response = client.get_object(Bucket=bucket, Key=source.key)
    data = response["Body"].read()
    if len(data) != source.size:
        raise RuntimeError(f"read {len(data)} bytes, listed {source.size}")
    return data, unquote(response.get("Metadata", {}).get("source-url", ""))


def _content_type(file_name: str) -> str:
    """The MIME type archive expansion gives the same member."""

    if file_name.casefold().endswith((".md", ".markdown")):
        return "text/markdown"
    guessed, _ = mimetypes.guess_type(file_name, strict=False)
    return (guessed or "application/octet-stream").casefold()


def _request_id(bucket: str, path: str) -> str:
    """A stable AIP-155 ``requestId`` for one R2 file."""

    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"r2://{bucket}/{path}"))


# -- API -----------------------------------------------------------------------


class ApiError(RuntimeError):
    def __init__(self, response: httpx.Response) -> None:
        self.reason = ""
        try:
            error = response.json().get("error") or {}
            detail = error.get("message") or error
            for entry in error.get("details") or []:
                self.reason = self.reason or entry.get("reason", "")
        except (ValueError, AttributeError):
            detail = response.text[:300]
        super().__init__(f"HTTP {response.status_code}: {detail}")
        self.status_code = response.status_code


class BoMeshApi:
    """The few API methods this script needs, as one authenticated caller."""

    def __init__(self, base_url: str, *, email: str | None, password: str | None, token: str | None):
        self._http = httpx.Client(base_url=base_url.rstrip("/"), timeout=300)
        self._credentials = (email, password) if email and password else None
        self._token = token
        self._lock = threading.Lock()
        self.workspace = ""
        if self._token is None:
            if self._credentials is None:
                raise SystemExit("give --email and --password, or --token")
            self._sign_in()

    def close(self) -> None:
        self._http.close()

    def _sign_in(self) -> None:
        """``CreateSession`` with the password credential."""

        assert self._credentials is not None
        email, password = self._credentials
        response = self._http.post(
            "/api/v1/sessions",
            json={"credential": {"password": {"email": email, "password": password}}},
        )
        if response.status_code != 200:
            raise ApiError(response)
        self._token = response.json()["accessToken"]

    def request(self, method: str, url: str, **kwargs: Any) -> httpx.Response:
        """Send once, re-signing in on an expired session.

        Reads and ``requestId`` writes are also retried on transient failures;
        a plain create is not, so a retry cannot duplicate it.
        """

        retryable = method == "GET" or "requestId" in (kwargs.get("params") or {})
        attempts = _ATTEMPTS if retryable else 1
        signed_in_again = False
        attempt = 0
        while True:
            attempt += 1
            token = self._token
            try:
                response = self._http.request(
                    method, url, headers={"Authorization": f"Bearer {token}"}, **kwargs
                )
            except httpx.TransportError:
                if attempt >= attempts:
                    raise
                time.sleep(2**attempt)
                continue
            if response.status_code == 401 and self._credentials and not signed_in_again:
                with self._lock:
                    if self._token == token:
                        self._sign_in()
                signed_in_again = True
                attempt -= 1
                continue
            if response.status_code in _RETRYABLE_STATUS and attempt < attempts:
                time.sleep(float(response.headers.get("Retry-After") or 2**attempt))
                continue
            return response

    def json(self, method: str, url: str, **kwargs: Any) -> Any:
        response = self.request(method, url, **kwargs)
        if response.status_code >= 400:
            raise ApiError(response)
        return response.json()

    def use_workspace(self, workspace_id: str | None) -> None:
        """Target ``workspace_id``, else the caller's only workspace (``ListWorkspaces``)."""

        if not workspace_id:
            workspaces = self.json("GET", "/api/v1/workspaces", params={"pageSize": 2})
            names = [workspace["name"] for workspace in workspaces.get("workspaces", [])]
            if len(names) != 1:
                raise SystemExit("give --workspace-id: the account is not in exactly one workspace")
            workspace_id = names[0].removeprefix("workspaces/")
        self.workspace = f"workspaces/{workspace_id}"

    def collection(self, *, collection_id: str | None, title: str) -> dict[str, Any]:
        """The target COLLECTION: by ID, else the root titled ``title`` or a new one."""

        items = f"/api/v1/{self.workspace}/items"
        if collection_id:
            return self.json("GET", f"{items}/{collection_id}")
        quoted = json.dumps(title, ensure_ascii=False)
        page = self.json(
            "GET",
            items,
            params={
                "filter": f'itemType = COLLECTION AND parentItem = "" AND displayName = {quoted}',
                "pageSize": 1,
            },
        )
        if page.get("items"):
            return page["items"][0]
        return self.json(
            "POST",
            items,
            json={
                "itemType": "COLLECTION",
                "displayName": title,
                "collection": {"description": "UTE website knowledge crawled into R2"},
            },
        )

    def create_document(
        self, collection: str, source: SourceObject, data: bytes, request_id: str
    ) -> dict[str, Any]:
        """``CreateItemMedia``: one KNOWLEDGE document with its bytes."""

        content_type = _content_type(source.name)
        metadata = {
            "itemType": "DOCUMENT",
            "displayName": source.name,
            "parentItem": collection,
            "document": {"mimeType": content_type, "purpose": "KNOWLEDGE"},
        }
        return self.json(
            "POST",
            f"/upload/api/v1/{self.workspace}/items",
            params={"requestId": request_id},
            data={"metadata": json.dumps(metadata, ensure_ascii=False)},
            files={"file": (source.name, data, content_type)},
        )

    def process_collection(self, collection: str) -> dict[str, Any]:
        """``CreateIngestionRun`` for the collection's PENDING and OUTDATED documents."""

        return self.json(
            "POST",
            f"/api/v1/{self.workspace}/ingestionRuns",
            json={"selector": {"ancestor": collection, "states": ["PENDING", "OUTDATED"]}},
        )

# -- Run -----------------------------------------------------------------------


def _load_one(
    r2: Any, bucket: str, api: BoMeshApi, collection: str, source: SourceObject
) -> dict[str, Any]:
    row: dict[str, Any] = {
        "r2_key": source.key, "path": source.path, "name": source.name,
        "size_bytes": source.size, "source_url": "", "result": "failed",
        "item": "", "error": "",
    }
    try:
        data, row["source_url"] = _download(r2, bucket, source)
        item = api.create_document(collection, source, data, _request_id(bucket, source.path))
        row.update(result="loaded", item=item["name"])
    except ApiError as exc:
        conflict = exc.reason == "REQUEST_ID_REUSED" or exc.status_code == 409
        row.update(result="conflict" if conflict else "failed", error=str(exc))
    except Exception as exc:  # noqa: BLE001 - one file never stops the run
        row["error"] = f"{type(exc).__name__}: {exc}"
    return row


def _write_skipped(path: Path, skipped: list[Skipped]) -> None:
    with path.open("w", newline="", encoding="utf-8") as target:
        writer = csv.DictWriter(target, fieldnames=["r2_key", "size_bytes", "reason"])
        writer.writeheader()
        writer.writerows(
            {"r2_key": skip.key, "size_bytes": skip.size, "reason": skip.reason}
            for skip in skipped
        )


def main() -> int:
    args = _parse_args()
    bucket = os.environ["R2_BUCKET"]
    prefix = args.prefix.strip("/") + "/"
    r2 = _r2_client()

    objects = _list_objects(r2, bucket, prefix)
    files, skipped = _classify(
        objects, prefix=prefix, max_upload_bytes=int(args.max_upload_mb * _MIB)
    )
    if args.limit is not None:
        files = files[: args.limit]

    print(f"r2://{bucket}/{prefix}: {len(objects)} objects")
    print(f"loading {len(files)} files ({sum(f.size for f in files) / _MIB:.1f} MiB)")
    for reason, count in Counter(skip.reason for skip in skipped).most_common():
        print(f"  skipped {count:5d}  {reason}")
    if args.dry_run or not files:
        return 0

    args.out.mkdir(parents=True, exist_ok=True)
    _write_skipped(args.out / "skipped.csv", skipped)
    results: Counter[str] = Counter()

    api = BoMeshApi(args.api, email=args.email, password=args.password, token=args.token)
    try:
        api.use_workspace(args.workspace_id)
        collection = api.collection(collection_id=args.collection_id, title=args.collection_title)
        print(f"collection {collection['displayName']!r} ({collection['name']})")

        # Written row by row, so an interrupted run still records what it did.
        with (
            (args.out / "manifest.csv").open("w", newline="", encoding="utf-8") as manifest,
            ThreadPoolExecutor(max_workers=args.workers) as pool,
        ):
            writer = csv.DictWriter(manifest, fieldnames=MANIFEST_FIELDS)
            writer.writeheader()
            loaded = pool.map(
                lambda source: _load_one(r2, bucket, api, collection["name"], source), files
            )
            for index, row in enumerate(loaded, start=1):
                writer.writerow(row)
                manifest.flush()
                results[row["result"]] += 1
                detail = row["item"] or row["error"]
                print(f"[{index:4d}/{len(files)}] {row['result']:8s} {row['path']}  {detail}")
        if args.process:
            try:
                run = api.process_collection(collection["name"])
                counts = run.get("counts") or {}
                print(f"ingestion run {run['name']}: {counts.get('totalCount', 0)} documents queued")
            except ApiError as exc:
                print(f"no ingestion run started: {exc}")
    finally:
        api.close()

    print(", ".join(f"{count} {result}" for result, count in results.most_common()))
    print(f"manifest: {args.out / 'manifest.csv'}")
    if not args.process:
        print("Documents are pending; process them with --process or from Ingestion in the web app.")
    return 0 if results["failed"] == 0 and results["conflict"] == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
