"use client";

import clsx from "clsx";
import { LoaderCircle, MessageSquarePlus, Search } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";

import { listCollections } from "@/modules/chat/api";
import {
  findDocumentsByContent,
  findDocumentsByName,
  type FoundDocument,
  recentDocuments,
} from "@/modules/knowledge/document-search";
import { formatRelative } from "@/modules/workspace-control/format";
import { FileTypeIcon } from "./ResourceIcon";

/** One submitted content search; `request` lets the same words be searched again. */
export interface ContentSearch {
  query: string;
  request: number;
}

type Loadable =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "ready"; items: FoundDocument[] }
  | { state: "error"; message: string };

const NAME_SEARCH_DELAY_MS = 250;
const MIN_NAME_QUERY_LENGTH = 2;

/**
 * Find a document from the chat home: by name while typing, inside documents
 * on Enter. A result opens beside the chat, or becomes context for a question.
 */
export function DocumentFinder({
  activeDocumentId,
  contentSearch,
  onAsk,
  onAskQuestion,
  onAskSelected,
  onSearchContent,
  onToggleSelect,
  onView,
  query,
  selectedIds,
}: {
  activeDocumentId?: string;
  contentSearch: ContentSearch | null;
  onAsk: (document: FoundDocument) => void;
  onAskQuestion: (question: string) => void;
  onAskSelected: () => void;
  onSearchContent: () => void;
  onToggleSelect: (document: FoundDocument) => void;
  onView: (document: FoundDocument) => void;
  query: string;
  selectedIds: ReadonlySet<string>;
}) {
  const trimmed = query.trim();
  const showsRecent = !trimmed;
  const [recent, setRecent] = useState<Loadable>({ state: "idle" });
  const [names, setNames] = useState<Loadable>({ state: "idle" });
  const [contents, setContents] = useState<Loadable>({ state: "idle" });
  const [recentRequest, setRecentRequest] = useState(0);
  const [nameRequest, setNameRequest] = useState(0);
  const [collections, setCollections] = useState<ReadonlyMap<string, string>>(new Map());

  // Collection names only label results; a failure leaves them unlabeled.
  useEffect(() => {
    const controller = new AbortController();
    void listCollections(controller.signal)
      .then((items) => setCollections(new Map(items.map((item) => [item.id, item.title]))))
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!showsRecent) return;
    let current = true;
    setRecent((previous) => previous.state === "ready" ? previous : { state: "loading" });
    recentDocuments()
      .then((items) => {
        if (current) setRecent({ state: "ready", items });
      })
      .catch((cause: unknown) => {
        if (current) setRecent({ state: "error", message: failure(cause) });
      });
    return () => {
      current = false;
    };
  }, [recentRequest, showsRecent]);

  useEffect(() => {
    if (trimmed.length < MIN_NAME_QUERY_LENGTH) {
      setNames({ state: "idle" });
      return;
    }
    const controller = new AbortController();
    // Earlier matches stay on screen while the next ones load, so typing
    // never blanks the list between keystrokes.
    setNames((previous) => previous.state === "ready" ? previous : { state: "loading" });
    const timer = window.setTimeout(() => {
      findDocumentsByName(trimmed, controller.signal)
        .then((items) => setNames({ state: "ready", items }))
        .catch((cause: unknown) => {
          if (!controller.signal.aborted) setNames({ state: "error", message: failure(cause) });
        });
    }, NAME_SEARCH_DELAY_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [nameRequest, trimmed]);

  useEffect(() => {
    if (!contentSearch) {
      setContents({ state: "idle" });
      return;
    }
    const controller = new AbortController();
    setContents({ state: "loading" });
    findDocumentsByContent(contentSearch.query, controller.signal)
      .then((items) => setContents({ state: "ready", items }))
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setContents({ state: "error", message: failure(cause) });
      });
    return () => controller.abort();
  }, [contentSearch]);

  // A document found both ways is listed once, by name, carrying the passage
  // the content search found in it.
  const { nameMatches, contentMatches } = useMemo(() => {
    const found = contents.state === "ready" ? contents.items : [];
    const passages = new Map(found.map((document) => [document.id, document.match]));
    const named = names.state === "ready"
      ? names.items.map((document) => ({ ...document, match: passages.get(document.id) ?? document.match }))
      : [];
    const namedIds = new Set(named.map((document) => document.id));
    return {
      nameMatches: named,
      contentMatches: found.filter((document) => !namedIds.has(document.id)),
    };
  }, [contents, names]);

  // Content results belong to the words that were searched; editing the
  // query offers a new content search instead of showing stale passages.
  const searchedContent = contentSearch?.query === trimmed ? contentSearch.query : null;
  const nameSearchSettled = trimmed.length < MIN_NAME_QUERY_LENGTH
    || names.state === "ready"
    || names.state === "error";
  const nothingFound = searchedContent !== null
    && nameSearchSettled
    && contents.state === "ready"
    && nameMatches.length === 0
    && contentMatches.length === 0;

  const row = (document: FoundDocument) => (
    <FinderRow
      active={document.id === activeDocumentId}
      collectionTitle={document.collectionId ? collections.get(document.collectionId) : undefined}
      document={document}
      key={document.id}
      onAsk={() => onAsk(document)}
      onToggle={() => onToggleSelect(document)}
      onView={() => onView(document)}
      selected={selectedIds.has(document.id)}
    />
  );

  return (
    <section aria-label="Find documents" className="document-finder">
      <header className="document-finder__header">
        <h2>Find a document</h2>
        <p>Search everything you can read. Open a document beside the chat, or select a few and ask about them.</p>
      </header>

      {showsRecent ? (
        <FinderGroup label="Recent">
          <GroupBody
            empty="Documents you work with will appear here."
            load={recent}
            onRetry={() => setRecentRequest((value) => value + 1)}
            render={(items) => items.slice(0, 6).map(row)}
          />
        </FinderGroup>
      ) : nothingFound ? (
        <div className="document-finder__empty" role="status">
          <p>No document matches “{trimmed}” by name or content.</p>
          <button className="document-finder__inline-action" onClick={() => onAskQuestion(trimmed)} type="button">
            <MessageSquarePlus aria-hidden="true" size={14} />
            Ask BoMesh instead
          </button>
        </div>
      ) : (
        <>
          {trimmed.length >= MIN_NAME_QUERY_LENGTH && (
            <FinderGroup label="Name matches">
              <GroupBody
                empty={`No document name contains “${trimmed}”.`}
                load={names}
                onRetry={() => setNameRequest((value) => value + 1)}
                render={() => nameMatches.map(row)}
              />
            </FinderGroup>
          )}
          <FinderGroup label="Inside documents">
            {searchedContent === null ? (
              <button className="document-finder__inline-action" onClick={onSearchContent} type="button">
                <Search aria-hidden="true" size={14} />
                Search inside documents for “{trimmed}”
              </button>
            ) : (
              <GroupBody
                empty={nameMatches.length
                  ? "No other document mentions it."
                  : `Nothing inside your documents matches “${searchedContent}”.`}
                load={contents}
                loadingLabel="Reading the most relevant passages…"
                onRetry={onSearchContent}
                render={() => contentMatches.map(row)}
              />
            )}
          </FinderGroup>
        </>
      )}

      {selectedIds.size > 0 && (
        <div className="document-finder__selection" role="status">
          <span>{selectedIds.size === 1 ? "1 document selected" : `${selectedIds.size} documents selected`}</span>
          <button className="document-finder__ask-selected" onClick={onAskSelected} type="button">
            <MessageSquarePlus aria-hidden="true" size={14} />
            {selectedIds.size === 1 ? "Ask about it" : "Ask about them"}
          </button>
        </div>
      )}
    </section>
  );
}

function FinderGroup({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div className="document-finder__group">
      <h3 className="document-finder__label">{label}</h3>
      {children}
    </div>
  );
}

function GroupBody({
  empty,
  load,
  loadingLabel = "Searching…",
  onRetry,
  render,
}: {
  empty: string;
  load: Loadable;
  loadingLabel?: string;
  onRetry: () => void;
  render: (items: FoundDocument[]) => ReactNode[];
}) {
  if (load.state === "idle" || load.state === "loading") {
    return (
      <p className="document-finder__note" role="status">
        <LoaderCircle aria-hidden="true" className="composer-attachment__spin" size={14} />
        {loadingLabel}
      </p>
    );
  }
  if (load.state === "error") {
    return (
      <p className="document-finder__note document-finder__note--error" role="alert">
        {load.message}
        <button className="document-finder__inline-action" onClick={onRetry} type="button">Try again</button>
      </p>
    );
  }
  const rows = render(load.items);
  return rows.length
    ? <ul className="document-finder__list">{rows}</ul>
    : <p className="document-finder__note">{empty}</p>;
}

function FinderRow({
  active,
  collectionTitle,
  document,
  onAsk,
  onToggle,
  onView,
  selected,
}: {
  active: boolean;
  collectionTitle?: string;
  document: FoundDocument;
  onAsk: () => void;
  onToggle: () => void;
  onView: () => void;
  selected: boolean;
}) {
  const match = document.match;
  const location = match?.page ? `Page ${match.page}` : match?.section;
  const meta = [
    collectionTitle,
    location,
    document.updatedAt ? `Updated ${formatRelative(document.updatedAt)}` : undefined,
    statusLabel(document.status),
  ].filter(Boolean).join(" · ");

  return (
    <li className={clsx("finder-row", selected && "is-selected", active && "is-active")}>
      <input
        aria-label={`Select ${document.name}`}
        checked={selected}
        className="finder-row__select"
        onChange={onToggle}
        type="checkbox"
      />
      <button
        aria-current={active || undefined}
        className="finder-row__open"
        onClick={onView}
        title="Open beside the chat"
        type="button"
      >
        <FileTypeIcon name={document.name} />
        <span className="finder-row__text">
          <span className="finder-row__name">{document.name}</span>
          {meta && <span className="finder-row__meta">{meta}</span>}
          {match?.excerpt && <span className="finder-row__excerpt">{match.excerpt}</span>}
        </span>
      </button>
      <button className="finder-row__ask" onClick={onAsk} type="button">
        Ask about this
      </button>
    </li>
  );
}

function statusLabel(status: FoundDocument["status"]) {
  if (status === "pending" || status === "processing") return "Processing, not in answers yet";
  if (status === "failed") return "Can’t be searched";
  if (status === "unsupported") return "Preview only";
  return undefined;
}

function failure(cause: unknown) {
  return cause instanceof Error && cause.message
    ? cause.message
    : "Documents could not be searched.";
}
