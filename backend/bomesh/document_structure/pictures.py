"""Pictures live beside a Structured Document, referenced by name, never inside it.

Docling's Office backends embed every bitmap as a ``data:`` URI; serialized
as is, a slide deck's JSON would carry megabytes of base64. Before storing,
each picture is re-encoded as PNG, named by its SHA-256 (identical pictures —
a logo on every slide — become one object) and its ``image.uri`` becomes that
name. A picture that is too small, too large in number or bytes, or
unreadable keeps no image (its caption and text remain).
"""

from __future__ import annotations

from dataclasses import dataclass
from hashlib import sha256
from io import BytesIO
from pathlib import Path

from docling_core.types.doc import DoclingDocument, ImageRef, Size
from PIL import Image

from .identity import PICTURE_NAME_PATTERN

MIN_SIDE_PIXELS = 32
MAX_SIDE_PIXELS = 4096
MAX_PICTURES = 500
MAX_TOTAL_BYTES = 50 * 1024 * 1024


@dataclass(frozen=True, slots=True)
class PictureObject:
    """A picture to store as ``images-v1/{name}``."""

    name: str
    data: bytes


def externalize_pictures(document: DoclingDocument) -> tuple[PictureObject, ...]:
    """Replace embedded pictures by name references; return the distinct objects to store.

    Mutates ``document``. Pictures already referenced by name are kept.
    """

    objects: dict[str, PictureObject] = {}
    total = 0
    for picture in document.pictures:
        image = picture.image
        if image is None or PICTURE_NAME_PATTERN.match(str(image.uri)):
            continue
        encoded = None
        if len(objects) < MAX_PICTURES:
            encoded = _png(image)
        if encoded is None:
            picture.image = None
            continue
        data, width, height = encoded
        name = f"{sha256(data).hexdigest()}.png"
        if name not in objects:
            if total + len(data) > MAX_TOTAL_BYTES:
                picture.image = None
                continue
            total += len(data)
            objects[name] = PictureObject(name=name, data=data)
        picture.image = ImageRef(
            mimetype="image/png",
            dpi=image.dpi,
            size=Size(width=width, height=height),
            uri=Path(name),
        )
    return tuple(objects.values())


def _png(image: ImageRef) -> tuple[bytes, int, int] | None:
    try:
        pil = image.pil_image
    except (OSError, ValueError):
        return None
    if pil is None:
        return None
    try:
        width, height = pil.size
        if min(width, height) < MIN_SIDE_PIXELS:
            return None
        if max(width, height) > MAX_SIDE_PIXELS:
            pil = pil.copy()
            pil.thumbnail((MAX_SIDE_PIXELS, MAX_SIDE_PIXELS))
            width, height = pil.size
        if pil.mode not in ("RGB", "RGBA", "L", "LA", "P"):
            pil = pil.convert("RGBA")
        buffer = BytesIO()
        pil.save(buffer, format="PNG", optimize=True)
    except (OSError, ValueError):
        return None
    return buffer.getvalue(), width, height


__all__ = [
    "MAX_PICTURES",
    "MAX_SIDE_PIXELS",
    "MAX_TOTAL_BYTES",
    "MIN_SIDE_PIXELS",
    "PictureObject",
    "externalize_pictures",
]
