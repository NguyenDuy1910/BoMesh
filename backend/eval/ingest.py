"""Ingestion benchmark: upload a folder through the public API, process it in one run, measure it.

The files go in as a user's upload does (CreateItem, the signed upload URL,
CompleteItemUpload) into a new Collection, then one explicit ingestion run
processes them in the running ingestion worker. Timings come from the run's
tasks and their phases; outputs from the API (Structured Document size), the
index (chunks), object storage (what the run stored per file) and the
Original preview (how well each chunk's citation highlights mark its text,
:mod:`eval.highlights`). The new Collection is the scope ``generate`` draws an
accuracy dataset from.
"""

from __future__ import annotations

import asyncio
import json
import mimetypes
import time
from collections import Counter, defaultdict
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any
from uuid import UUID

import httpx
from sqlalchemy import select

from bomesh.db.engine import transaction_scope
from bomesh.db.models import Item, ItemRevision
from bomesh.runtime import AppRuntime
from bomesh.storage.keys import file_prefix
from eval.highlights import check_document, render_highlights_markdown, summarize_highlights
from eval.metrics import mean, percentile
from eval.report import markdown_table

PHASES = ("FETCHING", "PARSING", "OCR", "CLASSIFYING", "CHUNKING", "EMBEDDING", "INDEXING")
_TERMINAL = {"SUCCEEDED", "FAILED", "CANCELLED"}


@dataclass(frozen=True, slots=True)
class IngestOptions:
    folder: Path
    limit: int | None
    api_url: str
    email: str
    password: str
    workspace: str
    collection_name: str
    read_images: bool = False
    poll_seconds: float = 2.0


def folder_files(folder: Path) -> list[Path]:
    """The folder's files in name order (hidden files skipped): the benchmark's order."""

    return sorted(path for path in folder.iterdir() if path.is_file() and not path.name.startswith("."))


async def run_ingest(runtime: AppRuntime, options: IngestOptions) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    everything = folder_files(options.folder)
    files = everything[: options.limit] if options.limit else everything
    if not files:
        raise SystemExit(f"no files in {options.folder}")
    base = options.api_url.rstrip("/") + "/api/v1"
    async with httpx.AsyncClient(base_url=base, timeout=300) as api, httpx.AsyncClient(timeout=300) as raw:
        token = (await _ok(api.post("/sessions", json={"credential": {"password": {
            "email": options.email, "password": options.password}}})))["accessToken"]
        api.headers["Authorization"] = f"Bearer {token}"
        workspace = await _workspace(api, options.workspace)
        collection = await _ok(api.post(f"/{workspace}/items", json={
            "itemKind": "COLLECTION", "displayName": options.collection_name}))
        print(f"collection {collection['name']} ({options.collection_name})")

        rows = [await _upload(api, raw, workspace, collection["name"], path) for path in files]
        uploaded = [row["item"] for row in rows if row.get("content_state") == "AVAILABLE"]
        if not uploaded:
            raise SystemExit("no file uploaded")
        run = await _ok(api.post(f"/{workspace}/ingestionRuns", json={
            "selector": {"items": uploaded}, "readImages": options.read_images}))
        print(f"run {run['name']}: {len(uploaded)} documents")
        run = await _wait(api, run["name"], options.poll_seconds)
        tasks = {task["item"]: task for task in await _tasks(api, run["name"])}
        for row in rows:
            task = tasks.get(row.get("item", ""))
            if task is not None:
                row.update(_task_timing(task))
                row.update(await _api_outputs(api, row["item"]))
        await _stored_outputs(runtime, workspace.split("/")[-1], rows)
    summary = _summary(rows, run, everything, files)
    summary.update(
        source=str(options.folder),
        workspace=workspace,
        collection=collection["name"],
        run=run["name"],
        read_images=options.read_images,
    )
    return rows, summary


async def _ok(request: Any) -> dict[str, Any]:
    response: httpx.Response = await request
    if response.is_error:
        raise SystemExit(f"{response.request.method} {response.request.url}: {response.status_code} {response.text}")
    return response.json()


async def _workspace(api: httpx.AsyncClient, code: str) -> str:
    page = await _ok(api.get("/workspaces", params={"pageSize": 100}))
    for workspace in page.get("workspaces", []):
        if code in (workspace.get("code"), workspace["name"], workspace["name"].split("/")[-1]):
            return workspace["name"]
    raise SystemExit(f"workspace {code} is not one of the caller's")


async def _upload(
    api: httpx.AsyncClient, raw: httpx.AsyncClient, workspace: str, collection: str, path: Path
) -> dict[str, Any]:
    data = path.read_bytes()
    mime_type = (mimetypes.guess_type(path.name, strict=False)[0] or "application/octet-stream").casefold()
    row: dict[str, Any] = {
        "file": path.name,
        "extension": path.suffix.casefold() or "(none)",
        "size_bytes": len(data),
        "mime_type": mime_type,
    }
    started = time.perf_counter()
    created = await api.post(f"/{workspace}/items", json={
        "itemKind": "DOCUMENT",
        "displayName": path.name,
        "parentItem": collection,
        "document": {"fileName": path.name, "mimeType": mime_type, "sizeBytes": str(len(data))},
    })
    if created.is_error:
        return {**row, "error": f"CreateItem {created.status_code}: {created.text[:300]}"}
    item = created.json()
    row["item"] = item["name"]
    put = await raw.put(item["document"]["uploadUri"], content=data, headers={"Content-Type": mime_type})
    if put.is_error:
        return {**row, "error": f"upload {put.status_code}: {put.text[:300]}"}
    completed = await api.post(f"/{item['name']}:completeUpload", json={})
    if completed.is_error:
        return {**row, "error": f"CompleteItemUpload {completed.status_code}: {completed.text[:300]}"}
    row["content_state"] = completed.json()["document"].get("contentState")
    row["upload_seconds"] = round(time.perf_counter() - started, 3)
    print(f"  uploaded {path.name} ({len(data) / 1024:.0f} KB) {row['content_state']}")
    return row


async def _wait(api: httpx.AsyncClient, run: str, poll_seconds: float) -> dict[str, Any]:
    started, shown = time.perf_counter(), None
    while True:
        current = await _ok(api.get(f"/{run}"))
        counts = current.get("counts", {})
        progress = (
            f"{counts.get('succeededCount', 0)} succeeded, {counts.get('failedCount', 0)} failed,"
            f" {counts.get('runningCount', 0)} running, {counts.get('queuedCount', 0)} queued"
        )
        if progress != shown:
            print(f"  [{time.perf_counter() - started:6.1f}s] {current['state']}: {progress}")
            shown = progress
        if current["state"] in _TERMINAL:
            return current
        await asyncio.sleep(poll_seconds)


async def _tasks(api: httpx.AsyncClient, run: str) -> list[dict[str, Any]]:
    tasks: list[dict[str, Any]] = []
    token = ""
    while True:
        page = await _ok(api.get(f"/{run}/tasks", params={"pageSize": 100, "pageToken": token}))
        tasks += page.get("tasks", [])
        token = page.get("nextPageToken", "")
        if not token:
            return tasks


def _seconds(start: str | None, end: str | None) -> float | None:
    if not start or not end:
        return None
    return round((datetime.fromisoformat(end) - datetime.fromisoformat(start)).total_seconds(), 3)


def _task_timing(task: dict[str, Any]) -> dict[str, Any]:
    error = task.get("error") or {}
    return {
        "task_state": task.get("state"),
        "error_class": task.get("errorClass"),
        "error": error.get("message"),
        "queue_seconds": _seconds(task.get("createTime"), task.get("startTime")),
        "task_seconds": _seconds(task.get("startTime"), task.get("endTime")),
        "task_start": task.get("startTime"),
        "task_end": task.get("endTime"),
        "phases": {
            phase["phase"]: seconds
            for phase in task.get("phases", [])
            if (seconds := _seconds(phase.get("startTime"), phase.get("endTime"))) is not None
        },
    }


async def _api_outputs(api: httpx.AsyncClient, item: str) -> dict[str, Any]:
    document = (await _ok(api.get(f"/{item}"))).get("document", {})
    outputs: dict[str, Any] = {
        "indexing_state": document.get("indexingState"),
        "language": document.get("languageCode"),
        "assistant_topics": len(document.get("assistantTopics", [])),
        "has_summary": bool(document.get("summary")),
    }
    content = await api.get(f"/{item}/content", params={"pageSize": 1})
    if not content.is_error:
        outputs["structure_nodes"] = content.json().get("totalNodes")
    return outputs


async def _stored_outputs(runtime: AppRuntime, tenant_id: str, rows: list[dict[str, Any]]) -> None:
    """Chunks in the index and the objects stored under each file's folder."""

    index, storage = runtime.item_index(), runtime.object_storage()
    for row in rows:
        if "item" not in row:
            continue
        item_id = row["item"].split("/")[-1]
        chunks = await index.get_item_content(item_id, tenant_id=tenant_id, limit=10_000)
        row["chunks"] = len(chunks)
        row["chunk_characters"] = sum(len(chunk.chunk_text) for chunk in chunks)
        async with transaction_scope(runtime.sessions()) as session:
            stored = (await session.execute(
                select(Item.workspace_code, ItemRevision.content_id)
                .join(ItemRevision, ItemRevision.id == Item.current_revision_id)
                .where(Item.id == UUID(item_id))
            )).first()
        if stored is None:
            continue
        prefix = file_prefix(stored.workspace_code, stored.content_id)
        objects: dict[str, dict[str, int]] = defaultdict(lambda: {"count": 0, "bytes": 0})
        for key in await storage.list_keys(prefix):
            kind = key.removeprefix(prefix).split("/")[0]
            objects[kind]["count"] += 1
            objects[kind]["bytes"] += (await storage.head(key)).size_bytes
        row["stored_prefix"] = prefix
        row["objects"] = dict(objects)
        row["highlights"] = await check_document(runtime, tenant_id=tenant_id, item_id=item_id)


def _summary(
    rows: list[dict[str, Any]],
    run: dict[str, Any],
    everything: Sequence[Path],
    files: Sequence[Path],
) -> dict[str, Any]:
    processed = [row for row in rows if row.get("task_seconds") is not None]
    run_seconds = _seconds(run.get("createTime"), run.get("endTime"))
    busy = sum(row["task_seconds"] for row in processed)
    parallelism = busy / run_seconds if run_seconds else 1.0
    phases = {
        phase: {
            "documents": len(values),
            "total_seconds": round(sum(values), 2),
            "mean_seconds": mean(values),
            "p50_seconds": percentile(values, 50),
            "p95_seconds": percentile(values, 95),
            "share": sum(values) / busy if busy else None,
        }
        for phase in PHASES
        if (values := [row["phases"][phase] for row in processed if phase in row["phases"]])
    }
    by_extension: dict[str, dict[str, Any]] = {}
    for extension in sorted({row["extension"] for row in rows}):
        group = [row for row in rows if row["extension"] == extension]
        timed = [row["task_seconds"] for row in group if row.get("task_seconds") is not None]
        by_extension[extension] = {
            "files": len(group),
            "succeeded": sum(row.get("task_state") == "SUCCEEDED" for row in group),
            "mean_task_seconds": mean(timed),
            "max_task_seconds": max(timed, default=None),
            "mean_chunks": mean(row["chunks"] for row in group if "chunks" in row),
            "megabytes": sum(row["size_bytes"] for row in group) / 1e6,
        }
    stored: dict[str, dict[str, int]] = defaultdict(lambda: {"count": 0, "bytes": 0})
    for row in rows:
        for kind, value in row.get("objects", {}).items():
            stored[kind]["count"] += value["count"]
            stored[kind]["bytes"] += value["bytes"]
    folder_counts = Counter(path.suffix.casefold() or "(none)" for path in everything)
    overall = mean(row["task_seconds"] for row in processed) or 0.0
    upload = mean(row["upload_seconds"] for row in rows if "upload_seconds" in row) or 0.0
    estimate = sum(
        count * ((by_extension.get(extension) or {}).get("mean_task_seconds") or overall)
        for extension, count in folder_counts.items()
    ) / max(parallelism, 1.0)
    return {
        "files": len(files),
        "states": dict(Counter(row.get("task_state") or "NOT_PROCESSED" for row in rows)),
        "error_classes": dict(Counter(row["error_class"] for row in rows if row.get("error_class"))),
        "megabytes": sum(row["size_bytes"] for row in rows) / 1e6,
        "upload_seconds": round(sum(row.get("upload_seconds", 0.0) for row in rows), 2),
        "run_seconds": run_seconds,
        "run_state": run.get("state"),
        "first_task_wait_seconds": min((row["queue_seconds"] for row in processed if row.get("queue_seconds") is not None), default=None),
        "documents_per_minute": 60 * len(processed) / run_seconds if run_seconds else None,
        "parallelism": parallelism,
        "task_seconds": {
            "mean": mean(row["task_seconds"] for row in processed),
            "p50": percentile([row["task_seconds"] for row in processed], 50),
            "p95": percentile([row["task_seconds"] for row in processed], 95),
            "max": max((row["task_seconds"] for row in processed), default=None),
        },
        "phases": phases,
        "by_extension": by_extension,
        "outputs": {
            "chunks": sum(row.get("chunks", 0) for row in rows),
            "chunk_characters": sum(row.get("chunk_characters", 0) for row in rows),
            "structure_nodes": sum(row.get("structure_nodes") or 0 for row in rows),
            "objects": dict(stored),
        },
        "highlights": summarize_highlights(rows),
        "folder": {
            "files": len(everything),
            "megabytes": sum(path.stat().st_size for path in everything) / 1e6,
            "by_extension": dict(folder_counts),
            "estimated_run_seconds": round(estimate, 1),
            "estimated_upload_seconds": round(upload * len(everything), 1),
        },
    }


def render_ingest_markdown(rows: list[dict[str, Any]], summary: dict[str, Any], *, title: str) -> str:
    def number(value: Any, digits: int = 1) -> str:
        return "—" if value is None else f"{value:.{digits}f}"

    folder = summary["folder"]
    lines = [
        f"# {title}", "",
        f"Folder `{summary['source']}` · collection `{summary['collection']}` · run `{summary['run']}` ({summary['run_state']})", "",
    ]
    lines += markdown_table(
        ["Files", "MB", "States", "Upload s", "Run s", "First task wait s", "Docs/min", "Parallelism",
         "Task p50 s", "Task p95 s", "Task max s"],
        [[
            str(summary["files"]), number(summary["megabytes"], 2),
            ", ".join(f"{k} {v}" for k, v in summary["states"].items()),
            number(summary["upload_seconds"]), number(summary["run_seconds"]),
            number(summary["first_task_wait_seconds"]), number(summary["documents_per_minute"]),
            number(summary["parallelism"], 2), number(summary["task_seconds"]["p50"]),
            number(summary["task_seconds"]["p95"]), number(summary["task_seconds"]["max"]),
        ]],
    )
    lines += ["## Phases", ""]
    lines += markdown_table(
        ["Phase", "Documents", "Total s", "Mean s", "p50 s", "p95 s", "Share of task time"],
        [[phase, str(v["documents"]), number(v["total_seconds"]), number(v["mean_seconds"], 2),
          number(v["p50_seconds"], 2), number(v["p95_seconds"], 2),
          "—" if v["share"] is None else f"{100 * v['share']:.0f}%"]
         for phase, v in summary["phases"].items()],
    )
    lines += ["## By file type", ""]
    lines += markdown_table(
        ["Type", "Files", "Succeeded", "MB", "Mean task s", "Max task s", "Mean chunks"],
        [[extension, str(v["files"]), str(v["succeeded"]), number(v["megabytes"], 2),
          number(v["mean_task_seconds"]), number(v["max_task_seconds"]), number(v["mean_chunks"])]
         for extension, v in summary["by_extension"].items()],
    )
    outputs = summary["outputs"]
    lines += ["## Outputs", "",
              (f"{outputs['chunks']} chunks ({outputs['chunk_characters']:,} characters), "
               f"{outputs['structure_nodes']} Structured Document nodes."), ""]
    lines += markdown_table(
        ["Stored object", "Count", "MB"],
        [[kind, str(v["count"]), number(v["bytes"] / 1e6, 2)] for kind, v in sorted(outputs["objects"].items())],
    )
    lines += ["", *render_highlights_markdown(summary["highlights"]), ""]
    lines += ["## Documents", ""]
    lines += markdown_table(
        ["File", "KB", "State", "Task s", *[phase.title() for phase in PHASES], "Nodes", "Chunks", "Error"],
        [[row["file"], f"{row['size_bytes'] / 1024:.0f}", row.get("task_state") or "—",
          number(row.get("task_seconds")),
          *[number((row.get("phases") or {}).get(phase), 2) for phase in PHASES],
          str(row.get("structure_nodes", "—")), str(row.get("chunks", "—")),
          (row.get("error_class") or "") + (f": {row['error']}" if row.get("error") else "")]
         for row in rows],
    )
    lines += [
        "## Estimate for the whole folder", "",
        f"{folder['files']} files ({folder['megabytes']:.1f} MB): about "
        f"{folder['estimated_run_seconds'] / 60:.1f} min of processing at the measured parallelism "
        f"({summary['parallelism']:.2f}), plus {folder['estimated_upload_seconds'] / 60:.1f} min of "
        "sequential upload. Per type, from the mean task time measured here (the overall mean for "
        "types not in the sample): "
        + ", ".join(f"{extension} {count}" for extension, count in sorted(folder["by_extension"].items())),
        "",
    ]
    return "\n".join(lines)


def write_ingest_run(directory: Path, *, rows: list[dict[str, Any]], summary: dict[str, Any], title: str) -> None:
    directory.mkdir(parents=True, exist_ok=True)
    with (directory / "results.jsonl").open("w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")
    (directory / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", "utf-8")
    (directory / "summary.md").write_text(render_ingest_markdown(rows, summary, title=title), "utf-8")


__all__ = ["IngestOptions", "folder_files", "render_ingest_markdown", "run_ingest", "write_ingest_run"]
