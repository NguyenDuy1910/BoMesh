"use client";

import NextLink from "next/link";
import type { ReactNode } from "react";

import { KeyValue, type KeyValuePair } from "@/components/ui/KeyValue";
import { resourceId } from "@/lib/api/client";
import { fmtDate } from "@/lib/format";

import type { DocumentConcept, Item } from "../api";
import { conceptHref } from "../model";
import { useItemsByName, useKnowledgeModel, useTaxonomy } from "../queries";
import { applicabilityText, assignmentsByScheme, conceptLabel, schemeLabel, type Taxonomy } from "../taxonomy";
import { ConceptTag } from "./ConceptTag";

export interface SchemeRowsOptions {
  /** Plain tags, and schemes with nothing to show left out (unless the classifier left them unclassified). */
  compact?: boolean;
  /** Scheme names the classifier left unclassified: “Chưa phân loại” instead of “—”. */
  uncertain?: readonly string[];
  /** Shown beside an empty scheme's marker (e.g. Thêm for editors). */
  add?: ReactNode;
}

/**
 * One row per classification scheme, in tab order (preview `X.res.schemeRows`): [scheme name, its concepts]. Accepted ones
 * link to Browse; the classifier's suggestions are marked “Chờ duyệt”; an empty scheme says “—” (“Chưa phân loại” when the
 * classifier left it in its pool). `compact` leaves out schemes with nothing to show and draws plain tags.
 */
export function schemeRows(taxonomy: Taxonomy, assignments: readonly DocumentConcept[] | undefined, { compact = false, uncertain = [], add }: SchemeRowsOptions = {}): KeyValuePair[] {
  return assignmentsByScheme(taxonomy, assignments).flatMap(({ scheme, items }): KeyValuePair[] => {
    const label = (
      <span translate="no" key="l">
        {schemeLabel(scheme)}
      </span>
    );
    if (items.length)
      return [
        [
          label,
          <span key="v" className="res-concepts">
            {items.map((a) => {
              const suggested = a.state === "SUGGESTED";
              return <ConceptTag key={a.concept} taxonomy={taxonomy} concept={a.concept!} href={compact || suggested ? undefined : conceptHref(a.concept!)} suggested={suggested} />;
            })}
          </span>,
        ],
      ];
    const unsure = uncertain.includes(scheme.name ?? "");
    if (compact && !unsure) return [];
    return [
      [
        label,
        <span key="v" className="row gap-8">
          <span className="muted">{unsure ? "Chưa phân loại" : "—"}</span>
          {add}
        </span>,
      ],
    ];
  });
}

/** A document's concepts grouped by classification scheme (Studio's document drawer, review); nothing when there is nothing to show. */
export function ConceptsByScheme({ assignments, ...options }: { assignments: readonly DocumentConcept[] | undefined } & SchemeRowsOptions) {
  const taxonomy = useTaxonomy().data;
  const rows = schemeRows(taxonomy, assignments, options);
  return rows.length ? <KeyValue pairs={rows} /> : null;
}

/** A form date (`YYYY-MM-DD`) as the local day. */
const localDay = (s: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime() : s;
};

/**
 * “Thông tin văn bản” (preview `X.res.issuance`): an issued document's number, issue and effective dates, issuing unit,
 * who it applies to and what it replaces. Empty rows are left out; nothing when there are none. Replaced documents the
 * viewer can't open aren't named.
 */
export function DocumentFacts({ item }: { item: Item }) {
  const { taxonomy, toResource } = useKnowledgeModel();
  const iss = item.document?.issuance;
  const app = item.document?.applicability;
  const replaced = useItemsByName(iss?.supersedes ?? [], { view: "BASIC", enabled: !!iss?.supersedes?.length });
  const who = applicabilityText(taxonomy, app);
  const sups = (iss?.supersedes ?? []).flatMap((n) => {
    const doc = replaced.items.get(n);
    return doc && doc.state !== "DELETED" ? [doc] : [];
  });
  const rows: (KeyValuePair | false | undefined)[] = [
    iss?.number ? ["Số hiệu", <span key="n" translate="no">{iss.number}</span>] : false,
    iss?.issueDate ? ["Ngày ban hành", fmtDate(localDay(iss.issueDate))] : false,
    iss?.effectiveDate ? ["Ngày hiệu lực", fmtDate(localDay(iss.effectiveDate))] : false,
    iss?.issuer && taxonomy.byName.has(iss.issuer) ? ["Đơn vị ban hành", <span key="i" translate="no">{conceptLabel(taxonomy, iss.issuer)}</span>] : false,
    who ? ["Phạm vi áp dụng", app?.level === "INSTITUTION" ? who : <span key="w" translate="no">{who}</span>] : false,
    sups.length > 0 && [
      "Thay thế",
      <span key="s" className="stack gap-2">
        {sups.map((d) => (
          <NextLink key={d.name} className="link" href={`/doc/${resourceId(d.name)}`} translate="no">
            {toResource(d).title}
          </NextLink>
        ))}
      </span>,
    ],
  ];
  if (!rows.some(Boolean)) return null;
  return (
    <section className="res-facts" aria-label="Thông tin văn bản">
      <h4 className="res-facts__title">Thông tin văn bản</h4>
      <KeyValue pairs={rows} />
    </section>
  );
}
