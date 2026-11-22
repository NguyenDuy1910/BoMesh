"""The configured vision model, and the text it reads inside pictures.

Scanned PDF pages go through Docling's VLM pipeline with this model
(``docling._vision_converter``). Pictures inside documents — slides saved as
images, diagrams, screenshots — are read here, one call per distinct picture,
only for a run that asks for it (``IngestionRun.readImages``).
"""

from __future__ import annotations

import base64
import hashlib
import time
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
#: The model's whole reply when a picture has no text (models describe a blank
#: image instead of replying with nothing).
_NO_TEXT = "NO_TEXT"
_PICTURE_PROMPT = (
    "Transcribe every visible text in this image exactly, in reading order and in "
    "its original language; use Markdown headings, lists and tables. Do not "
    "summarize, translate, describe or invent anything. Output only the Markdown. "
    f"If the image has no text, reply with exactly {_NO_TEXT}."
)
#: The model stopped before the end (a runaway repetition, or content withheld).
_INCOMPLETE_FINISH_REASONS = frozenset({"length", "content_filter"})
#: Busy (rate-limited) or failing upstream: worth asking again shortly.
_RETRY_STATUSES = frozenset({408, 429, 500, 502, 503, 504})
#: Waits before the 2nd, 3rd and 4th attempt; a Retry-After header wins when shorter than a minute.
_RETRY_DELAYS = (2.0, 5.0, 15.0)

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


def picture_reader(
    vision: VisionModel, *, transport: httpx.BaseTransport | None = None
) -> PictureReader:
    """Read one picture with ``vision``; any failure is a :class:`DoclingTranscriptionError`.

    A rate limit or an upstream error is asked again (``_RETRY_DELAYS``);
    only the last failure fails the picture.
    """

    client = httpx.Client(
        base_url=vision.base_url.rstrip("/"),
        headers={"Authorization": f"Bearer {vision.api_key}"},
        timeout=vision.timeout_seconds,
        transport=transport,
    )

    def post(body: dict[str, object]) -> httpx.Response:
        for delay in _RETRY_DELAYS:
            try:
                response = client.post("/chat/completions", json=body)
            except httpx.TransportError:
                time.sleep(delay)
                continue
            if response.status_code not in _RETRY_STATUSES:
                return response.raise_for_status()
            time.sleep(_retry_after(response, default=delay))
        return client.post("/chat/completions", json=body).raise_for_status()

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
            choice = post(body).json()["choices"][0]
        except (httpx.HTTPError, ValueError, LookupError, TypeError) as exc:
            raise DoclingTranscriptionError("the vision model could not read a picture") from exc
        if choice.get("finish_reason") in _INCOMPLETE_FINISH_REASONS:
            raise DoclingTranscriptionError("the vision model did not finish reading a picture")
        text = str((choice.get("message") or {}).get("content") or "").strip()
        return "" if text == _NO_TEXT else text

    return read


def _retry_after(response: httpx.Response, *, default: float) -> float:
    try:
        seconds = float(response.headers.get("retry-after", ""))
    except ValueError:
        return default
    return seconds if 0 <= seconds <= 60 else default


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
