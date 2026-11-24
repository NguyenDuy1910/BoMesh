"use client";

import { Button } from "@heroui/react";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Code, Copy } from "lucide-react";

import { ErrorState, ItemIcon, SkeletonRows } from "@/components/ui";
import { fmtNum } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";
import { copyText } from "@/modules/chat/download";

import { compileClassificationPrompt, type Topic } from "../../api";
import { CurationDrawer } from "../CurationDrawer";
import { ruleText, Sec, useRuleOptions } from "./TopicSignals";

/** Characters of one document's excerpt in the prompt (document_contract.md "Processing"), for the estimate. */
const EXCERPT_CHARACTERS = 12_000;

/**
 * The classification prompt (preview `DR['md-prompt']`): what processing sends the assistant, built from the topics as
 * they are now, in its two parts — the part every document of a run shares (instructions, note, taxonomy; the model
 * provider caches it) and one document's part (keyword matches, title, excerpt) — and the rules checked before it.
 * Loads only while open.
 */
export function PromptDrawer({ isOpen, onClose, topics }: { isOpen: boolean; onClose: () => void; topics: readonly Topic[] }) {
  const { id: ws } = useWorkspace();
  const options = useRuleOptions();
  const q = useQuery({ queryKey: [ws, "topics", "classificationPrompt"], queryFn: () => compileClassificationPrompt(ws), enabled: isOpen, staleTime: 0 });
  const byName = new Map(topics.map((t) => [t.name ?? "", t] as const));
  const data = q.data;
  const prompt = data?.prompt ?? "";
  const cut = prompt.indexOf("<keyword_matches>");
  const shared = cut > 0 ? prompt.slice(0, cut).trimEnd() : prompt;
  const each = cut > 0 ? prompt.slice(cut) : "";
  const tokens = (characters: number) => fmtNum(Math.ceil(characters / 4));

  return (
    <CurationDrawer
      isOpen={isOpen}
      onClose={onClose}
      size="xl"
      lead={<ItemIcon icon={Code} tone="accent" />}
      title="Cách trợ lý phân loại"
      description={
        data
          ? `Tạo từ các chủ đề này: khoảng ${tokens(shared.length)} token dùng chung cho mọi tài liệu (được nhà cung cấp mô hình lưu đệm) và khoảng ${tokens(each.length + EXCERPT_CHARACTERS)} token cho mỗi tài liệu.`
          : undefined
      }
      footer={
        <>
          <Button variant="ghost" onPress={onClose}>
            Đóng
          </Button>
          <Button variant="primary" isDisabled={!data?.prompt} onPress={() => void copyText(data?.prompt ?? "", "Đã sao chép câu lệnh")}>
            <Copy className="i" aria-hidden />
            Sao chép prompt
          </Button>
        </>
      }
    >
      {data ? (
        <div className="md-prompt stack gap-16">
          <Sec title="Quy tắc được kiểm tra trước" desc="Kho tài liệu hoặc nguồn dữ liệu khớp sẽ quyết định chủ đề mà không cần hỏi trợ lý.">
            {data.rules?.length ? (
              <ul className="md-prompt__rules">
                {data.rules.map((r, i) => {
                  const t = byName.get(r.topic ?? "");
                  return (
                    <li key={`${r.topic}-${i}`}>
                      <span>{r.rule ? ruleText(r.rule, options) : ""}</span>
                      <ArrowRight className="i i-xs" aria-hidden />
                      <span translate="no">{t?.displayName ?? ""}</span>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="tx-sec__empty">Chưa chủ đề nào có quy tắc.</p>
            )}
          </Sec>
          <Sec title="Dùng chung cho mọi tài liệu" desc="Giống nhau cho mọi tài liệu của một lần xử lý, nên nhà cung cấp mô hình lấy từ bộ nhớ đệm.">
            <pre className="md-prompt__code" tabIndex={0} aria-label="Prompt dùng chung" translate="no">
              <code>{shared}</code>
            </pre>
          </Sec>
          {each ? (
            <Sec title="Mỗi tài liệu">
              <pre className="md-prompt__code" tabIndex={0} aria-label="Prompt tài liệu" translate="no">
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
