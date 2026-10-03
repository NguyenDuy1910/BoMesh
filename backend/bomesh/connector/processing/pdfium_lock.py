"""The one lock every PDFium call in this process holds.

PDFium is a process-global C library and is not thread-safe: two threads in
it at once, even on different documents, corrupt its heap and abort the
process. Text extraction and preview rendering both run in worker threads
(``asyncio.to_thread``) and the ingestion worker runs several Activities at
once, so every use of ``pypdfium2`` — opening a document through closing
it — runs under this lock.
"""

from __future__ import annotations

import threading

PDFIUM_LOCK = threading.Lock()

__all__ = ["PDFIUM_LOCK"]
