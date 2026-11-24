"use client";

import { Button, Input, TextField } from "@heroui/react";
import { useMutation } from "@tanstack/react-query";
import { AlertCircle, CheckCircle2, Info } from "lucide-react";
import { useState, type ReactNode } from "react";

import { StatusChip } from "@/components/ui";
import { ApiError, errorMessage } from "@/lib/api/client";
import { useWorkspace } from "@/lib/workspace";

import { testTopicClassification, type TestClassificationRequest, type Topic } from "../../api";
import { PlainSelect } from "../parts";
import { Sec, type RuleOptions } from "./TopicSignals";

const ANY = "__any";

/** Why a test couldn't run, in words. */
function testError(error: unknown): string {
  if (error instanceof ApiError && error.code === "FAILED_PRECONDITION") return "Không có quy tắc nào khớp và chưa thiết lập mô hình trợ lý, nên chưa thử được.";
  if (error instanceof ApiError && error.code === "UNAVAILABLE") return "Trợ lý chưa trả lời. Hãy thử lại.";
  return errorMessage(error);
}

/**
 * Test classification (preview `testSec`): a sample title, optionally in a collection or from a source, classified the
 * way processing would (rules first, else the assistant), with this topic's unsaved changes. Nothing is stored.
 */
export function TestClassification({ topic, draft, topics, options }: { topic: Topic; draft: Topic | null; topics: readonly Topic[]; options: RuleOptions }) {
  const { id: ws } = useWorkspace();
  const [title, setTitle] = useState("");
  const [collection, setCollection] = useState("");
  const [source, setSource] = useState("");
  const run = useMutation({ mutationFn: (body: TestClassificationRequest) => testTopicClassification(ws, body) });

  const test = () => {
    const t = title.trim();
    if (!t) return;
    run.mutate({ title: t, collection: collection || undefined, source: source || undefined, topics: draft ? [draft] : undefined });
  };

  let out: ReactNode = null;
  if (run.isError) {
    out = (
      <p className="tx-test__verdict is-warn" role="alert">
        <AlertCircle className="i i-sm" aria-hidden />
        <span>{testError(run.error)}</span>
      </p>
    );
  } else if (run.data) {
    const results = run.data.results ?? [];
    const byName = new Map(topics.map((t) => [t.name ?? "", t]));
    const rank = results.findIndex((r) => r.topic === topic.name);
    const verdict =
      rank === 0 ? (
        <p className="tx-test__verdict is-ok">
          <CheckCircle2 className="i i-sm" aria-hidden />
          <span>Chủ đề này đứng đầu.</span>
        </p>
      ) : rank > 0 ? (
        <p className="tx-test__verdict">
          <Info className="i i-sm" aria-hidden />
          <span>Chủ đề này nằm trong kết quả khớp.</span>
        </p>
      ) : (
        <p className="tx-test__verdict is-warn">
          <AlertCircle className="i i-sm" aria-hidden />
          <span>Chủ đề này không nằm trong kết quả khớp. Hãy thêm từ khóa, từ đồng nghĩa hoặc quy tắc mà tiêu đề này sẽ khớp.</span>
        </p>
      );
    out = (
      <>
        {verdict}
        {results.length ? (
          <ol className="tx-results">
            {results.map((r, i) => {
              const tp = byName.get(r.topic ?? "");
              const dm = byName.get(tp?.parentTopic ?? "");
              return (
                <li key={`${r.topic}-${i}`} className={`tx-result${r.topic === topic.name ? " is-self" : ""}`}>
                  <span className="tx-result__rank">{i + 1}</span>
                  <div className="tx-result__main">
                    <div className="tx-result__name">
                      {dm ? (
                        <>
                          <span className="muted" translate="no">
                            {dm.displayName}
                          </span>
                          <span className="muted" aria-hidden="true">
                            {" · "}
                          </span>
                        </>
                      ) : null}
                      <span className="medium" translate="no">
                        {tp?.displayName ?? r.topic}
                      </span>
                    </div>
                  </div>
                  <StatusChip label={r.reason === "RULE" ? "Quy tắc" : "Trợ lý"} tone={r.reason === "RULE" ? "accent" : "default"} size="sm" dot={false} />
                </li>
              );
            })}
          </ol>
        ) : (
          <p className="tx-sec__empty">Không có chủ đề nào khớp. Tài liệu sẽ chờ một người chọn chủ đề.</p>
        )}
        {run.data.summary ? (
          <p className="tx-test__summary" translate="no">
            {run.data.summary}
          </p>
        ) : null}
      </>
    );
  }

  return (
    <Sec
      title="Thử phân loại"
      desc={
        <>
          <span>Hãy thử một tiêu đề. Chọn kho tài liệu hoặc nguồn dữ liệu để kiểm tra quy tắc.</span>
          {draft ? <span> Dùng các thay đổi chưa lưu của bạn.</span> : null}
        </>
      }
    >
      <div className="tx-test">
        <div className="tx-test__form">
          <TextField aria-label="Tiêu đề tài liệu" value={title} onChange={setTitle} maxLength={1024} className="tx-test__q">
            <Input placeholder="Một tiêu đề, ví dụ: Quy trình hoàn tiền 2027.pdf" spellCheck={false} onKeyDown={(e) => e.key === "Enter" && test()} />
          </TextField>
          <PlainSelect className="tx-test__src" label="Kho tài liệu" value={collection || ANY} options={[[ANY, "Mọi kho tài liệu"], ...options.collections]} onChange={(v) => setCollection(v === ANY ? "" : v)} />
          <PlainSelect className="tx-test__src" label="Nguồn" value={source || ANY} options={[[ANY, "Mọi nguồn dữ liệu"], ...options.sources]} onChange={(v) => setSource(v === ANY ? "" : v)} />
          <Button variant="secondary" size="sm" isPending={run.isPending} isDisabled={!title.trim()} onPress={test}>
            Thử
          </Button>
        </div>
        <div className="tx-test__out" aria-live="polite">
          {out}
        </div>
      </div>
    </Sec>
  );
}
