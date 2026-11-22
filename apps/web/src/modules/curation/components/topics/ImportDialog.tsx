"use client";

import { Button } from "@heroui/react";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, CircleAlert, CircleCheck, Database, Download, Sparkles, Table, Upload } from "lucide-react";
import { useRef, useState, type DragEvent, type ReactNode } from "react";

import { Callout, ChoiceGroup, EmptyState, ErrorState, FileIcon, LinkButton, SkeletonRows, StatusChip, toast } from "@/components/ui";
import { errorMessage } from "@/lib/api/client";
import { fmtNum, fmtSize, plural } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";
import { readXlsx } from "@/lib/xlsx";
import { KnowledgeModal } from "@/modules/knowledge/components/KnowledgeModal";

import { importTopics, type ImportTopicsResult, type TopicImportChange, type TopicImportRow } from "../../api";
import { useInvalidateCuration } from "../../queries";
import { parseSheet, rowsToImport, TEMPLATE_ROWS, type SheetImport } from "../../topicSheet";
import { saveCsv } from "../shared";

type Mode = "MERGE" | "REPLACE";

const MODES = [
  { value: "MERGE", title: "Add and update", description: "Topics are matched by name within their domain: new ones are added, matching ones updated. Nothing is removed." },
  { value: "REPLACE", title: "Replace", description: "Also archives topics that aren’t in the file. Topics documents still use are kept." },
] as const;

const DOT = (
  <span className="muted" aria-hidden="true">
    {" "}
    ·{" "}
  </span>
);

const changeCount = (r: ImportTopicsResult) => (r.created?.length ?? 0) + (r.updated?.length ?? 0) + (r.archived?.length ?? 0);

/** Updates the server reports, in words (renames and moves name what they became). */
const CHANGE_WORD: Readonly<Record<NonNullable<TopicImportChange["changes"]>[number], string>> = {
  RENAMED: "renamed",
  MOVED: "moved",
  DESCRIPTION: "description",
  KEYWORDS: "keywords",
  SYNONYMS: "synonyms",
  GUIDANCE: "guidance",
};

/** Reads a picked file into import rows: CSV/TSV as text, .xlsx through the workbook reader. */
async function readSheet(f: File): Promise<SheetImport | { error: string }> {
  const ext = (f.name.split(".").pop() ?? "").toLowerCase();
  if (ext === "xls") return { error: "Save the file as .xlsx or CSV." };
  if (ext === "xlsx") {
    try {
      return rowsToImport(await readXlsx(await f.arrayBuffer()));
    } catch {
      return { error: "Couldn’t read this Excel file. Save it as .xlsx or CSV." };
    }
  }
  if (!["csv", "tsv", "txt"].includes(ext)) return { error: "Choose a CSV or Excel file." };
  return parseSheet(await f.text());
}

/**
 * Import topics (preview `M['md-import']`): one dialog, two steps — choose a CSV or Excel file (drop zone, Download
 * template, Add and update or Replace) → Check the changes the server reports for the rows (`validateOnly`: skipped
 * rows with reasons, New, Updated, Archived, unchanged) → Import n changes in one transaction. Nothing changes until
 * you import.
 */
export function ImportDialog({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  return isOpen ? <ImportForm onClose={onClose} /> : null;
}

function ImportForm({ onClose }: { onClose: () => void }) {
  const { id: ws, workspace } = useWorkspace();
  const invalidate = useInvalidateCuration();
  const [mode, setMode] = useState<Mode>("MERGE");
  const [file, setFile] = useState<{ key: number; name: string; size: number; sheet: SheetImport } | null>(null);
  const [err, setErr] = useState("");
  const [drag, setDrag] = useState(false);
  const [applying, setApplying] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const picks = useRef(0);

  const check = useQuery({
    queryKey: [ws, "topics-import", file?.key, mode],
    enabled: !!file,
    queryFn: () => importTopics(ws, { rows: file!.sheet.rows, mode, validateOnly: true }),
    retry: false,
    staleTime: Infinity,
    gcTime: 0,
  });

  const read = (f: File) => {
    setErr("");
    void readSheet(f).then((parsed) => {
      if ("error" in parsed) setErr(parsed.error);
      else setFile({ key: ++picks.current, name: f.name, size: f.size, sheet: parsed });
    });
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDrag(false);
    const f = e.dataTransfer.files?.[0];
    if (f) read(f);
  };

  if (!file) {
    return (
      <KnowledgeModal
        isOpen
        onClose={onClose}
        size="md"
        icon={Database}
        title="Import topics"
        description={`Update the domains, topics, keywords and synonyms ${workspace.displayName} classifies documents with. You check every change before it’s applied.`}
        footerStart={<span className="t-xs muted">Nothing changes until you import.</span>}
        footer={
          <Button variant="ghost" onPress={onClose}>
            Cancel
          </Button>
        }
      >
        <button
          type="button"
          className={`ctb-drop${drag ? " is-drag" : ""}`}
          aria-describedby="md-drop-hint"
          onClick={() => input.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setDrag(true);
          }}
          onDragLeave={() => setDrag(false)}
          onDrop={onDrop}
        >
          <span className="ctb-drop__icon">
            <Table className="i i-lg" aria-hidden />
          </span>
          <span className="medium">
            Drop a spreadsheet here or <span className="text-accent">browse</span>
          </span>
          <span className="description" id="md-drop-hint">
            CSV or Excel · columns domain, topic, description, keywords, synonyms, guidance
          </span>
        </button>
        <input
          ref={input}
          type="file"
          hidden
          accept=".csv,.tsv,.txt,.xlsx,.xls,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) read(f);
            e.target.value = "";
          }}
        />
        {err ? (
          <div className="field-error mt-8" role="alert">
            <CircleAlert className="i" aria-hidden />
            <span>{err}</span>
          </div>
        ) : null}
        <div className="ctb-samples">
          <span className="grow" />
          <LinkButton icon={Download} onPress={() => saveCsv("topics-template.csv", TEMPLATE_ROWS)}>
            Download template
          </LinkButton>
        </div>
        <div className="field mt-16">
          <span className="label">How to apply it</span>
          <ChoiceGroup label="How to apply it" value={mode} onChange={setMode} options={MODES} columns={2} />
        </div>
      </KnowledgeModal>
    );
  }

  const { rows, lines, missing } = file.sheet;
  const x = check.data;
  const total = x ? changeCount(x) : 0;
  const back = () => setFile(null);

  /** A change named the way the file names it: Domain › Topic, or the domain. */
  const label = (c: TopicImportChange) => (c.kind === "TOPIC" && c.domain ? `${c.domain} › ${c.displayName ?? ""}` : (c.displayName ?? ""));
  const name = (s: string) => (
    <span className="medium" translate="no">
      {s}
    </span>
  );
  const note = (s: string) => <span className="muted">{s}</span>;
  const notes = (items: readonly string[]) =>
    items.map((s, i) => (
      <span key={s}>
        {i ? (
          <span className="muted" aria-hidden="true">
            ,{" "}
          </span>
        ) : null}
        {note(s)}
      </span>
    ));

  /** What an update changes, in words. */
  const what = (c: TopicImportChange): string[] =>
    (c.changes ?? []).map((k) => (k === "RENAMED" ? `renamed from “${c.previousDisplayName ?? ""}”` : k === "MOVED" ? `moved to ${c.domain ?? ""}` : CHANGE_WORD[k]));
  /** The file row a skipped row came from: Row n · Domain › Topic. */
  const rowLabel = (r: TopicImportRow | undefined) => (r ? [r.domain, r.topic].filter(Boolean).join(" › ") : "") || "—";

  async function apply() {
    setApplying(true);
    try {
      const done = await importTopics(ws, { rows, mode, validateOnly: false });
      invalidate();
      onClose();
      toast(`Imported ${plural(changeCount(done), "change")}`);
    } catch (error) {
      setApplying(false);
      toast(errorMessage(error), { tone: "danger" });
      void check.refetch();
    }
  }

  const list = (title: string, tone: "success" | "accent" | "default", items: readonly ReactNode[], limit = 6) =>
    items.length ? (
      <section className="md-chg">
        <h3 className="md-chg__title">
          <StatusChip label={fmtNum(items.length)} size="sm" tone={tone} dot={false} />
          <span>{title}</span>
        </h3>
        <ul className="md-chg__list">
          {items.slice(0, limit)}
          {items.length > limit ? <li className="muted">{`+${fmtNum(items.length - limit)} more`}</li> : null}
        </ul>
      </section>
    ) : null;

  const columns = missing.length > 1 ? `${missing.slice(0, -1).join(", ")} or ${missing[missing.length - 1]}` : missing[0];
  const effects = ["Published documents keep their topics. Rules and examples stay as they are.", columns ? `The file has no ${columns} column: those stay as they are.` : ""].filter(Boolean);
  const applies = `Import applies the changes below${mode === "REPLACE" ? " and archives unused topics missing from the file" : ""}.`;
  const skipped = x?.skippedRows ?? [];

  let body: ReactNode;
  if (check.isError) body = <ErrorState title="Couldn’t check the changes" error={check.error} onRetry={() => check.refetch()} boxed={false} compact />;
  else if (!x) body = <SkeletonRows rows={4} />;
  else {
    body = (
      <>
        {skipped.length ? (
          <Callout
            tone="warning"
            title={`${plural(skipped.length, "row")} will be skipped`}
            description={
              <ul className="md-errs">
                {skipped.map((s) => (
                  <li key={s.row}>
                    <span className="md-code">{`Row ${lines[(s.row ?? 0) - 1] ?? s.row}`}</span> <span translate="no">{rowLabel(rows[(s.row ?? 0) - 1])}</span>
                    {DOT}
                    <span>{s.reason}</span>
                  </li>
                ))}
              </ul>
            }
          />
        ) : null}
        {!total ? <EmptyState icon={CircleCheck} tone="success" title="Nothing to change" description="The file matches the topics." compact /> : null}
        {list(
          "New",
          "success",
          (x.created ?? []).map((c) => (
            <li key={c.topic}>
              {name(label(c))}
              {c.kind === "DOMAIN" ? (
                <>
                  {DOT}
                  {note("new domain")}
                </>
              ) : null}
            </li>
          )),
        )}
        {list(
          "Updated",
          "accent",
          (x.updated ?? []).map((c) => {
            const changes = what(c);
            return (
              <li key={c.topic}>
                {name(label(c))}
                {changes.length ? (
                  <>
                    {DOT}
                    {notes(changes)}
                  </>
                ) : null}
              </li>
            );
          }),
        )}
        {list(
          "Archived",
          "default",
          (x.archived ?? []).map((c) => (
            <li key={c.topic}>
              {name(label(c))}
              {DOT}
              {note("not in the file, unused")}
            </li>
          )),
        )}
        {total ? (
          <div className="md-effects">
            <Sparkles className="i i-sm" aria-hidden />
            <div>
              {effects.map((s) => (
                <p key={s}>{s}</p>
              ))}
            </div>
          </div>
        ) : null}
      </>
    );
  }

  return (
    <KnowledgeModal
      isOpen
      onClose={onClose}
      size="lg"
      icon={Database}
      title="Check the changes"
      description={x?.unchangedCount ? `${plural(x.unchangedCount, "topic")} unchanged. ${applies}` : applies}
      footerStart={
        <Button variant="ghost" onPress={back} isDisabled={applying}>
          <ArrowLeft className="i" aria-hidden />
          Back
        </Button>
      }
      footer={
        <>
          <Button variant="ghost" onPress={onClose} isDisabled={applying}>
            Cancel
          </Button>
          {x && !total ? (
            <Button variant="primary" onPress={onClose}>
              Close
            </Button>
          ) : (
            <Button variant="primary" onPress={() => void apply()} isPending={applying} isDisabled={!x || check.isFetching}>
              <Upload className="i" aria-hidden />
              {x ? `Import ${plural(total, "change")}` : "Import"}
            </Button>
          )}
        </>
      }
    >
      <div className="stack gap-16">
        <div className="md-file">
          <FileIcon name={file.name} size="sm" />
          <div className="grow md-min">
            <div className="medium truncate" translate="no">
              {file.name}
            </div>
            <div className="t-xs muted">{`${plural(rows.length, "row")} · ${fmtSize(file.size)}`}</div>
          </div>
          <Button variant="ghost" size="sm" onPress={back} isDisabled={applying}>
            Choose another file
          </Button>
        </div>
        {body}
      </div>
    </KnowledgeModal>
  );
}
