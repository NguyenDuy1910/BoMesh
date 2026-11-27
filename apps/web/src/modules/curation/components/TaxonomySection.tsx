"use client";

import { Button } from "@heroui/react";
import { ArrowLeft, Layers, Lock } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import { EmptyState, ErrorState, PageHeader, SectionTabs, SkeletonRows } from "@/components/ui";
import { useTaxonomy } from "@/modules/knowledge/queries";
import { classSchemes, isClassification, resourceKey, schemeByName, schemeLabel } from "@/modules/knowledge/taxonomy";

import { taxonomyHref } from "../model";
import { useClassificationSuggestions } from "../queries";
import { DemoChip } from "./parts";
import { Conflicts } from "./taxonomy/Conflicts";
import { useTaxonomyAccess } from "./taxonomy/parts";
import { SchemeView } from "./taxonomy/SchemeView";
import { Suggestions } from "./taxonomy/Suggestions";

/**
 * Knowledge Studio → Phân loại (`/studio?tab=taxonomy`, preview `features/masterdata.js`): the workspace's concept
 * schemes (`KNOWLEDGE_STUDIO.md` "Classification"). One tab per classification scheme (`?view=` = its ID; `?node=` = a concept) and
 * Gợi ý — the only tab with a count. Authority lists (org units, programs) are no tabs: they open from a scheme's ⋯ →
 * Danh mục tham chiếu, with a way back. `?conflicts=1` shows a scheme's duplicate labels. People without edit rights see
 * every view read-only; Gợi ý's decisions need `conceptProposals.decide`.
 */
export function TaxonomySection() {
  const access = useTaxonomyAccess();
  const taxonomy = useTaxonomy();
  const t = taxonomy.data;
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const suggestions = useClassificationSuggestions();
  const schemes = classSchemes(t);
  const raw = params.get("view") ?? "";
  const picked = raw === "suggestions" ? undefined : schemeByName(t, raw);
  const view = raw === "suggestions" ? "suggestions" : picked ? resourceKey(picked.name) : resourceKey(schemes[0]?.name) || "suggestions";
  const scheme = view === "suggestions" ? undefined : (picked ?? schemes[0]);
  const node = params.get("node") ?? "";

  const select = (id: string) => {
    const next = new URLSearchParams(params.toString());
    next.set("tab", "taxonomy");
    next.set("view", view);
    next.delete("conflicts");
    if (id) next.set("node", id);
    else next.delete("node");
    router.replace(`${pathname}?${next.toString()}`, { scroll: false });
  };

  const tabs =
    schemes.length && (!scheme || isClassification(scheme)) ? (
      <SectionTabs
        items={[
          ...schemes.map((s) => ({ id: resourceKey(s.name), label: schemeLabel(s), href: taxonomyHref(resourceKey(s.name)) })),
          { id: "suggestions", label: "Gợi ý", href: taxonomyHref("suggestions"), count: suggestions.count || null },
        ]}
        active={view}
        label="Các trục phân loại"
      />
    ) : null;
  const header = (
    <PageHeader title="Phân loại" chips={<DemoChip />}>
      {tabs}
    </PageHeader>
  );

  if (!access.scheme && !access.decide && !access.update) {
    return (
      <>
        {header}
        <EmptyState icon={Lock} title="Chỉ quản trị viên không gian làm việc mới thay đổi được phân loại" boxed />
      </>
    );
  }
  if (taxonomy.isPending) {
    return (
      <>
        {header}
        <SkeletonRows rows={6} />
      </>
    );
  }
  if (taxonomy.isError) {
    return (
      <>
        {header}
        <ErrorState title="Không tải được phân loại" error={taxonomy.error} onRetry={() => void taxonomy.refetch()} />
      </>
    );
  }
  if (!schemes.length) {
    return (
      <>
        {header}
        <EmptyState icon={Layers} title="Chưa có trục phân loại nào" description="Các trục phân loại đi kèm mẫu không gian làm việc." boxed />
      </>
    );
  }

  if (!scheme) {
    return (
      <>
        {header}
        {suggestions.data ? (
          <Suggestions taxonomy={t} access={access} data={suggestions.data} />
        ) : suggestions.isError ? (
          <ErrorState title="Không tải được gợi ý" error={suggestions.error} onRetry={suggestions.refetch} />
        ) : (
          <SkeletonRows rows={6} />
        )}
      </>
    );
  }

  const body =
    params.get("conflicts") && isClassification(scheme) ? (
      <Conflicts taxonomy={t} scheme={scheme} access={access} />
    ) : (
      <SchemeView key={scheme.name} taxonomy={t} scheme={scheme} access={access} node={node} onSelect={select} />
    );
  return (
    <>
      {header}
      {isClassification(scheme) ? null : (
        <div className="tx-ref">
          <Button variant="ghost" size="sm" onPress={() => router.push(taxonomyHref())}>
            <ArrowLeft className="i" aria-hidden />
            Quay lại Phân loại
          </Button>
        </div>
      )}
      {body}
    </>
  );
}
