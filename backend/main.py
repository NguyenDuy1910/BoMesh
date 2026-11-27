"""Executable bootstrap for the BoMesh HTTP application.

``python main.py`` runs the API and supervises the ingestion worker;
``python main.py --api-only`` runs the API alone, for a worker that runs on its
own (``make worker``: the ingestion-worker container).
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import subprocess
import sys
from contextlib import suppress
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[1]


async def main(*, with_worker: bool) -> None:
    """Serve the local API; supervise its managed-ingestion worker unless it runs elsewhere."""

    import uvicorn

    from api.app import create_app
    from config import get_config

    server_config = get_config().server
    logging.basicConfig(
        level=server_config.log_level,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)

    server = uvicorn.Server(
        uvicorn.Config(create_app(), host=server_config.host, port=server_config.port)
    )
    if not with_worker:
        await server.serve()
        return
    worker = await asyncio.create_subprocess_exec(
        sys.executable,
        "-m",
        "bomesh.services.ingestion.worker",  # [temporal-disabled] was bomesh.services.workflow.worker
        cwd=Path(__file__).parent,
        start_new_session=True,  # Ctrl-C reaches the API; the supervisor stops the worker.
    )
    api_task = asyncio.create_task(server.serve())
    worker_task = asyncio.create_task(worker.wait())
    try:
        done, _ = await asyncio.wait(
            (api_task, worker_task), return_when=asyncio.FIRST_COMPLETED
        )
        if worker_task in done and not api_task.done():
            server.should_exit = True
            await api_task
            raise RuntimeError(f"Ingestion worker exited ({worker.returncode})")
        await api_task
    finally:
        if worker.returncode is None:
            worker.terminate()
            try:
                await asyncio.wait_for(worker.wait(), timeout=15)
            except asyncio.TimeoutError:
                worker.kill()
                await worker.wait()
        worker_task.cancel()
        with suppress(asyncio.CancelledError):
            await worker_task
        if not api_task.done():
            server.should_exit = True
            await api_task


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Run the local BoMesh API.")
    parser.add_argument(
        "--api-only",
        action="store_true",
        help="do not start the ingestion worker (it runs on its own: make worker)",
    )
    arguments = parser.parse_args()
    # Reuse the non-destructive local bootstrap: dependencies and the bucket.
    # Configuration is loaded after make config.
    subprocess.run(["make", "services"], cwd=ROOT, check=True)
    load_dotenv(ROOT / ".env", override=False)
    with suppress(KeyboardInterrupt):
        asyncio.run(main(with_worker=not arguments.api_only))
