"""Coordinate one request's sandbox materialization and artifact promotion."""

from __future__ import annotations

import mimetypes
from dataclasses import replace
from pathlib import PurePosixPath
from uuid import UUID

from bomesh.agent import (
    ExecutionCapability,
    ResourceRef,
    SandboxArtifact,
    SandboxMaterialization,
)
from bomesh.agent.protocol import HostedExecutionResultItem, Item
from bomesh.services import (
    ArtifactValidationError,
    AuthContext,
    SandboxManifestResource,
    SandboxProviderFile,
    SandboxSessionState,
)
from bomesh.services.agent_runtime import SandboxProvider
from bomesh.services.agent_runtime.sandbox_renditions import renditions
from bomesh.services.artifact import ArtifactService
from bomesh.services.sandbox_session import SandboxSessionService


class SandboxWorkspace:
    """Use durable resources in a provider sandbox without exposing bindings.

    The workspace is request-scoped. It asks ``SandboxSessionService`` for a
    prior binding only when a shell-capable sampling step or a sandbox action
    actually needs one, so ordinary chat never creates provider state.
    """

    def __init__(
        self,
        *,
        access: AuthContext,
        conversation_id: UUID,
        request_id: str,
        provider: SandboxProvider,
        sessions: SandboxSessionService,
        artifacts: ArtifactService,
    ) -> None:
        self._access = access
        self._conversation_id = conversation_id
        self._request_id = request_id
        self._provider = provider
        self._sessions = sessions
        self._artifacts = artifacts
        self._state: SandboxSessionState | None = None
        self._state_loaded = False
        self._recovery: SandboxSessionState | None = None
        self._recovery_loaded = False
        self._exported: dict[str, SandboxArtifact] = {}
        # Provider files attached to the step being sampled; they count as
        # delivered once that step reports an execution.
        self._attaching: tuple[str, ...] = ()

    @property
    def artifacts(self) -> tuple[SandboxArtifact, ...]:
        return tuple(self._exported.values())

    async def configure_execution(
        self, capability: ExecutionCapability
    ) -> ExecutionCapability:
        """Attach an opaque resumed environment or initial provider files."""

        if (
            not capability.hosted_shell
            or capability.provider != self._provider.provider
        ):
            return capability
        state = await self._current_state()
        if state is None:
            return capability
        if state.environment_id is None:
            # A new workspace receives everything prepared so far.
            self._attaching = tuple(file.id for file in state.materialized_files)
            return replace(capability, workspace_file_ids=self._attaching)
        # A running workspace keeps its files; only newly prepared ones ride
        # on this step.
        self._attaching = tuple(
            file.id for file in state.materialized_files if not file.delivered
        )
        return replace(
            capability,
            environment_id=state.environment_id,
            workspace_file_ids=self._attaching,
        )

    async def observe_execution(self, items: tuple[Item, ...]) -> None:
        """Persist only provider-generated environment and file observations."""

        results = tuple(
            item for item in items if isinstance(item, HostedExecutionResultItem)
        )
        for result in results:
            environment = result.environment
            if (
                environment is None
                or environment.provider != self._provider.provider
            ):
                continue
            state = await self._ensure_state()
            reported_files = tuple(
                SandboxProviderFile(id=file.id, name=file.name or file.id)
                for file in result.files
                if file.provider == self._provider.provider
            )
            reported_names = {file.name for file in reported_files}
            files = (*reported_files, *(file for file in state.observed_files if file.name not in reported_names))
            self._state = await self._sessions.record_execution(
                self._access,
                session_id=state.id,
                environment_id=environment.id,
                files=files,
                delivered_file_ids=self._attaching,
            )
            self._attaching = ()

    async def materialize_resource(
        self, resource: ResourceRef
    ) -> SandboxMaterialization:
        """Upload one authorized Item for the next shell step.

        A new workspace receives it when it starts; a running one receives it
        on its next shell request. The result says where the shell finds it.
        """

        state = await self._ensure_state()
        await self._recover_if_needed(state)
        state = await self._ensure_state()
        if not any(file.resource_id == resource.id for file in state.materialized_files):
            await self._materialize(state, resource)
            state = await self._ensure_state()
        return SandboxMaterialization(
            resource=resource,
            paths=tuple(
                self._provider.workspace_path(file_id=file.id, file_name=file.name)
                for file in state.materialized_files
                if file.resource_id == resource.id
            ),
        )

    async def promote_file(self, file_name: str, *, summary: str) -> SandboxArtifact:
        """Export one observed sandbox file into the durable artifact lifecycle."""

        requested_name = _safe_workspace_name(_home_relative(file_name))
        state = await self._current_state()
        if state is None or state.environment_id is None:
            raise ArtifactValidationError("no active workspace file is available to export")
        source = next(
            (file for file in state.observed_files if file.name == requested_name),
            None,
        )
        if source is None:
            # Shell results report at most a few changed files per call, so a
            # file written earlier may only be found in the workspace itself.
            found = await self._provider.find_file(
                environment_id=state.environment_id, path=requested_name
            )
            if found is None:
                raise ArtifactValidationError(
                    f"{requested_name} is not in the workspace home directory; "
                    "write the file under ~ and export it by its path relative to ~"
                )
            source = SandboxProviderFile(id=found.id, name=requested_name)
        try:
            data = await self._provider.download_file(
                environment_id=state.environment_id, file_id=source.id
            )
        except Exception as exc:  # provider errors must not leak into model context
            await self._sessions.expire(self._access, session_id=state.id)
            self._state = None
            self._state_loaded = True
            raise ArtifactValidationError(
                "the workspace is no longer available; its durable inputs can be "
                "materialized again in a new workspace"
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
        self._state = await self._sessions.record_resource(
            self._access,
            session_id=state.id,
            resource=SandboxManifestResource(
                resource_id=artifact_id,
                name=str(artifact["file_name"]),
                mime_type=str(artifact["mime_type"]),
                size_bytes=artifact.get("size_bytes")
                if isinstance(artifact.get("size_bytes"), int)
                else None,
            ),
        )
        exported = SandboxArtifact(
            id=artifact_id,
            title=str(artifact["title"]),
            name=str(artifact["file_name"]),
            mime_type=str(artifact["mime_type"]),
            revision=revision,
            size_bytes=artifact.get("size_bytes")
            if isinstance(artifact.get("size_bytes"), int)
            else 0,
            updated_at=artifact.get("updated_at")
            if isinstance(artifact.get("updated_at"), str)
            else None,
        )
        # One entry per file, first-exported order, carrying its newest revision.
        self._exported[artifact_id] = exported
        return exported

    async def _current_state(self) -> SandboxSessionState | None:
        if not self._state_loaded:
            self._state = await self._sessions.active(
                self._access,
                conversation_id=self._conversation_id,
                provider=self._provider.provider,
            )
            self._state_loaded = True
        return self._state

    async def _ensure_state(self) -> SandboxSessionState:
        state = await self._current_state()
        if state is None:
            state = await self._sessions.ensure(
                self._access,
                conversation_id=self._conversation_id,
                provider=self._provider.provider,
            )
            self._state = state
        return state

    async def _recover_if_needed(self, state: SandboxSessionState) -> None:
        """Re-upload the prior manifest only after an expired workspace is reused."""

        if not self._recovery_loaded:
            self._recovery = await self._sessions.recoverable(
                self._access,
                conversation_id=self._conversation_id,
                provider=self._provider.provider,
            )
            self._recovery_loaded = True
        if self._recovery is None:
            return
        for manifest_resource in self._recovery.manifest:
            current = await self._ensure_state()
            if any(
                file.resource_id == manifest_resource.resource_id
                for file in current.materialized_files
            ):
                continue
            await self._materialize(
                current,
                ResourceRef(
                    id=manifest_resource.resource_id,
                    name=manifest_resource.name,
                    mime_type=manifest_resource.mime_type,
                    size_bytes=manifest_resource.size_bytes,
                ),
            )
        self._recovery = None

    async def _materialize(
        self, state: SandboxSessionState, resource: ResourceRef
    ) -> None:
        try:
            resource_id = UUID(resource.id)
        except ValueError as exc:
            raise ArtifactValidationError("resource cannot be materialized") from exc
        source = await self._artifacts.source_file(self._access, resource_id)
        uploads = (
            (source.file_name, source.mime_type, source.data),
            *(
                (copy.file_name, copy.mime_type, copy.data)
                for copy in renditions(source.file_name, source.data)
            ),
        )
        provider_files: list[SandboxProviderFile] = []
        for name, mime_type, data in uploads:
            uploaded = await self._provider.upload_file(
                file_name=_safe_workspace_name(name), mime_type=mime_type, data=data
            )
            if uploaded.provider != self._provider.provider:
                raise RuntimeError("sandbox provider returned a foreign file reference")
            provider_files.append(
                SandboxProviderFile(
                    id=uploaded.id, name=name, resource_id=resource.id, delivered=False
                )
            )
        self._state = await self._sessions.record_materialization(
            self._access,
            session_id=state.id,
            resource=SandboxManifestResource(
                resource_id=resource.id,
                name=source.file_name,
                mime_type=source.mime_type,
                size_bytes=source.size_bytes,
            ),
            provider_files=provider_files,
        )


def _home_relative(value: str) -> str:
    """Accept ``~/x`` and ``x`` alike: workspace files are named from home."""

    normalized = value.strip()
    return normalized[2:] if normalized.startswith("~/") else normalized


def _safe_workspace_name(value: str) -> str:
    """Accept a virtual sandbox path but reject traversal before provider I/O."""

    normalized = value.strip()
    if not normalized or "\\" in normalized or any(ord(char) < 32 for char in normalized):
        raise ArtifactValidationError("workspace file name is invalid")
    path = PurePosixPath(normalized)
    if path.is_absolute():
        raise ArtifactValidationError(
            "use the file's path relative to the workspace home directory (~)"
        )
    if any(part in {"", ".", ".."} for part in path.parts):
        raise ArtifactValidationError("workspace file name is invalid")
    if len(normalized) > 255:
        raise ArtifactValidationError("workspace file name is invalid")
    return normalized


__all__ = ["SandboxWorkspace"]
