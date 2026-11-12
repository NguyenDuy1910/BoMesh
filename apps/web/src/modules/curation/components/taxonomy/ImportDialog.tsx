"use client";

import { Button } from "@heroui/react";
import { ArrowLeft, CircleAlert, CircleCheck, Database, Download, Sparkles, Table, Upload } from "lucide-react";
import { useRef, useState, type DragEvent, type ReactNode } from "react";

import { Callout, ChoiceGroup, EmptyState, FileIcon, LinkButton, StatusChip, toast } from "@/components/ui";
import { errorMessage } from "@/lib/api/client";
import { fmtNum, fmtSize, plural } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";
import { KnowledgeModal } from "@/modules/knowledge/components/KnowledgeModal";

import { createTopic, deleteTopic, mergeTopic, undeleteTopic, updateTopic, type Topic } from "../../api";
import { holdDecision } from "../../decisions";
import { useInvalidateCuration } from "../../queries";
import { changeCount, diffTaxonomy, foldName, parseSheet, TEMPLATE_ROWS, type Change, type ImportMode, type Sheet } from "../../taxonomy";
import { saveCsv } from "../shared";

const MODES = [
  { value: "merge", title: "Add and update", description: "New topics are added and matching ones are updated. Nothing is removed." },
  { value: "replace", title: "Replace", description: "Also archives topics that aren’t in the file. Topics documents still use are kept." },
] as const;

const DOT = (
  <span className="muted" aria-hidden="true">
    {" "}
    ·{" "}
  </span>
);

/**
 * Import taxonomy (preview `M['md-import']`): one dialog, two steps — choose a CSV (drop zone, Download template,
 * Add and update or Replace) → Check the changes (skipped rows with reasons, New, Updated, Archived, Kept) →
 * Import n changes, applied at once with Undo. Nothing changes until you import.
 */
export function ImportDialog({ isOpen, onClose, topics }: { isOpen: boolean; onClose: () => void; topics: readonly Topic[] }) {
  return isOpen ? <ImportForm onClose={onClose} topics={topics} /> : null;
}

function ImportForm({ onClose, topics }: { onClose: () => void; topics: readonly Topic[] }) {
  const { id: ws, workspace } = useWorkspace();
  const invalidate = useInvalidateCuration();
  const [mode, setMode] = useState<ImportMode>("merge");
  const [file, setFile] = useState<{ name: string; size: number; sheet: Sheet } | null>(null);
  const [err, setErr] = useState("");
  const [drag, setDrag] = useState(false);
  const [applying, setApplying] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const read = (f: File) => {
    const ext = (f.name.split(".").pop() ?? "").toLowerCase();
    if (ext === "xlsx" || ext === "xls") {
      setErr("Save the sheet as CSV (File › Save as › CSV UTF-8), then import that file.");
      return;
    }
    if (!["csv", "tsv", "txt"].includes(ext)) {
      setErr("Choose a CSV file.");
      return;
    }
    setErr("");
    void f.text().then((text) => {
      const parsed = parseSheet(text);
      if ("error" in parsed) setErr(parsed.error);
      else setFile({ name: f.name, size: f.size, sheet: parsed });
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
        title="Import taxonomy"
        description={`Update the domains and topics ${workspace.displayName} classifies documents with. You check every change before it’s applied.`}
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
            CSV · columns code, name, parent_code, description
          </span>
        </button>
        <input
          ref={input}
          type="file"
          hidden
          accept=".csv,.tsv,.txt,text/csv"
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
          <LinkButton icon={Download} onPress={() => saveCsv("taxonomy-template.csv", TEMPLATE_ROWS)}>
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

  const used = (t: Topic) => (t.documentCount ?? 0) + (t.inReviewCount ?? 0) > 0;
  const x = diffTaxonomy(file.sheet, topics, mode, used);
  const total = changeCount(x);
  const name = (s: string) => (
    <span className="medium" translate="no">
      {s}
    </span>
  );
  const note = (s: string) => <span className="muted">{s}</span>;
  const code = (c: string) => <span className="md-code">{c}</span>;

  /** Applies the changes, then offers Undo (which reverses each one). Proposals the file covers fold in after the Undo window. */
  async function apply() {
    setApplying(true);
    const undo: (() => Promise<unknown>)[] = [];
    /** Folded name → topic the import created (proposals of the same name merge into it). */
    const created = new Map<string, string>();
    try {
      const domainByName = new Map(topics.filter((t) => t.kind === "DOMAIN" && t.state === "ACTIVE").map((t) => [foldName(t.displayName), t.name ?? ""]));
      const restore = async (c: Change) => {
        const t = await undeleteTopic(ws, c.topic!.name ?? "");
        undo.push(() => deleteTopic(ws, t.name ?? ""));
        return t;
      };
      // Domains first, so topics can point at them.
      for (const c of [...x.added.filter((a) => !a.parent), ...x.updated.filter((u) => !u.parent)]) {
        let t = c.topic ?? null;
        if (!t) {
          t = await createTopic(ws, { displayName: c.name, kind: "DOMAIN", description: c.description || undefined });
          const made = t.name ?? "";
          undo.push(() => deleteTopic(ws, made));
        } else {
          if (c.restore) t = await restore(c);
          if (c.patch?.description != null) {
            const before = t.description ?? "";
            t = await updateTopic(ws, t, { description: c.patch.description });
            const saved = t;
            undo.push(() => updateTopic(ws, saved, { description: before }));
          }
        }
        domainByName.set(foldName(c.name), t.name ?? "");
      }
      const parentOf = (domainName: string) => domainByName.get(foldName(domainName)) ?? "";
      for (const c of x.added.filter((a) => a.parent)) {
        const t = await createTopic(ws, { displayName: c.name, kind: "TOPIC", parentTopic: parentOf(c.domainName), description: c.description || undefined });
        created.set(foldName(c.name), t.name ?? "");
        undo.push(() => deleteTopic(ws, t.name ?? ""));
      }
      for (const c of x.updated.filter((u) => u.parent)) {
        let t = c.topic!;
        if (c.restore) t = await restore(c);
        if (c.patch) {
          const patch: { description?: string; parentTopic?: string } = {};
          if (c.patch.description != null) patch.description = c.patch.description;
          if (c.patch.parentDomain) patch.parentTopic = parentOf(c.patch.parentDomain);
          const before = { description: t.description ?? "", parentTopic: t.parentTopic ?? "" };
          const saved = await updateTopic(ws, t, patch);
          const revert = Object.fromEntries(Object.keys(patch).map((k) => [k, before[k as keyof typeof before]]));
          undo.push(() => updateTopic(ws, saved, revert));
        }
      }
      // Topics before their domains.
      for (const t of [...x.archived].sort((a, b) => (a.kind === "TOPIC" ? 0 : 1) - (b.kind === "TOPIC" ? 0 : 1))) {
        await deleteTopic(ws, t.name ?? "");
        undo.push(() => undeleteTopic(ws, t.name ?? ""));
      }
    } catch (error) {
      invalidate();
      setApplying(false);
      toast(`${errorMessage(error)}${undo.length ? ` · ${plural(undo.length, "change")} applied before it stopped` : ""}`, { tone: "danger" });
      return;
    }
    invalidate();
    onClose();
    const covered = x.covered;
    holdDecision({
      names: covered.map((p) => p.name ?? ""),
      message: `Taxonomy updated: ${plural(total, "change")}`,
      undoneMessage: "Import undone",
      // A proposal the file now covers folds into the imported topic of the same name (and tags its submissions).
      send: async () => {
        await Promise.all(covered.map((p) => (created.get(foldName(p.displayName)) ? mergeTopic(ws, p.name ?? "", created.get(foldName(p.displayName))!) : null)));
      },
      onSent: invalidate,
      onFailed: invalidate,
      onUndo: () => {
        void (async () => {
          for (const step of [...undo].reverse()) await step();
        })().then(invalidate, (error: unknown) => {
          invalidate();
          toast(errorMessage(error), { tone: "danger" });
        });
      },
    });
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

  const effects = [
    x.covered.length ? `${x.covered.map((p) => `“${p.displayName}”`).join(", ")} ${x.covered.length === 1 ? "was" : "were"} proposed by the assistant and will be covered.` : "",
    "Published documents keep their topics.",
    file.sheet.ignored.length ? `The taxonomy doesn’t store ${file.sheet.ignored.join(" or ")} yet: ${file.sheet.ignored.length === 1 ? "that column is" : "those columns are"} left out.` : "",
    file.sheet.hasDescription ? "" : "The file has no description column: descriptions stay as they are.",
  ].filter(Boolean);

  return (
    <KnowledgeModal
      isOpen
      onClose={onClose}
      size="lg"
      icon={Database}
      title="Check the changes"
      description={`${x.same ? `${plural(x.same, "row")} unchanged. ` : ""}Import applies the changes below${mode === "replace" ? " and archives unused topics missing from the file" : ""}.`}
      footerStart={
        <Button variant="ghost" onPress={() => setFile(null)} isDisabled={applying}>
          <ArrowLeft className="i" aria-hidden />
          Back
        </Button>
      }
      footer={
        <>
          <Button variant="ghost" onPress={onClose} isDisabled={applying}>
            Cancel
          </Button>
          {total ? (
            <Button variant="primary" onPress={() => void apply()} isPending={applying}>
              <Upload className="i" aria-hidden />
              {`Import ${plural(total, "change")}`}
            </Button>
          ) : (
            <Button variant="primary" onPress={onClose}>
              Close
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
            <div className="t-xs muted">{`${plural(file.sheet.rows.length, "row")} · ${fmtSize(file.size)}`}</div>
          </div>
          <Button variant="ghost" size="sm" onPress={() => setFile(null)}>
            Choose another file
          </Button>
        </div>
        {x.errors.length ? (
          <Callout
            tone="warning"
            title={`${plural(x.errors.length, "row")} will be skipped`}
            description={
              <ul className="md-errs">
                {x.errors.map((e) => (
                  <li key={e.row}>
                    <span className="md-code">{`Row ${e.row}`}</span> <span translate="no">{e.code}</span>
                    {DOT}
                    <span>{e.text}</span>
                  </li>
                ))}
              </ul>
            }
          />
        ) : null}
        {!total ? <EmptyState icon={CircleCheck} tone="success" title="Nothing to change" description="The file matches the taxonomy." compact /> : null}
        {list(
          "New",
          "success",
          x.added.map((c) => (
            <li key={c.code}>
              {code(c.code)}
              {name(c.name)}
              {DOT}
              {c.parent ? <span className="muted" translate="no">{c.domainName}</span> : note("new domain")}
            </li>
          )),
        )}
        {list(
          "Updated",
          "accent",
          x.updated.map((c) => (
            <li key={c.code}>
              {code(c.code)}
              {name(c.name)}
              {DOT}
              {note(c.what.join(", "))}
            </li>
          )),
        )}
        {list(
          "Archived",
          "default",
          x.archived.map((t) => (
            <li key={t.name}>
              {name(t.displayName ?? "")}
              {DOT}
              {note("not in the file, unused")}
            </li>
          )),
        )}
        {list(
          "Kept although not in the file",
          "default",
          x.kept.map((t) => (
            <li key={t.name}>
              {name(t.displayName ?? "")}
              {DOT}
              {note(t.kind === "DOMAIN" ? "it still has topics" : "documents use it")}
            </li>
          )),
          4,
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
      </div>
    </KnowledgeModal>
  );
}
