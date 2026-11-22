"use client";

import { Button, Checkbox, Dropdown, FieldError, Input, Label, Modal, Separator, Skeleton, Spinner, TextField } from "@heroui/react";
import { AlertCircle, ArrowLeft, ArrowRight, ArrowUpRight, ChevronDown, Copy, FileText, MoreHorizontal, Pencil, Plus, RotateCcw, Sparkles, Table, Trash2, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type Key } from "react";

import { Callout, EmptyState, FileIcon, IconButton, SearchInput, toast } from "@/components/ui";
import { errorMessage, resourceId } from "@/lib/api/client";
import { fmtNum, plural, rel } from "@/lib/format";

import { useStartWork } from "../actions";
import {
  cellOf,
  citationHref,
  citationText,
  criteriaFor,
  draftTypeLabel,
  entryKey,
  generationInstructions,
  MAX_REVIEW_SOURCES,
  optionDoc,
  optionOf,
  reviewGenerating,
  suggestionsFor,
  type Artifact,
  type ReviewCell,
  type ReviewEntry,
} from "../model";
import { useDocs } from "../queries";
import { WorkMarkdown } from "./parts";
import type { WorkPanel, WorkViewProps } from "./WorkItemPage";

type CellKey = { option: string; criterion: string };

const entries = (a: Artifact) => ({ options: a.evidenceReview?.options ?? [], criteria: a.evidenceReview?.criteria ?? [] });

/** Matrix edits: every change patches options/criteria, then regenerates the new cells. */
function useMatrix({ artifact: a, actions }: WorkViewProps) {
  const { options, criteria } = entries(a);
  const save = (next: { options?: ReviewEntry[]; criteria?: ReviewEntry[] }) =>
    actions.patch(
      { evidenceReview: { options: next.options ?? options, criteria: next.criteria ?? criteria } },
      [next.options ? "evidenceReview.options" : "", next.criteria ? "evidenceReview.criteria" : ""].filter(Boolean),
    );
  const fill = (cells: CellKey[]) => actions.revise({ cells }, { failure: "Couldn’t read the sources" });

  /** Adds rows; each fills in as it is read. Undo takes them all out again. */
  const addOptions = async (added: ReviewEntry[], { quiet = false }: { quiet?: boolean } = {}) => {
    const keys = new Set(added.map((e) => e.key));
    try {
      const next = await save({ options: [...entries(a).options.filter((o) => !keys.has(o.key)), ...added] });
      const crit = next.evidenceReview?.criteria ?? criteria;
      if (!quiet) toast(added.length === 1 ? `Added ${added[0].displayName}` : `Added ${plural(added.length, "source")}`, { undo: () => void removeOptions([...keys]) });
      await fill(added.flatMap((o) => crit.map((c) => ({ option: o.key, criterion: c.key }))));
    } catch (e) {
      toast(errorMessage(e), { tone: "danger" });
    }
  };
  /** Silent removal (Undo of an add). */
  const removeOptions = async (keys: string[]) => {
    await save({ options: entries(a).options.filter((o) => !keys.includes(o.key)) }).catch((e) => toast(errorMessage(e), { tone: "danger" }));
  };
  const removeOption = async (key: string) => {
    const entry = options.find((o) => o.key === key);
    if (!entry) return;
    if (options.length === 1) {
      toast("A review needs at least one source.", { tone: "danger" });
      return;
    }
    try {
      await save({ options: options.filter((o) => o.key !== key) });
      toast(`Removed ${entry.displayName}`, { undo: () => void addOptions([entry], { quiet: true }) });
    } catch (e) {
      toast(errorMessage(e), { tone: "danger" });
    }
  };
  const addCriterion = async (label: string, { quiet = false, at }: { quiet?: boolean; at?: number } = {}) => {
    const entry = { key: entryKey(label, criteria.map((c) => c.key)), displayName: label };
    const list = [...criteria];
    list.splice(at ?? list.length, 0, entry);
    try {
      const next = await save({ criteria: list });
      const opts = next.evidenceReview?.options ?? options;
      const ok = await fill(opts.map((o) => ({ option: o.key, criterion: entry.key })));
      if (quiet || !ok) return;
      toast(`Added ${label}`, { undo: () => void removeCriterion(entry.key, { quiet: true }) });
    } catch (e) {
      toast(errorMessage(e), { tone: "danger" });
    }
  };
  const removeCriterion = async (key: string, { quiet = false }: { quiet?: boolean } = {}) => {
    const i = criteria.findIndex((c) => c.key === key);
    if (i < 0) return;
    if (criteria.length === 1) {
      toast("A review needs at least one criterion.", { tone: "danger" });
      return;
    }
    const entry = criteria[i];
    try {
      await save({ criteria: criteria.filter((c) => c.key !== key) });
      if (!quiet) toast(`Removed ${entry.displayName}`, { undo: () => void addCriterion(entry.displayName ?? entry.key, { quiet: true, at: i }) });
    } catch (e) {
      toast(errorMessage(e), { tone: "danger" });
    }
  };
  const moveCriterion = async (key: string, by: -1 | 1) => {
    const i = criteria.findIndex((c) => c.key === key);
    const j = i + by;
    if (i < 0 || j < 0 || j >= criteria.length) return;
    const list = [...criteria];
    [list[i], list[j]] = [list[j], list[i]];
    await save({ criteria: list }).catch((e) => toast(errorMessage(e), { tone: "danger" }));
  };
  return { addOptions, removeOption, addCriterion, removeCriterion, moveCriterion, fill };
}

/* ═══════════════ Header actions ═══════════════ */

/** Draft from this review (preview `rvActions`); CSV sits with the other downloads in ⋯. */
export function ReviewActions({ artifact: a, canEdit, space }: WorkViewProps) {
  const startWork = useStartWork();
  const [busy, setBusy] = useState(false);
  const { options, criteria } = entries(a);
  if (!options.length || !(canEdit || !space || !!space.callerRole)) return null;
  const draft = async () => {
    /* A decision record when the review has architecture decisions as context, else an evidence summary. */
    const adr = options.some((o) => /^ADR-\d+/i.test(o.displayName ?? ""));
    const type = adr ? "decision" : "litreview";
    const findings = (a.evidenceReview?.cells ?? [])
      .filter((c) => c.summary && (c.state === "SUPPORTED" || c.state === "PARTIAL"))
      .map((c) => `- ${options.find((o) => o.key === c.option)?.displayName} / ${criteria.find((x) => x.key === c.criterion)?.displayName}: ${c.summary}`);
    const extra = [
      `Build on this evidence review (“${a.displayName}”), comparing ${options.map((o) => o.displayName).join(", ")} on ${criteria.map((c) => c.displayName).join(", ")}.`,
      findings.length ? `Findings:\n${findings.join("\n")}` : "",
      a.evidenceReview?.synthesis ? `Synthesis:\n${a.evidenceReview.synthesis}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    setBusy(true);
    try {
      await startWork({
        kind: "DRAFT",
        workflow: "DRAFT",
        title: `${draftTypeLabel(type)} — ${(a.displayName ?? "").replace(/\s*[—–-]\s*(evidence review|evidence matrix|evaluation)$/i, "")}`,
        space: a.space,
        sources: a.sourceItems ?? [],
        instructions: generationInstructions("DRAFT", { type, tone: "formal", length: "medium" }, { extra }),
      });
    } catch (e) {
      toast(errorMessage(e), { tone: "danger" });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button variant="primary" onPress={() => void draft()} isPending={busy}>
      <Pencil className="i" aria-hidden />
      Draft from this review
    </Button>
  );
}

/* ═══════════════ Body ═══════════════ */

const isSel = (panel: WorkPanel | null, option: string, criterion: string) => panel?.kind === "cell" && panel.option === option && panel.criterion === criterion;

export function ReviewView(props: WorkViewProps) {
  const { artifact: a, canEdit, space, panel, setPanel } = props;
  const matrix = useMatrix(props);
  const scroller = useRef<HTMLDivElement>(null);
  const [addPapers, setAddPapers] = useState(false);
  const [addCrit, setAddCrit] = useState(false);
  const [synthOpen, setSynthOpen] = useState(false);
  const { options, criteria } = entries(a);
  const r = a.evidenceReview;
  const busy = a.state === "GENERATING" || reviewGenerating(a);
  /** The synthesis skeleton shows while Synthesize runs (not while new cells fill). */
  const [synthBusy, setSynthBusy] = useState(false);
  const empty = !options.length || !criteria.length;
  const open = (option: string, criterion: string) => setPanel({ kind: "cell", option, criterion });

  const synthesize = () => {
    const failed = (r?.cells ?? []).filter((c) => c.state === "FAILED").map((c) => ({ option: c.option ?? "", criterion: c.criterion ?? "" }));
    setSynthBusy(true);
    void props.actions
      .revise({ cells: failed }, { failure: "Couldn’t write the synthesis" })
      .then((ok) => ok && toast("Synthesis ready"))
      .finally(() => setSynthBusy(false));
  };
  const addCriterion = (label: string) => {
    void matrix.addCriterion(label);
    requestAnimationFrame(() => scroller.current?.scrollTo({ left: scroller.current.scrollWidth, behavior: "smooth" }));
  };
  const rowMenu = (o: ReviewEntry) =>
    canEdit ? (
      <RowMenu
        label={o.displayName ?? o.key}
        doc={optionDoc(a, o.key)}
        isDisabled={busy}
        onReread={() => void matrix.fill(criteria.map((c) => ({ option: o.key, criterion: c.key }))).then((ok) => ok && toast("Row refreshed from the paper"))}
        onRemove={() => void matrix.removeOption(o.key)}
      />
    ) : null;
  const paperTitle = (o: ReviewEntry) => {
    const doc = optionDoc(a, o.key);
    return doc ? (
      <Link className="rv-paper__title clamp-2" href={`/doc/${resourceId(doc)}`} title={o.displayName} translate="no">
        {o.displayName}
      </Link>
    ) : (
      <span className="rv-paper__title clamp-2" translate="no">
        {o.displayName}
      </span>
    );
  };

  return (
    <div className="rv">
      {synthBusy ? (
        <div className="card rv-synth" aria-busy="true">
          <div className="row gap-8 muted t-sm">
            <Spinner size="sm" />
            Reading every cited passage…
          </div>
          <div className="rv-synth__grid">
            {[0, 1, 2].map((i) => (
              <div key={i} className="stack gap-8">
                <Skeleton className="skeleton--line" style={{ width: "40%" }} />
                <Skeleton className="skeleton--line" />
                <Skeleton className="skeleton--line" style={{ width: "80%" }} />
                <Skeleton className="skeleton--line" style={{ width: "65%" }} />
              </div>
            ))}
          </div>
        </div>
      ) : r?.synthesis ? (
        <section className={`card rv-synth${synthOpen ? " is-open" : ""}`} aria-label="Synthesis">
          <div className="card__header">
            <span className="item-icon item-icon--accent" aria-hidden>
              <Sparkles className="i" />
            </span>
            <div className="grow">
              <h2 className="card__title">Synthesis</h2>
              <p className="card__description">{`From ${plural(options.length, "paper")} · ${rel(a.updateTime)}`}</p>
            </div>
            <div className="row gap-4 none">
              {canEdit ? (
                <Button size="sm" variant="tertiary" onPress={synthesize} isDisabled={busy}>
                  <RotateCcw className="i" aria-hidden />
                  Update
                </Button>
              ) : null}
              {/* On phones the synthesis folds into one line so the comparison stays on the first screen. */}
              <button type="button" className="rv-synth__toggle" aria-expanded={synthOpen} onClick={() => setSynthOpen(!synthOpen)}>
                <ChevronDown className="i disclosure__chevron" aria-hidden />
                <span className="sr-only">Show synthesis</span>
              </button>
            </div>
          </div>
          <WorkMarkdown text={r.synthesis} className="rv-synth__text prose" />
        </section>
      ) : r?.synthesisAvailable === false ? (
        <Callout title="Synthesis hidden" description="It cites sources you can no longer open." />
      ) : null}

      {empty ? null : (
        <div className="rv-bar">
          <span className="t-sm muted rv-bar__hint">Select a cell to see its evidence</span>
          <span className="row gap-8">
            {canEdit ? (
              <Button size="sm" variant="ghost" onPress={() => setAddCrit(true)} isDisabled={busy}>
                <Plus className="i" aria-hidden />
                Add criterion
              </Button>
            ) : null}
            {canEdit && !r?.synthesis && !synthBusy ? (
              <Button size="sm" variant="secondary" onPress={synthesize} isDisabled={busy}>
                <Sparkles className="i" aria-hidden />
                Synthesize
              </Button>
            ) : null}
          </span>
        </div>
      )}

      {!empty ? (
        <>
          <div className="table-root rv-matrix">
            <div className="table__scroll rv-matrix__scroll" ref={scroller} tabIndex={0} role="region" aria-label={a.displayName ?? "Evidence review"}>
              <table className="table__content rv-table">
                <thead className="table__head">
                  <tr>
                    <th className="table__column rv-col rv-col--paper" scope="col">
                      Source
                    </th>
                    {criteria.map((c, i) => (
                      <th key={c.key} className="table__column rv-col" scope="col">
                        <span className="rv-col__inner">
                          <span className="truncate" translate="no">
                            {c.displayName}
                          </span>
                          {canEdit ? (
                            <ColumnMenu
                              label={c.displayName ?? c.key}
                              first={i === 0}
                              last={i === criteria.length - 1}
                              isDisabled={busy}
                              onMove={(by) => void matrix.moveCriterion(c.key, by)}
                              onRemove={() => void matrix.removeCriterion(c.key)}
                            />
                          ) : null}
                        </span>
                      </th>
                    ))}
                    {canEdit ? (
                      <th className="table__column rv-col--add" scope="col">
                        <IconButton icon={Plus} tip="Add criterion" size="sm" onPress={() => setAddCrit(true)} isDisabled={busy} />
                      </th>
                    ) : null}
                  </tr>
                </thead>
                <tbody className="table__body">
                  {options.map((o) => (
                    <tr key={o.key} className="table__row">
                      <th className="table__cell rv-paper" scope="row">
                        <div className="rv-paper__inner">
                          <div className="grow" style={{ minWidth: 0 }}>
                            {paperTitle(o)}
                            {o.description ? <div className="t-xs muted truncate">{o.description}</div> : null}
                          </div>
                          {rowMenu(o)}
                        </div>
                      </th>
                      {criteria.map((c) => (
                        <MatrixCell
                          key={c.key}
                          cell={cellOf(a, o.key, c.key)}
                          label={`${c.displayName} for ${o.displayName}`}
                          selected={isSel(panel, o.key, c.key)}
                          onOpen={() => open(o.key, c.key)}
                        />
                      ))}
                      {canEdit ? <td className="table__cell rv-cell--add" aria-hidden="true" /> : null}
                    </tr>
                  ))}
                  {canEdit ? (
                    <tr className="table__row rv-add-row">
                      <th className="table__cell rv-paper" scope="row">
                        <Button size="sm" variant="ghost" onPress={() => setAddPapers(true)} isDisabled={busy}>
                          <Plus className="i" aria-hidden />
                          Add papers
                        </Button>
                      </th>
                      <td className="table__cell" colSpan={criteria.length + 1} />
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </div>

          {/* Phones: one card per paper, each criterion a row (the table is hidden by a container query). */}
          <div className="rv-cards">
            {options.map((o) => (
              <section key={o.key} className="card rv-card" aria-label={o.displayName}>
                <div className="rv-card__head">
                  <div className="grow" style={{ minWidth: 0 }}>
                    {paperTitle(o)}
                    {o.description ? <div className="t-xs muted truncate">{o.description}</div> : null}
                  </div>
                  {rowMenu(o)}
                </div>
                <ul className="rv-card__list">
                  {criteria.map((c) => {
                    const cell = cellOf(a, o.key, c.key);
                    const f = finding(cell);
                    return (
                      <li key={c.key}>
                        <button
                          type="button"
                          className={`rv-card__row${f.none ? " rv-cell--none" : ""}${isSel(panel, o.key, c.key) ? " is-selected" : ""}`}
                          aria-label={`${c.displayName} for ${o.displayName}: ${f.text}`}
                          aria-current={isSel(panel, o.key, c.key) || undefined}
                          onClick={() => open(o.key, c.key)}
                        >
                          <span className="rv-card__label" translate="no">
                            {c.displayName}
                          </span>
                          <span className="rv-card__text">
                            {f.pending ? (
                              <Skeleton className="skeleton--line" style={{ width: "70%" }} />
                            ) : (
                              <>
                                <span translate={f.none ? undefined : "no"}>{f.text}</span>
                                {f.page ? (
                                  <>
                                    {" "}
                                    <span className="cite" aria-hidden="true">
                                      p.{f.page}
                                    </span>
                                  </>
                                ) : null}
                              </>
                            )}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
            {canEdit ? (
              <div className="row gap-8">
                <Button size="sm" onPress={() => setAddPapers(true)} isDisabled={busy}>
                  <Plus className="i" aria-hidden />
                  Add papers
                </Button>
              </div>
            ) : null}
          </div>
        </>
      ) : (
        <EmptyState
          icon={Table}
          title={options.length ? "No criteria yet" : "No papers yet"}
          description={options.length ? "Add what you want to compare, like Cost or Risks." : "Add documents from this space’s knowledge to compare them."}
          actions={
            canEdit ? (
              <Button variant="primary" onPress={() => (options.length ? setAddCrit(true) : setAddPapers(true))}>
                <Plus className="i" aria-hidden />
                {options.length ? "Add criterion" : "Add papers"}
              </Button>
            ) : null
          }
          boxed
        />
      )}

      <AddPapersDialog artifact={a} isOpen={addPapers} onClose={() => setAddPapers(false)} onAdd={(list) => void matrix.addOptions(list)} />
      <AddCriterionDialog artifact={a} spaceType={space?.spaceType} isOpen={addCrit} onClose={() => setAddCrit(false)} onAdd={addCriterion} />
    </div>
  );
}

/** What a cell says (preview cell text): the finding, or why there is none. */
function finding(cell: ReviewCell | undefined): { text: string; none: boolean; pending: boolean; page?: number } {
  if (!cell || cell.state === "GENERATING") return { text: "", none: false, pending: true };
  if (cell.available === false) return { text: "Hidden — you can’t open its source", none: true, pending: false };
  if (cell.state === "FAILED") return { text: "Couldn’t read this", none: true, pending: false };
  if (cell.state === "NOT_FOUND") return { text: "Not reported", none: true, pending: false };
  return { text: cell.summary ?? "—", none: false, pending: false, page: cell.citations?.find((c) => c.pageNumber)?.pageNumber ?? undefined };
}

/** One finding (preview `rv-cell`): summary + page chip; skeleton while it is read. */
function MatrixCell({ cell, label, selected, onOpen }: { cell: ReviewCell | undefined; label: string; selected: boolean; onOpen: () => void }) {
  const f = finding(cell);
  if (f.pending)
    return (
      <td className="table__cell rv-cell" aria-busy="true">
        <Skeleton className="skeleton--line" style={{ width: "86%" }} />
        <Skeleton className="skeleton--line mt-8" style={{ width: "54%" }} />
      </td>
    );
  return (
    <td
      className={`table__cell rv-cell${f.none ? " rv-cell--none" : ""}${selected ? " is-selected" : ""}`}
      role="button"
      tabIndex={0}
      aria-label={`${label}: ${f.text}`}
      aria-current={selected || undefined}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
    >
      <span className="rv-cell__text" translate={f.none ? undefined : "no"}>
        {f.text}
      </span>
      {f.page ? (
        <span className="cite" aria-hidden="true">
          p.{f.page}
        </span>
      ) : null}
    </td>
  );
}

/* Row and column menus are secondary: they show on hover or keyboard focus (always on touch). */
function ColumnMenu({ label, first, last, isDisabled, onMove, onRemove }: { label: string; first: boolean; last: boolean; isDisabled: boolean; onMove: (by: -1 | 1) => void; onRemove: () => void }) {
  const onAction = (key: Key) => {
    if (key === "left") onMove(-1);
    else if (key === "right") onMove(1);
    else if (key === "remove") onRemove();
  };
  return (
    <Dropdown>
      <IconButton icon={MoreHorizontal} tip={`Options for ${label}`} size="sm" showTip={false} isDisabled={isDisabled} className="rv-more" />
      <Dropdown.Popover placement="bottom end">
        <Dropdown.Menu aria-label={`Options for ${label}`} onAction={onAction} disabledKeys={[...(first ? ["left"] : []), ...(last ? ["right"] : [])]}>
          <Dropdown.Item id="left" textValue="Move left">
            <ArrowLeft className="i" aria-hidden />
            <Label>Move left</Label>
          </Dropdown.Item>
          <Dropdown.Item id="right" textValue="Move right">
            <ArrowRight className="i" aria-hidden />
            <Label>Move right</Label>
          </Dropdown.Item>
          <Separator />
          <Dropdown.Item id="remove" textValue="Remove column" variant="danger">
            <Trash2 className="i" aria-hidden />
            <Label>Remove column</Label>
          </Dropdown.Item>
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  );
}

function RowMenu({ label, doc, isDisabled, onReread, onRemove }: { label: string; doc: string | null; isDisabled: boolean; onReread: () => void; onRemove: () => void }) {
  const router = useRouter();
  const onAction = (key: Key) => {
    if (key === "open" && doc) router.push(`/doc/${resourceId(doc)}`);
    else if (key === "reread") onReread();
    else if (key === "remove") onRemove();
  };
  return (
    <Dropdown>
      <IconButton icon={MoreHorizontal} tip={`Options for ${label}`} size="sm" showTip={false} isDisabled={isDisabled} className="rv-more" />
      <Dropdown.Popover placement="bottom end">
        <Dropdown.Menu aria-label={`Options for ${label}`} onAction={onAction}>
          {doc ? (
            <Dropdown.Item id="open" textValue="Open document">
              <FileText className="i" aria-hidden />
              <Label>Open document</Label>
            </Dropdown.Item>
          ) : null}
          <Dropdown.Item id="reread" textValue="Re-read this paper">
            <RotateCcw className="i" aria-hidden />
            <Label>Re-read this paper</Label>
          </Dropdown.Item>
          <Separator />
          <Dropdown.Item id="remove" textValue="Remove paper" variant="danger">
            <Trash2 className="i" aria-hidden />
            <Label>Remove paper</Label>
          </Dropdown.Item>
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  );
}

/* ═══════════════ Evidence panel ═══════════════ */

/**
 * Preview `rvPanel`: non-modal, beside the review; selecting another cell updates it. Re-read restates the
 * finding from its passage; Copy citation; Open document. Escape closes it.
 */
export function EvidencePanel({ artifact: a, canEdit, actions, setPanel, at }: WorkViewProps & { at: CellKey }) {
  const router = useRouter();
  const [rereading, setRereading] = useState(false);
  const opt = a.evidenceReview?.options?.find((o) => o.key === at.option);
  const crit = a.evidenceReview?.criteria?.find((c) => c.key === at.criterion);
  const cell = cellOf(a, at.option, at.criterion);
  const doc = optionDoc(a, at.option);
  const first = cell?.citations?.find((c) => c.available !== false);
  const generating = rereading || cell?.state === "GENERATING";
  const close = () => setPanel(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) setPanel(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [setPanel]);
  /* A removed row or column closes the panel. */
  useEffect(() => {
    if (!opt || !crit) setPanel(null);
  }, [opt, crit, setPanel]);
  if (!opt || !crit) return null;

  const reread = async () => {
    setRereading(true);
    const ok = await actions.revise({ cells: [at] }, { failure: "Couldn’t re-read the passage" });
    setRereading(false);
    if (ok) toast("Finding restated from the passage");
  };

  let evidence: React.ReactNode = null;
  if (cell?.available === false) evidence = <Callout className="mt-24" title="You can’t open its source" description="This finding is hidden because it cites a document you can no longer read." />;
  else if (cell?.state === "FAILED") evidence = <Callout className="mt-24" tone="warning" title="Couldn’t read this" description="The assistant couldn’t check this paper. Re-read it to try again." />;
  else if (cell?.state === "NOT_FOUND" || (cell && !cell.citations?.length))
    evidence = <Callout className="mt-24" title="No passage found" description={`This paper doesn’t report ${(crit.displayName ?? "this").toLowerCase()}. Check the document if you expected it.`} />;
  else if (cell)
    evidence = (
      <>
        <div className="t-label mt-24 mb-8">Evidence</div>
        <div className="stack gap-16">
          {(cell.citations ?? [])
            .filter((c) => c.available !== false)
            .map((c, i) => (
              <div key={`${c.passage}-${i}`}>
                <div className="row gap-12">
                  <FileIcon name={c.displayName} size="lg" />
                  <div className="grow" style={{ minWidth: 0 }}>
                    <Link className="rv-ev__name truncate" href={citationHref(c)} translate="no">
                      {c.displayName}
                    </Link>
                    {c.pageNumber ? <div className="t-xs muted truncate">Page {c.pageNumber}</div> : null}
                  </div>
                </div>
                {c.excerpt ? (
                  <blockquote className="rv-ev__quote" translate="no">
                    <mark className="evidence is-focus">{c.excerpt}</mark>
                  </blockquote>
                ) : null}
              </div>
            ))}
        </div>
      </>
    );

  return (
    <aside className="split__panel rv-panel" aria-label="Evidence">
      <div className="panel__header">
        <div className="panel__title truncate" translate="no">
          {opt.displayName ?? "Source"}
        </div>
        {canEdit ? <IconButton icon={RotateCcw} tip="Re-read the passage and restate the finding" size="sm" onPress={() => void reread()} isDisabled={generating} /> : null}
        {first ? (
          <IconButton icon={Copy} tip="Copy citation" size="sm" onPress={() => void navigator.clipboard.writeText(citationText(first)).then(() => toast("Citation copied"))} />
        ) : null}
        <IconButton icon={X} tip="Close evidence" size="sm" onPress={close} />
      </div>
      <div className="panel__body">
        <div className="t-label mb-8" translate="no">
          {crit.displayName}
        </div>
        <p className="rv-ev__finding">
          {generating ? (
            <span className="row gap-8 muted">
              <Spinner size="sm" />
              Re-reading the passage…
            </span>
          ) : (
            <span translate="no">{cell?.summary || "—"}</span>
          )}
        </p>
        {generating ? null : evidence}
        {first || doc ? (
          <div className="mt-16">
            <Button size="sm" variant="secondary" onPress={() => router.push(first ? citationHref(first) : `/doc/${resourceId(doc)}`)}>
              <ArrowUpRight className="i" aria-hidden />
              Open document
            </Button>
          </div>
        ) : null}
      </div>
    </aside>
  );
}

/* ═══════════════ Add papers / criterion ═══════════════ */

/**
 * Preview `M['rv-add-paper']`: search, pick several, each row fills in as it is read; a review compares up to
 * MAX_REVIEW_SOURCES. The API can't add source items to an artifact, so the candidates are the review's own
 * sources that aren't rows yet.
 */
function AddPapersDialog({ artifact: a, isOpen, onClose, onAdd }: { artifact: Artifact; isOpen: boolean; onClose: () => void; onAdd: (list: ReviewEntry[]) => void }) {
  const docs = useDocs(isOpen ? (a.sourceItems ?? []) : []);
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [err, setErr] = useState("");
  const rows = useMemo(() => new Set((a.evidenceReview?.options ?? []).map((o) => o.key)), [a.evidenceReview?.options]);
  const left = (a.sourceItems ?? []).map((s) => docs.byName.get(s)).filter((d) => !!d && !rows.has(resourceId(d.name)));
  const needle = q.trim().toLowerCase();
  const shown = left.filter((d) => !needle || [d?.displayName, d?.ancestors?.[0]?.displayName].some((t) => t?.toLowerCase().includes(needle)));
  const room = Math.max(0, MAX_REVIEW_SOURCES - rows.size);
  const n = picked.length;
  const reset = () => {
    setQ("");
    setPicked([]);
    setErr("");
  };
  const close = () => {
    reset();
    onClose();
  };
  const toggle = (name: string) => {
    setPicked(picked.includes(name) ? picked.filter((x) => x !== name) : [...picked, name]);
    setErr("");
  };
  const add = () => {
    if (!n) {
      setErr("Select at least one document.");
      return;
    }
    if (n > room) {
      setErr(
        room > 0
          ? `A review compares up to ${MAX_REVIEW_SOURCES} papers. Pick ${room} or fewer, or remove a paper first.`
          : `This review already compares ${MAX_REVIEW_SOURCES} papers. Remove one first.`,
      );
      return;
    }
    const list = left.filter((d) => !!d && picked.includes(d.name ?? "")).map((d) => optionOf(d!));
    close();
    onAdd(list);
  };
  return (
    <Modal.Backdrop isOpen={isOpen} onOpenChange={(o) => !o && close()}>
      <Modal.Container size="md">
        <Modal.Dialog>
          <Modal.CloseTrigger aria-label="Close" />
          <Modal.Header>
            <Modal.Heading>Add papers</Modal.Heading>
            <p className="modal__description">Each one is read for every criterion, and every cell cites its passage.</p>
          </Modal.Header>
          <Modal.Body>
            {docs.isPending ? (
              <div className="stack gap-8">
                <Skeleton className="skeleton--line" />
                <Skeleton className="skeleton--line" style={{ width: "80%" }} />
              </div>
            ) : !left.length ? (
              <EmptyState icon={FileText} title="Every paper is already in this review" description="Start a new review to compare documents that aren’t among its sources." compact />
            ) : (
              <>
                <SearchInput value={q} onChange={setQ} placeholder="Search documents" label="Search documents" />
                {shown.length ? (
                  <div className="option-list rv-options mt-12" role="group" aria-label="Documents">
                    {shown.map((d) => (
                      <Checkbox key={d?.name} isSelected={picked.includes(d?.name ?? "")} onChange={() => toggle(d?.name ?? "")}>
                        <Checkbox.Content>
                          <Checkbox.Control>
                            <Checkbox.Indicator />
                          </Checkbox.Control>
                          <span className="checkbox__label">
                            <span className="rv-opt">
                              <FileIcon mime={d?.document?.mimeType} name={d?.document?.fileName} size="sm" />
                              <span className="rv-opt__text">
                                <span className="rv-opt__title truncate" translate="no">
                                  {d?.displayName}
                                </span>
                                {d?.ancestors?.[0]?.displayName ? (
                                  <span className="rv-opt__meta truncate" translate="no">
                                    {d.ancestors[0].displayName}
                                  </span>
                                ) : null}
                              </span>
                            </span>
                          </span>
                        </Checkbox.Content>
                      </Checkbox>
                    ))}
                  </div>
                ) : (
                  <p className="t-sm muted rv-options__empty">No documents match. Try another word.</p>
                )}
              </>
            )}
            {err ? (
              <div className="field-error mt-8" role="alert">
                <AlertCircle className="i" aria-hidden />
                <span>{err}</span>
              </div>
            ) : null}
          </Modal.Body>
          <Modal.Footer>
            <span className="modal__footer-start t-sm muted">
              {n ? `${plural(n, "paper")} selected · room for ${fmtNum(room)}` : left.length ? `Room for ${plural(room, "more paper")}.` : ""}
            </span>
            <Button slot="close" variant="ghost">
              {left.length ? "Cancel" : "Close"}
            </Button>
            {left.length ? (
              <Button variant="primary" onPress={add}>
                <Plus className="i" aria-hidden />
                {n ? `Add ${plural(n, "paper")}` : "Add papers"}
              </Button>
            ) : null}
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}

function AddCriterionDialog({
  artifact: a,
  spaceType,
  isOpen,
  onClose,
  onAdd,
}: {
  artifact: Artifact;
  spaceType: string | undefined;
  isOpen: boolean;
  onClose: () => void;
  onAdd: (label: string) => void;
}) {
  const [label, setLabel] = useState("");
  const [err, setErr] = useState("");
  const have = useMemo(() => new Set((a.evidenceReview?.criteria ?? []).map((c) => (c.displayName ?? "").toLowerCase())), [a.evidenceReview?.criteria]);
  const sugg = [...new Set([...criteriaFor(spaceType), ...suggestionsFor(spaceType)])].filter((s) => !have.has(s.toLowerCase()));
  const submit = (value = label) => {
    const v = value.trim().replace(/^./, (m) => m.toUpperCase());
    if (!v) {
      setErr("Name what you want to compare.");
      return;
    }
    if (have.has(v.toLowerCase())) {
      setErr("That column is already in the matrix.");
      return;
    }
    setLabel("");
    setErr("");
    onClose();
    onAdd(v);
  };
  return (
    <Modal.Backdrop
      isOpen={isOpen}
      onOpenChange={(o) => {
        if (!o) {
          setErr("");
          onClose();
        }
      }}
    >
      <Modal.Container size="sm">
        <Modal.Dialog>
          <Modal.CloseTrigger aria-label="Close" />
          <Modal.Header>
            <Modal.Heading>Add a criterion</Modal.Heading>
            <p className="modal__description">A new column. Each source is read for it and every cell is cited.</p>
          </Modal.Header>
          <Modal.Body>
            <TextField
              value={label}
              onChange={(v) => {
                setLabel(v);
                setErr("");
              }}
              isInvalid={!!err}
              autoFocus
              fullWidth
              maxLength={40}
            >
              <Label>What do you want to compare?</Label>
              <Input
                placeholder="e.g. Time to migrate"
                onKeyDown={(e) => {
                  if (e.key === "Enter") submit();
                }}
              />
              <FieldError>{err}</FieldError>
            </TextField>
            {sugg.length ? (
              <div className="mt-16">
                <div className="t-label mb-8">Suggested</div>
                <div className="row gap-8 wrap">
                  {sugg.map((s) => (
                    <button key={s} type="button" className="rv-chip" onClick={() => submit(s)}>
                      <Plus className="i i-sm" aria-hidden />
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
          </Modal.Body>
          <Modal.Footer>
            <Button slot="close" variant="ghost">
              Cancel
            </Button>
            <Button variant="primary" onPress={() => submit()}>
              <Plus className="i" aria-hidden />
              Add criterion
            </Button>
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}
