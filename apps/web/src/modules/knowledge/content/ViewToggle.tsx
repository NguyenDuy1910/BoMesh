"use client";

import { File, FileText } from "lucide-react";

import { Segmented } from "@/components/ui/Segmented";

export type ViewMode = "content" | "original";

const OPTIONS = [
  { value: "content", label: "Nội dung", icon: FileText },
  { value: "original", label: "Bản gốc", icon: File },
] as const;

/** Content (the extracted blocks) | Original (the file as its own app shows it, loaded only when chosen). */
export function ViewToggle({ value, onChange }: { value: ViewMode; onChange: (mode: ViewMode) => void }) {
  return <Segmented value={value} options={OPTIONS} onChange={onChange} label="Chế độ xem" className="cv-toggle" />;
}
