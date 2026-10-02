"use client";

import { ArrowLeft, FileUp, Upload } from "lucide-react";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { CommandBar, FilterTrigger } from "@/components/layout/CommandBar";
import { SplitView } from "@/components/layout/SplitView";
import { DocumentRow } from "@/components/patterns";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { PageHeader } from "@/components/ui/PageHeader";
import { PageLoadingSkeleton } from "@/components/ui/Skeleton";
import { useToast } from "@/components/ui/Toast";
import { useRouteState } from "@/lib/hooks/useRouteState";
import { DocumentViewer } from "@/modules/knowledge/components/DocumentViewer";
import { FileTypeIcon } from "@/modules/knowledge/components/FileTypeIcon";
import { pluralize } from "@/modules/workspace-control/format";
import { libraryActions, useLibrary } from "./queries";

/**
 * The documents that belong to this person rather than to the workspace.
 *
 * They live in the private Collection every member is given, so what is shown
 * here is exactly what the knowledge service holds for them — uploads, and
 * whatever a conversation saved on their behalf.
 */
export function LibraryScreen() {
  const router = useRouter();
  const { toast } = useToast();
  const query = useLibrary();
  const [selectedId, setSelectedId] = useRouteState("document");
  const [search, setSearch] = useState("");
  const [type, setType] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const upload = useRef<HTMLInputElement>(null);

  const documents = query.data?.documents ?? [];
  const collectionId = query.data?.collectionId ?? null;
  const selected = documents.find((item) => item.id === selectedId);
  const rows = documents.filter((item) =>
    (!type || item.kind === type) && item.title.toLowerCase().includes(search.toLowerCase()),
  );
  const hasFilters = Boolean(search || type);
  const openUpload = () => upload.current?.click();
  const clearFilters = () => {
    setSearch("");
    setType("");
  };

  const list = (
    <div className="library-list">
      <div className="knowledge-list-heading">
        <h2 className="knowledge-eyebrow">{query.data?.collectionTitle ?? "My documents"}</h2>
        {query.data && <span>{pluralize(rows.length, "document")}</span>}
      </div>
      {!query.data && !query.error ? (
        <PageLoadingSkeleton label="Loading your documents" />
      ) : !rows.length ? (
        hasFilters ? (
          <EmptyState
            action={<Button onClick={clearFilters} variant="secondary">Clear filters</Button>}
            description="Try a different search or clear the filters."
            size="sm"
            title="No matching documents"
          />
        ) : (
          <EmptyState
            action={
              <Button icon={<Upload aria-hidden="true" size={16} />} loading={busy} onClick={openUpload} variant="secondary">
                Upload a file
              </Button>
            }
            className="library-empty-state"
            description="Upload a document, or save one from a conversation."
            icon={<FileUp size={20} />}
            title="No documents yet"
          />
        )
      ) : (
        <div className="knowledge-rows">
          {rows.map((item) => (
            <DocumentRow
              icon={<FileTypeIcon kind={item.kind} />}
              key={item.id}
              layout={selected ? "narrow" : "full"}
              meta={item.source}
              onSelect={() => { setSelectedId(item.id); setExpanded(false); }}
              selected={item.id === selectedId}
              title={item.title}
              updated={item.updatedLabel}
            />
          ))}
        </div>
      )}
    </div>
  );

  return (
    <section aria-label="Personal library" className="document-workspace">
      <PageHeader
        actions={
          <Button
            disabled={!query.data}
            icon={<Upload aria-hidden="true" size={16} />}
            loading={busy}
            onClick={openUpload}
          >
            Upload
          </Button>
        }
        className="document-workspace__head"
        description="Documents you uploaded or saved from conversations."
        eyebrow={
          <Button
            className="-ml-2.5"
            icon={<ArrowLeft aria-hidden="true" size={16} />}
            onClick={() => router.push("/app")}
            size="sm"
            variant="ghost"
          >
            Back to chat
          </Button>
        }
        title="Library"
      />
      <CommandBar
        filters={
          <FilterTrigger
            label="Filter by type"
            onChange={setType}
            options={[
              { value: "", label: "All types" },
              { value: "pdf", label: "PDF" },
              { value: "document", label: "Documents" },
              { value: "spreadsheet", label: "Spreadsheets" },
            ]}
            value={type}
          />
        }
        search={{ value: search, onChange: setSearch, placeholder: "Search your documents…", label: "Search library" }}
      />
      {/* Reloading fixes a failed load; it would not repeat a failed upload,
          so that one is dismissed instead of offered a "Retry". */}
      {(query.error || error) && (
        <div className="mx-[var(--page-gutter)] mt-[var(--space-5)] grid gap-[var(--space-2)]">
          {query.error && (
            <ErrorState
              actionLabel="Retry"
              description={query.error}
              layout="inline"
              onAction={query.reload}
              title="Your library couldn’t be loaded"
            />
          )}
          {error && (
            <ErrorState
              actionLabel="Dismiss"
              description={error}
              layout="inline"
              onAction={() => setError(null)}
              title="Upload failed"
            />
          )}
        </div>
      )}
      <SplitView
        detail={selected ? (
          <DocumentViewer
            document={selected}
            expanded={expanded}
            onClose={() => setSelectedId("")}
            onExpand={() => setExpanded((value) => !value)}
          />
        ) : null}
        list={list}
        mode={selected ? (expanded ? "detail" : "split") : "list"}
      />
      <input
        aria-label="Upload a document"
        className="hidden"
        onChange={async (event) => {
          const file = event.target.files?.[0];
          if (!file) return;
          setBusy(true);
          setError(null);
          try {
            await libraryActions.upload(file, collectionId);
            toast({ title: `${file.name} uploaded`, variant: "success" });
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : "The file could not be uploaded.");
          } finally {
            setBusy(false);
            event.target.value = "";
          }
        }}
        ref={upload}
        // Your own uploads are processed directly; archives are bulk ingestion
        // and belong in a workspace collection. Images are not knowledge yet.
        accept=".csv,.docx,.htm,.html,.json,.jsonl,.log,.markdown,.md,.pdf,.pptx,.rst,.sql,.tsv,.txt,.xlsx,.xml,.yaml,.yml"
        type="file"
      />
    </section>
  );
}
