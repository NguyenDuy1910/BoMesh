"""Assistant interface, Artifact part (``api_design.md`` §7).

Services (one per resource, built with ``from_runtime``):
:class:`~.artifacts.ArtifactResourceService` (``workspaces/{w}/artifacts``) and
:class:`~.revisions.ArtifactRevisionService` (``…/artifacts/{a}/revisions``).
:mod:`.artifact_store` is the artifact engine: ``runtime.artifact_service()
.record_generated(access, *, conversation_id, file_name, mime_type, data,
summary, source_ids=()) -> GeneratedArtifact`` records a sandbox export of a
turn as a FILE artifact whose sources are the readable documents of
``source_ids`` (Conversations).

Importing :mod:`.artifacts` registers the ``createArtifact`` / ``reviseArtifact``
operation hooks: the result loader (an ``ArtifactRecord``), cancel (stop the
running generation) and abandon (restore the artifact after a crash).
"""
