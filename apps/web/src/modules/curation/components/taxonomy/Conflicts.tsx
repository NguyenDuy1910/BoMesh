"use client";

import { Button } from "@heroui/react";
import { ArrowLeft, CircleCheck, Pencil, TriangleAlert } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { EmptyState, ErrorState, Section, SkeletonRows } from "@/components/ui";
import type { Concept, ConceptScheme } from "@/modules/knowledge/api";
import { ConceptTag } from "@/modules/knowledge/components/ConceptTag";
import { conceptLabel, resourceKey, schemeLabel, schemeOfConcept, type Taxonomy } from "@/modules/knowledge/taxonomy";

import { LABEL_FIELD, LABEL_KIND_TEXT, sharedLabelsOf, withoutLabel } from "../../governance";
import { taxonomyHref } from "../../model";
import { useSharedLabels } from "../../queries";
import type { SharedLabel } from "../../taxonomyApi";
import { MoveLabelDialog } from "./ConceptDialogs";
import { useEditConcept, type TaxonomyAccess } from "./parts";

type Held = NonNullable<SharedLabel["concepts"]>[number];

const nodeHref = (concept: string) => taxonomyHref(resourceKey(schemeOfConcept(concept)), { node: resourceKey(concept) });

/**
 * Duplicate labels (`?conflicts=1`, preview `conflictsView`): labels two concepts of the scheme share (warnings: remove
 * the label or move it to another concept; a preferred one is renamed in its concept) and labels shared with other
 * schemes (allowed: a search reads the rest of the question). ListSharedLabels.
 */
export function Conflicts({ taxonomy: t, scheme, access }: { taxonomy: Taxonomy; scheme: ConceptScheme; access: TaxonomyAccess }) {
  const shared = useSharedLabels();
  const edit = useEditConcept();
  const router = useRouter();
  const [moving, setMoving] = useState<Held | null>(null);
  const sname = scheme.name ?? "";
  const back = (
    <div className="tx-ref">
      <Button variant="ghost" size="sm" onPress={() => router.push(taxonomyHref(resourceKey(sname)))}>
        <ArrowLeft className="i" aria-hidden />
        {`Quay lại ${schemeLabel(scheme)}`}
      </Button>
    </div>
  );
  if (!shared.data) {
    return (
      <>
        {back}
        {shared.isError ? <ErrorState title="Không tải được nhãn trùng" error={shared.error} onRetry={() => void shared.refetch()} /> : <SkeletonRows rows={4} />}
      </>
    );
  }
  const { within, across } = sharedLabelsOf(shared.data, sname);
  const conceptOf = (h: Held): Concept | undefined => t.byName.get(h.concept ?? "");
  const drop = (h: Held) => {
    const c = conceptOf(h);
    const kind = h.kind ?? "ALT";
    if (!c || kind === "PREF") return;
    const field = LABEL_FIELD[kind];
    void edit(c, { [field]: withoutLabel(c[field], h.languageCode ?? "", h.text ?? "") }, `Đã gỡ “${h.text}” khỏi ${conceptLabel(t, c.name)}`);
  };
  const move = async (h: Held, to: Concept) => {
    const c = conceptOf(h);
    const kind = h.kind ?? "ALT";
    if (!c || kind === "PREF") return;
    const field = LABEL_FIELD[kind];
    const saved = await edit(to, { [field]: [...(to[field] ?? []), { languageCode: h.languageCode ?? "vi", text: h.text ?? "" }] }, `Đã chuyển “${h.text}” sang ${conceptLabel(t, to.name)}`);
    if (saved) await edit(c, { [field]: withoutLabel(c[field], h.languageCode ?? "", h.text ?? "") }, `Đã gỡ “${h.text}” khỏi ${conceptLabel(t, c.name)}`);
  };
  const row = (h: Held, i: number) => (
    <li key={`${h.concept}-${h.kind}-${h.languageCode}-${i}`} className="tx-dup__row">
      <ConceptTag taxonomy={t} concept={h.concept ?? ""} href={nodeHref(h.concept ?? "")} />
      <span className="tx-dup__kind">{LABEL_KIND_TEXT[h.kind ?? "ALT"]}</span>
      <span className="tx-chip__lang" translate="no">
        {h.languageCode}
      </span>
      {access.update ? (
        <span className="tx-dup__acts">
          {h.kind === "PREF" ? (
            <Button variant="ghost" size="sm" onPress={() => router.push(nodeHref(h.concept ?? ""))}>
              <Pencil className="i" aria-hidden />
              Đổi tên
            </Button>
          ) : (
            <>
              <Button variant="ghost" size="sm" onPress={() => drop(h)}>
                Gỡ nhãn
              </Button>
              <Button variant="ghost" size="sm" onPress={() => setMoving(h)}>
                Chuyển nhãn sang…
              </Button>
            </>
          )}
        </span>
      ) : null}
    </li>
  );
  return (
    <>
      {back}
      <div className="tx-conf">
        <header className="tx-scheme">
          <div className="tx-scheme__main">
            <h2 className="tx-scheme__name">Nhãn trùng</h2>
            <p className="tx-scheme__desc" translate="no">
              {schemeLabel(scheme)}
            </p>
          </div>
        </header>
        <Section title="Trong trục phân loại này" description="Hai khái niệm cùng một nhãn sẽ chia tài liệu và kết quả tìm kiếm cho nhau. Hãy giữ nhãn ở một khái niệm.">
          {within.length ? (
            <ul className="tx-dups">
              {within.map((g) => (
                <li key={g.label} className="tx-dup tx-dup--warn">
                  <div className="tx-dup__label">
                    <TriangleAlert className="i i-sm" aria-hidden />
                    <span className="medium" translate="no">{`“${g.concepts?.[0]?.text ?? g.label}”`}</span>
                  </div>
                  <ul className="tx-dup__rows">{(g.concepts ?? []).map(row)}</ul>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState icon={CircleCheck} tone="success" title="Không có nhãn trùng trong trục phân loại này" compact />
          )}
        </Section>
        <Section title="Giữa các trục phân loại" description="Được phép: tìm kiếm dựa vào phần còn lại của câu hỏi để biết nghĩa nào, và nhóm kết quả theo nghĩa khi không phân định được.">
          {across.length ? (
            <ul className="tx-dups">
              {across.map((g) => (
                <li key={g.label} className="tx-dup">
                  <div className="tx-dup__label">
                    <span className="medium" translate="no">{`“${g.concepts?.find((c) => c.scheme === sname)?.text ?? g.label}”`}</span>
                  </div>
                  <div className="tx-dup__tags">
                    {(g.concepts ?? []).map((c, i) => (
                      <span key={`${c.concept}-${i}`} className="tx-dup__where">
                        <span className="muted" translate="no">
                          {schemeLabel(t.schemes.find((s) => s.name === (c.scheme || schemeOfConcept(c.concept ?? ""))))}
                        </span>
                        <ConceptTag taxonomy={t} concept={c.concept ?? ""} href={nodeHref(c.concept ?? "")} />
                      </span>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState icon={CircleCheck} tone="success" title="Không có nhãn trùng với trục phân loại khác" compact />
          )}
        </Section>
      </div>
      {moving ? (
        <MoveLabelDialog taxonomy={t} concept={moving.concept ?? ""} text={moving.text ?? ""} onMove={(to) => void move(moving, to)} onClose={() => setMoving(null)} />
      ) : null}
    </>
  );
}
