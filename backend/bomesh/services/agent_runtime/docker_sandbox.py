"""BoMesh-owned Docker sandbox: warm pool, one container per conversation.

Every Docker call is blocking, so each one runs on this module's own thread
pool and never on the event loop. The container lifecycle is:

* **Warm** — started ahead of demand from the configured image with no
  network, a non-root user, dropped capabilities and memory/CPU/PID limits,
  running ``sleep infinity``. A warm container is pristine: no tenant data has
  ever entered it.
* **Claimed** — a warm container is renamed ``bomesh-sandbox-<session id>``
  and bound to one ``sandbox_sessions`` row. It is never returned to the pool;
  it serves only that conversation until it is removed. Docker labels cannot
  change on a running container, so the name (and the session row's
  ``provider_state.container_id``) is the claim record.
* **Removed** — the reaper removes claimed containers whose session went idle
  past the TTL (and expires the session) or whose session is no longer active.
"""

from __future__ import annotations

import asyncio
import hashlib
import io
import logging
import tarfile
import time
from collections import deque
from collections.abc import Callable, Sequence
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from functools import partial
from typing import Any, TypeVar
from uuid import UUID, uuid4

import docker
from docker.errors import APIError, DockerException, ImageNotFound, NotFound

from bomesh.agent import ShellCommandResult, ShellRun
from bomesh.agent.execution import MAX_SHELL_COMMANDS
from bomesh.services import ArtifactValidationError
from bomesh.services.sandbox_session import SandboxSessionService
from config import SandboxConfig

_log = logging.getLogger(__name__)

PROVIDER = "docker"
SANDBOX_HOME = "/home/sandbox"
SANDBOX_USER = "sandbox"
#: The image's ``sandbox`` user; materialized files are owned by it.
SANDBOX_UID = 1000
MAX_CHANGED_FILES = 50

_LABEL = "bomesh.sandbox"
_POOL_LABEL = "bomesh.pool"
_SPEC_LABEL = "bomesh.spec"
_WARM_PREFIX = "bomesh-warm-"
_CLAIMED_PREFIX = "bomesh-sandbox-"
_RUN_MARKER = "/tmp/.bomesh-run"
#: A claim's session row may not be committed yet; the reaper leaves a freshly
#: claimed container alone for this long.
_CLAIM_GRACE_SECONDS = 120.0
_T = TypeVar("_T")


class SandboxContainerGone(RuntimeError):
    """The bound container no longer exists; the workspace must rebind."""


class _BoundedOutput:
    """Head and tail of one output stream, bounded while it is read."""

    __slots__ = ("_head", "_head_limit", "_tail", "_tail_limit", "_total")

    def __init__(self, limit: int) -> None:
        self._head_limit = max(1, limit * 2 // 5)
        self._tail_limit = max(1, limit - self._head_limit)
        self._head = bytearray()
        self._tail = bytearray()
        self._total = 0

    def add(self, chunk: bytes) -> None:
        self._total += len(chunk)
        room = self._head_limit - len(self._head)
        if room > 0:
            self._head.extend(chunk[:room])
            chunk = chunk[room:]
        if chunk:
            self._tail.extend(chunk)
            overflow = len(self._tail) - self._tail_limit
            if overflow > 0:
                del self._tail[:overflow]

    def text(self) -> str:
        omitted = self._total - len(self._head) - len(self._tail)
        head = self._head.decode("utf-8", "replace")
        tail = self._tail.decode("utf-8", "replace")
        if omitted <= 0:
            return head + tail
        return f"{head}\n…[{omitted} bytes truncated]…\n{tail}"


class DockerSandbox:
    """Process-wide owner of the sandbox containers and their warm pool."""

    provider = PROVIDER

    def __init__(
        self,
        config: SandboxConfig,
        *,
        sessions: SandboxSessionService,
        client_factory: Callable[[], Any] = docker.from_env,
        reap_interval_seconds: float = 60.0,
    ) -> None:
        self._config = config
        self._sessions = sessions
        self._client_factory = client_factory
        self._reap_interval_seconds = reap_interval_seconds
        self._client: Any | None = None
        self._executor = ThreadPoolExecutor(
            max_workers=8, thread_name_prefix="bomesh-sandbox"
        )
        self._pool_id = uuid4().hex[:12]
        self._spec = hashlib.sha256(
            repr(
                (config.image, config.memory, config.cpus, config.pids_limit)
            ).encode()
        ).hexdigest()[:16]
        self._warm: deque[str] = deque()
        self._replenishing: asyncio.Task[None] | None = None
        self._reaper: asyncio.Task[None] | None = None
        self._locks: dict[UUID, asyncio.Lock] = {}
        self._claimed_at: dict[str, float] = {}
        self.guidance = _guidance(config.command_timeout_seconds)
        self.default_timeout_seconds = config.command_timeout_seconds

    @property
    def available(self) -> bool:
        """Whether sandbox tools may be offered; false when Docker is unusable."""

        return self._client is not None

    # -- Lifecycle ------------------------------------------------------------

    async def start(self) -> None:
        """Connect, reconcile containers left by a previous process, fill the pool."""

        if not self._config.enabled:
            _log.info("sandbox disabled by BOMESH_SANDBOX_ENABLED")
            return
        try:
            client = await self._call(self._client_factory)
            await self._call(client.ping)
            await self._call(client.images.get, self._config.image)
        except ImageNotFound:
            _log.warning(
                "sandbox image %s is missing; build it with "
                "`docker build -t %s deployment/sandbox`. Sandbox tools are off.",
                self._config.image,
                self._config.image,
            )
            return
        except DockerException as exc:
            _log.warning("Docker is unavailable (%s); sandbox tools are off.", exc)
            return
        self._client = client
        await self._call(self._adopt_warm)
        try:
            await self.reap_once()
        except Exception:  # noqa: BLE001 - a DB hiccup must not stop startup
            _log.exception("sandbox startup reconciliation failed")
        self._schedule_replenish()
        self._reaper = asyncio.create_task(self._reap_forever())

    async def aclose(self) -> None:
        """Remove idle warm containers; claimed ones stay for reuse within the TTL."""

        for task in (self._reaper, self._replenishing):
            if task is not None and not task.done():
                task.cancel()
                try:
                    await task
                except (asyncio.CancelledError, Exception):  # noqa: BLE001
                    pass
        if self._client is not None:
            warm = tuple(self._warm)
            self._warm.clear()
            for container_id in warm:
                await self._call(self._remove_quietly, container_id)
            await self._call(self._client.close)
            self._client = None
        self._executor.shutdown(wait=False, cancel_futures=True)

    # -- Container binding ----------------------------------------------------

    def lock(self, session_id: UUID) -> asyncio.Lock:
        """Serialize binding work for one session inside this process."""

        return self._locks.setdefault(session_id, asyncio.Lock())

    async def resolve(self, *, session_id: UUID, container_id: str | None) -> str | None:
        """Return the session's running container, restarting a stopped one."""

        return await self._call(self._resolve, _claimed_name(session_id), container_id)

    async def claim(self, *, session_id: UUID) -> str:
        """Bind a warm container to a session, or start one if the pool is empty."""

        name = _claimed_name(session_id)
        container_id: str | None = None
        while self._warm and container_id is None:
            candidate = self._warm.popleft()
            container_id = await self._call(self._rename, candidate, name)
        if container_id is None:
            container_id = await self._call(self._create, name, warm=False)
        self._claimed_at[container_id] = time.monotonic()
        self._schedule_replenish()
        return container_id

    async def discard(self, container_id: str) -> None:
        """Remove a claimed container nobody is bound to."""

        self._claimed_at.pop(container_id, None)
        await self._call(self._remove_quietly, container_id)

    # -- Workspace I/O --------------------------------------------------------

    async def run(
        self, container_id: str, commands: Sequence[str], *, timeout_seconds: int
    ) -> ShellRun:
        """Run commands one after another in the home directory."""

        if not 1 <= len(commands) <= MAX_SHELL_COMMANDS:
            raise ValueError(f"run between 1 and {MAX_SHELL_COMMANDS} commands")
        timeout = max(1, min(timeout_seconds, self._config.command_timeout_seconds))
        budget = max(200, self._config.max_output_characters // len(commands))
        results: list[ShellCommandResult] = []
        for index, command in enumerate(commands):
            results.append(
                await asyncio.wait_for(
                    self._call(
                        self._exec,
                        container_id,
                        command,
                        timeout=timeout,
                        budget=budget,
                        mark=index == 0,
                    ),
                    # The in-container ``timeout`` ends the command; this only
                    # bounds a Docker daemon that stopped answering.
                    timeout=timeout + 30,
                )
            )
        changed = await self._call(self._changed_files, container_id)
        return ShellRun(results=tuple(results), changed_files=changed)

    async def write_files(
        self, container_id: str, files: Sequence[tuple[str, bytes]]
    ) -> None:
        """Copy files into the home directory, owned by the sandbox user."""

        await self._call(self._put_archive, container_id, files)

    async def read_file(self, container_id: str, path: str, *, max_bytes: int) -> bytes:
        """Read one regular file below the home directory, size-capped."""

        return await self._call(self._get_archive, container_id, path, max_bytes)

    # -- Maintenance ----------------------------------------------------------

    async def reap_once(self) -> None:
        """Expire idle sessions and remove every claimed container without one."""

        if self._client is None:
            return
        cutoff = datetime.now(UTC) - timedelta(seconds=self._config.idle_ttl_seconds)
        for container_id in await self._sessions.expire_idle(
            provider=PROVIDER, idle_before=cutoff
        ):
            await self.discard(container_id)
        bound = await self._sessions.active_container_ids(provider=PROVIDER)
        now = time.monotonic()
        for container_id in await self._call(self._claimed_ids):
            claimed_at = self._claimed_at.get(container_id)
            if container_id in bound or (
                claimed_at is not None and now - claimed_at < _CLAIM_GRACE_SECONDS
            ):
                continue
            await self.discard(container_id)

    async def _reap_forever(self) -> None:
        while True:
            await asyncio.sleep(self._reap_interval_seconds)
            try:
                await self.reap_once()
            except Exception:  # noqa: BLE001 - the reaper must keep running
                _log.exception("sandbox reaper pass failed")

    def _schedule_replenish(self) -> None:
        if self._client is None or (
            self._replenishing is not None and not self._replenishing.done()
        ):
            return
        self._replenishing = asyncio.create_task(self._replenish())

    async def _replenish(self) -> None:
        while self._client is not None and len(self._warm) < self._config.warm_pool_size:
            try:
                container_id = await self._call(
                    self._create, f"{_WARM_PREFIX}{uuid4().hex[:12]}", warm=True
                )
            except DockerException:
                _log.exception("could not start a warm sandbox container")
                return
            self._warm.append(container_id)

    async def _call(self, function: Callable[..., _T], *args: Any, **kwargs: Any) -> _T:
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(
            self._executor, partial(function, *args, **kwargs)
        )

    # -- Blocking Docker operations (executor threads only) ------------------

    def _docker(self) -> Any:
        if self._client is None:
            raise SandboxContainerGone("the sandbox is not running")
        return self._client

    def _create(self, name: str, *, warm: bool) -> str:
        labels = {_LABEL: "1", _SPEC_LABEL: self._spec}
        if warm:
            labels[_POOL_LABEL] = self._pool_id
        client = self._docker()
        try:
            container = self._run_container(client, name, labels)
        except APIError as exc:
            if exc.status_code != 409:
                raise
            # A stopped leftover holds the name; the session has no use for it.
            self._remove_quietly(name)
            container = self._run_container(client, name, labels)
        return str(container.id)

    def _run_container(self, client: Any, name: str, labels: dict[str, str]) -> Any:
        config = self._config
        return client.containers.run(
            config.image,
            command=["sleep", "infinity"],
            name=name,
            detach=True,
            init=True,
            user=SANDBOX_USER,
            working_dir=SANDBOX_HOME,
            network_mode="none",
            mem_limit=config.memory,
            memswap_limit=config.memory,
            nano_cpus=int(config.cpus * 1_000_000_000),
            pids_limit=config.pids_limit,
            cap_drop=["ALL"],
            security_opt=["no-new-privileges"],
            privileged=False,
            labels=labels,
        )

    def _rename(self, container_id: str, name: str) -> str | None:
        client = self._docker()
        try:
            container = client.containers.get(container_id)
            if container.status != "running":
                container.remove(force=True)
                return None
            try:
                container.rename(name)
            except APIError as exc:
                if exc.status_code != 409:
                    raise
                self._remove_quietly(name)
                container.rename(name)
        except NotFound:
            return None
        return str(container.id)

    def _resolve(self, name: str, container_id: str | None) -> str | None:
        client = self._docker()
        for reference in (container_id, name):
            if reference is None:
                continue
            try:
                container = client.containers.get(reference)
            except NotFound:
                continue
            # A container is only ever reused by the session it was claimed for.
            if container.name != name:
                continue
            if container.status != "running":
                try:
                    container.start()
                except APIError:
                    self._remove_quietly(container.id)
                    return None
            return str(container.id)
        return None

    def _exec(
        self,
        container_id: str,
        command: str,
        *,
        timeout: int,
        budget: int,
        mark: bool,
    ) -> ShellCommandResult:
        api = self._docker().api
        argv = ["timeout", "-k", "2", str(timeout), "bash", "-lc", command]
        if mark:
            # The first command also stamps the batch start for changed files.
            argv = ["sh", "-c", f'touch {_RUN_MARKER} && exec "$@"', "sh", *argv]
        try:
            exec_id = api.exec_create(
                container_id, argv, user=SANDBOX_USER, workdir=SANDBOX_HOME
            )["Id"]
            stdout = _BoundedOutput(budget // 2)
            stderr = _BoundedOutput(budget - budget // 2)
            started = time.monotonic()
            for out, err in api.exec_start(exec_id, stream=True, demux=True):
                if out:
                    stdout.add(out)
                if err:
                    stderr.add(err)
            elapsed = time.monotonic() - started
            exit_code = api.exec_inspect(exec_id).get("ExitCode")
        except NotFound as exc:
            raise SandboxContainerGone("the sandbox container is gone") from exc
        except APIError as exc:
            if exc.status_code == 409:  # not running
                raise SandboxContainerGone("the sandbox container stopped") from exc
            raise
        timed_out = exit_code in (124, 137) and elapsed >= timeout - 0.5
        return ShellCommandResult(
            command=command,
            stdout=stdout.text(),
            stderr=stderr.text(),
            exit_code=None if timed_out else int(exit_code if exit_code is not None else -1),
            timed_out=timed_out,
        )

    def _changed_files(self, container_id: str) -> tuple[str, ...]:
        api = self._docker().api
        try:
            exec_id = api.exec_create(
                container_id,
                [
                    "find", SANDBOX_HOME, "-xdev", "-type", "f",
                    "-newer", _RUN_MARKER, "-not", "-path", "*/.*",
                    "-printf", "%P\\n",
                ],
                user=SANDBOX_USER,
            )["Id"]
            output = api.exec_start(exec_id)
        except (NotFound, APIError):
            return ()
        lines = output.decode("utf-8", "replace").splitlines() if output else []
        return tuple(sorted(line for line in lines if line)[:MAX_CHANGED_FILES])

    def _put_archive(self, container_id: str, files: Sequence[tuple[str, bytes]]) -> None:
        buffer = io.BytesIO()
        now = time.time()
        with tarfile.open(fileobj=buffer, mode="w") as archive:
            for path, data in files:
                info = tarfile.TarInfo(name=path)
                info.size = len(data)
                info.mode = 0o644
                info.uid = info.gid = SANDBOX_UID
                info.mtime = now
                archive.addfile(info, io.BytesIO(data))
        try:
            if not self._docker().api.put_archive(
                container_id, SANDBOX_HOME, buffer.getvalue()
            ):
                raise RuntimeError("sandbox rejected the file copy")
        except NotFound as exc:
            raise SandboxContainerGone("the sandbox container is gone") from exc

    def _get_archive(self, container_id: str, path: str, max_bytes: int) -> bytes:
        api = self._docker().api
        try:
            stream, stat = api.get_archive(container_id, f"{SANDBOX_HOME}/{path}")
        except NotFound as exc:
            try:
                api.inspect_container(container_id)
            except NotFound:
                raise SandboxContainerGone("the sandbox container is gone") from exc
            raise ArtifactValidationError(
                f"{path} does not exist in the sandbox home directory; write the "
                "file under ~ and export it by its path relative to ~"
            ) from exc
        mode = int(stat.get("mode", 0))
        # Go's FileMode marks directories, symlinks, devices, … in high bits.
        if mode & 0xFFF00000:
            raise ArtifactValidationError(f"{path} is not a regular file")
        if int(stat.get("size", 0)) > max_bytes:
            raise ArtifactValidationError(
                f"{path} exceeds the {max_bytes} byte export limit"
            )
        archive_bytes = bytearray()
        for chunk in stream:
            archive_bytes += chunk
            if len(archive_bytes) > max_bytes + 64 * 1024:
                raise ArtifactValidationError(
                    f"{path} exceeds the {max_bytes} byte export limit"
                )
        with tarfile.open(fileobj=io.BytesIO(bytes(archive_bytes))) as archive:
            member = next(iter(archive.getmembers()), None)
            if member is None or not member.isfile():
                raise ArtifactValidationError(f"{path} is not a regular file")
            extracted = archive.extractfile(member)
            if extracted is None:
                raise ArtifactValidationError(f"{path} is not a regular file")
            return extracted.read()

    def _adopt_warm(self) -> None:
        """Keep pristine warm containers of the current spec; remove the rest."""

        client = self._docker()
        for container in client.containers.list(
            all=True, filters={"label": f"{_LABEL}=1"}
        ):
            if not container.name.startswith(_WARM_PREFIX):
                continue
            if (
                container.status == "running"
                and container.labels.get(_SPEC_LABEL) == self._spec
                and len(self._warm) < self._config.warm_pool_size
            ):
                self._warm.append(str(container.id))
            else:
                self._remove_quietly(container.id)

    def _claimed_ids(self) -> tuple[str, ...]:
        client = self._docker()
        return tuple(
            str(container.id)
            for container in client.containers.list(
                all=True, filters={"label": f"{_LABEL}=1"}
            )
            if container.name.startswith(_CLAIMED_PREFIX)
        )

    def _remove_quietly(self, reference: str) -> None:
        try:
            self._docker().containers.get(reference).remove(force=True)
        except (NotFound, SandboxContainerGone):
            pass
        except APIError:
            _log.warning("could not remove sandbox container %s", reference)


def _claimed_name(session_id: UUID) -> str:
    return f"{_CLAIMED_PREFIX}{session_id}"


def _guidance(timeout_seconds: int) -> str:
    return (
        "run_shell runs bash commands in this conversation's private Linux "
        f"sandbox (Debian, Python 3.12). The working directory is {SANDBOX_HOME}, "
        "which is also ~. There is no internet access, so nothing can be "
        "installed; use python3 with the installed libraries: pandas, numpy, "
        "openpyxl, xlsxwriter, matplotlib (headless), python-docx, python-pptx, "
        "pypdf, reportlab, pillow and tabulate. Files under ~ persist across "
        "this conversation's turns while it stays in use. "
        "materialize_sandbox_resource copies an available file into ~ and "
        "returns its path. The user cannot see sandbox files: to deliver one, "
        "write it under ~ and call export_sandbox_file with its path relative "
        f"to ~. Each command may run for at most {timeout_seconds} seconds; "
        "long output is truncated, so print summaries rather than whole files."
    )


__all__ = [
    "PROVIDER",
    "SANDBOX_HOME",
    "DockerSandbox",
    "SandboxContainerGone",
]
