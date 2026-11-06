"use client";

export interface CitationMarkerProps {
  n: number;
  /** Accessible name and tooltip: "Source 1: Handbook.pdf, page 18". */
  label: string;
  pressed?: boolean;
  onPress?: () => void;
}

/**
 * Inline evidence marker (preview `.cite`): the one non-HeroUI semantic. It opens
 * the source panel at its passage; `pressed` marks the source shown there.
 */
export function CitationMarker({ n, label, pressed = false, onPress }: CitationMarkerProps) {
  return (
    <button type="button" className="cite" aria-pressed={pressed} aria-label={label} onClick={onPress}>
      {n}
    </button>
  );
}
