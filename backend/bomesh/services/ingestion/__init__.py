"""Ingestion services: connectors, ingestion policies, connections, sources and
their syncs, ingestion runs and their tasks (``api_design.md`` §6).

Engines: :mod:`.run_engine` (Ingestion Run state), :mod:`.source_store` and
:mod:`.source_sync` (Source rows and their syncs), :mod:`.connection_store`,
:mod:`.credentials` and :mod:`.oauth_flow` (integration connections).

Cross-domain API (light modules):

- :mod:`.names`: ``source_name(ws, code)``, ``parse_source(name, ws, *, field)``,
  ``source_id_by_code(ws, code)``, ``await source_codes(session, ids)``,
  ``connection_name(ws, code)``;
- :mod:`.queries` SQL builders (no session, no permission check):
  ``failing_source_codes(ws)``, ``expired_connection_codes(ws)``,
  ``processed_document_rows()``.
"""
