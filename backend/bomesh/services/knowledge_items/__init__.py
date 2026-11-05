"""Knowledge services, Item part: collections, documents, revisions, links, IAM, search.

Services (one per resource, built with ``from_runtime``):
:class:`~.items.KnowledgeItemService`, :class:`~.content.ItemContentService`,
:class:`~.links.ItemLinkService`, :class:`~.iam.ItemIamService`,
:class:`~.search.ItemSearchService`. Engines (no authorization; the caller's
session): :mod:`.item_store` (rows, tree lifecycle, revisions),
:mod:`.indexing` (processing a document into the index, payload upkeep),
:mod:`.file_content`, :mod:`.preview`, :mod:`.rendition`, :mod:`.citations`
and :mod:`.archive_expansion`.

Cross-domain API (the caller authorizes; session-taking functions run inside
the caller's transaction):

- :func:`~.item_store.ensure_personal_collection` /
  :func:`~.item_store.personal_collection_id` — a member's PERSONAL collection
  (Workspaces).
- :func:`~.items.create_document` — a document with its bytes (Artifacts
  publish, request answers).
- :func:`~.documents.set_document_metadata`, :func:`~.documents.tag_document` —
  document type, summary and the one topic tagger (contribution approval).
- :func:`~.items.move_item`, :func:`~.items.publish_item`,
  :func:`~.items.append_revision_from`, :func:`~.items.delete_item` —
  contribution approval (KnowledgeCuration); they return the document IDs whose
  index payload changed: pass them to :func:`~.indexing.sync_item_payloads`
  after commit.
- :func:`~.search.retrieve_passages` — the agent's knowledge search (Conversations).
- :mod:`.inventory` builders (``failed_document_ids`` …) — counts for the
  workspace overview, knowledge gaps and IAM analysis (Workspaces).
- :func:`~.indexing.reconcile_dirty_payloads` — the scheduled payload retry;
  :func:`~.purge.purge_deleted_items` — the scheduled purge of items past
  ``purgeTime`` (maintenance activities).
- :mod:`.summary`: ``get_item_summary`` — a visibility-checked reference summary
  (merge chains resolved; ``serves_content`` false when resolved through a
  merge); ``visible_or_discoverable_summary`` /
  ``is_visible_or_discoverable_root`` also admit LOCKED discoverable roots
  (access requests); ``readable_item_ids``, ``collection_ids_for_spaces`` —
  batch visibility for references and space scopes (Collaboration,
  Conversations).
- :mod:`.content`: ``resolve_page_assets``, ``resolve_rendition`` — signed
  viewer URLs of a revision's preview manifest (Artifacts snapshots);
  ``item_thumbnail`` the current revision's first page image (Library Home).
"""
