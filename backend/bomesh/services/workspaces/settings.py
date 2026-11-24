"""WorkspaceSettings and WorkspaceAssistant singletons, plus their cross-slice reads.

Settings live in ``tenants.settings`` (snake_case keys, lower-case enum values,
``reverification_duration`` in seconds); the settings etag is a hash of that
document without its ``archive`` record. The Home map background is
``branding.map_background``: an image object in document storage (one per
workspace) identified by ``image_id``; its key is
``asset_key(workspace, MAP_BACKGROUND, image_id)`` (never stored) and its
download URI is signed per read; the object it replaces or removes is deleted
after the change commits. The workspace logo is ``branding.logo``, stored the
same way under ``asset_key(workspace, LOGO, image_id)``. The assistant is one
``workspace_assistant_settings`` row, product defaults when absent; starter
prompts store role IDs and read back as role names.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import io
import json
import logging
from collections import Counter
from collections.abc import Callable, Mapping, Sequence
from dataclasses import replace
from datetime import UTC, datetime
from pathlib import PurePosixPath
from typing import TYPE_CHECKING, Any
from uuid import UUID, uuid4

from PIL import Image, ImageOps
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from bomesh import etag
from bomesh.db.engine import SessionFactory, transaction_scope
from bomesh.db.models import Role, Tenant, WorkspaceAssistantSettings
from bomesh.errors import FailedPrecondition, InvalidArgument
from bomesh.iam.authorizer import WorkspaceRef, not_found
from bomesh.iam.policy import role_name
from bomesh.services.kernel.audit import Audit
from bomesh.services.kernel.context import RequestContext
from bomesh.services.kernel.workspaces import WorkspaceResolver, workspace_name
from bomesh.services.knowledge_items.records import UploadedFile
from bomesh.services.workspaces.records import (
    AssistantSettings,
    MapBackground,
    SpaceType,
    StarterPrompt,
    Workflow,
    WorkspaceLogo,
    WorkspaceSettings,
)
from bomesh.services.workspaces.support import lock_workspace, workspace_role
from bomesh.storage import DocumentStorage, ObjectStorageError
from bomesh.storage.keys import IMMUTABLE_CACHE_CONTROL, LOGO, MAP_BACKGROUND, asset_key

if TYPE_CHECKING:
    from bomesh.runtime import AppRuntime

log = logging.getLogger(__name__)

MODULES = ("spaces", "work", "requests")
PUBLISHING_POLICIES = ("auto_publish", "review_first")
ACCENT_COLORS = ("indigo", "teal", "ocean", "plum", "graphite")
WORKFLOWS = ("evidence_review", "draft", "study_guide", "quiz")
ANSWER_LENGTHS = ("concise", "balanced", "detailed")

MAX_INSTRUCTIONS = 2000
MAX_WELCOME = 60
MAX_PROMPT_TITLE = 40
MAX_PROMPT_TEXT = 160
MAX_PROMPTS_PER_ROLE = 3
DEFAULT_WELCOME = "How can I help you today?"
_DEFAULT_CAPABILITIES = {"web_search": False, "file_work": True, "charts": True}
_CAPABILITY_PATHS = {
    "capabilities.webSearch": "web_search",
    "capabilities.fileWork": "file_work",
    "capabilities.charts": "charts",
}

#: Pillow format → stored content type of a map background or logo image.
MAP_BACKGROUND_FORMATS = {"JPEG": "image/jpeg", "PNG": "image/png", "WEBP": "image/webp"}
MAX_MAP_BACKGROUND_BYTES = 10 * 1024 * 1024
MAX_LOGO_BYTES = 1024 * 1024
#: The stored logo's largest side: sharp at 48 px on 3× screens, a few KB.
LOGO_SIZE = 256
#: Pixel cap checked before decoding (a small file can still decompress to a huge image).
MAX_LOGO_PIXELS = 36_000_000
DEFAULT_MAP_STRENGTH = 25


# -- Cross-slice reads ----------------------------------------------------------


async def workspace_settings(session: AsyncSession, workspace_id: UUID) -> WorkspaceSettings:
    """The workspace's settings with defaults applied; no permission check."""
    workspace = await session.get(Tenant, workspace_id)
    if workspace is None:
        raise not_found(WorkspaceRef(workspace_id))
    return _settings(workspace)


async def assistant_settings(session: AsyncSession, workspace_id: UUID) -> AssistantSettings:
    """The workspace's assistant configuration (defaults if never saved); no permission check."""
    workspace = await session.get(Tenant, workspace_id)
    if workspace is None:
        raise not_found(WorkspaceRef(workspace_id))
    row = await session.get(WorkspaceAssistantSettings, workspace_id)
    return await _assistant(session, workspace, row)


def signed_logo_uri(
    storage: DocumentStorage, workspace: Tenant, *, expires_seconds: int
) -> str | None:
    """The short-lived download URI of the workspace's logo, ``None`` without one."""
    logo = _logo(((workspace.settings or {}).get("branding") or {}).get("logo"))
    if logo is None:
        return None
    return storage.presign_download(
        asset_key(workspace.id, LOGO, logo.image_id),
        expires_seconds=expires_seconds,
        file_name=logo.file_name,
    ).url


# -- Service --------------------------------------------------------------------


class SettingsService:
    """Get/Update of ``…/settings`` and ``…/assistant``."""

    def __init__(
        self,
        sessions: SessionFactory,
        storage: Callable[[], DocumentStorage],
        *,
        url_seconds: int,
    ) -> None:
        self._sessions = sessions
        self._resolver = WorkspaceResolver()
        # Built on first use: most settings reads have no map background to sign.
        self._storage = storage
        self._url_seconds = url_seconds

    @classmethod
    def from_runtime(cls, runtime: AppRuntime) -> SettingsService:
        return cls(
            runtime.sessions(),
            runtime.object_storage,
            url_seconds=runtime.config.preview.url_seconds,
        )

    async def get_settings(self, ctx: RequestContext, workspace_id: UUID) -> WorkspaceSettings:
        workspace = await self._resolver.open(
            ctx, WorkspaceRef(workspace_id), "workspaces.getSettings", write=False
        )
        return self._signed(_settings(workspace))

    async def update_settings(
        self,
        ctx: RequestContext,
        workspace_id: UUID,
        changes: Mapping[str, Any],
        *,
        expected_etag: str | None,
    ) -> WorkspaceSettings:
        """``changes`` keyed by mask path; ``None`` clears a field back to its default."""
        await self._resolver.open(
            ctx, WorkspaceRef(workspace_id), "workspaces.updateSettings", write=True
        )
        async with transaction_scope(self._sessions) as session:
            workspace = await lock_workspace(session, workspace_id)
            etag.check(expected_etag, _settings_etag(workspace.settings))
            previous = _map_image_id(workspace.settings)
            previous_logo = _logo_image_id(workspace.settings)
            workspace.settings = _apply_settings(
                dict(workspace.settings), changes, editor=ctx.user_id
            )
            await session.flush()
            await Audit(session).record(
                ctx,
                workspace_id=workspace_id,
                category="settings",
                action="UpdateWorkspaceSettings",
                target=f"{workspace_name(workspace_id)}/settings",
                details={"fields": sorted(changes)},
            )
            settings = _settings(workspace)
            replaced = _map_image_id(workspace.settings) != previous
            logo_replaced = _logo_image_id(workspace.settings) != previous_logo
        if previous and replaced:
            await self._discard(workspace_id, MAP_BACKGROUND, previous)
        if previous_logo and logo_replaced:
            await self._discard(workspace_id, LOGO, previous_logo)
        return self._signed(settings)

    async def upload_map_background(
        self, ctx: RequestContext, workspace_id: UUID, file: UploadedFile
    ) -> WorkspaceSettings:
        """UploadMapBackground: store ``file`` and make it the workspace's map background."""
        await self._resolver.open(
            ctx, WorkspaceRef(workspace_id), "workspaces.updateSettings", write=True
        )
        content_type, width, height = _map_image(file.data, MAX_MAP_BACKGROUND_BYTES, "10 MB")
        image_id = uuid4()
        storage = self._storage()
        await asyncio.to_thread(
            storage.put_bytes,
            file.data,
            asset_key(workspace_id, MAP_BACKGROUND, image_id),
            content_type=content_type,
            cache_control=IMMUTABLE_CACHE_CONTROL,
        )
        try:
            async with transaction_scope(self._sessions) as session:
                workspace = await lock_workspace(session, workspace_id)
                stored = dict(workspace.settings)
                branding = dict(stored.get("branding") or {})
                previous = branding.get("map_background") or {}
                file_name = (file.file_name or "").strip()[:255] or "background"
                branding["map_background"] = {
                    "image_id": str(image_id),
                    "file_name": file_name,
                    "content_type": content_type,
                    "size_bytes": len(file.data),
                    "width": width,
                    "height": height,
                    "strength": previous.get("strength", DEFAULT_MAP_STRENGTH),
                    "updated_by_user_id": str(ctx.user_id),
                    "updated_at": datetime.now(UTC).isoformat(),
                }
                stored["branding"] = branding
                workspace.settings = stored
                await session.flush()
                await Audit(session).record(
                    ctx,
                    workspace_id=workspace_id,
                    category="settings",
                    action="UploadMapBackground",
                    target=f"{workspace_name(workspace_id)}/settings",
                    details={"fileName": file_name, "width": width, "height": height},
                )
                settings = _settings(workspace)
        except BaseException:
            await self._discard(workspace_id, MAP_BACKGROUND, image_id)
            raise
        if previous.get("image_id"):
            await self._discard(workspace_id, MAP_BACKGROUND, UUID(previous["image_id"]))
        return self._signed(settings)

    async def upload_logo(
        self, ctx: RequestContext, workspace_id: UUID, file: UploadedFile
    ) -> WorkspaceSettings:
        """UploadWorkspaceLogo: store ``file`` and make it the workspace's logo."""
        await self._resolver.open(
            ctx, WorkspaceRef(workspace_id), "workspaces.updateSettings", write=True
        )
        _map_image(file.data, MAX_LOGO_BYTES, "1 MB")
        png, width, height = await asyncio.to_thread(_square_logo, file.data)
        content_type = "image/png"
        image_id = uuid4()
        storage = self._storage()
        await asyncio.to_thread(
            storage.put_bytes,
            png,
            asset_key(workspace_id, LOGO, image_id),
            content_type=content_type,
            cache_control=IMMUTABLE_CACHE_CONTROL,
        )
        try:
            async with transaction_scope(self._sessions) as session:
                workspace = await lock_workspace(session, workspace_id)
                stored = dict(workspace.settings)
                branding = dict(stored.get("branding") or {})
                previous = branding.get("logo") or {}
                stem = PurePosixPath((file.file_name or "").strip()).stem[:250]
                file_name = f"{stem or 'logo'}.png"
                branding["logo"] = {
                    "image_id": str(image_id),
                    "file_name": file_name,
                    "content_type": content_type,
                    "size_bytes": len(png),
                    "width": width,
                    "height": height,
                    "updated_by_user_id": str(ctx.user_id),
                    "updated_at": datetime.now(UTC).isoformat(),
                }
                stored["branding"] = branding
                workspace.settings = stored
                await session.flush()
                await Audit(session).record(
                    ctx,
                    workspace_id=workspace_id,
                    category="settings",
                    action="UploadWorkspaceLogo",
                    target=f"{workspace_name(workspace_id)}/settings",
                    details={"fileName": file_name, "width": width, "height": height},
                )
                settings = _settings(workspace)
        except BaseException:
            await self._discard(workspace_id, LOGO, image_id)
            raise
        if previous.get("image_id"):
            await self._discard(workspace_id, LOGO, UUID(previous["image_id"]))
        return self._signed(settings)

    def _signed(self, settings: WorkspaceSettings) -> WorkspaceSettings:
        """``settings`` with its map background's and logo's short-lived download URIs."""
        background, logo = settings.map_background, settings.logo
        if background is not None:
            uri = self._presign(
                settings.workspace_id, MAP_BACKGROUND, background.image_id, background.file_name
            )
            settings = replace(settings, map_background=replace(background, image_uri=uri))
        if logo is not None:
            uri = self._presign(settings.workspace_id, LOGO, logo.image_id, logo.file_name)
            settings = replace(settings, logo=replace(logo, uri=uri))
        return settings

    def _presign(self, workspace_id: UUID, kind: str, image_id: UUID, file_name: str) -> str:
        return (
            self._storage()
            .presign_download(
                asset_key(workspace_id, kind, image_id),
                expires_seconds=self._url_seconds,
                file_name=file_name,
            )
            .url
        )

    async def _discard(self, workspace_id: UUID, kind: str, image_id: UUID) -> None:
        """Drop a replaced or orphaned image asset (workspace media, no revisions); best effort."""
        key = asset_key(workspace_id, kind, image_id)
        try:
            await self._storage().delete(key)
        except ObjectStorageError:
            log.warning("could not delete %s object %s", kind, key, exc_info=True)

    async def get_assistant(self, ctx: RequestContext, workspace_id: UUID) -> AssistantSettings:
        workspace = await self._resolver.open(
            ctx, WorkspaceRef(workspace_id), "workspaces.getAssistant", write=False
        )
        async with transaction_scope(self._sessions) as session:
            row = await session.get(WorkspaceAssistantSettings, workspace_id)
            return await _assistant(session, workspace, row)

    async def update_assistant(
        self,
        ctx: RequestContext,
        workspace_id: UUID,
        changes: Mapping[str, Any],
        *,
        expected_etag: str | None,
    ) -> AssistantSettings:
        """``changes`` keyed by mask path; ``starterPrompts`` holds :class:`StarterPrompt`."""
        await self._resolver.open(
            ctx, WorkspaceRef(workspace_id), "workspaces.updateAssistant", write=True
        )
        async with transaction_scope(self._sessions) as session:
            workspace = await lock_workspace(session, workspace_id)
            row = await session.get(WorkspaceAssistantSettings, workspace_id)
            current = await _assistant(session, workspace, row)
            etag.check(expected_etag, current.etag)
            if row is None:
                row = WorkspaceAssistantSettings(
                    tenant_id=workspace_id,
                    instructions="",
                    welcome_message=DEFAULT_WELCOME,
                    capabilities=dict(_DEFAULT_CAPABILITIES),
                    starter_prompts=[],
                )
                session.add(row)
            await _apply_assistant(session, workspace_id, row, changes)
            row.updated_by_user_id = ctx.user_id
            await session.flush()
            await session.refresh(row)
            await Audit(session).record(
                ctx,
                workspace_id=workspace_id,
                category="settings",
                action="UpdateWorkspaceAssistant",
                target=f"{workspace_name(workspace_id)}/assistant",
                details={"fields": sorted(changes)},
            )
            return await _assistant(session, workspace, row)


# -- Settings document ----------------------------------------------------------


def _settings(workspace: Tenant) -> WorkspaceSettings:
    stored = workspace.settings
    modules = stored.get("modules") or {}
    branding = stored.get("branding") or {}
    return WorkspaceSettings(
        workspace_id=workspace.id,
        modules={module: modules.get(module, True) is not False for module in MODULES},
        accent_color=branding.get("accent_color"),
        space_types=tuple(
            SpaceType(
                key=entry["key"],
                display_name=entry["display_name"],
                icon=entry.get("icon"),
                enabled=entry.get("enabled", True),
            )
            for entry in stored.get("space_types") or ()
        ),
        workflows=tuple(
            Workflow(key=entry["key"], enabled=entry.get("enabled", True))
            for entry in stored.get("workflows") or ()
        ),
        default_publishing_policy=stored.get("default_publishing_policy") or "auto_publish",
        reverification_seconds=stored.get("reverification_duration"),
        etag=_settings_etag(stored),
        map_background=_map_background(branding.get("map_background")),
        logo=_logo(branding.get("logo")),
    )


def _map_background(stored: Mapping[str, Any] | None) -> MapBackground | None:
    if not stored:
        return None
    updater = stored.get("updated_by_user_id")
    return MapBackground(
        image_id=UUID(stored["image_id"]),
        file_name=stored["file_name"],
        width=stored["width"],
        height=stored["height"],
        strength=stored.get("strength", DEFAULT_MAP_STRENGTH),
        updated_by=UUID(updater) if updater else None,
        updated_at=datetime.fromisoformat(stored["updated_at"]),
    )


def _map_image_id(stored: Mapping[str, Any]) -> UUID | None:
    image_id = ((stored.get("branding") or {}).get("map_background") or {}).get("image_id")
    return UUID(image_id) if image_id else None


def _logo(stored: Mapping[str, Any] | None) -> WorkspaceLogo | None:
    if not stored:
        return None
    return WorkspaceLogo(
        image_id=UUID(stored["image_id"]),
        file_name=stored["file_name"],
        updated_at=datetime.fromisoformat(stored["updated_at"]),
    )


def _logo_image_id(stored: Mapping[str, Any]) -> UUID | None:
    image_id = ((stored.get("branding") or {}).get("logo") or {}).get("image_id")
    return UUID(image_id) if image_id else None


def _map_image(data: bytes, max_bytes: int, limit: str) -> tuple[str, int, int]:
    """Content type and pixel size of an uploaded map background or logo; INVALID_ARGUMENT otherwise."""
    if len(data) > max_bytes:
        raise InvalidArgument.for_field("file", f"The image is larger than {limit}.")
    try:
        # Reads the header only: nothing is decoded, so a huge image costs nothing.
        with Image.open(io.BytesIO(data)) as image:
            image_format, (width, height) = image.format, image.size
    except Exception:  # Pillow raises many types for unreadable or hostile input.
        image_format, width, height = None, 0, 0
    content_type = MAP_BACKGROUND_FORMATS.get(image_format or "")
    if content_type is None or width < 1 or height < 1:
        raise InvalidArgument.for_field("file", "Use a JPEG, PNG or WebP image.")
    return content_type, width, height


def _square_logo(data: bytes) -> tuple[bytes, int, int]:
    """The stored logo: transparent margins trimmed, centred on a square (transparent, or
    the image's own corner colour when it has no transparency) and scaled down to at most
    ``LOGO_SIZE``, as PNG. Done once here, so every mark draws a small image whole instead
    of the browser cropping a large one of any shape. INVALID_ARGUMENT for a huge, broken
    or blank image."""
    try:
        with Image.open(io.BytesIO(data)) as source:
            if source.width * source.height > MAX_LOGO_PIXELS:
                raise InvalidArgument.for_field("file", "The image has too many pixels.")
            image = ImageOps.exif_transpose(source).convert("RGBA")
    except (OSError, ValueError, Image.DecompressionBombError) as error:
        raise InvalidArgument.for_field("file", "The image can't be read.") from error
    alpha = image.getchannel("A")
    box = alpha.getbbox()
    if box is None:
        raise InvalidArgument.for_field("file", "The image is fully transparent.")
    opaque = alpha.getextrema()[0] == 255
    image = image.crop(box)
    side = max(image.size)
    square = Image.new("RGBA", (side, side), image.getpixel((0, 0)) if opaque else (0, 0, 0, 0))
    square.paste(image, ((side - image.width) // 2, (side - image.height) // 2))
    if side > LOGO_SIZE:
        square = square.resize((LOGO_SIZE, LOGO_SIZE), Image.Resampling.LANCZOS)
    out = io.BytesIO()
    square.save(out, format="PNG", optimize=True)
    return out.getvalue(), square.width, square.height


def _settings_etag(stored: Mapping[str, Any]) -> str:
    document = {key: value for key, value in stored.items() if key != "archive"}
    canonical = json.dumps(document, sort_keys=True, separators=(",", ":"), default=str)
    return base64.urlsafe_b64encode(hashlib.sha256(canonical.encode()).digest()[:12]).decode()


def _apply_settings(
    stored: dict[str, Any], changes: Mapping[str, Any], *, editor: UUID
) -> dict[str, Any]:
    for path, value in changes.items():
        head, _, leaf = path.partition(".")
        match head:
            case "modules":
                modules = dict(stored.get("modules") or {})
                _set(modules, leaf, _boolean(value, path))
                stored["modules"] = modules
            case "branding":
                branding = dict(stored.get("branding") or {})
                _apply_branding(branding, path, value, editor=editor)
                stored["branding"] = branding
            case "spaceTypes":
                _set(stored, "space_types", _space_types(value))
            case "workflows":
                _set(stored, "workflows", _workflows(value))
            case "defaultPublishingPolicy":
                _set(
                    stored,
                    "default_publishing_policy",
                    _choice(value, PUBLISHING_POLICIES, path),
                )
            case "reverificationDuration":
                _set(stored, "reverification_duration", _seconds(value, path))
            case _:
                raise ValueError(f"unknown settings path {path!r}")
    return {key: value for key, value in stored.items() if value not in ({}, None)}


def _set(target: dict[str, Any], key: str, value: Any) -> None:
    if value is None:
        target.pop(key, None)
    else:
        target[key] = value


def _apply_branding(branding: dict[str, Any], path: str, value: Any, *, editor: UUID) -> None:
    """``branding.mapBackground``/``branding.logo`` → ``None`` removes it; a background's
    ``strength`` needs one set."""
    match path:
        case "branding.accentColor":
            _set(branding, "accent_color", _choice(value, ACCENT_COLORS, path))
        case "branding.mapBackground":
            if value is None:
                branding.pop("map_background", None)
        case "branding.logo":
            if value is None:
                branding.pop("logo", None)
        case "branding.mapBackground.strength":
            current = branding.get("map_background")
            if current is None:
                if value is None:
                    return
                raise FailedPrecondition("The workspace has no map background; upload one first.")
            strength = DEFAULT_MAP_STRENGTH if value is None else value
            if isinstance(strength, bool) or not isinstance(strength, int) or not 0 <= strength <= 100:
                raise InvalidArgument.for_field(path, f"{path} must be an integer from 0 to 100.")
            branding["map_background"] = {
                **current,
                "strength": strength,
                "updated_by_user_id": str(editor),
                "updated_at": datetime.now(UTC).isoformat(),
            }
        case _:
            raise ValueError(f"unknown settings path {path!r}")


def _boolean(value: object, field: str) -> bool | None:
    if value is None or isinstance(value, bool):
        return value
    raise InvalidArgument.for_field(field, f"{field} must be a boolean.")


def _choice(value: object, allowed: Sequence[str], field: str) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str) or value not in allowed:
        raise InvalidArgument.for_field(field, f"Unsupported {field} value.")
    return value


def _seconds(value: object, field: str) -> int | None:
    if value is None:
        return None
    if not isinstance(value, int) or value <= 0:
        raise InvalidArgument.for_field(field, f"{field} must be a positive duration.")
    return value


def _unique_keys(keys: Sequence[str], field: str) -> None:
    for key in keys:
        if not key.strip() or len(key) > 64:
            raise InvalidArgument.for_field(field, f"Every {field} key must be 1-64 characters.")
    duplicates = [key for key, count in Counter(keys).items() if count > 1]
    if duplicates:
        raise InvalidArgument.for_field(field, f"Duplicate {field} key '{duplicates[0]}'.")


def _label(value: str, field: str) -> str:
    text = value.strip()
    if not text or len(text) > 255:
        raise InvalidArgument.for_field(field, f"Every {field} displayName must be 1-255 characters.")
    return text


def _space_types(value: Sequence[SpaceType] | None) -> list[dict[str, Any]] | None:
    if value is None:
        return None
    _unique_keys([entry.key for entry in value], "spaceTypes")
    return [
        {
            "key": entry.key,
            "display_name": _label(entry.display_name, "spaceTypes"),
            "icon": entry.icon,
            "enabled": entry.enabled,
        }
        for entry in value
    ]


def _workflows(value: Sequence[Workflow] | None) -> list[dict[str, Any]] | None:
    if value is None:
        return None
    _unique_keys([entry.key for entry in value], "workflows")
    for entry in value:
        _choice(entry.key, WORKFLOWS, "workflows")
    return [{"key": entry.key, "enabled": entry.enabled} for entry in value]


# -- Assistant ------------------------------------------------------------------


async def _assistant(
    session: AsyncSession, workspace: Tenant, row: WorkspaceAssistantSettings | None
) -> AssistantSettings:
    name = f"{workspace_name(workspace.id)}/assistant"
    if row is None:
        return AssistantSettings(
            workspace_id=workspace.id,
            instructions="",
            answer_length="balanced",
            web_search=_DEFAULT_CAPABILITIES["web_search"],
            file_work=_DEFAULT_CAPABILITIES["file_work"],
            charts=_DEFAULT_CAPABILITIES["charts"],
            welcome_message=DEFAULT_WELCOME,
            starter_prompts=(),
            etag=etag.compute(name, workspace.created_at),
        )
    capabilities = {**_DEFAULT_CAPABILITIES, **row.capabilities}
    return AssistantSettings(
        workspace_id=workspace.id,
        instructions=row.instructions,
        answer_length=row.answer_length,
        web_search=bool(capabilities["web_search"]),
        file_work=bool(capabilities["file_work"]),
        charts=bool(capabilities["charts"]),
        welcome_message=row.welcome_message,
        starter_prompts=await _prompts_out(session, row.starter_prompts),
        etag=etag.compute(name, row.updated_at),
    )


async def _apply_assistant(
    session: AsyncSession,
    workspace_id: UUID,
    row: WorkspaceAssistantSettings,
    changes: Mapping[str, Any],
) -> None:
    capabilities = {**_DEFAULT_CAPABILITIES, **row.capabilities}
    for path, value in changes.items():
        if path == "instructions":
            row.instructions = _bounded(value or "", MAX_INSTRUCTIONS, path, allow_empty=True)
        elif path == "answerLength":
            row.answer_length = _choice(value, ANSWER_LENGTHS, path) or "balanced"
        elif path in _CAPABILITY_PATHS:
            key = _CAPABILITY_PATHS[path]
            flag = _boolean(value, path)
            capabilities[key] = _DEFAULT_CAPABILITIES[key] if flag is None else flag
        elif path == "welcomeMessage":
            row.welcome_message = (
                _bounded(value, MAX_WELCOME, path, allow_empty=False)
                if value
                else DEFAULT_WELCOME
            )
        elif path == "starterPrompts":
            row.starter_prompts = await _prompts_in(session, workspace_id, value or ())
        else:
            raise ValueError(f"unknown assistant path {path!r}")
    row.capabilities = capabilities


def _bounded(value: object, limit: int, field: str, *, allow_empty: bool) -> str:
    if not isinstance(value, str) or len(value) > limit or (not allow_empty and not value.strip()):
        raise InvalidArgument.for_field(field, f"{field} must be at most {limit} characters.")
    return value


async def _prompts_in(
    session: AsyncSession, workspace_id: UUID, prompts: Sequence[StarterPrompt]
) -> list[dict[str, Any]]:
    per_role: Counter[UUID | None] = Counter()
    stored: list[dict[str, Any]] = []
    for prompt in prompts:
        title = _bounded(prompt.title, MAX_PROMPT_TITLE, "starterPrompts", allow_empty=False)
        text = _bounded(prompt.prompt, MAX_PROMPT_TEXT, "starterPrompts", allow_empty=False)
        role_ids = [
            (await workspace_role(session, workspace_id, name, field="starterPrompts")).id
            for name in dict.fromkeys(prompt.roles)
        ]
        per_role.update(role_ids or [None])
        stored.append({"title": title, "prompt": text, "role_ids": [str(r) for r in role_ids]})
    if any(count > MAX_PROMPTS_PER_ROLE for count in per_role.values()):
        raise InvalidArgument.for_field(
            "starterPrompts", f"At most {MAX_PROMPTS_PER_ROLE} starter prompts per role."
        )
    return stored


async def _prompts_out(
    session: AsyncSession, stored: Sequence[Mapping[str, Any]]
) -> tuple[StarterPrompt, ...]:
    role_ids = {UUID(role_id) for prompt in stored for role_id in prompt.get("role_ids", ())}
    roles = {
        role.id: role
        for role in await session.scalars(
            select(Role).where(Role.id.in_(role_ids), Role.deleted_at.is_(None))
        )
    } if role_ids else {}
    return tuple(
        StarterPrompt(
            title=prompt["title"],
            prompt=prompt["prompt"],
            roles=tuple(
                role_name(roles[UUID(role_id)])
                for role_id in prompt.get("role_ids", ())
                if UUID(role_id) in roles
            ),
        )
        for prompt in stored
    )


__all__ = [
    "ACCENT_COLORS",
    "ANSWER_LENGTHS",
    "DEFAULT_MAP_STRENGTH",
    "MAX_LOGO_BYTES",
    "MAX_MAP_BACKGROUND_BYTES",
    "MODULES",
    "PUBLISHING_POLICIES",
    "WORKFLOWS",
    "SettingsService",
    "assistant_settings",
    "signed_logo_uri",
    "workspace_settings",
]
