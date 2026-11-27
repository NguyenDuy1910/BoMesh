"use client";

import { Button, Input, TextField } from "@heroui/react";
import { useMutation } from "@tanstack/react-query";
import { ArrowRight, Bot, Copy } from "lucide-react";
import { useState, type KeyboardEvent } from "react";

import { ErrorState, ItemIcon, SkeletonRows } from "@/components/ui";
import { fmtNum, plural } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";
import { copyText } from "@/modules/chat/download";
import { ConceptTag } from "@/modules/knowledge/components/ConceptTag";
import { classSchemes, conceptLabel, schemeLabel, type Taxonomy } from "@/modules/knowledge/taxonomy";
import type { ConceptScheme } from "@/modules/knowledge/api";

import { useClassificationPrompt, useConceptRules } from "../../queries";
import { testClassification } from "../../taxonomyApi";
import { CurationDrawer } from "../CurationDrawer";
import { DOT, Sec, useRuleWhen } from "./parts";

/** Characters of one document's part (metadata and leading excerpts) in the prompt, for the estimate. */
const EXCERPT_CHARACTERS = 12_000;
/** Where one document's part of the prompt starts (`document_contract.md` "Processing"). */
const EACH_MARKERS = ["<settled>", "<candidates>", "<document_title>"];

const POLICY: Readonly<Record<NonNullable<ConceptScheme["llmPolicy"]>, string>> = {
  ALWAYS: "Luôn hỏi trợ lý",
  FALLBACK: "Chỉ hỏi trợ lý khi quy tắc chưa chắc chắn",
  NEVER: "Không bao giờ hỏi trợ lý",
};
const pct = (v: number | undefined, fallback: number) => `${Math.round((v ?? fallback) * 100)}%`;

/**
 * How the assistant classifies (preview `DR['tx-prompt']`): each classification scheme's policy and thresholds, the rules
 * checked before the model (ListConceptRules, in words), a box to test a title against the published schemes
 * (TestClassification, nothing stored),
 * and the prompt in its two parts — shared by every document (cached by the provider) and one document's. Loads while open.
 */
export function PromptDrawer({ isOpen, onClose, taxonomy: t }: { isOpen: boolean; onClose: () => void; taxonomy: Taxonomy }) {
  const { id: ws } = useWorkspace();
  const q = useClassificationPrompt({ enabled: isOpen });
  const [title, setTitle] = useState("");
  const test = useMutation({ mutationFn: (sample: string) => testClassification(ws, { title: sample }) });
  const data = q.data;
  const rules = (useConceptRules("", { enabled: isOpen }).data ?? []).filter((r) => r.then && t.byName.has(r.then));
  const when = useRuleWhen(t, rules);
  const prompt = data?.prompt ?? "";
  const cut = Math.min(...EACH_MARKERS.map((m) => prompt.indexOf(m)).filter((i) => i > 0), prompt.length);
  const shared = prompt.slice(0, cut).trimEnd();
  const each = prompt.slice(cut);
  const tokens = (characters: number) => fmtNum(Math.ceil(characters / 4));
  const schemes = classSchemes(t);
  const run = () => {
    if (title.trim()) test.mutate(title.trim());
  };
  const onEnter = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    run();
  };
  const result = test.data;

  return (
    <CurationDrawer
      isOpen={isOpen}
      onClose={onClose}
      size="xl"
      lead={<ItemIcon icon={Bot} tone="accent" />}
      title="Cách trợ lý phân loại"
      description={
        data
          ? `Mỗi tài liệu một lần gọi, đọc mọi trục phân loại đã công bố: khoảng ${tokens(shared.length)} token dùng chung cho mọi tài liệu và được nhà cung cấp mô hình lưu đệm, cộng khoảng ${tokens(each.length + EXCERPT_CHARACTERS)} cho mỗi tài liệu.`
          : undefined
      }
      footer={
        <>
          <Button variant="ghost" onPress={onClose}>
            Đóng
          </Button>
          <Button variant="primary" isDisabled={!prompt} onPress={() => void copyText(prompt, "Đã sao chép câu lệnh")}>
            <Copy className="i" aria-hidden />
            Sao chép prompt
          </Button>
        </>
      }
    >
      {data ? (
        <div className="stack gap-16">
          <Sec title="Các trục phân loại" desc="Nhãn từ mức thứ nhất trở lên được gán; giữa hai mức thì chờ trong Gợi ý; thấp hơn thì tài liệu ở lại Chưa phân loại.">
            <ul className="tx-pols">
              {schemes.map((s) => (
                <li key={s.name} className="tx-pol">
                  <div className="tx-pol__head">
                    <span className="medium" translate="no">
                      {schemeLabel(s)}
                    </span>
                    <span className="muted">{s.publishedVersion ? `Phiên bản ${s.publishedVersion}` : "Chưa công bố"}</span>
                  </div>
                  <div className="tx-pol__meta">
                    <span>{POLICY[s.llmPolicy ?? "ALWAYS"]}</span>
                    {DOT}
                    <span>{`Gán từ ${pct(s.autoThreshold, 0.85)}, gợi ý từ ${pct(s.reviewThreshold, 0.5)}`}</span>
                    {DOT}
                    <span>{s.cardinality?.max == null ? "Không giới hạn số nhãn" : `Tối đa ${s.cardinality.max} nhãn`}</span>
                    {s.cardinality?.primary ? (
                      <>
                        {DOT}
                        <span>Một nhãn chính</span>
                      </>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          </Sec>
          <Sec title="Quy tắc được kiểm tra trước" desc="“Luôn luôn” quyết định trục phân loại mà không hỏi trợ lý; “dễ được chọn hơn” thêm một ứng viên có trọng số.">
            {rules.length ? (
              <ul className="tx-rulexs">
                {rules.map((r) => (
                  <li key={r.name}>
                    <span>{when(r)}</span> <ArrowRight className="i i-xs" aria-hidden />{" "}
                    <span className="medium" translate="no">
                      {conceptLabel(t, r.then)}
                    </span>
                    <span className="muted">{r.effect === "IMPLIES" ? "luôn luôn" : "dễ được chọn hơn"}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="tx-sec__empty">Chưa có quy tắc.</p>
            )}
          </Sec>
          <Sec title="Thử phân loại" desc="Thử một tiêu đề với các trục phân loại hiện tại.">
            <div className="tx-try">
              <div className="tx-try__form">
                <TextField className="grow" value={title} onChange={setTitle} aria-label="Tiêu đề tài liệu">
                  <Input placeholder="Một tiêu đề, ví dụ Quyết định ban hành quy chế đào tạo.pdf" spellCheck={false} onKeyDown={onEnter} />
                </TextField>
                <Button variant="secondary" size="sm" onPress={run} isPending={test.isPending}>
                  Thử
                </Button>
              </div>
              {test.isError ? <ErrorState title="Không thử được" error={test.error} boxed={false} compact /> : null}
              {result ? (
                <ul className="tx-try__out" aria-live="polite">
                  {schemes.map((s) => {
                    const mine = (result.assignments ?? []).filter((a) => a.scheme === s.name || a.concept?.startsWith(`${s.name}/`));
                    const outcome = result.outcomes?.find((o) => o.scheme === s.name)?.outcome;
                    return (
                      <li key={s.name} className="tx-try__row">
                        <span className="tx-try__scheme" translate="no">
                          {schemeLabel(s)}
                        </span>
                        <span className="tx-try__tags">
                          {mine.length ? (
                            mine.map((a) => (
                              <span key={a.concept} className="tx-try__hit">
                                <ConceptTag taxonomy={t} concept={a.concept ?? ""} suggested={a.state === "SUGGESTED"} />
                                {a.confidence != null ? <span className="muted">{pct(a.confidence, 0)}</span> : null}
                              </span>
                            ))
                          ) : (
                            <span className="muted">{outcome === "UNCERTAIN" ? "Chưa phân loại" : outcome === "FAILED" ? "Không phân loại được" : "—"}</span>
                          )}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              ) : null}
              {result ? <p className="t-xs muted">{result.modelCalled ? "Đã hỏi trợ lý." : `Quy tắc và mẫu nhận diện đã quyết định, không cần hỏi trợ lý · ${plural(result.candidates?.length ?? 0, "concept")} ứng viên`}</p> : null}
            </div>
          </Sec>
          <Sec title="Dùng chung cho mọi tài liệu" desc="Giống nhau cho mọi tài liệu của một lần xử lý, nên nhà cung cấp mô hình lấy từ bộ nhớ đệm.">
            <pre className="tx-code" tabIndex={0} aria-label="Prompt dùng chung" translate="no">
              <code>{shared}</code>
            </pre>
          </Sec>
          {each ? (
            <Sec title="Mỗi tài liệu">
              <pre className="tx-code" tabIndex={0} aria-label="Prompt tài liệu" translate="no">
                <code>{each}</code>
              </pre>
            </Sec>
          ) : null}
        </div>
      ) : q.isError ? (
        <ErrorState title="Không tải được prompt" error={q.error} onRetry={() => void q.refetch()} />
      ) : (
        <SkeletonRows rows={6} />
      )}
    </CurationDrawer>
  );
}
