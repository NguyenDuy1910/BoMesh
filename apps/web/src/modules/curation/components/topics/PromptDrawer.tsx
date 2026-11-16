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

/**
 * The classification prompt (preview `DR['md-prompt']`): what processing sends the assistant, built from the topics as
 * they are now, and the rules checked before it. Loads only while open.
 */
export function PromptDrawer({ isOpen, onClose, topics }: { isOpen: boolean; onClose: () => void; topics: readonly Topic[] }) {
  const { id: ws } = useWorkspace();
  const options = useRuleOptions();
  const q = useQuery({ queryKey: [ws, "topics", "classificationPrompt"], queryFn: () => compileClassificationPrompt(ws), enabled: isOpen, staleTime: 0 });
  const byName = new Map(topics.map((t) => [t.name ?? "", t] as const));
  const data = q.data;

  return (
    <CurationDrawer
      isOpen={isOpen}
      onClose={onClose}
      size="xl"
      lead={<ItemIcon icon={Code} tone="accent" />}
      title="Classification prompt"
      description={data ? `Built from these topics. Sent once per document, about ${fmtNum(data.estimatedTokens ?? 0)} tokens.` : undefined}
      footer={
        <>
          <Button variant="ghost" onPress={onClose}>
            Close
          </Button>
          <Button variant="primary" isDisabled={!data?.prompt} onPress={() => void copyText(data?.prompt ?? "", "Prompt copied")}>
            <Copy className="i" aria-hidden />
            Copy prompt
          </Button>
        </>
      }
    >
      {data ? (
        <div className="md-prompt stack gap-16">
          <Sec title="Rules checked first" desc="A matching collection or source settles the topic without asking the assistant.">
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
              <p className="tx-sec__empty">No topic has a rule.</p>
            )}
          </Sec>
          <Sec title="Prompt">
            <pre className="md-prompt__code" tabIndex={0} aria-label="Classification prompt" translate="no">
              <code>{data.prompt}</code>
            </pre>
          </Sec>
        </div>
      ) : q.isError ? (
        <ErrorState title="The prompt didn’t load" error={q.error} onRetry={() => void q.refetch()} />
      ) : (
        <SkeletonRows rows={6} />
      )}
    </CurationDrawer>
  );
}
