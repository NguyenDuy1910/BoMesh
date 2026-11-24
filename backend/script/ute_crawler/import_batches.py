"""Send prepared UTE batches to BoMesh as contributions, the way the web Contribute flow does.

For every file of a batch (``batches.py`` output), through the public API of a
running backend:

1. **Upload** into the importing member's *My files* (``CreateItemMedia``), as the
   web client does. Nothing is processed: the document is ``AVAILABLE`` and
   waits for an Ingestion Run.
2. **Submit** it for review (``CreateContribution`` ``NEW_DOCUMENT``) with the
   batch folder as ``targetCollection`` and the source URL as the note.

The script stops there. Processing (Documents → Processing, an explicit
Ingestion Run) and review/approval stay manual, in that order
(``item_model.md`` §4.7).

Folders of the shared collection do not accept contributions when imported,
so the script turns ``acceptsContributions`` on for each target folder it uses
(and prints it).

Reruns are safe. Every batch keeps an ``import.jsonl`` ledger of what reached
the server, and every request carries a ``requestId`` derived from the file's
``sha256``. A file whose upload or contribution failed is retried; a finished
file is skipped.

Usage (from backend/script/ute_crawler; the API must be running):
    ../../.venv/bin/python import_batches.py 001                  # by number
    ../../.venv/bin/python import_batches.py 002 003 --parallel 6
    ../../.venv/bin/python import_batches.py 001 --dry-run        # resolve folders only
The password is asked for, or read from --password / BOMESH_IMPORT_PASSWORD.
"""

from __future__ import annotations

import argparse
import asyncio
import getpass
import json
import os
import sys
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import httpx

DEFAULT_BATCHES = Path.home() / "Documents" / "workspace" / "ute_docs" / "batches"
DEFAULT_API = "http://127.0.0.1:8000"
DEFAULT_WORKSPACE = "hcmute"
DEFAULT_EMAIL = "nguyendqduy@gmail.com"
DEFAULT_COLLECTION = "Kho tài liệu chung"
LEDGER = "import.jsonl"
#: requestIds are UUIDv5 of the workspace and file, so a retried request is the same request.
REQUEST_NAMESPACE = uuid.UUID("6f1c2a52-8a3e-4c1e-9a43-5e0b7e3a9d21")
MIME_TYPES = {
    ".pdf": "application/pdf",
    ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".docm": "application/vnd.ms-word.document.macroEnabled.12",
    ".xls": "application/vnd.ms-excel",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".ppt": "application/vnd.ms-powerpoint",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
}
#: Archives go only into STANDARD collections, never into My files, so they cannot be
#: contributed (document_contract.md, FORMAT_NOT_ALLOWED); an editor uploads them directly.
ARCHIVE_EXTS = {".zip"}
#: Statuses worth another attempt: the server or the network, never the request itself.
RETRY_STATUSES = {429, 500, 502, 503, 504}
ATTEMPTS = 4


class ApiError(RuntimeError):
    def __init__(self, method: str, path: str, response: httpx.Response) -> None:
        self.status = response.status_code
        try:
            error = response.json().get("error", {})
            reason = next(
                (d.get("reason") for d in error.get("details", []) if d.get("reason")),
                None,
            )
            detail = f"{error.get('status', '')} {reason or ''}: {error.get('message', '')}".strip()
        except ValueError:
            detail = response.text[:300]
        super().__init__(f"{method} {path} → {self.status} {detail}")


@dataclass
class Api:
    """The backend's public API as the importing member; signs in again when the session ends."""

    base: str
    email: str
    password: str
    http: httpx.AsyncClient = field(init=False)
    _token: str | None = None
    _signing_in: asyncio.Lock = field(default_factory=asyncio.Lock)

    def __post_init__(self) -> None:
        self.http = httpx.AsyncClient(
            base_url=self.base, timeout=httpx.Timeout(300, connect=10)
        )

    async def sign_in(self, stale: str | None = None) -> None:
        async with self._signing_in:
            if self._token is not None and self._token != stale:
                return  # another request already signed in again
            response = await self.http.post(
                "/api/v1/sessions",
                json={
                    "credential": {
                        "password": {"email": self.email, "password": self.password}
                    }
                },
            )
            if response.status_code != 200:
                raise ApiError("POST", "/api/v1/sessions", response)
            self._token = response.json()["accessToken"]

    async def call(self, method: str, path: str, **kwargs: Any) -> dict[str, Any]:
        for attempt in range(1, ATTEMPTS + 1):
            token = self._token
            try:
                for stream in kwargs.get("files", {}).values():
                    stream[1].seek(
                        0
                    )  # a retried upload sends the file again from the start
                response = await self.http.request(
                    method, path, headers={"Authorization": f"Bearer {token}"}, **kwargs
                )
            except httpx.TransportError:
                if attempt == ATTEMPTS:
                    raise
                await asyncio.sleep(2**attempt)
                continue
            if response.status_code == 401 and attempt < ATTEMPTS:
                await self.sign_in(stale=token)
                continue
            if response.status_code in RETRY_STATUSES and attempt < ATTEMPTS:
                await asyncio.sleep(2**attempt)
                continue
            if response.status_code >= 400:
                raise ApiError(method, path, response)
            return response.json() if response.content else {}
        raise AssertionError("unreachable")

    async def list_all(
        self, path: str, key: str, **params: str
    ) -> list[dict[str, Any]]:
        found: list[dict[str, Any]] = []
        token = ""
        while True:
            page = await self.call(
                "GET", path, params={**params, "pageSize": "500", "pageToken": token}
            )
            found += page.get(key, [])
            token = page.get("nextPageToken", "")
            if not token:
                return found


@dataclass(frozen=True)
class Target:
    workspace: str  # workspaces/{id}
    personal: str  # the member's My files
    folders: dict[str, str]  # "Unit/Folder" -> items/{id}, "" = the shared collection


async def resolve(api: Api, workspace_code: str, collection: str) -> Target:
    found = await api.list_all(
        "/api/v1/workspaces", "workspaces", filter=f'code = "{workspace_code}"'
    )
    if not found:
        sys.exit(
            f"workspace {workspace_code!r} not found, or the account is not a member"
        )
    workspace = found[0]["name"]
    member = await api.call("GET", f"/api/v1/{workspace}/members/me")
    roots = await api.list_all(
        f"/api/v1/{workspace}/items",
        "items",
        filter='parentItem = "" AND itemKind = COLLECTION',
    )
    root = next(
        (item["name"] for item in roots if item["displayName"] == collection), None
    )
    if root is None:
        sys.exit(f"collection {collection!r} not found in {workspace_code}")
    folders = {"": root}
    pending = [("", root)]
    while pending:
        path, parent = pending.pop()
        children = await api.list_all(
            f"/api/v1/{workspace}/items",
            "items",
            filter=f'parentItem = "{parent}" AND itemKind = COLLECTION',
        )
        for child in children:
            child_path = (
                f"{path}/{child['displayName']}" if path else child["displayName"]
            )
            folders[child_path] = child["name"]
            pending.append((child_path, child["name"]))
    return Target(workspace, member["personalCollection"], folders)


async def accept_contributions(api: Api, folder: str, path: str) -> None:
    item = await api.call("GET", f"/api/v1/{folder}")
    if item.get("collection", {}).get("acceptsContributions"):
        return
    await api.call(
        "PATCH",
        f"/api/v1/{folder}",
        params={"updateMask": "collection.acceptsContributions"},
        json={"collection": {"acceptsContributions": True}, "etag": item.get("etag")},
    )
    print(f"  folder now accepts contributions: {path or DEFAULT_COLLECTION}")


def request_id(workspace: str, sha256: str, step: str) -> str:
    return str(uuid.uuid5(REQUEST_NAMESPACE, f"{workspace}:{sha256}:{step}"))


def note(record: dict[str, Any]) -> str:
    lines = [f"Nguồn: {record['url']}"]
    if record.get("source_page"):
        lines.append(f"Trang liên kết: {record['source_page']}")
    return "\n".join(lines)


class Ledger:
    """``import.jsonl`` of one batch: the latest line per file wins."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self.entries: dict[str, dict[str, Any]] = {}
        if path.is_file():
            for line in path.read_text(encoding="utf-8").splitlines():
                if line.strip():
                    entry = json.loads(line)
                    self.entries[entry["sha256"]] = entry
        self._file = path.open("a", encoding="utf-8")

    def write(self, entry: dict[str, Any]) -> None:
        self.entries[entry["sha256"]] = entry
        self._file.write(json.dumps(entry, ensure_ascii=False) + "\n")
        self._file.flush()

    def close(self) -> None:
        self._file.close()


async def send(
    api: Api, target: Target, batch: Path, record: dict[str, Any], ledger: Ledger
) -> str:
    """Upload one file and open its contribution.

    Returns ``done``, ``skipped`` (sent before), ``archive`` (not contributable) or ``failed``.
    """
    sha256 = record["sha256"]
    entry = dict(ledger.entries.get(sha256, {}), sha256=sha256, file=record["file"])
    if entry.get("contribution"):
        return "skipped"
    if Path(record["file"]).suffix.lower() in ARCHIVE_EXTS:
        if not entry.get("archive"):
            entry.pop("error", None)
            ledger.write({**entry, "archive": True})
        return "archive"
    entry.pop("error", None)
    workspace = target.workspace
    try:
        if not entry.get("item"):
            path = batch / record["file"]
            metadata = {
                "itemKind": "DOCUMENT",
                "displayName": path.stem,
                "parentItem": target.personal,
                "document": {
                    "fileName": path.name,
                    "mimeType": MIME_TYPES.get(
                        path.suffix.lower(), "application/octet-stream"
                    ),
                    "purpose": "KNOWLEDGE",
                },
            }
            with path.open("rb") as stream:
                item = await api.call(
                    "POST",
                    f"/upload/api/v1/{workspace}/items",
                    params={"requestId": request_id(workspace, sha256, "item")},
                    data={"metadata": json.dumps(metadata, ensure_ascii=False)},
                    files={
                        "file": (path.name, stream, metadata["document"]["mimeType"])
                    },
                )
            entry["item"] = item["name"]
            ledger.write(entry)
        contribution = await api.call(
            "POST",
            f"/api/v1/{workspace}/contributions",
            params={"requestId": request_id(workspace, sha256, "contribution")},
            json={
                "kind": "NEW_DOCUMENT",
                "item": entry["item"],
                "targetCollection": target.folders[record["collection"]],
                "note": note(record),
            },
        )
        entry["contribution"] = contribution["name"]
        ledger.write(entry)
        return "done"
    except (ApiError, httpx.HTTPError, OSError) as error:
        entry["error"] = str(error)
        ledger.write(entry)
        print(f"  ! {record['file']}: {error}")
        return "failed"


def batch_folder(root: Path, name: str) -> Path:
    path = Path(name)
    if path.is_dir():
        return path
    matches = (
        sorted(root.glob(f"{name.zfill(3)}-*"))
        if name.isdigit()
        else sorted(root.glob(f"{name}*"))
    )
    matches = [m for m in matches if (m / "manifest.jsonl").is_file()]
    if len(matches) != 1:
        sys.exit(
            f"batch {name!r}: expected one folder with a manifest under {root}, found {len(matches)}"
        )
    return matches[0]


async def send_batch(
    api: Api, target: Target, batch: Path, records: list[dict[str, Any]], parallel: int
) -> dict[str, int]:
    """Send every file of one batch, ``parallel`` at a time; counts by outcome."""
    ledger = Ledger(batch / LEDGER)
    started = time.monotonic()
    counts = {"done": 0, "skipped": 0, "archive": 0, "failed": 0}
    queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
    for record in records:
        queue.put_nowait(record)

    async def worker() -> None:
        while not queue.empty():
            record = queue.get_nowait()
            counts[await send(api, target, batch, record, ledger)] += 1
            finished = sum(counts.values())
            if finished % 25 == 0 or finished == len(records):
                elapsed = time.monotonic() - started
                print(f"  {finished}/{len(records)}  {counts}  {elapsed:.0f}s")

    try:
        await asyncio.gather(*(worker() for _ in range(parallel)))
    finally:
        ledger.close()
    return counts


async def run(args: argparse.Namespace) -> None:
    batches = [batch_folder(args.batches, name) for name in args.batch]
    api = Api(args.api, args.email, args.password)
    try:
        await api.sign_in()
        target = await resolve(api, args.workspace, args.collection)
        for batch in batches:
            records = [
                json.loads(line)
                for line in (batch / "manifest.jsonl")
                .read_text(encoding="utf-8")
                .splitlines()
                if line.strip()
            ]
            missing = sorted({r["collection"] for r in records} - target.folders.keys())
            if missing:
                sys.exit(
                    f"{batch.name}: folders missing in {args.collection!r}: {', '.join(missing)}"
                )
            used = sorted({r["collection"] for r in records})
            print(
                f"{batch.name}: {len(records)} files into {len(used)} folders of {args.collection!r}"
            )
            if args.dry_run:
                for path in used:
                    print(
                        f"  {sum(r['collection'] == path for r in records):>5}  {path}"
                    )
                continue
            for path in used:
                await accept_contributions(api, target.folders[path], path)
            counts = await send_batch(api, target, batch, records, args.parallel)
            print(f"{batch.name}: {counts}; ledger {batch / LEDGER}")
    finally:
        await api.http.aclose()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument(
        "batch", nargs="+", help="batch number (1, 001), folder name prefix or path"
    )
    parser.add_argument(
        "--batches", type=Path, default=DEFAULT_BATCHES, help="folder batches.py wrote"
    )
    parser.add_argument("--api", default=DEFAULT_API, help="backend base URL")
    parser.add_argument("--workspace", default=DEFAULT_WORKSPACE, help="workspace code")
    parser.add_argument(
        "--collection",
        default=DEFAULT_COLLECTION,
        help="root collection the batch folders mirror",
    )
    parser.add_argument("--email", default=DEFAULT_EMAIL, help="importing account")
    parser.add_argument(
        "--password",
        default=os.environ.get("BOMESH_IMPORT_PASSWORD"),
        help="its password",
    )
    parser.add_argument("--parallel", type=int, default=4, help="files sent at once")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="sign in and resolve folders; send nothing",
    )
    args = parser.parse_args()
    args.password = args.password or getpass.getpass(f"Password for {args.email}: ")
    asyncio.run(run(args))


if __name__ == "__main__":
    main()
