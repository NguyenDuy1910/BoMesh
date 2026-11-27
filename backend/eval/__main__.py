"""Benchmark CLI: ``uv run python -m eval <command> --suite <name>`` from ``backend/``.

Commands
- ``bench``: ingest the suite's files into a fresh Collection (or ``--reuse`` the last one), measure
  ingestion and citation highlights, then score the suite's questions; one report per run.
- ``generate``: draw the suite's questions from its last ingestion.
- ``classify``: run the facet classifier on ``eval/classification/<suite>/labels.jsonl`` against a
  workspace's published taxonomy; precision/recall per scheme and threshold calibration.
"""

from __future__ import annotations

import argparse
import asyncio
import getpass
import json
import os
from dataclasses import asdict, replace
from datetime import datetime
from pathlib import Path
from typing import Any

from dotenv import load_dotenv
from sqlalchemy import select

from bomesh.db.engine import transaction_scope
from bomesh.db.models import User
from bomesh.runtime import AppRuntime
from config import AppConfig
from eval.classification.runner import run_classification
from eval.generate import GenerationPlan, generate_dataset
from eval.highlights import check_collection, render_highlights_markdown, summarize_highlights
from eval.ingest import IngestOptions, render_ingest_markdown, run_ingest
from eval.judge import AnswerJudge, RelevanceJudge
from eval.llm import JsonCache, JsonModel
from eval.report import render_markdown, summarize, write_report
from eval.runner import STAGES, VARIANTS, Judges, RunOptions, run_variant, variant_config
from eval.suite import Suite, load_suite

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


async def _ingest(config: AppConfig, suite: Suite, args: argparse.Namespace, started: datetime) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    password = os.environ.get("BOMESH_EVAL_PASSWORD") or getpass.getpass(f"password for {suite.user}: ")
    runtime = AppRuntime(config)
    try:
        rows, summary = await run_ingest(runtime, IngestOptions(
            files=suite.files(),
            api_url=args.api_url,
            email=suite.user,
            password=password,
            workspace=suite.workspace,
            collection_name=f"Benchmark {suite.name} {started:%Y-%m-%d %H:%M}",
            previous_collection=suite.collection.name if suite.collection else None,
            read_images=args.read_images,
        ))
        signature = runtime.item_index().current_processing_signature()
    finally:
        await runtime.aclose()
    suite.record_ingestion(
        collection=summary["collection"], run=summary["run"], files=suite.fingerprint(), processing_signature=signature
    )
    return rows, summary


async def _reused(config: AppConfig, suite: Suite) -> list[dict[str, Any]]:
    if suite.collection is None:
        raise SystemExit(f"suite {suite.name} has not been ingested yet: run bench without --reuse")
    if suite.collection.files != suite.fingerprint():
        raise SystemExit(f"the files of suite {suite.name} changed since its last ingestion: run bench without --reuse")
    runtime = AppRuntime(config)
    try:
        rows = await check_collection(runtime, collection_id=suite.collection.collection_id)
    finally:
        await runtime.aclose()
    if not rows:
        raise SystemExit(f"collection {suite.collection.name} has no live documents: run bench without --reuse")
    return rows


async def _score(config: AppConfig, suite: Suite, items: dict[str, str], args: argparse.Namespace) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    dataset = suite.dataset(items)
    judge_runtime = AppRuntime(config)
    try:
        async with transaction_scope(judge_runtime.sessions()) as session:
            reader_id = await session.scalar(select(User.id).where(User.email == suite.user))
        if reader_id is None:
            raise SystemExit(f"no user {suite.user}")
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
            Judges(relevance=_relevance_judge(judge_runtime), answer=AnswerJudge(_json_model(judge_runtime, "judge_calls")))
            if options.judge
            else None
        )
        settings: dict[str, dict[str, object]] = {}
        rows: list[dict[str, Any]] = []
        for name in options.variants:
            print(f"[{name}] {', '.join(options.stages)} on {len(dataset.questions)} questions")
            settings[name], variant_rows = await run_variant(
                name=name, config=variant_config(config, name, options), dataset=dataset, options=options, judges=judges
            )
            if settings[name]["processing_signature"] != dataset.manifest.processing_signature:
                print(f"[{name}] warning: the index processing signature differs from the questions'; "
                      "gold quotes may no longer match re-chunked content")
            rows += variant_rows
        summary = summarize(rows, settings)
        if judges is not None:
            summary["judge_model"] = judge_runtime.model_transport().model
    finally:
        await judge_runtime.aclose()
    return summary, rows


async def _bench(config: AppConfig, args: argparse.Namespace) -> None:
    suite = load_suite(args.suite)
    started = datetime.now()
    if args.reuse:
        documents, ingestion = await _reused(config, suite), None
    else:
        documents, ingestion = await _ingest(config, suite, args, started)
    items = {row["file"]: row["item"].split("/")[-1] for row in documents if "item" in row}

    scored, results = None, []
    if suite.questions():
        scored, results = await _score(config, suite, items, args)

    highlights = summarize_highlights(documents)
    title = f"Benchmark {suite.name} ({started:%Y-%m-%d %H:%M})"
    markdown = [f"# {title}", "", f"Collection `{suite.collection.name}` · {len(documents)} documents", ""]
    if ingestion is not None:
        markdown += render_ingest_markdown(documents, ingestion)
    markdown += [*render_highlights_markdown(highlights), ""]
    if scored is not None:
        markdown += render_markdown(scored)
    else:
        markdown += ["No questions yet: `uv run python -m eval generate --suite " + suite.name + "`.", ""]
    directory = RUNS_ROOT / suite.name / f"{started:%Y%m%d-%H%M%S}"
    summary = {
        "suite": suite.name,
        "collection": suite.collection.name,
        "processing_signature": suite.collection.processing_signature,
        "ingestion": ingestion,
        "highlights": highlights,
        "retrieval": scored,
        "questions": suite.generation,
    }
    write_report(directory, summary=summary, markdown=markdown, documents=documents, results=results)
    print("\n".join(markdown))
    print(f"results: {directory}")
    if scored is not None:
        violations = sum(
            stage.get("index_violations", 0) + stage.get("retriever_violations", 0)
            for variant in scored["stages"].values()
            for name, stage in variant.items()
            if name.startswith("leak")
        )
        if violations:
            raise SystemExit(f"permission leak probes found {violations:.0f} violation(s)")


async def _generate(config: AppConfig, args: argparse.Namespace) -> None:
    suite = load_suite(args.suite)
    if suite.collection is None:
        raise SystemExit(f"suite {suite.name} has not been ingested yet: run bench first")
    if suite.questions() and not args.force:
        raise SystemExit(f"suite {suite.name} has questions; pass --force to replace them")
    runtime = AppRuntime(config)
    try:
        dataset, report = await generate_dataset(
            name=suite.name,
            tenant_id=suite.collection.tenant_id,
            collection_item_ids=(suite.collection.collection_id,),
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
            model=_json_model(runtime, "generation_calls"),
            relevance=_relevance_judge(runtime),
        )
    finally:
        await runtime.aclose()
    suite.write_questions(dataset)
    print(f"wrote {len(dataset.questions)} questions to {suite.questions_path}")
    print(json.dumps(asdict(report), ensure_ascii=False, indent=2))


async def _classify(config: AppConfig, args: argparse.Namespace) -> None:
    run = await run_classification(
        config, suite=args.suite, workspace=args.workspace, concurrency=args.concurrency, limit=args.limit
    )
    print("\n".join(run.markdown))
    print(f"results: {run.directory}")


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

    bench = commands.add_parser("bench", help="ingest a suite (or --reuse its last ingestion), measure it, score it")
    bench.add_argument("--suite", required=True)
    bench.add_argument("--reuse", action="store_true", help="skip ingestion: score the suite's last Collection")
    bench.add_argument("--read-images", action="store_true", help="describe pictures (vision model)")
    bench.add_argument("--api-url", default="http://127.0.0.1:8000")
    bench.add_argument("--variants", type=_csv(tuple(VARIANTS)), default=["configured"])
    bench.add_argument("--stages", type=_csv(STAGES), default=["retrieval", "leak"])
    bench.add_argument("--candidates", type=int, help="override BOMESH_RETRIEVAL_CANDIDATE_COUNT")
    bench.add_argument("--top-k", type=int, help="override BOMESH_FINAL_RETRIEVAL_TOP_K")
    bench.add_argument("--no-judge", action="store_true", help="traditional metrics only")
    bench.add_argument("--concurrency", type=int, default=4)

    generate = commands.add_parser("generate", help="draw the suite's questions from its last ingestion")
    generate.add_argument("--suite", required=True)
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

    classify = commands.add_parser("classify", help="score the facet classifier on a labeled suite")
    classify.add_argument("--suite", required=True, help="folder under eval/classification/")
    classify.add_argument("--workspace", required=True, help="workspace code whose published taxonomy is used")
    classify.add_argument("--limit", type=int, help="first N samples only")
    classify.add_argument("--concurrency", type=int, default=4)
    return parser


def main() -> int:
    args = _parser().parse_args()
    if args.concurrency < 1:
        raise SystemExit("--concurrency must be at least one")
    config = load_config(trace=args.trace)
    commands = {"bench": _bench, "generate": _generate, "classify": _classify}
    asyncio.run(commands[args.command](config, args))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
