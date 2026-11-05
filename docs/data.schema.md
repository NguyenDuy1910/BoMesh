# BoMesh Storage Ownership

The canonical PostgreSQL schema is
[`design.dbml`](../backend/docs_design/design.dbml), implemented by
`backend/bomesh/db/models/`. Storage ownership, identity and session
separation, Item lineage, ID and index policy, and the schema-change policy are
described in
[`database_architecture.md`](../backend/docs_design/database_architecture.md);
the Item domain (collections, documents, revisions, publication and indexing
states) is in [`item_model.md`](../backend/docs_design/item_model.md).
