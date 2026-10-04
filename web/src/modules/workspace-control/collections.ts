/**
 * Domain types for the knowledge side of workspace control: collections, the
 * documents inside them, where a document came from, and the grants that
 * decide who can read them. Sources and connections live in
 * `@/modules/ingestion/integrations-api`.
 */

export interface Paginated<T> {
  items: T[];
  total: number;
  page?: number;
  page_size?: number;
}

export interface ExternalResource {
  id: string;
  external_id: string;
  source_url: string | null;
  ingestion_source_id: string;
  integration_connection: {
    id: string;
    display_name: string;
    connector_key: string;
  };
}

export interface KnowledgeItem {
  [key: string]: unknown;
  id: string;
  item_type: "collection" | "document";
  document_type: string | null;
  title: string;
  mime_type: string | null;
  size_bytes: number | null;
  parent_item_id: string | null;
  parent_relation: string | null;
  status: "pending" | "processing" | "ready" | "failed" | "unsupported";
  indexed: boolean;
  item_count?: number;
  source_count?: number;
  created_by_user_id: string | null;
  created_at: string;
  updated_at: string;
  external_resources: ExternalResource[];
  metadata?: Record<string, unknown>;
  inherit_access?: boolean;
  role_assignments?: CollectionGrant[];
}

export interface CollectionGrant {
  [key: string]: unknown;
  item_id?: string | null;
  principal_type: "user" | "group";
  principal_id: string;
  role_id?: string;
  role_code: "collection_owner" | "collection_editor" | "collection_viewer";
  role_display_name?: string;
  created_at?: string;
  updated_at?: string;
}

export interface DirectoryUser {
  [key: string]: unknown;
  id: string;
  email: string;
  display_name: string | null;
  status: string;
}

export interface DirectoryGroup {
  [key: string]: unknown;
  id: string;
  display_name: string;
  status: string;
  member_count: number;
}

/** Collections carry their description in metadata rather than a column. */
export function collectionDescription(item: KnowledgeItem) {
  const description = item.metadata?.description;
  return typeof description === "string" ? description : "";
}
