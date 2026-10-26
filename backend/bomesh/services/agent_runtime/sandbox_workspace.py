"""Coordinate one request's sandbox container, files and artifact promotion."""

from __future__ import annotations

import logging
import mimetypes
from pathlib import PurePosixPath
from uuid import UUID

from bomesh.agent import (
    ResourceRef,
    SandboxArtifact,
    SandboxMaterialization,
    ShellRun,
)
from bomesh.services import (
    ArtifactValidationError,
    AuthContext,
    AuthorizationError,
    DocumentNotFoundError,
    SandboxManifestResource,
    SandboxMaterializedFile,
    SandboxSessionState,
)
from bomesh.services.agent_runtime.docker_sandbox import (
    PROVIDER,
    SANDBOX_HOME,
    DockerSandbox,
    SandboxContainerGone,
)
from bomesh.services.agent_runtime.sandbox_renditions import renditions
from bomesh.services.artifact import ArtifactService
from bomesh.services.sandbox_session import SandboxSessionService

_log = logging.getLogger(__name__)


class SandboxWorkspace:
    """Use durable resources in the conversation's container without exposing it.

    The workspace is request-scoped. It binds a container only when a sandbox
    tool actually needs one, so ordinary chat never claims a container or
    creates a sandbox session. Container ids and host details never leave it.
    """

    def __init__(
        self,
        *,
        access: AuthContext,
        conversation_id: UUID,
        request_id: str,
        sandbox: DockerSandbox,
        sessions: SandboxSessionService,
        artifacts: ArtifactService,
        max_export_bytes: int,
    ) -> None:
        self._access = access
        self._conversation_id = conversation_id
        self._request_id = request_id
        self._sandbox = sandbox
        self._sessions = sessions
        self._artifacts = artifacts
        self._max_export_bytes = max_export_bytes
        self._state: SandboxSessionState | None = None
        self._container_id: str | None = None
        self._exported: dict[str, SandboxArtifact] = {}

    @property
    def guidance(self) -> str:
        return self._sandbox.guidance

    @property
    def artifacts(self) -> tuple[SandboxArtifact, ...]:
        return tuple(self._exported.values())

    async def run_commands(
        self, commands: tuple[str, ...], *, timeout_seconds: int | None
    ) -> ShellRun:
        """Run a command batch in the conversation's container."""

        timeout = timeout_seconds or self._sandbox.default_timeout_seconds
        try:
            return await self._sandbox.run(
                await self._container(), commands, timeout_seconds=timeout
            )
        except SandboxContainerGone:
            # Removed underneath this request (reaper, daemon restart): rebuild
            # once from the durable manifest and run the batch there.
            self._container_id = None
            return await self._sandbox.run(
                await self._container(), commands, timeout_seconds=timeout
            )

    async def materialize_resource(
        self, resource: ResourceRef
    ) -> SandboxMaterialization:
        """Copy one authorized Item into the home directory; return its paths."""

        container_id = await self._container()
        state = self._bound_state()
        if not any(file.resource_id == resource.id for file in state.materialized_files):
            try:
                await self._materialize(container_id, resource)
            except SandboxContainerGone:
                self._container_id = None
                container_id = await self._container()
                if not any(
                    file.resource_id == resource.id
                    for file in self._bound_state().materialized_files
                ):
                    await self._materialize(container_id, resource)
        return SandboxMaterialization(
            resource=resource,
            paths=tuple(
                f"~/{file.path}"
                for file in self._bound_state().materialized_files
                if file.resource_id == resource.id
            ),
        )

    async def promote_file(self, file_name: str, *, summary: str) -> SandboxArtifact:
        """Export one sandbox file into the durable artifact lifecycle."""

        requested_name = sandbox_path(file_name)
        container_id = await self._existing_container()
        if container_id is None:
            raise ArtifactValidationError(
                "the sandbox has no files yet; create the file with run_shell first"
            )
        try:
            data = await self._sandbox.read_file(
                container_id, requested_name, max_bytes=self._max_export_bytes
            )
        except SandboxContainerGone as exc:
            self._container_id = None
            raise ArtifactValidationError(
                "the sandbox was reset and that file is gone; its durable inputs "
                "are restored on the next run_shell call, so recreate the file"
            ) from exc
        mime_type = mimetypes.guess_type(requested_name)[0] or "application/octet-stream"
        artifact = await self._artifacts.record_generated(
            self._access,
            conversation_id=self._conversation_id,
            request_id=self._request_id,
            file_name=requested_name,
            mime_type=mime_type,
            data=data,
            summary=summary,
        )
        artifact_id = str(artifact["id"])
        revision = artifact.get("revision")
        if not isinstance(revision, int) or revision < 1:
            raise RuntimeError("artifact service returned an invalid revision")
        size_bytes = artifact.get("size_bytes")
        self._state = await self._sessions.record_resource(
            self._access,
            session_id=self._bound_state().id,
            resource=SandboxManifestResource(
                resource_id=artifact_id,
                name=str(artifact["file_name"]),
                mime_type=str(artifact["mime_type"]),
                size_bytes=size_bytes if isinstance(size_bytes, int) else None,
            ),
        )
        updated_at = artifact.get("updated_at")
        exported = SandboxArtifact(
            id=artifact_id,
            title=str(artifact["title"]),
            name=str(artifact["file_name"]),
            mime_type=str(artifact["mime_type"]),
            revision=revision,
            size_bytes=size_bytes if isinstance(size_bytes, int) else 0,
            updated_at=updated_at if isinstance(updated_at, str) else None,
        )
        # One entry per file, first-exported order, carrying its newest revision.
        self._exported[artifact_id] = exported
        return exported

    # -- Container binding ----------------------------------------------------

    async def _existing_container(self) -> str | None:
        """The bound container, without claiming one when there is none."""

        if self._container_id is not None:
            return self._container_id
        state = await self._sessions.active(
            self._access, conversation_id=self._conversation_id, provider=PROVIDER
        )
        if state is None:
            return None
        container_id = await self._sandbox.resolve(
            session_id=state.id, container_id=state.container_id
        )
        if container_id is not None and container_id == state.container_id:
            self._state = state
            self._container_id = container_id
        return self._container_id

    async def _container(self) -> str:
        """The conversation's running container, claiming and rebuilding as needed."""

        if self._container_id is not None:
            return self._container_id
        state = await self._sessions.ensure(
            self._access, conversation_id=self._conversation_id, provider=PROVIDER
        )
        async with self._sandbox.lock(state.id):
            container_id = await self._sandbox.resolve(
                session_id=state.id, container_id=state.container_id
            )
            if container_id is not None and container_id == state.container_id:
                self._state = state
                self._container_id = container_id
                return container_id
            claimed = container_id or await self._sandbox.claim(session_id=state.id)
            bound = await self._sessions.bind_container(
                self._access,
                session_id=state.id,
                container_id=claimed,
                replaces=state.container_id,
            )
            if bound.container_id != claimed and bound.container_id is not None:
                # Another process bound this session first; use its container.
                await self._sandbox.discard(claimed)
                self._state = bound
                self._container_id = bound.container_id
                return bound.container_id
            self._state = bound
            self._container_id = claimed
            await self._rebuild(claimed, bound)
            return claimed

    async def _rebuild(self, container_id: str, state: SandboxSessionState) -> None:
        """Restore every durable input the conversation had in an earlier container."""

        manifest = list(state.manifest)
        previous = await self._sessions.recoverable(
            self._access, conversation_id=self._conversation_id, provider=PROVIDER
        )
        if previous is not None:
            known = {resource.resource_id for resource in manifest}
            manifest.extend(
                resource for resource in previous.manifest if resource.resource_id not in known
            )
        for resource in manifest:
            try:
                await self._materialize(
                    container_id,
                    ResourceRef(
                        id=resource.resource_id,
                        name=resource.name,
                        mime_type=resource.mime_type,
                        size_bytes=resource.size_bytes,
                    ),
                )
            except (ArtifactValidationError, AuthorizationError, DocumentNotFoundError):
                # Deleted or no longer readable: it simply does not come back.
                _log.info("sandbox rebuild skipped resource %s", resource.resource_id)

    async def _materialize(self, container_id: str, resource: ResourceRef) -> None:
        try:
            resource_id = UUID(resource.id)
        except ValueError as exc:
            raise ArtifactValidationError("resource cannot be materialized") from exc
        source = await self._artifacts.source_file(self._access, resource_id)
        taken = {
            file.path
            for file in self._bound_state().materialized_files
            if file.resource_id != resource.id
        }
        files = tuple(
            (_free_name(_base_name(name), taken, resource.id), data)
            for name, data in (
                (source.file_name, source.data),
                *(
                    (copy.file_name, copy.data)
                    for copy in renditions(source.file_name, source.data)
                ),
            )
        )
        await self._sandbox.write_files(container_id, files)
        self._state = await self._sessions.record_materialization(
            self._access,
            session_id=self._bound_state().id,
            container_id=container_id,
            resource=SandboxManifestResource(
                resource_id=resource.id,
                name=source.file_name,
                mime_type=source.mime_type,
                size_bytes=source.size_bytes,
            ),
            files=tuple(
                SandboxMaterializedFile(path=path, resource_id=resource.id)
                for path, _ in files
            ),
        )

    def _bound_state(self) -> SandboxSessionState:
        if self._state is None:
            raise RuntimeError("sandbox workspace has no bound session")
        return self._state


def sandbox_path(value: str) -> str:
    """Normalize a model-supplied path to one relative to the sandbox home.

    ``~/x``, ``x`` and ``/home/sandbox/x`` name the same file. Other absolute
    paths, ``..`` segments and control characters are rejected before any
    container call.
    """

    normalized = value.strip()
    if normalized.startswith("~/"):
        normalized = normalized[2:]
    elif normalized.startswith(f"{SANDBOX_HOME}/"):
        normalized = normalized[len(SANDBOX_HOME) + 1 :]
    if not normalized or "\\" in normalized or any(ord(char) < 32 for char in normalized):
        raise ArtifactValidationError("sandbox file path is invalid")
    path = PurePosixPath(normalized)
    if path.is_absolute():
        raise ArtifactValidationError(
            "use the file's path relative to the sandbox home directory (~)"
        )
    if any(part in {"", ".", ".."} for part in normalized.split("/")):
        raise ArtifactValidationError("sandbox file path is invalid")
    if len(normalized) > 255:
        raise ArtifactValidationError("sandbox file path is invalid")
    return normalized


def _base_name(value: str) -> str:
    name = PurePosixPath(value.replace("\\", "/")).name.strip()
    name = "".join(char for char in name if ord(char) >= 32)
    if name in {"", ".", ".."}:
        return "file"
    return name[:200]


def _free_name(name: str, taken: set[str], resource_id: str) -> str:
    """Keep the original name unless another resource already uses it."""

    chosen = name if name not in taken else f"{resource_id[:8]}-{name}"
    taken.add(chosen)
    return chosen


__all__ = ["SandboxWorkspace", "sandbox_path"]
