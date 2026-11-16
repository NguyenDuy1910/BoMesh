"""IMAGE: pictures a browser cannot show (BMP, TIFF, ICO) as WebP.

The first frame, turned upright, scaled to at most :data:`MAX_SIDE` pixels on
its long side (never enlarged), alpha kept.
"""

from __future__ import annotations

from io import BytesIO
from pathlib import Path

from PIL import Image, ImageOps, UnidentifiedImageError

from bomesh.services.previews.results import UNREADABLE, ConversionFailed, Output

MAX_SIDE = 4096
WEBP_QUALITY = 85
#: Decoded pixels a picture may have (a decompression bomb is refused).
MAX_PIXELS = 100_000_000
_WIDE_MODES = frozenset({"I", "I;16", "I;16B", "I;16L", "I;16N", "F"})


def produce_image(source: Path) -> Output:
    """The WebP IMAGE representation of the picture ``source``."""
    try:
        with Image.open(source) as image:
            width, height = image.size
            if width < 1 or height < 1 or width * height > MAX_PIXELS:
                raise ConversionFailed(UNREADABLE, "the picture has unusable dimensions")
            image.seek(0)
            frame = _displayable(ImageOps.exif_transpose(image))
            try:
                frame.thumbnail((MAX_SIDE, MAX_SIDE), Image.Resampling.LANCZOS)
                output = BytesIO()
                frame.save(output, format="WEBP", quality=WEBP_QUALITY, method=4)
            finally:
                frame.close()
    except (UnidentifiedImageError, Image.DecompressionBombError, OSError, ValueError) as exc:
        raise ConversionFailed(UNREADABLE, "the picture cannot be decoded") from exc
    return Output(data=output.getvalue(), mime_type="image/webp", extension="webp")


def _displayable(image: Image.Image) -> Image.Image:
    """An RGB(A) copy of ``image`` (16-bit and float pictures scaled to 8 bits)."""
    if image.mode in _WIDE_MODES:
        image = image.convert("I").point(lambda value: value * (1 / 256)).convert("L")
    alpha = "A" in image.getbands() or "transparency" in image.info
    return image.convert("RGBA" if alpha else "RGB")


__all__ = ["MAX_SIDE", "produce_image"]
