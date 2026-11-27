"use client";

import { Button } from "@heroui/react";
import { History } from "lucide-react";

import { EmptyState, ErrorState, ItemIcon, SkeletonRows, StatusChip } from "@/components/ui";
import { resourceId } from "@/lib/api/client";
import { fmtDate, plural } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";
import type { ConceptScheme } from "@/modules/knowledge/api";
import { useMemberNames } from "@/modules/knowledge/queries";
import { conceptLabel, schemeLabel, type Taxonomy } from "@/modules/knowledge/taxonomy";

import { changeKindText, impactLines } from "../../governance";
import { useSchemeVersions } from "../../queries";
import type { ConceptChange, ConceptSchemeVersion } from "../../taxonomyApi";
import { CurationDrawer } from "../CurationDrawer";
import { DOT } from "./parts";

/**
 * Version history (preview `DR['tx-versions']`): the working copy's unpublished changes (for publishers, from the
 * publish preview), then each published version — when, by whom, its changes, its warnings and what it did to documents.
 * Loads while open.
 */
export function VersionsDrawer({
  isOpen,
  onClose,
  taxonomy: t,
  scheme,
  preview,
}: {
  isOpen: boolean;
  onClose: () => void;
  taxonomy: Taxonomy;
  scheme: ConceptScheme;
  preview?: ConceptSchemeVersion;
}) {
  const { workspace } = useWorkspace();
  const versions = useSchemeVersions(scheme.name ?? "", { enabled: isOpen });
  const list = versions.data ?? [];
  const members = useMemberNames(list.map((v) => (v.publisher ? `${workspace.name}/members/${resourceId(v.publisher)}` : null)));
  const pending = preview?.changes ?? [];
  const changeLi = (c: ConceptChange, i: number) => (
    <li key={`${c.kind}-${c.concept ?? c.group ?? i}`} className="tx-change">
      <StatusChip label={changeKindText(c)} size="sm" dot={false} />
      <span className="truncate" translate="no">
        {c.concept ? conceptLabel(t, c.concept) : schemeLabel(scheme)}
      </span>
      {c.replacedBy?.length ? (
        <span className="muted truncate" translate="no">
          {c.replacedBy.map((r) => conceptLabel(t, r)).join(", ")}
        </span>
      ) : null}
    </li>
  );

  let body;
  if (versions.isError) body = <ErrorState title="Không tải được lịch sử phiên bản" error={versions.error} onRetry={() => void versions.refetch()} />;
  else if (!versions.data) body = <SkeletonRows rows={4} />;
  else if (!list.length && !pending.length) body = <EmptyState icon={History} title="Chưa công bố" compact />;
  else {
    body = (
      <ul className="tx-vers">
        {pending.length ? (
          <li className="tx-ver tx-ver--draft">
            <div className="tx-ver__head">
              <span className="medium">Bản làm việc</span>
              <StatusChip label={`${plural(pending.length, "change")} chưa công bố`} size="sm" tone="accent" dot={false} />
            </div>
            <ul className="tx-changes__list">{pending.map(changeLi)}</ul>
          </li>
        ) : null}
        {[...list]
          .sort((a, b) => (b.version ?? 0) - (a.version ?? 0))
          .map((v) => {
            const r = v.reclassification;
            const impact = r && (r.remappedCount || r.rerank?.length || r.rerunParents?.length || r.thresholdsChanged) ? impactLines(t, r) : [];
            const by = v.publisher ? members.get(`${workspace.name}/members/${resourceId(v.publisher)}`) || "Thành viên cũ" : "";
            const warnings = v.warnings ?? [];
            return (
              <li key={v.name ?? v.version} className="tx-ver">
                <div className="tx-ver__head">
                  <span className="medium">{`Phiên bản ${v.version ?? ""}`}</span>
                  {v.version === scheme.publishedVersion ? <StatusChip label="Hiện tại" size="sm" tone="success" dot={false} /> : null}
                </div>
                <div className="tx-ver__meta">
                  {v.publishTime ? fmtDate(v.publishTime) : null}
                  {by ? (
                    <>
                      {DOT}
                      <span translate="no">{by}</span>
                    </>
                  ) : null}
                  {DOT}
                  {plural(v.changes?.length ?? 0, "change")}
                  {v.conceptCount != null ? (
                    <>
                      {DOT}
                      {plural(v.conceptCount, "concept")}
                    </>
                  ) : null}
                </div>
                {warnings.length ? <p className="tx-ver__note">{`${plural(warnings.length, "cảnh báo")} khi công bố`}</p> : null}
                {impact.length ? <p className="tx-ver__note">{impact.join(" · ")}</p> : null}
                {v.changes?.length ? <ul className="tx-changes__list">{v.changes.map(changeLi)}</ul> : null}
              </li>
            );
          })}
      </ul>
    );
  }

  return (
    <CurationDrawer
      isOpen={isOpen}
      onClose={onClose}
      size="md"
      lead={<ItemIcon icon={History} tone="accent" />}
      title="Lịch sử phiên bản"
      description={schemeLabel(scheme)}
      footer={
        <Button variant="ghost" onPress={onClose}>
          Đóng
        </Button>
      }
    >
      {body}
    </CurationDrawer>
  );
}
