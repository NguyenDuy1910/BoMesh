"""The preview engine: every stored file → one of six representations (``document_viewer.md``).

One package owns turning a stored original into something to look at:

- :mod:`.formats` — the format registry: extension (then MIME type) →
  representation kind and how to get it (as is, or a producer).
- Producers: :mod:`.gotenberg` (Office, OpenDocument, RTF, HTML, e-mail → PDF),
  :mod:`.images` (uncommon pictures → WebP), :mod:`.text` (text and code →
  UTF-8), :mod:`.tables` (CSV/TSV/XLSX → TABLE JSON), :mod:`.archives` (ZIP →
  entry list).
- :mod:`.manifest` — what a revision records (``item_revisions.exports``) and
  where derived objects live.
- :mod:`.engine` — :class:`~.engine.PreviewEngine`: the read path
  (GetItemPreview) and the produce path (ingestion worker).
- :mod:`.covers` — ``document.cover``: produced after the representation,
  resolved on every listed Item.

Requests never convert; the ingestion worker produces (``bomesh_cover`` on
content arrival, ``bomesh_preview`` when a read finds a representation
missing, and a periodic sweep).
"""
