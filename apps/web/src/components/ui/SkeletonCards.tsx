import { Card, Skeleton } from "@heroui/react";

export interface SkeletonCardsProps {
  /** Number of placeholder cards (default 6). */
  cards?: number;
  /** Grid columns class from base.css (default `cols-3`). */
  columns?: "cols-2" | "cols-3" | "cols-4" | "cols-auto";
}

/** Loading grid of cards (preview `skelCards()`): icon tile + two lines per card. */
export function SkeletonCards({ cards = 6, columns = "cols-3" }: SkeletonCardsProps) {
  return (
    <div className={`grid ${columns}`} aria-busy="true" aria-label="Loading">
      {Array.from({ length: cards }, (_, i) => (
        <Card key={i}>
          <Skeleton style={{ width: 36, height: 36, borderRadius: 10 }} />
          <Skeleton className="skeleton--line" style={{ width: "60%" }} />
          <Skeleton className="skeleton--line" style={{ width: "85%", height: 10 }} />
        </Card>
      ))}
    </div>
  );
}
