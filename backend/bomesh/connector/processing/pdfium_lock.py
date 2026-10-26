"""The one lock every PDFium call in this process holds.

PDFium is a process-global C library and is not thread-safe: two threads in
it at once, even on different documents, corrupt its heap and abort the
process. Text extraction, preview rendering and Docling's own PDF backends
(which render scanned pages for transcription) all run in worker threads, and
the ingestion worker runs several Activities at once. Docling guards its
PDFium calls with ``docling.utils.locks.pypdfium2_lock``; this is that same
lock, so BoMesh and Docling never enter PDFium together. It is not re-entrant:
never call into Docling while holding it.
"""

from __future__ import annotations

from docling.utils.locks import pypdfium2_lock as PDFIUM_LOCK

__all__ = ["PDFIUM_LOCK"]
