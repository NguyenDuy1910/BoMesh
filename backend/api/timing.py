"""Browser-measurable API timing (``api_design.md`` "Performance observability").

``Timing-Allow-Origin`` lets a trusted web origin read Resource Timing phases
(DNS, connect, request, response) and ``serverTiming`` of cross-origin API
calls. ``Server-Timing`` carries coarse durations, never counts, resource names
or statement text, so it reveals nothing the total response time does not:

- ``app``: time until the response started (headers of a stream);
- ``db``: cumulative PostgreSQL statement time of the request;
- the fixed stage names a service marked with :func:`bomesh.request_timing.stage`
  (SearchItems: ``visibility``, ``embedding``, ``index``, ``page``,
  ``projection``, ``facets``).
"""

from __future__ import annotations

from contextvars import ContextVar
from dataclasses import dataclass
from time import perf_counter

from sqlalchemy import event
from sqlalchemy.engine import Engine
from starlette.datastructures import Headers, MutableHeaders
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from bomesh.request_timing import recording


@dataclass(slots=True)
class _DatabaseClock:
    seconds: float = 0.0


_clock: ContextVar[_DatabaseClock | None] = ContextVar("bomesh_request_db_clock", default=None)
_STARTED = "_bomesh_started"


@event.listens_for(Engine, "before_cursor_execute")
def _before_execute(conn, cursor, statement, parameters, context, executemany) -> None:  # noqa: ANN001
    if context is not None and _clock.get() is not None:
        setattr(context, _STARTED, perf_counter())


@event.listens_for(Engine, "after_cursor_execute")
def _after_execute(conn, cursor, statement, parameters, context, executemany) -> None:  # noqa: ANN001
    clock = _clock.get()
    started = getattr(context, _STARTED, None) if context is not None else None
    if clock is not None and started is not None:
        clock.seconds += perf_counter() - started


class ApiTimingMiddleware:
    """Add ``Server-Timing`` to every HTTP response and ``Timing-Allow-Origin`` for allowed origins.

    ``origins`` empty means any origin, mirroring CORS ``*`` (identity is only
    the bearer token, so no ambient credential is exposed).
    """

    def __init__(self, app: ASGIApp, *, origins: tuple[str, ...] = ()) -> None:
        self._app = app
        self._origins = frozenset(origins)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self._app(scope, receive, send)
            return
        origin = Headers(scope=scope).get("origin")
        allowed = origin if origin and (not self._origins or origin in self._origins) else None
        clock = _DatabaseClock()
        token = _clock.set(clock)
        started = perf_counter()

        with recording() as stages:

            async def send_with_timing(message: Message) -> None:
                if message["type"] == "http.response.start":
                    headers = MutableHeaders(scope=message)
                    app_ms = (perf_counter() - started) * 1000
                    metrics = [f"app;dur={app_ms:.1f}", f"db;dur={clock.seconds * 1000:.1f}"]
                    metrics.extend(f"{name};dur={seconds * 1000:.1f}" for name, seconds in stages.items())
                    headers.append("Server-Timing", ", ".join(metrics))
                    if allowed is not None:
                        headers["Timing-Allow-Origin"] = allowed
                        headers.add_vary_header("Origin")
                await send(message)

            try:
                await self._app(scope, receive, send_with_timing)
            finally:
                _clock.reset(token)


__all__ = ["ApiTimingMiddleware"]
