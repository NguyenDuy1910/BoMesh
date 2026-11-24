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
  { value: "MERGE", title: "Thêm và cập nhật", description: "Chủ đề được đối chiếu theo tên trong lĩnh vực của nó: chủ đề mới được thêm, chủ đề trùng tên được cập nhật. Không xóa gì." },
  { value: "REPLACE", title: "Thay thế", description: "Đồng thời lưu trữ các chủ đề không có trong tệp. Chủ đề đang được tài liệu sử dụng vẫn được giữ." },
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
  DESCRIPTION: "mô tả",
  KEYWORDS: "keywords",
  SYNONYMS: "synonyms",
  GUIDANCE: "guidance",
};

/** Reads a picked file into import rows: CSV/TSV as text, .xlsx through the workbook reader. */
async function readSheet(f: File): Promise<SheetImport | { error: string }> {
  const ext = (f.name.split(".").pop() ?? "").toLowerCase();
  if (ext === "xls") return { error: "Hãy lưu tệp thành .xlsx hoặc CSV." };
  if (ext === "xlsx") {
    try {
      return rowsToImport(await readXlsx(await f.arrayBuffer()));
    } catch {
      return { error: "Không đọc được tệp Excel này. Hãy lưu thành .xlsx hoặc CSV." };
    }
  }
  if (!["csv", "tsv", "txt"].includes(ext)) return { error: "Chọn tệp CSV hoặc Excel." };
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
        title="Nhập chủ đề"
        description={`Cập nhật lĩnh vực, chủ đề, từ khóa và từ đồng nghĩa mà ${workspace.displayName} dùng để phân loại tài liệu. Bạn kiểm tra mọi thay đổi trước khi áp dụng.`}
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
            Thả bảng tính vào đây hoặc <span className="text-accent">chọn tệp</span>
          </span>
          <span className="description" id="md-drop-hint">
            CSV hoặc Excel · các cột domain, topic, description, keywords, synonyms, guidance
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
            Tải mẫu
          </LinkButton>
        </div>
        <div className="field mt-16">
          <span className="label">Cách áp dụng</span>
          <ChoiceGroup label="Cách áp dụng" value={mode} onChange={setMode} options={MODES} columns={2} />
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
    (c.changes ?? []).map((k) => (k === "RENAMED" ? `đổi tên từ “${c.previousDisplayName ?? ""}”` : k === "MOVED" ? `chuyển sang ${c.domain ?? ""}` : CHANGE_WORD[k]));
  /** The file row a skipped row came from: Row n · Domain › Topic. */
  const rowLabel = (r: TopicImportRow | undefined) => (r ? [r.domain, r.topic].filter(Boolean).join(" › ") : "") || "—";

  async function apply() {
    setApplying(true);
    try {
      const done = await importTopics(ws, { rows, mode, validateOnly: false });
      invalidate();
      onClose();
      toast(`Đã nhập ${plural(changeCount(done), "change")}`);
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
          {items.length > limit ? <li className="muted">{`+${fmtNum(items.length - limit)} nữa`}</li> : null}
        </ul>
      </section>
    ) : null;

  const columns = missing.length > 1 ? `${missing.slice(0, -1).join(", ")} hoặc ${missing[missing.length - 1]}` : missing[0];
  const effects = ["Tài liệu đã công bố giữ nguyên chủ đề. Quy tắc và ví dụ được giữ nguyên.", columns ? `Tệp không có cột ${columns}: các giá trị đó được giữ nguyên.` : ""].filter(Boolean);
  const applies = `Thao tác nhập sẽ áp dụng các thay đổi dưới đây${mode === "REPLACE" ? " và lưu trữ các chủ đề không dùng đến không có trong tệp" : ""}.`;
  const skipped = x?.skippedRows ?? [];

  let body: ReactNode;
  if (check.isError) body = <ErrorState title="Không kiểm tra được các thay đổi" error={check.error} onRetry={() => check.refetch()} boxed={false} compact />;
  else if (!x) body = <SkeletonRows rows={4} />;
  else {
    body = (
      <>
        {skipped.length ? (
          <Callout
            tone="warning"
            title={`${plural(skipped.length, "row")} sẽ bị bỏ qua`}
            description={
              <ul className="md-errs">
                {skipped.map((s) => (
                  <li key={s.row}>
                    <span className="md-code">{`Hàng ${lines[(s.row ?? 0) - 1] ?? s.row}`}</span> <span translate="no">{rowLabel(rows[(s.row ?? 0) - 1])}</span>
                    {DOT}
                    <span>{s.reason}</span>
                  </li>
                ))}
              </ul>
            }
          />
        ) : null}
        {!total ? <EmptyState icon={CircleCheck} tone="success" title="Không có gì thay đổi" description="Tệp khớp với các chủ đề." compact /> : null}
        {list(
          "Mới",
          "success",
          (x.created ?? []).map((c) => (
            <li key={c.topic}>
              {name(label(c))}
              {c.kind === "DOMAIN" ? (
                <>
                  {DOT}
                  {note("lĩnh vực mới")}
                </>
              ) : null}
            </li>
          )),
        )}
        {list(
          "Đã cập nhật",
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
          "Đã lưu trữ",
          "default",
          (x.archived ?? []).map((c) => (
            <li key={c.topic}>
              {name(label(c))}
              {DOT}
              {note("không có trong tệp, chưa dùng")}
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
      title="Kiểm tra thay đổi"
      description={x?.unchangedCount ? `${plural(x.unchangedCount, "topic")} unchanged. ${applies}` : applies}
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
          {x && !total ? (
            <Button variant="primary" onPress={onClose}>
              Đóng
            </Button>
          ) : (
            <Button variant="primary" onPress={() => void apply()} isPending={applying} isDisabled={!x || check.isFetching}>
              <Upload className="i" aria-hidden />
              {x ? `Nhập ${plural(total, "change")}` : "Nhập"}
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
            Chọn tệp khác
          </Button>
        </div>
        {body}
      </div>
    </KnowledgeModal>
  );
}
