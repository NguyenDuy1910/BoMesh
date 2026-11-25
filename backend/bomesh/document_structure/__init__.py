"""The Structured Document: BoMesh's one content representation of a document.

A document's original is parsed once per :class:`ParseProfile` into a Docling
JSON (``workspaces/{code}/files/{content}/structure-v1/{fingerprint}.json.gz``) with
its pictures stored beside it by name. Chunking, citations, the content API
and the agent all read it; nothing parses the original again. This package is
pure (no database, no storage I/O): identities, the block rules, the codec,
picture externalization and the read projection.
"""

from .codec import MEDIA_TYPE, StructureDecodeError, decode_document, decode_json, encode
from .identity import (
    MAX_LOCATION_CHARACTERS,
    MAX_QUOTE_CHARACTERS,
    CitationTarget,
    Fingerprint,
    NodeRef,
    ParseProfile,
    StructureManifest,
    StructureRef,
    clip,
    node_ref,
    self_ref,
)
from .nodes import (
    ContentCell,
    ContentImage,
    ContentNode,
    ContentRun,
    ContentWindow,
    NodeKind,
)
from .pictures import PictureObject, externalize_pictures
from .tree import DoclingTree, NodeTree, block_ref
from .view import MAX_TABLE_ROWS, StructureView

__all__ = [
    "MAX_LOCATION_CHARACTERS",
    "MAX_QUOTE_CHARACTERS",
    "MAX_TABLE_ROWS",
    "MEDIA_TYPE",
    "CitationTarget",
    "ContentCell",
    "ContentImage",
    "ContentNode",
    "ContentRun",
    "ContentWindow",
    "DoclingTree",
    "Fingerprint",
    "NodeKind",
    "NodeRef",
    "NodeTree",
    "ParseProfile",
    "PictureObject",
    "StructureDecodeError",
    "StructureManifest",
    "StructureRef",
    "StructureView",
    "block_ref",
    "clip",
    "decode_document",
    "decode_json",
    "encode",
    "externalize_pictures",
    "node_ref",
    "self_ref",
]
