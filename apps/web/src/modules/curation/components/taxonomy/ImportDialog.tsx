"use client";

import { Button } from "@heroui/react";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, CircleAlert, CircleCheck, Download, Sparkles, Table, Upload } from "lucide-react";
import { useRef, useState, type DragEvent, type ReactNode } from "react";

import { Callout, EmptyState, ErrorState, FileIcon, LinkButton, SkeletonRows, StatusChip, toast } from "@/components/ui";
import { ApiError, errorMessage } from "@/lib/api/client";
import { fmtNum, fmtSize, plural } from "@/lib/format";
import { serverText } from "@/lib/i18n";
import { useWorkspace } from "@/lib/workspace";
import { readXlsx } from "@/lib/xlsx";
import type { ConceptScheme } from "@/modules/knowledge/api";
import { KnowledgeModal } from "@/modules/knowledge/components/KnowledgeModal";
import { conceptLabel, resourceKey, schemeLabel, topConcepts, type Taxonomy } from "@/modules/knowledge/taxonomy";

import { COLUMNS, parseSheet, planSheet, readSheet, templateRows, type ConceptSheet, type ImportBatch, type SkippedRow } from "../../conceptSheet";
import { useInvalidateTaxonomy } from "../../queries";
import { importConcepts, type ImportConceptsResult } from "../../taxonomyApi";
import { saveCsv } from "../shared";
import { DOT } from "./parts";

/** Reads a picked file: CSV/TSV as text, .xlsx through the workbook reader. */
async function readFile(f: File): Promise<ConceptSheet | { error: string }> {
  const ext = (f.name.split(".").pop() ?? "").toLowerCase();
  if (ext === "xls") return { error: "Hãy lưu tệp thành .xlsx hoặc CSV." };
  if (ext === "xlsx") {
    try {
      return readSheet(await readXlsx(await f.arrayBuffer()));
    } catch {
      return { error: "Không đọc được tệp Excel này. Hãy lưu thành .xlsx hoặc CSV." };
    }
  }
  if (!["csv", "tsv", "txt"].includes(ext)) return { error: "Chọn tệp CSV hoặc Excel." };
  return parseSheet(await f.text());
}

interface Checked {
  /** Per scheme: the rows that pass and what importing them does. */
  results: { batch: ImportBatch; result: ImportConceptsResult }[];
  /** The file's skipped rows: ours, then the ones the server refused (`rows[i].field`). */
  skipped: SkippedRow[];
}

/**
 * Each scheme's rows checked by the server (`validateOnly`). A bad row fails the whole request with a violation per field
 * (`rows[3].broader`): those rows are skipped (with the server's reason) and the rest checked again, so one mistake
 * never blocks a file.
 */
async function checkBatches(batches: readonly ImportBatch[]): Promise<Checked> {
  const skipped: SkippedRow[] = [];
  const results: Checked["results"] = [];
  for (const original of batches) {
    let batch = original;
    for (let attempt = 0; ; attempt++) {
      if (!batch.rows.length) break;
      try {
        results.push({ batch, result: await importConcepts(batch.scheme.name ?? "", { rows: batch.rows, validateOnly: true }) });
        break;
      } catch (error) {
        const bad = new Map<number, string>();
        if (error instanceof ApiError)
          for (const v of error.fieldViolations) {
            const m = /^rows\[(\d+)\]/.exec(v.field);
            if (m && !bad.has(Number(m[1]))) bad.set(Number(m[1]), serverText(v.description));
          }
        if (!bad.size || attempt >= 4) throw error;
        for (const [i, reason] of bad) skipped.push({ line: batch.lines[i], label: batch.rows[i]?.notation ?? "", reason });
        batch = { scheme: batch.scheme, rows: batch.rows.filter((_, i) => !bad.has(i)), lines: batch.lines.filter((_, i) => !bad.has(i)) };
      }
    }
  }
  return { results, skipped };
}

const changeCount = (c: Checked) => c.results.reduce((n, r) => n + (r.result.created?.length ?? 0) + (r.result.updated?.length ?? 0), 0);

/**
 * Import CSV (preview `M['tx-import']`): one dialog, two steps — choose a CSV or Excel file (drop zone, Download
 * template) → Check the changes the server reports (`validateOnly`: rows skipped with why, New drafts, Updated,
 * unchanged) → Import n changes into the working copy (one transaction per scheme). Classification uses them once each
 * scheme is published.
 */
export function ImportDialog({ taxonomy: t, scheme, onClose }: { taxonomy: Taxonomy; scheme: ConceptScheme; onClose: () => void }) {
  const { id: ws } = useWorkspace();
  const refresh = useInvalidateTaxonomy();
  const [file, setFile] = useState<{ key: number; name: string; size: number; sheet: ConceptSheet } | null>(null);
  const [err, setErr] = useState("");
  const [drag, setDrag] = useState(false);
  const [applying, setApplying] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const picks = useRef(0);
  const plan = file ? planSheet(file.sheet, t, scheme) : null;

  const check = useQuery({
    queryKey: [ws, "taxonomy", "import", file?.key],
    enabled: !!plan,
    queryFn: () => checkBatches(plan!.batches),
    retry: false,
    staleTime: Infinity,
    gcTime: 0,
  });

  const read = (f: File) => {
    setErr("");
    void readFile(f).then((parsed) => {
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
  const template = () => saveCsv("classification-template.csv", templateRows(t, topConcepts(t, scheme.name ?? "")[0]?.name));

  if (!file || !plan) {
    return (
      <KnowledgeModal
        isOpen
        onClose={onClose}
        size="md"
        icon={Upload}
        title="Nhập CSV"
        description="Các dòng khớp khái niệm theo trục phân loại và ký hiệu; dòng không có ký hiệu sẽ thêm khái niệm mới. Nhãn thay thế và nhãn ẩn cách nhau bằng “;” và có thể bắt đầu bằng ngôn ngữ, ví dụ “en:scholarship”."
        footerStart={<span className="t-xs muted">Chưa có gì thay đổi cho đến khi bạn nhập.</span>}
        footer={
          <Button variant="ghost" onPress={onClose}>
            Hủy
          </Button>
        }
      >
        <button
          type="button"
          className={`ctb-drop${drag ? " is-drag" : ""}`}
          aria-describedby="tx-drop-hint"
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
            Thả bảng tính vào đây hoặc <span className="text-accent">chọn tệp</span>
          </span>
          <span className="description" id="tx-drop-hint">
            {`CSV hoặc Excel · các cột ${COLUMNS.join(", ")}`}
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
          <LinkButton icon={Download} onPress={template}>
            Tải mẫu
          </LinkButton>
        </div>
      </KnowledgeModal>
    );
  }

  const x = check.data;
  const total = x ? changeCount(x) : 0;
  const skipped = [...plan.skipped, ...(x?.skipped ?? [])].sort((a, b) => a.line - b.line);
  const unchanged = x?.results.reduce((n, r) => n + (r.result.unchangedCount ?? 0), 0) ?? 0;
  const back = () => setFile(null);
  /** A created or updated concept: its name in the file (new ones aren't in the taxonomy yet), and its scheme. */
  const nameOf = (r: Checked["results"][number], concept: string) => {
    const row = r.batch.rows.find((x) => x.notation === resourceKey(concept));
    return t.byName.has(concept) ? conceptLabel(t, concept) : row?.prefVi || row?.prefEn || resourceKey(concept);
  };
  const lines = (kind: "created" | "updated") =>
    (x?.results ?? []).flatMap((r) =>
      (r.result[kind] ?? []).map((c) => (
        <li key={c} className="tx-change">
          <span className="medium truncate" translate="no">
            {nameOf(r, c)}
          </span>
          <span className="muted truncate" translate="no">
            {schemeLabel(r.batch.scheme)}
          </span>
        </li>
      )),
    );
  const list = (title: string, tone: "success" | "accent", items: readonly ReactNode[], limit = 8) =>
    items.length ? (
      <section className="tx-changes">
        <h3 className="tx-changes__title">
          <StatusChip label={fmtNum(items.length)} size="sm" tone={tone} dot={false} />
          <span>{title}</span>
        </h3>
        <ul className="tx-changes__list">
          {items.slice(0, limit)}
          {items.length > limit ? <li className="tx-change muted">{`+${fmtNum(items.length - limit)} nữa`}</li> : null}
        </ul>
      </section>
    ) : null;

  async function apply() {
    if (!x) return;
    setApplying(true);
    try {
      let n = 0;
      for (const r of x.results) {
        const done = await importConcepts(r.batch.scheme.name ?? "", { rows: r.batch.rows });
        n += (done.created?.length ?? 0) + (done.updated?.length ?? 0);
      }
      refresh();
      onClose();
      toast(`Đã nhập ${plural(n, "change")} · hãy công bố để dùng chúng`);
    } catch (error) {
      setApplying(false);
      refresh();
      toast(errorMessage(error), { tone: "danger" });
      void check.refetch();
    }
  }

  let body: ReactNode;
  if (check.isError) body = <ErrorState title="Không kiểm tra được các thay đổi" error={check.error} onRetry={() => void check.refetch()} boxed={false} compact />;
  else if (!x && plan.batches.length) body = <SkeletonRows rows={4} />;
  else {
    body = (
      <>
        {skipped.length ? (
          <Callout
            tone="warning"
            title={`${plural(skipped.length, "row")} sẽ bị bỏ qua`}
            description={
              <ul className="tx-issues">
                {skipped.map((s, i) => (
                  <li key={`${s.line}-${i}`}>
                    <span className="tx-issues__row">{`Hàng ${s.line}`}</span>
                    {s.label ? (
                      <>
                        <span translate="no">{s.label}</span>
                        {DOT}
                      </>
                    ) : null}
                    <span>{s.reason}</span>
                  </li>
                ))}
              </ul>
            }
          />
        ) : null}
        {!total ? <EmptyState icon={CircleCheck} tone="success" title="Không có gì thay đổi" description="Tệp khớp với bản làm việc." compact /> : null}
        {list("Bản nháp mới", "success", lines("created"))}
        {list("Đã cập nhật", "accent", lines("updated"))}
        {total ? (
          <div className="tx-impact">
            <Sparkles className="i i-sm" aria-hidden />
            <ul>
              <li>Thay đổi được đưa vào bản làm việc. Phân loại dùng chúng khi bạn công bố từng trục phân loại.</li>
            </ul>
          </div>
        ) : null}
      </>
    );
  }

  return (
    <KnowledgeModal
      isOpen
      onClose={onClose}
      guard={applying}
      size="lg"
      icon={Upload}
      title="Kiểm tra thay đổi"
      description={unchanged ? `${plural(unchanged, "row")} không đổi.` : `Đang nhập vào ${schemeLabel(scheme)}.`}
      footerStart={
        <Button variant="ghost" onPress={back} isDisabled={applying}>
          <ArrowLeft className="i" aria-hidden />
          Quay lại
        </Button>
      }
      footer={
        <>
          <Button variant="ghost" onPress={onClose} isDisabled={applying}>
            Hủy
          </Button>
          {(x || !plan.batches.length) && !total ? (
            <Button variant="primary" onPress={onClose}>
              Đóng
            </Button>
          ) : (
            <Button variant="primary" onPress={() => void apply()} isPending={applying} isDisabled={!x || check.isFetching}>
              {applying ? null : <Upload className="i" aria-hidden />}
              {x ? `Nhập ${plural(total, "change")}` : "Nhập"}
            </Button>
          )}
        </>
      }
    >
      <div className="stack gap-16">
        <div className="tx-file">
          <FileIcon name={file.name} size="sm" />
          <div className="grow tx-min">
            <div className="medium truncate" translate="no">
              {file.name}
            </div>
            <div className="t-xs muted">{`${plural(file.sheet.rows.length, "row")} · ${fmtSize(file.size)}`}</div>
          </div>
          <Button variant="ghost" size="sm" onPress={back} isDisabled={applying}>
            Chọn tệp khác
          </Button>
        </div>
        {body}
      </div>
    </KnowledgeModal>
  );
}
