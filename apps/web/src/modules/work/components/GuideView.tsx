"use client";

import { Button, Dropdown, Label, Skeleton } from "@heroui/react";
import { BookOpen, ChevronDown, Download, FileText, Lightbulb, RefreshCw, SlidersHorizontal, Target, TriangleAlert } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, type Key } from "react";

import { Callout, EmptyState, ErrorState, IconButton, SkeletonRows, toast } from "@/components/ui";
import { resourceId } from "@/lib/api/client";
import { useWorkspace } from "@/lib/workspace";

import { isSpaceStaff, newWorkHref, workflowsFor } from "../kinds";
import { guideSections } from "../model";
import { useArtifactText } from "../queries";
import { WorkMarkdown } from "./parts";
import type { WorkViewProps } from "./WorkItemPage";

/** "Practice quiz from this" + Download (preview `guideActions`). */
export function GuideActions({ artifact: a, space, actions }: WorkViewProps) {
  const router = useRouter();
  const { settings, hasModule } = useWorkspace();
  const quiz = (space ? workflowsFor(settings, space) : hasModule("spaces") ? [] : workflowsFor(settings)).find((f) => f.id === "QUIZ");
  const label = isSpaceStaff(space) ? "Make a quiz from this" : "Practice quiz from this";
  const onDownload = (key: Key) => void actions.download(key === "word" ? "word" : "pdf");
  return (
    <>
      {quiz ? (
        <Button variant="tertiary" onPress={() => router.push(newWorkHref({ workflow: "QUIZ", space: a.space ? resourceId(a.space) : undefined, docs: a.sourceItems }))}>
          <Target className="i" aria-hidden />
          {label}
        </Button>
      ) : null}
      <Dropdown>
        <IconButton icon={Download} tip="Download" showTip={false} />
        <Dropdown.Popover placement="bottom end">
          <Dropdown.Menu aria-label="Download" onAction={onDownload}>
            <Dropdown.Item id="word" textValue="Word document">
              <FileText className="i" aria-hidden />
              <Label>Word document</Label>
            </Dropdown.Item>
            <Dropdown.Item id="pdf" textValue="PDF">
              <Download className="i" aria-hidden />
              <Label>PDF</Label>
            </Dropdown.Item>
          </Dropdown.Menu>
        </Dropdown.Popover>
      </Dropdown>
    </>
  );
}

const REWRITE = {
  regen: (t: string) => `Regenerate only the section “${t}” from the materials, with a fresh take. Keep every other section exactly as it is.`,
  short: (t: string) => `Make only the section “${t}” shorter. Keep every other section exactly as it is.`,
  simple: (t: string) => `Make only the section “${t}” simpler, in plain words. Keep every other section exactly as it is.`,
} as const;
const DONE = { regen: "Section regenerated", short: "Made shorter", simple: "Made simpler" } as const;

/** Study guide: one section per heading, each regenerated or rewritten on its own (preview `renderGuide`). */
export function GuideView({ artifact: a, canEdit, actions }: WorkViewProps) {
  const text = useArtifactText(a);
  const [busy, setBusy] = useState<string | null>(null);
  const generating = a.state === "GENERATING";

  if (text.isPending && a.revision) return <SkeletonRows rows={8} />;
  if (text.isError)
    return (a.hiddenSourceCount ?? 0) > 0 ? (
      <Callout tone="warning" icon={TriangleAlert} title="This guide is hidden from you" description="It uses sources you can no longer open. Ask the owner to share them again." />
    ) : (
      <ErrorState error={text.error} onRetry={() => void text.refetch()} />
    );
  const sections = guideSections(text.data ?? "");
  if (!sections.length) return <EmptyState icon={BookOpen} title="This guide is empty" boxed />;

  const rewrite = async (id: string, title: string, mode: keyof typeof REWRITE) => {
    setBusy(id);
    const ok = await actions.revise({ instructions: REWRITE[mode](title) }, { failure: "Couldn’t rewrite this section" });
    setBusy(null);
    if (ok) toast(DONE[mode]);
  };

  return (
    <article className="guide" translate="no">
      {sections.map((s) => (
        <section key={s.id} className="guide-sec" aria-labelledby={`gs-${s.id}`}>
          {s.title ? (
            <div className="guide-sec__head">
              <h2 className="guide-sec__title" id={`gs-${s.id}`}>
                {s.title}
              </h2>
              <span className="grow" />
              {canEdit ? (
                <div className="guide-sec__acts" translate="yes">
                  <IconButton icon={RefreshCw} tip="Regenerate" size="sm" onPress={() => void rewrite(s.id, s.title, "regen")} isDisabled={!!busy || generating} />
                  <Dropdown>
                    <Button variant="ghost" size="sm" isDisabled={!!busy || generating}>
                      Rewrite
                      <ChevronDown className="i" aria-hidden />
                    </Button>
                    <Dropdown.Popover placement="bottom end">
                      <Dropdown.Menu aria-label={`Rewrite ${s.title}`} onAction={(k: Key) => void rewrite(s.id, s.title, k === "short" ? "short" : "simple")}>
                        <Dropdown.Item id="short" textValue="Shorter">
                          <SlidersHorizontal className="i" aria-hidden />
                          <Label>Shorter</Label>
                        </Dropdown.Item>
                        <Dropdown.Item id="simple" textValue="Simpler">
                          <Lightbulb className="i" aria-hidden />
                          <Label>Simpler</Label>
                        </Dropdown.Item>
                      </Dropdown.Menu>
                    </Dropdown.Popover>
                  </Dropdown>
                </div>
              ) : null}
            </div>
          ) : null}
          {busy === s.id ? (
            <div className="stack gap-8" aria-busy="true">
              <Skeleton className="skeleton--line" style={{ width: "92%" }} />
              <Skeleton className="skeleton--line" style={{ width: "85%" }} />
              <Skeleton className="skeleton--line" style={{ width: "60%" }} />
            </div>
          ) : (
            <WorkMarkdown text={s.body} className="guide-sec__body" />
          )}
        </section>
      ))}
    </article>
  );
}
