"""Derived previews of conversation artifacts: PDF page images.

:class:`KnowledgePreview` stores the PDF page images of an artifact revision
and resolves them for the caller who authorized the artifact. Knowledge
documents are shown through the preview engine (:mod:`bomesh.services.previews`)
instead; the text of either is read from its Structured Document
(``GetItemContent``).

A document passed here shows one content (``Item.content``: its current
revision). Its manifest is ``item_revisions.exports.preview`` of that revision
and never holds a key: page images are
``derived/{tenant}/{content_id}/preview-v{renderer}/page-0001.webp`` (or
``asset-0001.webp``), all immutable.
"""

from __future__ import annotations

import asyncio
import logging
import tempfile
from io import BytesIO
from pathlib import Path
from uuid import UUID

import pypdfium2 as pdfium
from PIL import Image

from bomesh.connector.processing.pdfium_lock import PDFIUM_LOCK
from bomesh.db.models import Item
from bomesh.db.models.knowledge import ItemContent
from bomesh.services import (
    DEFAULT_PREVIEW_MAX_DIMENSION,
    DEFAULT_PREVIEW_MAX_PAGES,
    DEFAULT_PREVIEW_MAX_SOURCE_BYTES,
    DEFAULT_PREVIEW_WEBP_QUALITY,
    PREVIEW_RENDERER_VERSION,
    PREVIEW_SCHEMA_VERSION,
    KnowledgePreviewView,
    PreviewAsset,
    PreviewGenerationError,
    PreviewManifest,
    PreviewOriginal,
    RenderedPreview,
    RenderedPreviewAsset,
    ResolvedPreviewAsset,
)
from bomesh.storage import DocumentStorage, StoredObject
from bomesh.storage.keys import (
    IMMUTABLE_CACHE_CONTROL,
    PREVIEW,
    content_key,
    derived_key,
)

log = logging.getLogger(__name__)

_PDF_CONTENT_TYPES = frozenset({"application/pdf"})
_PDF_EXTENSIONS = frozenset({".pdf"})


class KnowledgePreview:
    """Render, store, and resolve bounded previews for one knowledge Item."""

    def __init__(
        self,
        object_storage: DocumentStorage,
        *,
        max_source_bytes: int = DEFAULT_PREVIEW_MAX_SOURCE_BYTES,
        max_pages: int = DEFAULT_PREVIEW_MAX_PAGES,
        max_dimension: int = DEFAULT_PREVIEW_MAX_DIMENSION,
        webp_quality: int = DEFAULT_PREVIEW_WEBP_QUALITY,
        max_image_pixels: int = 40_000_000,
    ) -> None:
        if min(max_source_bytes, max_pages, max_dimension, max_image_pixels) < 1:
            raise ValueError("preview limits must be greater than zero")
        if not 1 <= webp_quality <= 100:
            raise ValueError("webp_quality must be between 1 and 100")
        self._object_storage = object_storage
        self._max_source_bytes = max_source_bytes
        self.max_pages = max_pages
        self.max_dimension = max_dimension
        self.webp_quality = webp_quality
        self.max_image_pixels = max_image_pixels

    def render(self, source_path: Path, *, file_name: str, content_type: str | None) -> RenderedPreview:
        source = Path(source_path)
        if not source.is_file():
            raise PreviewGenerationError(f"preview source is not a file: {source}")
        normalized_type = (content_type or "").split(";", 1)[0].strip().casefold()
        extension = Path(file_name).suffix.casefold() or source.suffix.casefold()
        if normalized_type in _PDF_CONTENT_TYPES or extension in _PDF_EXTENSIONS:
            return self._render_pdf(source)
        return RenderedPreview(representation="original")

    @staticmethod
    def supports(*, file_name: str, content_type: str | None) -> bool:
        """Whether a page preview is rendered: PDFs only (images are not knowledge)."""

        normalized_type = (content_type or "").split(";", 1)[0].strip().casefold()
        extension = Path(file_name).suffix.casefold()
        return normalized_type in _PDF_CONTENT_TYPES or extension in _PDF_EXTENSIONS

    def _render_pdf(self, source: Path) -> RenderedPreview:
        with PDFIUM_LOCK:
            return self._render_pdf_pages(source)

    def _render_pdf_pages(self, source: Path) -> RenderedPreview:
        try:
            document = pdfium.PdfDocument(str(source))
        except Exception as exc:
            raise PreviewGenerationError("PDF preview rendering failed") from exc
        try:
            page_count = len(document)
            if page_count < 1:
                raise PreviewGenerationError("PDF preview source has no pages")
            assets: list[RenderedPreviewAsset] = []
            for page_index in range(min(page_count, self.max_pages)):
                page = document[page_index]
                try:
                    width, height = page.get_size()
                    if width <= 0 or height <= 0:
                        raise PreviewGenerationError("PDF page has invalid dimensions")
                    bitmap = page.render(scale=max(min(2.0, self.max_dimension / width, self.max_dimension / height), 0.0001))
                    try:
                        image = bitmap.to_pil()
                        try:
                            assets.append(self._webp_asset(image, page=page_index + 1))
                        finally:
                            image.close()
                    finally:
                        bitmap.close()
                finally:
                    page.close()
            return RenderedPreview(representation="pages", assets=tuple(assets), page_count=page_count, truncated=page_count > self.max_pages)
        except PreviewGenerationError:
            raise
        except Exception as exc:
            raise PreviewGenerationError("PDF preview rendering failed") from exc
        finally:
            document.close()

    def _webp_asset(self, image: Image.Image, *, page: int) -> RenderedPreviewAsset:
        self._validate_dimensions(*image.size)
        image.thumbnail((self.max_dimension, self.max_dimension), Image.Resampling.LANCZOS)
        converted = image.convert("RGBA" if "A" in image.getbands() else "RGB") if image.mode not in {"RGB", "RGBA"} else None
        rendered = converted or image
        try:
            output = BytesIO()
            rendered.save(output, format="WEBP", quality=self.webp_quality, method=4)
            data = output.getvalue()
            if not data:
                raise PreviewGenerationError("WebP encoder returned an empty preview")
            return RenderedPreviewAsset(data=data, content_type="image/webp", width=rendered.width, height=rendered.height, page=page)
        finally:
            if converted is not None:
                converted.close()

    def _validate_dimensions(self, width: int, height: int) -> None:
        if width < 1 or height < 1:
            raise PreviewGenerationError("preview source has invalid dimensions")
        if width * height > self.max_image_pixels:
            raise PreviewGenerationError("preview source exceeds the image pixel limit")

    async def generate(
        self,
        document: Item,
        *,
        page_images: bool,
        source_path: Path | None = None,
    ) -> PreviewManifest | None:
        """Build an idempotent manifest while leaving the original untouched.

        ``page_images`` is the caller's choice: knowledge documents are viewed
        from their original and get none; conversation artifacts keep PDF page
        images, kept while the source is unchanged.
        """

        shown = document.content
        if shown is None:
            return None
        key = content_key(document.tenant_id, shown.content_id)
        stored = await self._object_storage.head(key)
        if shown.size_bytes is not None and stored.size_bytes != shown.size_bytes:
            raise PreviewGenerationError(
                "stored preview source size does not match its revision"
            )
        source_version = _source_version(shown)
        if not page_images:
            return PreviewManifest(source_version=source_version, representation="original")
        return await self._page_manifest(
            document,
            _manifest(document),
            source_path=source_path,
            stored=stored,
            key=key,
            source_version=source_version,
        )

    async def _page_manifest(
        self,
        document: Item,
        current: PreviewManifest | None,
        *,
        source_path: Path | None,
        stored: StoredObject,
        key: str,
        source_version: str,
    ) -> PreviewManifest:
        if (
            current is not None
            and current.schema_version == PREVIEW_SCHEMA_VERSION
            and current.renderer_version == PREVIEW_RENDERER_VERSION
            and current.source_version == source_version
        ):
            return current
        if stored.size_bytes > self._max_source_bytes:
            return PreviewManifest(
                source_version=source_version,
                representation="original",
            )
        content_type = _content_type(document) or stored.content_type
        if not self.supports(
            file_name=_file_name(document),
            content_type=content_type,
        ):
            return PreviewManifest(
                source_version=source_version,
                representation="original",
            )

        if source_path is not None:
            source = Path(source_path)
            if not source.is_file() or source.stat().st_size != stored.size_bytes:
                raise PreviewGenerationError(
                    "local preview source does not match the stored original"
                )
            return await self._render_and_store(
                document,
                source,
                stored=stored,
                source_version=source_version,
            )

        suffix = Path(_file_name(document)).suffix
        with tempfile.TemporaryDirectory(prefix="bomesh-preview-") as directory:
            source = Path(directory) / f"source{suffix}"
            downloaded = await self._object_storage.download_to_path(
                key,
                source,
                max_bytes=self._max_source_bytes,
            )
            if downloaded.size_bytes != stored.size_bytes:
                raise PreviewGenerationError(
                    "downloaded preview source no longer matches object metadata"
                )
            return await self._render_and_store(
                document,
                source,
                stored=stored,
                source_version=source_version,
            )

    def resolve(
        self,
        document: Item,
        *,
        expires_seconds: int,
    ) -> KnowledgePreviewView | None:
        """Resolve short-lived URLs after the caller has authorized the Item."""

        if expires_seconds < 1:
            raise ValueError("preview URL lifetime must be greater than zero")
        shown = document.content
        if shown is None:
            return None
        original_request = self._object_storage.presign_download(
            content_key(document.tenant_id, shown.content_id),
            expires_seconds=expires_seconds,
            file_name=_file_name(document),
        )
        manifest = _manifest(document)
        representation = manifest.representation if manifest is not None else "original"
        assets = (
            self.resolve_assets(document, manifest, expires_seconds=expires_seconds)
            if manifest is not None
            else []
        )
        if representation != "original" and not assets:
            representation = "original"
        return KnowledgePreviewView(
            representation=representation,
            original=PreviewOriginal(
                url=original_request.url,
                file_name=_file_name(document),
                content_type=_content_type(document) or "application/octet-stream",
                size_bytes=max(0, shown.size_bytes or 0),
            ),
            assets=tuple(assets),
            page_count=manifest.page_count if manifest is not None else None,
            truncated=manifest.truncated if manifest is not None else False,
        )

    def resolve_assets(
        self,
        document: Item,
        manifest: PreviewManifest,
        *,
        expires_seconds: int,
    ) -> list[ResolvedPreviewAsset]:
        """Short-lived URLs of a manifest's page images, after the caller was authorized."""

        shown = document.content
        if shown is None or manifest.source_version != _source_version(shown):
            return []
        assets: list[ResolvedPreviewAsset] = []
        for position, asset in enumerate(manifest.assets, start=1):
            try:
                request = self._object_storage.presign_download(
                    _asset_key(document.tenant_id, shown.content_id, page=asset.page, position=position),
                    expires_seconds=expires_seconds,
                )
            except Exception:
                log.exception("could not resolve derived preview object")
                continue
            assets.append(
                ResolvedPreviewAsset(
                    url=request.url,
                    content_type=asset.content_type,
                    size_bytes=asset.size_bytes,
                    width=asset.width,
                    height=asset.height,
                    page=asset.page,
                )
            )
        return assets

    async def _render_and_store(
        self,
        document: Item,
        source: Path,
        *,
        stored: StoredObject,
        source_version: str,
    ) -> PreviewManifest:
        rendered = await asyncio.to_thread(
            self.render,
            source,
            file_name=_file_name(document),
            content_type=_content_type(document) or stored.content_type,
        )
        shown = document.content
        assert shown is not None
        assets: list[PreviewAsset] = []
        for position, rendered_asset in enumerate(rendered.assets, start=1):
            persisted = await asyncio.to_thread(
                self._object_storage.put_bytes,
                rendered_asset.data,
                _asset_key(
                    document.tenant_id,
                    shown.content_id,
                    page=rendered_asset.page,
                    position=position,
                ),
                content_type=rendered_asset.content_type,
                cache_control=IMMUTABLE_CACHE_CONTROL,
            )
            assets.append(
                PreviewAsset(
                    content_type=rendered_asset.content_type,
                    size_bytes=persisted.size_bytes,
                    width=rendered_asset.width,
                    height=rendered_asset.height,
                    page=rendered_asset.page,
                )
            )
        return PreviewManifest(
            source_version=source_version,
            representation=rendered.representation,
            assets=tuple(assets),
            page_count=rendered.page_count,
            truncated=rendered.truncated,
        )


def _manifest(document: Item) -> PreviewManifest | None:
    """The manifest of the revision ``document`` shows (``exports.preview``).

    ``document`` carries that revision (``artifact_store.revision_document``).
    """
    revision = document.current_revision
    if revision is None:
        return None
    return parse_manifest(revision.exports.get("preview"))


def parse_manifest(value: object) -> PreviewManifest | None:
    """A stored preview manifest (``item_revisions.exports.preview``), if current."""

    if value is None:
        return None
    try:
        manifest = PreviewManifest.model_validate(value)
    except ValueError:
        return None
    return manifest if manifest.schema_version == PREVIEW_SCHEMA_VERSION else None


def _source_version(shown: ItemContent) -> str:
    """What a manifest was derived from: the content identity (its bytes never change)."""
    return str(shown.content_id)


def _product_version(label: str) -> int:
    """``webp-v1`` → 1: the derived key version of a producer."""
    return int(label.rsplit("v", 1)[1])


def _asset_key(tenant_id: UUID, content_id: UUID, *, page: int | None, position: int) -> str:
    part = f"page-{page:04d}.webp" if page is not None else f"asset-{position:04d}.webp"
    return derived_key(
        tenant_id, content_id, PREVIEW, _product_version(PREVIEW_RENDERER_VERSION), part
    )


def _file_name(document: Item) -> str:
    shown = document.content
    return (
        _text(shown.file_name if shown is not None else None)
        or _text(document.item_name)
        or "document"
    )


def _content_type(document: Item) -> str | None:
    shown = document.content
    return _text(shown.mime_type) if shown is not None else None


def _text(value: object) -> str | None:
    normalized = str(value).strip() if value is not None else ""
    return normalized or None


__all__ = ["KnowledgePreview", "parse_manifest"]
