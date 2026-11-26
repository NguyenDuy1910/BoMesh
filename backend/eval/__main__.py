"""Benchmark CLI: ``uv run python -m eval <command>`` from ``backend/``.

Commands
- ``ingest``: upload a folder into a new Collection, process it, measure it.
- ``highlights``: how well an indexed Collection's citation highlights mark their text.
- ``collections``: tenants and Collections with indexed Documents.
- ``generate``: draw a dataset from an already-indexed workspace.
- ``run``: benchmark variants side by side and write a report.
"""

from __future__ import annotations

import argparse
import asyncio
import getpass
import json
from dataclasses import asdict, replace
from datetime import datetime
from pathlib import Path

from dotenv import load_dotenv
from sqlalchemy import select

from bomesh.db.engine import transaction_scope
from bomesh.db.models import Tenant, User
from bomesh.runtime import AppRuntime
from config import AppConfig
from eval.corpus import indexed_documents, tenant_collection_ids
from eval.dataset import Dataset, dataset_directory, load_dataset, save_dataset
from eval.generate import GenerationPlan, generate_dataset
from eval.highlights import check_collection, render_highlights_markdown, summarize_highlights
from eval.ingest import IngestOptions, run_ingest, write_ingest_run
from eval.judge import AnswerJudge, RelevanceJudge
from eval.llm import JsonCache, JsonModel
from eval.report import render_markdown, summarize, write_run
from eval.runner import (
    STAGES,
    VARIANTS,
    Judges,
    RunOptions,
    run_variant,
    variant_config,
)

EVAL_ROOT = Path(__file__).resolve().parent
BACKEND_ROOT = EVAL_ROOT.parent
CACHE_ROOT = EVAL_ROOT / "cache"
RUNS_ROOT = EVAL_ROOT / "runs"


def load_config(*, trace: bool) -> AppConfig:
    """Parse the environment once; the benchmark never starts the sandbox."""

    load_dotenv(BACKEND_ROOT.parent / ".env", override=False)
    config = AppConfig.from_environment()
    config = replace(config, sandbox=replace(config.sandbox, enabled=False))
    if not trace:
        config = replace(
            config,
            observability=replace(
                config.observability, langfuse_public_key=None, langfuse_secret_key=None
            ),
        )
    return config


def _json_model(runtime: AppRuntime, cache_name: str) -> JsonModel:
    transport = runtime.model_transport()
    return JsonModel(
        transport,
        model_name=transport.model,
        cache=JsonCache(CACHE_ROOT / f"{cache_name}.jsonl"),
    )


def _relevance_judge(runtime: AppRuntime) -> RelevanceJudge:
    return RelevanceJudge(
        _json_model(runtime, "judge_calls"), JsonCache(CACHE_ROOT / "relevance_grades.jsonl")
    )


async def _collections(config: AppConfig) -> None:
    runtime = AppRuntime(config)
    try:
        async with transaction_scope(runtime.sessions()) as session:
            tenants = (await session.execute(select(Tenant.id, Tenant.tenant_name))).all()
        for tenant in tenants:
            tenant_id = str(tenant.id)
            collections = await tenant_collection_ids(runtime.sessions(), tenant_id=tenant_id)
            if not collections:
                continue
            documents = await indexed_documents(
                runtime.sessions(), tenant_id=tenant_id, collection_item_ids=collections
            )
            counts: dict[str, int] = {}
            for document in documents:
                counts[document.collection_item_id] = counts.get(document.collection_item_id, 0) + 1
            if counts:
                print(f"tenant {tenant_id}  {tenant.name}")
                for collection_id, count in sorted(counts.items(), key=lambda kv: -kv[1]):
                    print(f"  collection {collection_id}  indexed documents={count}")
    finally:
        await runtime.aclose()


async def _generate(config: AppConfig, args: argparse.Namespace) -> None:
    directory = dataset_directory(args.name)
    if (directory / "questions.jsonl").exists() and not args.force:
        raise SystemExit(f"dataset {args.name} exists; pass --force to overwrite it")
    runtime = AppRuntime(config)
    try:
        model = _json_model(runtime, "generation_calls")
        dataset, report = await generate_dataset(
            name=args.name,
            tenant_id=args.tenant,
            collection_item_ids=tuple(args.collection),
            plan=GenerationPlan(
                single_hop=args.questions,
                multi_hop=args.multi_hop,
                unanswerable=args.unanswerable,
                language=args.language,
                second_language=args.second_language or None,
                second_language_every=args.second_language_every,
                seed=args.seed,
                concurrency=args.concurrency,
            ),
            sessions=runtime.sessions(),
            index=runtime.item_index(),
            model=model,
            relevance=_relevance_judge(runtime),
        )
    finally:
        await runtime.aclose()
    path = save_dataset(dataset)
    print(f"wrote {len(dataset.questions)} questions to {path}")
    print(json.dumps(asdict(report), ensure_ascii=False, indent=2))


async def _ingest(config: AppConfig, args: argparse.Namespace) -> None:
    started = datetime.now()
    folder = Path(args.folder).expanduser().resolve()
    options = IngestOptions(
        folder=folder,
        limit=args.limit,
        api_url=args.api_url,
        email=args.email,
        password=args.password or getpass.getpass(f"password for {args.email}: "),
        workspace=args.workspace,
        collection_name=args.collection_name or f"Benchmark {folder.name} {started:%Y-%m-%d %H:%M}",
        read_images=args.read_images,
        poll_seconds=args.poll_seconds,
    )
    runtime = AppRuntime(config)
    try:
        rows, summary = await run_ingest(runtime, options)
    finally:
        await runtime.aclose()
    title = f"Ingestion benchmark: {folder.name} ({started:%Y-%m-%d %H:%M})"
    directory = RUNS_ROOT / "ingest" / folder.name / f"{started:%Y%m%d-%H%M%S}"
    write_ingest_run(directory, rows=rows, summary=summary, title=title)
    print((directory / "summary.md").read_text("utf-8"))
    print(f"results: {directory}")
    tenant, collection = summary["workspace"].split("/")[-1], summary["collection"].split("/")[-1]
    print(
        "accuracy: uv run python -m eval generate --name <dataset> "
        f"--tenant {tenant} --collection {collection}, then: uv run python -m eval run --dataset <dataset>"
    )


async def _highlights(config: AppConfig, args: argparse.Namespace) -> None:
    runtime = AppRuntime(config)
    try:
        rows = await check_collection(runtime, collection_id=args.collection)
    finally:
        await runtime.aclose()
    summary = summarize_highlights(rows)
    started = datetime.now()
    directory = RUNS_ROOT / "highlights" / args.collection / f"{started:%Y%m%d-%H%M%S}"
    directory.mkdir(parents=True, exist_ok=True)
    with (directory / "results.jsonl").open("w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")
    report = "\n".join(
        [f"# Citation highlights: collection {args.collection} ({started:%Y-%m-%d %H:%M})", "",
         *render_highlights_markdown(summary)[2:]]
    )
    (directory / "summary.md").write_text(report + "\n", "utf-8")
    print(report)
    print(f"results: {directory}")


async def _run(config: AppConfig, args: argparse.Namespace) -> None:
    dataset = load_dataset(args.dataset)
    if args.limit:
        dataset = Dataset(dataset.manifest, dataset.questions[: args.limit])
    judge_runtime = AppRuntime(config)
    async with transaction_scope(judge_runtime.sessions()) as session:
        reader_id = await session.scalar(select(User.id).where(User.email == args.reader))
    if reader_id is None:
        await judge_runtime.aclose()
        raise SystemExit(f"no user {args.reader}")
    options = RunOptions(
        variants=tuple(args.variants),
        stages=tuple(args.stages),
        candidate_count=args.candidates,
        final_top_k=args.top_k,
        judge=not args.no_judge,
        concurrency=args.concurrency,
        reader_id=str(reader_id),
    )
    judges = (
        Judges(
            relevance=_relevance_judge(judge_runtime),
            answer=AnswerJudge(_json_model(judge_runtime, "judge_calls")),
        )
        if options.judge
        else None
    )
    started = datetime.now()
    settings: dict[str, dict[str, object]] = {}
    rows: list[dict[str, object]] = []
    try:
        for name in options.variants:
            print(f"[{name}] running {', '.join(options.stages)} on {len(dataset.questions)} questions")
            variant_settings, variant_rows = await run_variant(
                name=name,
                config=variant_config(config, name, options),
                dataset=dataset,
                options=options,
                judges=judges,
            )
            settings[name] = variant_settings
            rows += variant_rows
            if variant_settings["processing_signature"] != dataset.manifest.processing_signature:
                print(
                    f"[{name}] warning: the index processing signature differs from the "
                    "dataset's; gold quotes may no longer match re-chunked content"
                )
    finally:
        await judge_runtime.aclose()
    summary = summarize(rows, settings)
    if judges is not None:
        summary["judge_model"] = judge_runtime.model_transport().model
    title = f"RAG benchmark: {args.dataset} ({started:%Y-%m-%d %H:%M})"
    directory = RUNS_ROOT / args.dataset / f"{started:%Y%m%d-%H%M%S}"
    write_run(directory, rows=rows, summary=summary, manifest=asdict(dataset.manifest), title=title)
    print(render_markdown(summary, title=title))
    print(f"results: {directory}")
    violations = sum(
        stage.get("index_violations", 0) + stage.get("retriever_violations", 0)
        for variant in summary["stages"].values()
        for name, stage in variant.items()
        if name.startswith("leak")
    )
    if violations:
        raise SystemExit(f"permission leak probes found {violations:.0f} violation(s)")


def _csv(choices: tuple[str, ...]):
    def parse(value: str) -> list[str]:
        items = [item.strip() for item in value.split(",") if item.strip()]
        unknown = [item for item in items if item not in choices]
        if not items or unknown:
            raise argparse.ArgumentTypeError(f"choose from {', '.join(choices)}")
        return items

    return parse


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="python -m eval", description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--trace", action="store_true", help="send Langfuse traces")
    commands = parser.add_subparsers(dest="command", required=True)

    ingest = commands.add_parser("ingest", help="upload a folder, process it in one run, measure it")
    ingest.add_argument("--folder", required=True)
    ingest.add_argument("--limit", type=int, help="only the first N files in name order")
    ingest.add_argument("--workspace", required=True, help="workspace code or ID")
    ingest.add_argument("--email", required=True)
    ingest.add_argument("--password", help="prompted for when omitted")
    ingest.add_argument("--api-url", default="http://127.0.0.1:8000")
    ingest.add_argument("--collection-name", help="default: Benchmark <folder> <time>")
    ingest.add_argument("--read-images", action="store_true", help="describe pictures (vision model)")
    ingest.add_argument("--poll-seconds", type=float, default=2.0)

    commands.add_parser("collections", help="list Collections with indexed Documents")

    highlights = commands.add_parser("highlights", help="measure an indexed Collection's citation highlights")
    highlights.add_argument("--collection", required=True, help="Collection item ID")

    generate = commands.add_parser("generate", help="draw a dataset from the indexed workspace")
    generate.add_argument("--name", required=True)
    generate.add_argument("--tenant", required=True)
    generate.add_argument("--collection", action="append", required=True)
    generate.add_argument("--questions", type=int, default=60, help="single-passage questions")
    generate.add_argument("--multi-hop", type=int, default=10)
    generate.add_argument("--unanswerable", type=int, default=10)
    generate.add_argument("--language", default="Vietnamese")
    generate.add_argument("--second-language", default="English",
                          help="cross-lingual questions; empty to disable")
    generate.add_argument("--second-language-every", type=int, default=4)
    generate.add_argument("--seed", type=int, default=7)
    generate.add_argument("--concurrency", type=int, default=4)
    generate.add_argument("--force", action="store_true")

    run = commands.add_parser("run", help="benchmark variants side by side")
    run.add_argument("--dataset", required=True)
    run.add_argument("--reader", required=True,
                     help="email of the user the final stage and the agent read as")
    run.add_argument("--variants", type=_csv(tuple(VARIANTS)), default=["fused", "rerank"])
    run.add_argument("--stages", type=_csv(STAGES), default=["retrieval", "leak"])
    run.add_argument("--candidates", type=int, help="override BOMESH_RETRIEVAL_CANDIDATE_COUNT")
    run.add_argument("--top-k", type=int, help="override BOMESH_FINAL_RETRIEVAL_TOP_K")
    run.add_argument("--limit", type=int, help="only the first N questions")
    run.add_argument("--no-judge", action="store_true", help="traditional metrics only")
    run.add_argument("--concurrency", type=int, default=4)
    return parser


def main() -> int:
    args = _parser().parse_args()
    if getattr(args, "concurrency", 1) < 1:
        raise SystemExit("--concurrency must be at least one")
    config = load_config(trace=args.trace)
    if args.command == "collections":
        asyncio.run(_collections(config))
    elif args.command == "ingest":
        asyncio.run(_ingest(config, args))
    elif args.command == "highlights":
        asyncio.run(_highlights(config, args))
    elif args.command == "generate":
        asyncio.run(_generate(config, args))
    else:
        asyncio.run(_run(config, args))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
