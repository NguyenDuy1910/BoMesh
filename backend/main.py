"""Executable bootstrap for the BoMesh HTTP application."""

from __future__ import annotations

import asyncio
import logging
import subprocess
import sys
from contextlib import suppress
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[1]


async def main() -> None:
    """Supervise the local API and its managed-ingestion worker."""

    import uvicorn

    from api.app import app
    from config import get_config

    server_config = get_config().server
    logging.basicConfig(
        level=server_config.log_level,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)

    worker = await asyncio.create_subprocess_exec(
        sys.executable,
        "-m",
        "bomesh.services.workflow.worker",
        cwd=Path(__file__).parent,
        start_new_session=True,  # Ctrl-C reaches the API; the supervisor stops the worker.
    )
    server = uvicorn.Server(
        uvicorn.Config(app, host=server_config.host, port=server_config.port)
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
            raise RuntimeError(f"Temporal ingestion worker exited ({worker.returncode})")
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
    # Reuse the non-destructive local bootstrap: dependencies, bucket, and
    # Temporal search attributes. Configuration is loaded after make config.
    subprocess.run(["make", "services"], cwd=ROOT, check=True)
    load_dotenv(ROOT / ".env", override=False)
    with suppress(KeyboardInterrupt):
        asyncio.run(main())
