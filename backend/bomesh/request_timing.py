"""Named stage durations of the current request, reported as ``Server-Timing`` metrics.

The API's timing middleware opens a recording per HTTP request
(:func:`recording`); services mark coarse stages with :func:`stage`. Outside a
recording (workers, tests calling services directly) :func:`stage` only runs
its block. Durations of one stage name add up within the request.
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from time import perf_counter

_stages: ContextVar[dict[str, float] | None] = ContextVar("bomesh_request_stages", default=None)


@contextmanager
def recording() -> Iterator[dict[str, float]]:
    """Collect the stages run inside the block: name → seconds, in first-run order."""
    stages: dict[str, float] = {}
    token = _stages.set(stages)
    try:
        yield stages
    finally:
        _stages.reset(token)


@contextmanager
def stage(name: str) -> Iterator[None]:
    """Time the block as ``name`` when a recording is open."""
    stages = _stages.get()
    if stages is None:
        yield
        return
    started = perf_counter()
    try:
        yield
    finally:
        stages[name] = stages.get(name, 0.0) + perf_counter() - started


__all__ = ["recording", "stage"]
