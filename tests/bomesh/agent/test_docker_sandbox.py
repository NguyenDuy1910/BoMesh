"""The Docker sandbox: warm pool, per-conversation reuse, limits and file I/O.

Unit tests drive the real ``DockerSandbox`` and ``SandboxWorkspace`` over an
in-memory Docker client and session store. One integration test runs against
the local Docker daemon when it and the sandbox image are available.
"""

from __future__ import annotations

import asyncio
import io
import json
import sys
import tarfile
import time
from dataclasses import replace
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

import pytest

_TESTS_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(_TESTS_ROOT.parent / "backend"))

from docker.errors import NotFound

from bomesh.agent import ResourceRef, ShellCommandResult, ShellRun
from bomesh.agent.tools.run_shell import _render
from bomesh.services import (
    ArtifactValidationError,
    AuthContext,
    SandboxManifestResource,
    SandboxMaterializedFile,
    SandboxSessionState,
)
from bomesh.services.agent_runtime.docker_sandbox import DockerSandbox
from bomesh.services.agent_runtime.sandbox_workspace import (
    SandboxWorkspace,
    sandbox_path,
)
from bomesh.services.artifact import WorkspaceSource
from config import SandboxConfig


# -- In-memory Docker -----------------------------------------------------------


class FakeContainer:
    def __init__(self, client: FakeDocker, name: str, labels: dict[str, str]) -> None:
        self._client = client
        self.id = uuid4().hex
        self.name = name
        self.labels = labels
        self.status = "running"
        self.files: dict[str, bytes] = {}

    def rename(self, name: str) -> None:
        self.name = name

    def remove(self, force: bool = False) -> None:
        self._client.removed.append(self.id)
        self._client.containers_by_id.pop(self.id, None)

    def start(self) -> None:
        self.status = "running"


class FakeContainers:
    def __init__(self, client: FakeDocker) -> None:
        self._client = client

    def run(self, image: str, **kwargs: Any) -> FakeContainer:
        self._client.run_kwargs.append(kwargs)
        container = FakeContainer(self._client, kwargs["name"], dict(kwargs["labels"]))
        self._client.containers_by_id[container.id] = container
        return container

    def get(self, reference: str) -> FakeContainer:
        for container in self._client.containers_by_id.values():
            if reference in (container.id, container.name):
                return container
        raise NotFound(f"no container {reference}")

    def list(self, all: bool = False, filters: dict[str, Any] | None = None) -> list[FakeContainer]:
        return list(self._client.containers_by_id.values())


class FakeApi:
    """The low-level exec/archive calls ``DockerSandbox`` makes."""

    def __init__(self, client: FakeDocker) -> None:
        self._client = client
        self._execs: dict[str, tuple[str, list[str]]] = {}
        self._exit: dict[str, int] = {}

    def _container(self, container_id: str) -> FakeContainer:
        container = self._client.containers_by_id.get(container_id)
        if container is None:
            raise NotFound("gone")
        return container

    def exec_create(self, container_id: str, argv: list[str], **_: Any) -> dict[str, str]:
        self._container(container_id)
        exec_id = uuid4().hex
        self._execs[exec_id] = (container_id, argv)
        return {"Id": exec_id}

    def exec_start(self, exec_id: str, stream: bool = False, demux: bool = False) -> Any:
        container_id, argv = self._execs[exec_id]
        if argv[0] == "find":
            return b"report.csv\n"
        command = argv[-1]
        self._client.commands.append((container_id, command))
        stdout, stderr, exit_code, delay = self._client.script.get(command, (b"", b"", 0, 0.0))
        if delay:
            time.sleep(delay)
        self._exit[exec_id] = exit_code
        return iter([(stdout, None), (None, stderr)])

    def exec_inspect(self, exec_id: str) -> dict[str, int]:
        return {"ExitCode": self._exit[exec_id]}

    def put_archive(self, container_id: str, path: str, data: bytes) -> bool:
        container = self._container(container_id)
        with tarfile.open(fileobj=io.BytesIO(data)) as archive:
            for member in archive.getmembers():
                extracted = archive.extractfile(member)
                assert extracted is not None
                assert (member.uid, member.mode) == (1000, 0o644)
                container.files[member.name] = extracted.read()
        return True

    def get_archive(self, container_id: str, path: str) -> tuple[Any, dict[str, int]]:
        container = self._container(container_id)
        name = path.removeprefix("/home/sandbox/")
        if name not in container.files:
            raise NotFound("no such file")
        data = container.files[name]
        buffer = io.BytesIO()
        with tarfile.open(fileobj=buffer, mode="w") as archive:
            info = tarfile.TarInfo(name=Path(name).name)
            info.size = len(data)
            archive.addfile(info, io.BytesIO(data))
        return iter([buffer.getvalue()]), {"size": len(data), "mode": 0o644}

    def inspect_container(self, container_id: str) -> dict[str, str]:
        self._container(container_id)
        return {"Id": container_id}


class FakeDocker:
    def __init__(self) -> None:
        self.containers_by_id: dict[str, FakeContainer] = {}
        self.run_kwargs: list[dict[str, Any]] = []
        self.removed: list[str] = []
        self.commands: list[tuple[str, str]] = []
        self.script: dict[str, tuple[bytes, bytes, int, float]] = {}
        self.containers = FakeContainers(self)
        self.api = FakeApi(self)
        self.images = type("Images", (), {"get": staticmethod(lambda image: image)})()

    def ping(self) -> bool:
        return True

    def close(self) -> None:
        return None

    def claimed(self) -> list[FakeContainer]:
        return [
            container
            for container in self.containers_by_id.values()
            if container.name.startswith("bomesh-sandbox-")
        ]

    def warm(self) -> list[FakeContainer]:
        return [
            container
            for container in self.containers_by_id.values()
            if container.name.startswith("bomesh-warm-")
        ]


# -- In-memory session store and artifacts -------------------------------------


class FakeSessions:
    def __init__(self) -> None:
        self.active_rows: dict[UUID, SandboxSessionState] = {}
        self.expired_rows: dict[UUID, SandboxSessionState] = {}
        self.idle: set[UUID] = set()

    def _conversation_of(self, session_id: UUID) -> UUID:
        return next(key for key, row in self.active_rows.items() if row.id == session_id)

    async def active(self, _: AuthContext, *, conversation_id: UUID, provider: str):
        return self.active_rows.get(conversation_id)

    async def recoverable(self, _: AuthContext, *, conversation_id: UUID, provider: str):
        return self.expired_rows.get(conversation_id)

    async def ensure(self, _: AuthContext, *, conversation_id: UUID, provider: str):
        if conversation_id not in self.active_rows:
            self.active_rows[conversation_id] = SandboxSessionState(
                id=uuid4(), provider=provider, status="active"
            )
        return self.active_rows[conversation_id]

    async def bind_container(
        self, _: AuthContext, *, session_id: UUID, container_id: str, replaces: str | None
    ):
        conversation = self._conversation_of(session_id)
        row = self.active_rows[conversation]
        if row.container_id == replaces:
            row = replace(row, container_id=container_id, materialized_files=())
            self.active_rows[conversation] = row
        return row

    async def record_materialization(
        self,
        _: AuthContext,
        *,
        session_id: UUID,
        container_id: str,
        resource: SandboxManifestResource,
        files: tuple[SandboxMaterializedFile, ...],
    ):
        conversation = self._conversation_of(session_id)
        row = self.active_rows[conversation]
        manifest = row.manifest
        if all(item.resource_id != resource.resource_id for item in manifest):
            manifest = (*manifest, resource)
        row = replace(row, manifest=manifest, materialized_files=(*row.materialized_files, *files))
        self.active_rows[conversation] = row
        return row

    async def record_resource(
        self, _: AuthContext, *, session_id: UUID, resource: SandboxManifestResource
    ):
        conversation = self._conversation_of(session_id)
        row = self.active_rows[conversation]
        row = replace(row, manifest=(*row.manifest, resource))
        self.active_rows[conversation] = row
        return row

    async def expire_idle(self, *, provider: str, idle_before: Any) -> tuple[str, ...]:
        expired: list[str] = []
        for conversation in tuple(self.idle):
            row = self.active_rows.pop(conversation)
            self.expired_rows[conversation] = replace(row, status="expired")
            if row.container_id is not None:
                expired.append(row.container_id)
        self.idle.clear()
        return tuple(expired)

    async def active_container_ids(self, *, provider: str) -> frozenset[str]:
        return frozenset(
            row.container_id for row in self.active_rows.values() if row.container_id
        )


class FakeArtifacts:
    def __init__(self, sources: dict[str, WorkspaceSource] | None = None) -> None:
        self.sources = sources or {}
        self.generated: list[dict[str, Any]] = []

    async def source_file(self, _: AuthContext, document_id: UUID) -> WorkspaceSource:
        return self.sources[str(document_id)]

    async def record_generated(self, _: AuthContext, **fields: Any) -> dict[str, object]:
        self.generated.append(fields)
        return {
            "id": str(UUID(int=44)),
            "title": fields["file_name"],
            "file_name": fields["file_name"].rsplit("/", 1)[-1],
            "mime_type": fields["mime_type"],
            "size_bytes": len(fields["data"]),
            "revision": len(self.generated),
            "updated_at": "2026-10-15T00:00:00Z",
        }


def _access() -> AuthContext:
    return AuthContext(
        user_id=uuid4(),
        email="owner@example.com",
        display_name=None,
        tenant_id=uuid4(),
        permission_codes=("knowledge.read",),
        group_ids=(),
        role_codes=("member",),
    )


async def _started(
    docker: Any, sessions: FakeSessions, **overrides: Any
) -> DockerSandbox:
    sandbox = DockerSandbox(
        SandboxConfig(**{"warm_pool_size": 2, **overrides}),
        sessions=sessions,  # type: ignore[arg-type]
        client_factory=lambda: docker,
        reap_interval_seconds=3600,
    )
    await sandbox.start()
    await _pool_filled(docker, overrides.get("warm_pool_size", 2))
    return sandbox


async def _pool_filled(docker: FakeDocker, size: int) -> None:
    for _ in range(200):
        if len(docker.warm()) >= size:
            return
        await asyncio.sleep(0.01)
    raise AssertionError("warm pool was not replenished")


def _workspace(
    sandbox: DockerSandbox,
    sessions: FakeSessions,
    conversation_id: UUID,
    artifacts: FakeArtifacts | None = None,
) -> SandboxWorkspace:
    return SandboxWorkspace(
        access=_access(),
        conversation_id=conversation_id,
        request_id="r" * 32,
        sandbox=sandbox,
        sessions=sessions,  # type: ignore[arg-type]
        artifacts=artifacts or FakeArtifacts(),  # type: ignore[arg-type]
        max_export_bytes=1024,
    )


# -- Pool and reuse -------------------------------------------------------------


@pytest.mark.asyncio
async def test_a_claimed_container_is_never_reused_by_another_conversation() -> None:
    docker, sessions = FakeDocker(), FakeSessions()
    sandbox = await _started(docker, sessions)
    first_conversation, second_conversation = uuid4(), uuid4()
    try:
        warm_before = {container.id for container in docker.warm()}
        await _workspace(sandbox, sessions, first_conversation).run_commands(
            ("echo a",), timeout_seconds=None
        )
        await _workspace(sandbox, sessions, second_conversation).run_commands(
            ("echo b",), timeout_seconds=None
        )
        await _pool_filled(docker, 2)

        first = sessions.active_rows[first_conversation].container_id
        second = sessions.active_rows[second_conversation].container_id
        # Both claims were served warm: no container was started on the request.
        assert {first, second} == warm_before
        assert first != second
        # The pool was replenished with fresh containers, never the claimed ones.
        assert {container.id for container in docker.warm()}.isdisjoint({first, second})
        assert {container.name for container in docker.claimed()} == {
            f"bomesh-sandbox-{sessions.active_rows[first_conversation].id}",
            f"bomesh-sandbox-{sessions.active_rows[second_conversation].id}",
        }
    finally:
        await sandbox.aclose()


@pytest.mark.asyncio
async def test_the_same_conversation_reuses_its_container_across_requests() -> None:
    docker, sessions = FakeDocker(), FakeSessions()
    sandbox = await _started(docker, sessions)
    conversation = uuid4()
    try:
        await _workspace(sandbox, sessions, conversation).run_commands(
            ("echo one",), timeout_seconds=None
        )
        await _pool_filled(docker, 2)
        started = len(docker.run_kwargs)
        await _workspace(sandbox, sessions, conversation).run_commands(
            ("echo two",), timeout_seconds=None
        )

        container = sessions.active_rows[conversation].container_id
        assert [command for _, command in docker.commands] == ["echo one", "echo two"]
        assert {owner for owner, _ in docker.commands} == {container}
        assert len(docker.run_kwargs) == started
    finally:
        await sandbox.aclose()


@pytest.mark.asyncio
async def test_containers_are_isolated_and_resource_limited() -> None:
    docker, sessions = FakeDocker(), FakeSessions()
    sandbox = await _started(docker, sessions, warm_pool_size=1, memory="512m", cpus=0.5)
    try:
        kwargs = docker.run_kwargs[0]
        assert kwargs["network_mode"] == "none"
        assert kwargs["user"] == "sandbox"
        assert kwargs["cap_drop"] == ["ALL"]
        assert kwargs["security_opt"] == ["no-new-privileges"]
        assert kwargs["privileged"] is False
        assert (kwargs["mem_limit"], kwargs["nano_cpus"], kwargs["pids_limit"]) == (
            "512m",
            500_000_000,
            256,
        )
        assert kwargs["command"] == ["sleep", "infinity"]
        assert kwargs["labels"]["bomesh.sandbox"] == "1"
    finally:
        await sandbox.aclose()


@pytest.mark.asyncio
async def test_a_lost_container_is_rebuilt_from_the_durable_manifest() -> None:
    docker, sessions = FakeDocker(), FakeSessions()
    revenue_id = str(UUID(int=33))
    artifacts = FakeArtifacts({
        revenue_id: WorkspaceSource(
            document_id=revenue_id, title="Revenue", file_name="revenue.csv",
            mime_type="text/csv", data=b"month,total\nJan,10\n",
        ),
    })
    sandbox = await _started(docker, sessions)
    conversation = uuid4()
    try:
        workspace = _workspace(sandbox, sessions, conversation, artifacts)
        materialized = await workspace.materialize_resource(
            ResourceRef(id=revenue_id, name="revenue.csv", mime_type="text/csv")
        )
        old = sessions.active_rows[conversation].container_id
        docker.containers.get(old).remove(force=True)

        await _workspace(sandbox, sessions, conversation, artifacts).run_commands(
            ("cat revenue.csv",), timeout_seconds=None
        )

        new = sessions.active_rows[conversation].container_id
        assert materialized.paths == ("~/revenue.csv",)
        assert new != old
        assert docker.containers.get(new).files == {"revenue.csv": b"month,total\nJan,10\n"}
    finally:
        await sandbox.aclose()


@pytest.mark.asyncio
async def test_the_reaper_removes_idle_containers_and_orphans() -> None:
    docker, sessions = FakeDocker(), FakeSessions()
    sandbox = await _started(docker, sessions)
    idle_conversation = uuid4()
    try:
        await _workspace(sandbox, sessions, idle_conversation).run_commands(
            ("true",), timeout_seconds=None
        )
        idle = sessions.active_rows[idle_conversation].container_id
        sessions.idle.add(idle_conversation)

        await sandbox.reap_once()

        assert idle in docker.removed
        assert idle_conversation in sessions.expired_rows
        assert docker.claimed() == []
    finally:
        await sandbox.aclose()


@pytest.mark.asyncio
async def test_without_docker_the_sandbox_is_simply_unavailable() -> None:
    def broken() -> Any:
        from docker.errors import DockerException

        raise DockerException("no daemon")

    sandbox = DockerSandbox(
        SandboxConfig(), sessions=FakeSessions(), client_factory=broken  # type: ignore[arg-type]
    )
    await sandbox.start()
    try:
        assert sandbox.available is False
    finally:
        await sandbox.aclose()


# -- Commands and output --------------------------------------------------------


@pytest.mark.asyncio
async def test_a_command_past_its_timeout_reports_timed_out() -> None:
    docker, sessions = FakeDocker(), FakeSessions()
    docker.script["sleep 5"] = (b"", b"", 124, 0.6)
    docker.script["echo after"] = (b"after\n", b"", 0, 0.0)
    sandbox = await _started(docker, sessions)
    try:
        run = await _workspace(sandbox, sessions, uuid4()).run_commands(
            ("sleep 5", "echo after"), timeout_seconds=1
        )

        assert run.results[0].timed_out is True
        assert run.results[0].exit_code is None
        assert run.results[1] == ShellCommandResult(
            command="echo after", stdout="after\n", stderr="", exit_code=0
        )
        assert run.failed is True
        assert run.changed_files == ("report.csv",)
    finally:
        await sandbox.aclose()


@pytest.mark.asyncio
async def test_long_output_keeps_its_head_and_tail_within_the_budget() -> None:
    docker, sessions = FakeDocker(), FakeSessions()
    noisy = b"START" + b"x" * 50_000 + b"END"
    docker.script["python3 noisy.py"] = (noisy, b"Traceback\nValueError: bad\n", 1, 0.0)
    sandbox = await _started(docker, sessions, max_output_characters=2_000)
    try:
        run = await _workspace(sandbox, sessions, uuid4()).run_commands(
            ("python3 noisy.py",), timeout_seconds=None
        )

        result = run.results[0]
        assert result.stdout.startswith("START")
        assert result.stdout.endswith("END")
        assert "bytes truncated" in result.stdout
        assert len(result.stdout) < 1_100
        assert result.stderr == "Traceback\nValueError: bad\n"
        assert result.exit_code == 1
    finally:
        await sandbox.aclose()


def test_the_run_shell_observation_is_json_that_fits_the_tool_budget() -> None:
    run = ShellRun(
        results=(
            ShellCommandResult(command="a", stdout="\n" * 6_000, stderr="", exit_code=0),
            ShellCommandResult(command="b", stdout="", stderr='"' * 6_000, exit_code=2),
        ),
        changed_files=("out.csv",),
    )

    rendered = _render(run, 2_000)
    payload = json.loads(rendered)

    assert len(rendered) <= 2_000
    assert [result["exit_code"] for result in payload["results"]] == [0, 2]
    assert payload["changed_files"] == ["out.csv"]
    assert "truncated" in payload["results"][1]["stderr"]


# -- Paths and export -----------------------------------------------------------


@pytest.mark.parametrize(
    "path",
    ["../etc/passwd", "/etc/passwd", "out/../../x", "~/../x", "a//b", "", "a\\b", "x\x00"],
)
def test_sandbox_paths_cannot_escape_the_home_directory(path: str) -> None:
    with pytest.raises(ArtifactValidationError):
        sandbox_path(path)


def test_home_relative_spellings_name_the_same_file() -> None:
    assert sandbox_path("~/out/report.csv") == "out/report.csv"
    assert sandbox_path("/home/sandbox/out/report.csv") == "out/report.csv"
    assert sandbox_path(" out/report.csv ") == "out/report.csv"


@pytest.mark.asyncio
async def test_export_reads_a_home_file_and_rejects_oversized_or_missing_ones() -> None:
    docker, sessions = FakeDocker(), FakeSessions()
    artifacts = FakeArtifacts()
    sandbox = await _started(docker, sessions)
    conversation = uuid4()
    try:
        workspace = _workspace(sandbox, sessions, conversation, artifacts)
        with pytest.raises(ArtifactValidationError, match="no files yet"):
            await workspace.promote_file("report.csv", summary="Saved")
        await workspace.run_commands(("true",), timeout_seconds=None)
        container = docker.containers.get(sessions.active_rows[conversation].container_id)
        container.files["out/report.csv"] = b"month,total\n"
        container.files["big.bin"] = b"0" * 2_048

        exported = await workspace.promote_file("~/out/report.csv", summary="Saved")

        assert artifacts.generated[0]["data"] == b"month,total\n"
        assert exported.name == "report.csv"
        assert workspace.artifacts == (exported,)
        with pytest.raises(ArtifactValidationError, match="export limit"):
            await workspace.promote_file("big.bin", summary="Saved")
        with pytest.raises(ArtifactValidationError, match="does not exist"):
            await workspace.promote_file("missing.csv", summary="Saved")
    finally:
        await sandbox.aclose()


# -- Real Docker ----------------------------------------------------------------


def _docker_with_image() -> bool:
    try:
        import docker

        client = docker.from_env()
        try:
            client.images.get(SandboxConfig().image)
        finally:
            client.close()
    except Exception:  # noqa: BLE001 - no daemon or no image: skip
        return False
    return True


@pytest.mark.asyncio
@pytest.mark.skipif(not _docker_with_image(), reason="Docker and the sandbox image are required")
async def test_real_docker_claim_run_python_and_export() -> None:
    sessions = FakeSessions()
    artifacts = FakeArtifacts()
    sandbox = DockerSandbox(
        SandboxConfig(warm_pool_size=1), sessions=sessions  # type: ignore[arg-type]
    )
    await sandbox.start()
    conversation = uuid4()
    try:
        assert sandbox.available
        for _ in range(300):
            if sandbox._warm:  # noqa: SLF001 - wait for the warm container
                break
            await asyncio.sleep(0.1)
        workspace = _workspace(sandbox, sessions, conversation, artifacts)
        workspace._max_export_bytes = 1_000_000  # noqa: SLF001

        started = time.monotonic()
        run = await workspace.run_commands(
            (
                "python3 -c \"import pandas as pd; pd.DataFrame({'a': [1, 2]})"
                ".to_csv('out.csv', index=False); print('ok')\"",
                "python3 -c \"import urllib.request; urllib.request.urlopen("
                "'https://example.com', timeout=2)\" 2>/dev/null || echo offline",
                "whoami",
            ),
            timeout_seconds=30,
        )
        first_call_seconds = time.monotonic() - started
        exported = await workspace.promote_file("out.csv", summary="Saved")
        again = await _workspace(sandbox, sessions, conversation, artifacts).run_commands(
            ("cat out.csv",), timeout_seconds=None
        )

        assert run.results[0].stdout.strip() == "ok", run.results[0].stderr
        assert "offline" in run.results[1].stdout
        assert run.results[2].stdout.strip() == "sandbox"
        assert "out.csv" in run.changed_files
        assert artifacts.generated[0]["data"] == b"a\n1\n2\n"
        assert exported.name == "out.csv"
        # The same conversation's container still has the file on a new request.
        assert again.results[0].stdout == "a\n1\n2\n"
        # A warm claim keeps the first call well under a container start.
        assert first_call_seconds < 10
    finally:
        container_id = (
            sessions.active_rows[conversation].container_id
            if conversation in sessions.active_rows
            else None
        )
        if container_id is not None:
            await sandbox.discard(container_id)
        await sandbox.aclose()
