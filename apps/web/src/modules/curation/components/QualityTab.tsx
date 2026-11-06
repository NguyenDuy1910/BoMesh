"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMemo } from "react";

import { ErrorState, Segmented, SkeletonRows } from "@/components/ui";
import { fmtNum } from "@/lib/format";

import { detailEntries, duplicatePairs, qualitySummary, resolveSeg, reviewEntries, type QualitySeg } from "../governance";
import { DetailsSegment } from "./quality/DetailsSegment";
import { DuplicatesSegment } from "./quality/DuplicatesSegment";
import { useQualityPool } from "./quality/parts";
import { ReverifySegment } from "./quality/ReverifySegment";

/**
 * Manage → Documents › Quality (preview `X.gov.quality`): keeps published documents trustworthy —
 * re-verification, missing details and possible duplicates in the bases the caller looks after.
 * Reads and writes `?seg=reverify|details|duplicates` (legacy `review` → reverify).
 */
export function QualityTab() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const query = useQualityPool();

  const signals = useMemo(() => {
    if (!query.data) return null;
    const { pool, visible } = query.data;
    return { pool, rv: reviewEntries(pool), dt: detailEntries(pool), dp: duplicatePairs(pool, visible) };
  }, [query.data]);

  if (!signals) {
    if (query.isError) return <ErrorState title="Quality checks didn’t load" error={query.error} onRetry={query.refetch} />;
    return <SkeletonRows rows={6} />;
  }

  const { pool, rv, dt, dp } = signals;
  const seg = resolveSeg(params.get("seg") ?? "", { reverify: rv.length, details: dt.length, duplicates: dp.length });
  const setSeg = (value: QualitySeg) => {
    const next = new URLSearchParams(params.toString());
    next.set("tab", "quality");
    next.set("seg", value);
    router.replace(`${pathname}?${next.toString()}`, { scroll: false });
  };

  return (
    <div className="kh gov">
      <p className="gov-summary">{qualitySummary(pool, rv.length, dt.length, dp.length)}</p>
      <div className="gov-seg">
        <Segmented
          label="Quality checks"
          value={seg}
          onChange={setSeg}
          options={[
            { value: "reverify", label: `Due for re-verification · ${fmtNum(rv.length)}` },
            { value: "details", label: `Missing details · ${fmtNum(dt.length)}` },
            { value: "duplicates", label: `Possible duplicates · ${fmtNum(dp.length)}` },
          ]}
        />
      </div>
      {seg === "reverify" ? <ReverifySegment entries={rv} /> : seg === "details" ? <DetailsSegment entries={dt} /> : <DuplicatesSegment pairs={dp} />}
    </div>
  );
}
