"use client";

import { Button, Drawer, Dropdown, Input, Label, Modal, Separator, Skeleton, Spinner, TextField, FieldError } from "@heroui/react";
import { ArrowLeft, ArrowRight, ArrowUpRight, Copy, Download, FileText, MoreHorizontal, Pencil, Plus, RotateCcw, Sparkles, Table, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useRef, useState, type Key } from "react";

import { Callout, EmptyState, FileIcon, IconButton, List, ListItem, toast } from "@/components/ui";
import { errorMessage, resourceId } from "@/lib/api/client";
import { plural, rel } from "@/lib/format";

import { useStartWork } from "../actions";
import {
  cellOf,
  citationHref,
  citationText,
  draftTypeLabel,
  entryKey,
  generationInstructions,
  optionDoc,
  optionOf,
  reviewGenerating,
  SUGGESTED_CRITERIA,
  type Artifact,
  type ReviewCell,
  type ReviewEntry,
} from "../model";
import { useDocs } from "../queries";
import { WorkMarkdown } from "./parts";
import type { WorkViewProps } from "./WorkItemPage";

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

  const addOption = async (entry: ReviewEntry, { quiet = false }: { quiet?: boolean } = {}) => {
    try {
      const next = await save({ options: [...entries(a).options.filter((o) => o.key !== entry.key), entry] });
      const crit = next.evidenceReview?.criteria ?? criteria;
      if (!quiet) toast(`Added ${entry.displayName}`, { undo: () => void removeOption(entry.key, { quiet: true }) });
      await fill(crit.map((c) => ({ option: entry.key, criterion: c.key })));
    } catch (e) {
      toast(errorMessage(e), { tone: "danger" });
    }
  };
  const removeOption = async (key: string, { quiet = false }: { quiet?: boolean } = {}) => {
    const entry = options.find((o) => o.key === key);
    if (!entry) return;
    if (options.length === 1) {
      toast("A review needs at least one source.", { tone: "danger" });
      return;
    }
    try {
      await save({ options: options.filter((o) => o.key !== key) });
      if (!quiet) toast(`Removed ${entry.displayName}`, { undo: () => void addOption(entry, { quiet: true }) });
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
      if (!quiet) toast(`Added ${label}`, { undo: () => void removeCriterion(entry.key, { quiet: true }) });
      await fill(opts.map((o) => ({ option: o.key, criterion: entry.key })));
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
  return { addOption, removeOption, addCriterion, removeCriterion, moveCriterion, fill };
}

/* ═══════════════ Header actions ═══════════════ */

/** Export CSV · Draft from this review (preview `rvActions`). */
export function ReviewActions({ artifact: a, actions }: WorkViewProps) {
  const startWork = useStartWork();
  const [busy, setBusy] = useState(false);
  const { options, criteria } = entries(a);
  const draft = async () => {
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
        title: `${draftTypeLabel(type)} — ${(a.displayName ?? "").replace(/\s*[—–-]\s*(evidence matrix|evaluation)$/i, "")}`,
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
    <>
      <Button variant="tertiary" onPress={() => void actions.download("csv")}>
        <Download className="i" aria-hidden />
        Export CSV
      </Button>
      {options.length ? (
        <Button variant="primary" onPress={() => void draft()} isPending={busy}>
          <Pencil className="i" aria-hidden />
          Draft from this review
        </Button>
      ) : null}
    </>
  );
}

/* ═══════════════ Body ═══════════════ */

export function ReviewView(props: WorkViewProps) {
  const { artifact: a, canEdit } = props;
  const matrix = useMatrix(props);
  const scroller = useRef<HTMLDivElement>(null);
  const [cell, setCell] = useState<CellKey | null>(null);
  const [addSource, setAddSource] = useState(false);
  const [addCrit, setAddCrit] = useState(false);
  const { options, criteria } = entries(a);
  const r = a.evidenceReview;
  const busy = a.state === "GENERATING" || reviewGenerating(a);
  /** The synthesis skeleton shows while Synthesize runs (not while new cells fill). */
  const [synthBusy, setSynthBusy] = useState(false);

  const synthesize = () => {
    const failed = (r?.cells ?? []).filter((c) => c.state === "FAILED").map((c) => ({ option: c.option ?? "", criterion: c.criterion ?? "" }));
    setSynthBusy(true);
    void props.actions
      .revise({ cells: failed }, { failure: "Couldn’t write the synthesis" })
      .then((ok) => ok && toast("Synthesis ready"))
      .finally(() => setSynthBusy(false));
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
              </div>
            ))}
          </div>
        </div>
      ) : r?.synthesis ? (
        <section className="card rv-synth" aria-label="Synthesis">
          <div className="card__header">
            <span className="item-icon item-icon--accent" aria-hidden>
              <Sparkles className="i" />
            </span>
            <div className="grow">
              <h2 className="card__title">Synthesis</h2>
              <p className="card__description">
                From {plural(options.length, "source")} · {rel(a.updateTime)}
              </p>
            </div>
          </div>
          <WorkMarkdown text={r.synthesis} className="prose" />
        </section>
      ) : r?.synthesisAvailable === false ? (
        <Callout title="Synthesis hidden" description="It cites sources you can no longer open." />
      ) : null}

      <div className="rv-bar">
        <span className="t-sm muted">
          {plural(options.length, "source")} · {plural(criteria.length, "criterion", "criteria")}
        </span>
        {canEdit ? (
          <div className="row gap-8 wrap">
            <Button size="sm" variant="tertiary" onPress={() => setAddSource(true)} isDisabled={busy}>
              <Plus className="i" aria-hidden />
              Add source
            </Button>
            <Button size="sm" variant="tertiary" onPress={() => setAddCrit(true)} isDisabled={busy}>
              <Plus className="i" aria-hidden />
              Add criterion
            </Button>
            <Button size="sm" variant="secondary" onPress={synthesize} isPending={synthBusy} isDisabled={busy || !options.length || !criteria.length}>
              <Sparkles className="i" aria-hidden />
              {r?.synthesis ? "Update synthesis" : "Synthesize"}
            </Button>
          </div>
        ) : null}
      </div>

      {options.length && criteria.length ? (
        <div className="table-root table-root--primary rv-matrix">
          <div className="table__scroll-container rv-matrix__scroll" ref={scroller} tabIndex={0} role="region" aria-label="Evidence matrix">
            <table className="table__content rv-table">
              <thead className="table__header">
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
                </tr>
              </thead>
              <tbody className="table__body">
                {options.map((o) => {
                  const doc = optionDoc(a, o.key);
                  return (
                    <tr key={o.key} className="table__row">
                      <th className="table__cell rv-paper" scope="row">
                        <div className="rv-paper__inner">
                          <div className="grow" style={{ minWidth: 0 }}>
                            {doc ? (
                              <Link className="rv-paper__title clamp-2" href={`/doc/${resourceId(doc)}`} title={o.displayName} translate="no">
                                {o.displayName}
                              </Link>
                            ) : (
                              <span className="rv-paper__title clamp-2" translate="no">
                                {o.displayName}
                              </span>
                            )}
                            {o.description ? <div className="t-xs muted truncate">{o.description}</div> : null}
                          </div>
                          {canEdit ? (
                            <RowMenu
                              label={o.displayName ?? o.key}
                              doc={doc}
                              isDisabled={busy}
                              onReread={() =>
                                void matrix.fill(criteria.map((c) => ({ option: o.key, criterion: c.key }))).then((ok) => ok && toast("Row refreshed from the source"))
                              }
                              onRemove={() => void matrix.removeOption(o.key)}
                            />
                          ) : null}
                        </div>
                      </th>
                      {criteria.map((c) => (
                        <MatrixCell key={c.key} cell={cellOf(a, o.key, c.key)} label={`${c.displayName} for ${o.displayName}`} onOpen={() => setCell({ option: o.key, criterion: c.key })} />
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <EmptyState
          icon={Table}
          title={options.length ? "No criteria yet" : "No sources yet"}
          description={options.length ? "Add what you want to compare, like Cost or Risks." : "Add documents from this space’s knowledge to compare them."}
          actions={
            canEdit ? (
              <Button variant="primary" onPress={() => (options.length ? setAddCrit(true) : setAddSource(true))}>
                <Plus className="i" aria-hidden />
                {options.length ? "Add criterion" : "Add source"}
              </Button>
            ) : null
          }
          boxed
        />
      )}

      <CellDrawer artifact={a} at={cell} canEdit={canEdit} busy={busy} onClose={() => setCell(null)} onReplace={(k) => void matrix.fill([k]).then((ok) => ok && toast("Finding replaced"))} />
      <AddSourceDialog artifact={a} isOpen={addSource} onClose={() => setAddSource(false)} onPick={(e) => void matrix.addOption(e)} />
      <AddCriterionDialog
        artifact={a}
        isOpen={addCrit}
        onClose={() => setAddCrit(false)}
        onAdd={(label) => {
          void matrix.addCriterion(label);
          requestAnimationFrame(() => scroller.current?.scrollTo({ left: scroller.current.scrollWidth, behavior: "smooth" }));
        }}
      />
    </div>
  );
}

/** One finding (preview `rv-cell`): summary + page chip; skeleton while generating. */
function MatrixCell({ cell, label, onOpen }: { cell: ReviewCell | undefined; label: string; onOpen: () => void }) {
  if (!cell || cell.state === "GENERATING")
    return (
      <td className="table__cell rv-cell" aria-busy="true">
        <Skeleton className="skeleton--line" style={{ width: "86%" }} />
        <Skeleton className="skeleton--line mt-8" style={{ width: "54%" }} />
      </td>
    );
  const text =
    cell.available === false
      ? "Hidden — you can’t open its source"
      : cell.state === "FAILED"
        ? "Couldn’t read this"
        : cell.state === "NOT_FOUND"
          ? "Not reported"
          : (cell.summary ?? "—");
  const none = cell.available === false || cell.state === "FAILED" || cell.state === "NOT_FOUND";
  const page = cell.citations?.find((c) => c.pageNumber)?.pageNumber;
  return (
    <td
      className={`table__cell rv-cell${none ? " rv-cell--none" : ""}`}
      role="button"
      tabIndex={0}
      aria-label={`${label}: ${text}`}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
    >
      <span className="rv-cell__text" translate={none ? undefined : "no"}>
        {text}
      </span>
      {page ? (
        <span className="cite" aria-hidden="true">
          p.{page}
        </span>
      ) : null}
    </td>
  );
}

function ColumnMenu({ label, first, last, isDisabled, onMove, onRemove }: { label: string; first: boolean; last: boolean; isDisabled: boolean; onMove: (by: -1 | 1) => void; onRemove: () => void }) {
  const onAction = (key: Key) => {
    if (key === "left") onMove(-1);
    else if (key === "right") onMove(1);
    else if (key === "remove") onRemove();
  };
  return (
    <Dropdown>
      <IconButton icon={MoreHorizontal} tip={`Options for ${label}`} size="sm" showTip={false} isDisabled={isDisabled} />
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
      <IconButton icon={MoreHorizontal} tip={`Options for ${label}`} size="sm" showTip={false} isDisabled={isDisabled} />
      <Dropdown.Popover placement="bottom end">
        <Dropdown.Menu aria-label={`Options for ${label}`} onAction={onAction}>
          {doc ? (
            <Dropdown.Item id="open" textValue="Open document">
              <FileText className="i" aria-hidden />
              <Label>Open document</Label>
            </Dropdown.Item>
          ) : null}
          <Dropdown.Item id="reread" textValue="Re-read this source">
            <RotateCcw className="i" aria-hidden />
            <Label>Re-read this source</Label>
          </Dropdown.Item>
          <Separator />
          <Dropdown.Item id="remove" textValue="Remove source" variant="danger">
            <Trash2 className="i" aria-hidden />
            <Label>Remove source</Label>
          </Dropdown.Item>
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  );
}

/* ═══════════════ Cell evidence drawer ═══════════════ */

function CellDrawer({
  artifact: a,
  at,
  canEdit,
  busy,
  onClose,
  onReplace,
}: {
  artifact: Artifact;
  at: CellKey | null;
  canEdit: boolean;
  busy: boolean;
  onClose: () => void;
  onReplace: (k: CellKey) => void;
}) {
  const router = useRouter();
  const opt = at ? a.evidenceReview?.options?.find((o) => o.key === at.option) : undefined;
  const crit = at ? a.evidenceReview?.criteria?.find((c) => c.key === at.criterion) : undefined;
  const cell = at ? cellOf(a, at.option, at.criterion) : undefined;
  const doc = at ? optionDoc(a, at.option) : null;
  const first = cell?.citations?.find((c) => c.available !== false);
  const generating = cell?.state === "GENERATING";
  let evidence: React.ReactNode = null;
  if (cell?.available === false) evidence = <Callout className="mt-24" title="You can’t open its source" description="This finding is hidden because it cites a document you can no longer read." />;
  else if (cell?.state === "FAILED") evidence = <Callout className="mt-24" tone="warning" title="Couldn’t read this" description="The assistant couldn’t check this source. Replace the finding to try again." />;
  else if (cell?.state === "NOT_FOUND" || (cell && !cell.citations?.length))
    evidence = <Callout className="mt-24" title="No passage found" description={`This source doesn’t report ${(crit?.displayName ?? "this").toLowerCase()}. Check the document if you expected it.`} />;
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
    <Drawer.Backdrop isOpen={!!at} onOpenChange={(o) => !o && onClose()}>
      <Drawer.Content placement="right">
        <Drawer.Dialog>
          <Drawer.CloseTrigger aria-label="Close" />
          <Drawer.Header>
            <Drawer.Heading translate="no">{opt?.displayName ?? "Finding"}</Drawer.Heading>
            {opt?.description ? <p className="drawer__description">{opt.description}</p> : null}
          </Drawer.Header>
          <Drawer.Body>
            {cell && crit ? (
              <>
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
                    <span translate="no">{cell.summary || "—"}</span>
                  )}
                </p>
                {generating ? null : evidence}
              </>
            ) : (
              <EmptyState icon={FileText} title="This cell no longer exists" compact />
            )}
          </Drawer.Body>
          <Drawer.Footer>
            {canEdit && cell ? (
              <div className="drawer__footer-start row gap-8">
                <Button variant="tertiary" onPress={() => at && onReplace(at)} isPending={generating} isDisabled={busy}>
                  <RotateCcw className="i" aria-hidden />
                  Wrong? Replace finding
                </Button>
              </div>
            ) : null}
            {first ? (
              <Button
                variant="ghost"
                onPress={() => {
                  void navigator.clipboard.writeText(citationText(first)).then(() => toast("Citation copied"));
                }}
              >
                <Copy className="i" aria-hidden />
                Copy
              </Button>
            ) : null}
            {first || doc ? (
              <Button variant="primary" onPress={() => router.push(first ? citationHref(first) : `/doc/${resourceId(doc)}`)}>
                <ArrowUpRight className="i" aria-hidden />
                Open document
              </Button>
            ) : null}
          </Drawer.Footer>
        </Drawer.Dialog>
      </Drawer.Content>
    </Drawer.Backdrop>
  );
}

/* ═══════════════ Add source / criterion ═══════════════ */

function AddSourceDialog({ artifact: a, isOpen, onClose, onPick }: { artifact: Artifact; isOpen: boolean; onClose: () => void; onPick: (e: ReviewEntry) => void }) {
  const docs = useDocs(isOpen ? (a.sourceItems ?? []) : []);
  const inMatrix = new Set((a.evidenceReview?.options ?? []).map((o) => o.key));
  const left = (a.sourceItems ?? []).map((s) => docs.byName.get(s)).filter((d) => !!d && !inMatrix.has(resourceId(d.name)));
  return (
    <Modal.Backdrop isOpen={isOpen} onOpenChange={(o) => !o && onClose()}>
      <Modal.Container size="md">
        <Modal.Dialog>
          <Modal.CloseTrigger aria-label="Close" />
          <Modal.Header>
            <Modal.Heading>Add a source</Modal.Heading>
            <p className="modal__description">From the documents this review was made from</p>
          </Modal.Header>
          <Modal.Body>
            {left.length ? (
              <List plain>
                {left.map((d) => (
                  <ListItem
                    key={d?.name}
                    lead={<FileIcon mime={d?.document?.mimeType} name={d?.document?.fileName} />}
                    title={<span translate="no">{d?.displayName}</span>}
                    description={d?.ancestors?.[0]?.displayName}
                    actions={<Plus className="i muted" aria-hidden />}
                    onPress={() => {
                      if (d) onPick(optionOf(d));
                      onClose();
                    }}
                  />
                ))}
              </List>
            ) : (
              <EmptyState
                icon={FileText}
                title="Every source is already in the matrix"
                description="Start a new review to compare documents that aren’t among this review’s sources."
                compact
              />
            )}
          </Modal.Body>
          <Modal.Footer>
            <Button slot="close" variant="tertiary">
              Cancel
            </Button>
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}

function AddCriterionDialog({ artifact: a, isOpen, onClose, onAdd }: { artifact: Artifact; isOpen: boolean; onClose: () => void; onAdd: (label: string) => void }) {
  const [label, setLabel] = useState("");
  const [err, setErr] = useState("");
  const have = useMemo(() => new Set((a.evidenceReview?.criteria ?? []).map((c) => (c.displayName ?? "").toLowerCase())), [a.evidenceReview?.criteria]);
  const sugg = SUGGESTED_CRITERIA.filter((s) => !have.has(s.toLowerCase()));
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
            >
              <Label>Criterion</Label>
              <Input
                placeholder="e.g. Security"
                onKeyDown={(e) => {
                  if (e.key === "Enter") submit();
                }}
              />
              <FieldError>{err}</FieldError>
            </TextField>
            {sugg.length ? (
              <div className="row gap-8 wrap mt-12">
                {sugg.map((s) => (
                  <button key={s} type="button" className="rv-chip" onClick={() => submit(s)}>
                    <Plus className="i i-sm" aria-hidden />
                    {s}
                  </button>
                ))}
              </div>
            ) : null}
          </Modal.Body>
          <Modal.Footer>
            <Button slot="close" variant="tertiary">
              Cancel
            </Button>
            <Button variant="primary" onPress={() => submit()}>
              Add column
            </Button>
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}
