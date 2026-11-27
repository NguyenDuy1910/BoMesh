"use client";

import { Button } from "@heroui/react";
import { useQuery } from "@tanstack/react-query";
import { Sparkles, Upload } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Callout, ErrorState, SkeletonRows, StatusChip, toast } from "@/components/ui";
import { errorMessage } from "@/lib/api/client";
import { fmtNum } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";
import type { ConceptScheme } from "@/modules/knowledge/api";
import { KnowledgeModal } from "@/modules/knowledge/components/KnowledgeModal";
import { conceptLabel, resourceKey, schemeLabel, type Taxonomy } from "@/modules/knowledge/taxonomy";

import { changeKindText, changeTone, impactLines, VIOLATION_TEXT, warningLines } from "../../governance";
import { taxonomyHref } from "../../model";
import { curationKeys, useInvalidateCuration } from "../../queries";
import { publishConceptScheme } from "../../taxonomyApi";

/**
 * Publish a scheme (preview `M['tx-publish']`): the version publishing would make (`validateOnly`) — blocking problems,
 * each linking to its concept; warnings; what it does to documents (merges remapped, documents classified again) and the
 * changes — then Publish version n, disabled while problems remain. Machines use it at once; there is no Undo.
 */
export function PublishDialog({ taxonomy: t, scheme, onClose, onOpenConcept }: { taxonomy: Taxonomy; scheme: ConceptScheme; onClose: () => void; onOpenConcept: (concept: string) => void }) {
  const { id: ws } = useWorkspace();
  const router = useRouter();
  const invalidate = useInvalidateCuration();
  const [busy, setBusy] = useState(false);
  const sname = scheme.name ?? "";
  const check = useQuery({
    queryKey: [...curationKeys.schemePreview(ws, sname, scheme.etag ?? ""), "dialog"],
    queryFn: () => publishConceptScheme(scheme, { validateOnly: true }),
    retry: false,
    staleTime: 0,
    gcTime: 0,
  });
  const v = check.data;
  const next = (scheme.publishedVersion ?? 0) + 1;
  const violations = v?.violations ?? [];
  const blocked = !v || violations.length > 0;
  const changes = v?.changes ?? [];
  const warnings = v ? warningLines(t, sname, v.warnings ?? []) : [];

  const publish = async () => {
    setBusy(true);
    try {
      const done = await publishConceptScheme(scheme);
      invalidate();
      onClose();
      const r = done.reclassification;
      const again = (r?.rerank?.length ?? 0) + (r?.rerunParents?.length ?? 0);
      toast(`Đã công bố ${schemeLabel(scheme)} phiên bản ${done.version ?? next}`, {
        description: r?.remappedCount ? `${fmtNum(r.remappedCount)} nhãn được ánh xạ lại` : again ? "Đang phân loại lại các tài liệu liên quan…" : undefined,
      });
    } catch (error) {
      setBusy(false);
      toast(errorMessage(error), { tone: "danger" });
      void check.refetch();
    }
  };

  let body;
  if (check.isError) body = <ErrorState title="Không kiểm tra được trục phân loại" error={check.error} onRetry={() => void check.refetch()} boxed={false} compact />;
  else if (!v) body = <SkeletonRows rows={4} />;
  else {
    body = (
      <div className="stack gap-16">
        {violations.length ? (
          <Callout
            tone="danger"
            title={violations.length === 1 ? "Sửa lỗi này trước khi công bố" : `Sửa ${fmtNum(violations.length)} lỗi này trước khi công bố`}
            description={
              <ul className="tx-issues">
                {violations.flatMap((x, i) =>
                  (x.concepts?.length ? x.concepts : [""]).map((c) => (
                    <li key={`${i}-${c}`}>
                      {c ? (
                        <button
                          type="button"
                          className="link"
                          translate="no"
                          onClick={() => {
                            onClose();
                            onOpenConcept(c);
                          }}
                        >
                          {conceptLabel(t, c)}
                        </button>
                      ) : null}{" "}
                      <span>{x.invariant ? VIOLATION_TEXT[x.invariant] : x.message}</span>
                    </li>
                  )),
                )}
              </ul>
            }
          />
        ) : null}
        {warnings.length ? (
          <Callout
            tone="warning"
            title="Nên xem qua"
            description={
              <ul className="tx-issues">
                {warnings.map((w) => (
                  <li key={w.text}>
                    <span>{w.text}</span>
                    {w.names ? (
                      <>
                        {" "}
                        <span translate="no">{w.names}</span>
                      </>
                    ) : null}
                    {w.conflicts ? (
                      <>
                        {" "}
                        <button
                          type="button"
                          className="link"
                          onClick={() => {
                            onClose();
                            router.push(taxonomyHref(resourceKey(sname), { conflicts: "1" }));
                          }}
                        >
                          Xem
                        </button>
                      </>
                    ) : null}
                  </li>
                ))}
              </ul>
            }
          />
        ) : null}
        <div className="tx-impact">
          <Sparkles className="i i-sm" aria-hidden />
          <ul>
            {impactLines(t, v.reclassification).map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
        {changes.length ? (
          <section className="tx-changes">
            <h3 className="tx-changes__title">{`Thay đổi (${fmtNum(changes.length)})`}</h3>
            <ul className="tx-changes__list">
              {changes.map((c, i) => (
                <li key={`${c.kind}-${c.concept ?? c.group ?? i}`} className="tx-change">
                  <StatusChip label={changeKindText(c)} size="sm" tone={changeTone(c)} dot={false} />
                  <span className="medium truncate" translate="no">
                    {c.concept ? conceptLabel(t, c.concept) : schemeLabel(scheme)}
                  </span>
                  {c.replacedBy?.length ? (
                    <span className="muted truncate" translate="no">
                      {c.replacedBy.map((r) => conceptLabel(t, r)).join(", ")}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    );
  }

  return (
    <KnowledgeModal
      isOpen
      onClose={onClose}
      guard={busy}
      size="lg"
      icon={Upload}
      title={`Công bố ${schemeLabel(scheme)}`}
      description={`Phiên bản ${next}. Phân loại và tìm kiếm dùng ngay phiên bản này.`}
      footer={
        <>
          <Button variant="ghost" onPress={onClose} isDisabled={busy}>
            Hủy
          </Button>
          <Button variant="primary" onPress={() => void publish()} isPending={busy} isDisabled={blocked || check.isFetching}>
            {busy ? null : <Upload className="i" aria-hidden />}
            {`Công bố phiên bản ${next}`}
          </Button>
        </>
      }
    >
      {body}
      {v && violations.length ? <p className="t-xs muted mt-8">Hãy sửa các lỗi ở trên trước</p> : null}
    </KnowledgeModal>
  );
}
