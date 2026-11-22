"""The configured vision model, and the text it reads inside pictures.

Scanned PDF pages go through Docling's VLM pipeline with this model
(``docling._vision_converter``). Pictures inside documents — slides saved as
images, diagrams, screenshots — are read here, one call per distinct picture,
only for a run that asks for it (``IngestionRun.readImages``).
"""

from __future__ import annotations

import base64
import hashlib
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from io import BytesIO

import httpx
from docling_core.types.doc import (
    DescriptionAnnotation,
    DescriptionMetaField,
    DoclingDocument,
    PictureItem,
    PictureMeta,
)
from PIL.Image import Image

from . import DoclingTranscriptionError

#: Narrower or shorter pictures are icons, bullets and rules: nothing to read.
MIN_PICTURE_PIXELS = 32
#: Larger pictures are scaled down first; vision models downsample anyway.
MAX_PICTURE_PIXELS = 2048
_PICTURE_PROMPT = (
    "Transcribe every visible text in this image exactly, in reading order and in "
    "its original language; use Markdown headings, lists and tables. Do not "
    "summarize, translate, describe or invent anything. If the image has no text, "
    "reply with nothing. Output only the Markdown."
)
#: The model stopped before the end (a runaway repetition, or content withheld).
_INCOMPLETE_FINISH_REASONS = frozenset({"length", "content_filter"})

#: PNG bytes → the text in the picture ("" when it has none).
PictureReader = Callable[[bytes], str]


@dataclass(frozen=True, slots=True)
class VisionModel:
    """The configured vision model (``BOMESH_DOCLING_MODEL``) on an OpenAI-compatible endpoint."""

    api_key: str
    base_url: str
    model: str
    timeout_seconds: float = 120.0
    concurrency: int = 2
    max_tokens: int = 8192

    def __post_init__(self) -> None:
        if not self.api_key.strip() or not self.model.strip():
            raise ValueError("the vision model needs an API key and a model")
        if self.timeout_seconds <= 0 or self.concurrency < 1 or self.max_tokens < 1:
            raise ValueError("vision model limits must be positive")


def picture_reader(vision: VisionModel) -> PictureReader:
    """Read one picture with ``vision``; any failure is a :class:`DoclingTranscriptionError`."""

    client = httpx.Client(
        base_url=vision.base_url.rstrip("/"),
        headers={"Authorization": f"Bearer {vision.api_key}"},
        timeout=vision.timeout_seconds,
    )

    def read(png: bytes) -> str:
        image = f"data:image/png;base64,{base64.b64encode(png).decode('ascii')}"
        body = {
            "model": vision.model,
            "max_tokens": vision.max_tokens,
            "temperature": 0,
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": _PICTURE_PROMPT},
                        {"type": "image_url", "image_url": {"url": image}},
                    ],
                }
            ],
        }
        try:
            response = client.post("/chat/completions", json=body)
            response.raise_for_status()
            choice = response.json()["choices"][0]
        except (httpx.HTTPError, ValueError, LookupError, TypeError) as exc:
            raise DoclingTranscriptionError("the vision model could not read a picture") from exc
        if choice.get("finish_reason") in _INCOMPLETE_FINISH_REASONS:
            raise DoclingTranscriptionError("the vision model did not finish reading a picture")
        return str((choice.get("message") or {}).get("content") or "").strip()

    return read


def read_pictures(
    document: DoclingDocument, read: PictureReader, *, concurrency: int, created_by: str
) -> None:
    """Give every readable picture of ``document`` the text the model reads in it.

    The text is the picture's description (``meta.description``, by
    ``created_by``), so the picture's element carries it
    (``ImagePart.description``) and chunking serializes it with the picture's
    page and box: chunks and citations land on the picture. Identical
    pictures (a logo on every slide) are read once.
    """

    pngs = {
        picture.self_ref: png
        for picture in document.pictures
        if (png := _png(picture.get_image(document))) is not None
    }
    digests = {ref: hashlib.sha256(png).hexdigest() for ref, png in pngs.items()}
    distinct = {digests[ref]: png for ref, png in pngs.items()}
    with ThreadPoolExecutor(max_workers=concurrency) as pool:
        texts = dict(zip(distinct, pool.map(read, distinct.values()), strict=True))
    for picture in document.pictures:
        text = texts.get(digests.get(picture.self_ref, ""), "")
        if text:
            _describe(picture, text, created_by=created_by)


def _describe(picture: PictureItem, text: str, *, created_by: str) -> None:
    meta = picture.meta or PictureMeta()
    meta.description = DescriptionMetaField(text=text, created_by=created_by)
    picture.meta = meta


def picture_descriptions(picture: PictureItem) -> list[str]:
    """The text a picture carries: its description annotations and ``meta.description``."""
    # ``annotations`` is read from the instance dict: the field is deprecated, and
    # reading it through the attribute warns.
    texts = [
        annotation.text
        for annotation in picture.__dict__.get("annotations", ())
        if isinstance(annotation, DescriptionAnnotation)
    ]
    if picture.meta is not None and picture.meta.description is not None:
        texts.append(picture.meta.description.text)
    return texts


def _png(image: Image | None) -> bytes | None:
    if image is None or min(image.size) < MIN_PICTURE_PIXELS:
        return None
    if max(image.size) > MAX_PICTURE_PIXELS:
        image = image.copy()
        image.thumbnail((MAX_PICTURE_PIXELS, MAX_PICTURE_PIXELS))
    if image.mode not in ("RGB", "RGBA", "L", "LA"):
        image = image.convert("RGBA" if "A" in image.getbands() else "RGB")
    buffer = BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


__all__ = [
    "PictureReader",
    "VisionModel",
    "picture_descriptions",
    "picture_reader",
    "read_pictures",
]
