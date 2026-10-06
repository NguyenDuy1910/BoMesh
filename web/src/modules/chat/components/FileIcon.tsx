import {
  FileArchive,
  FileCode2,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileType2,
  Presentation,
  type LucideIcon,
} from "lucide-react";

import { cn } from "@/lib/cn";

const KINDS: { pattern: RegExp; Icon: LucideIcon; tone: string }[] = [
  { pattern: /\.pdf$/i, Icon: FileType2, tone: "bg-file-pdf" },
  { pattern: /\.(csv|tsv|xlsx|xlsm|xls)$/i, Icon: FileSpreadsheet, tone: "bg-file-sheet" },
  { pattern: /\.(pptx?|key)$/i, Icon: Presentation, tone: "bg-file-slides" },
  { pattern: /\.(png|jpe?g|gif|webp|avif|bmp|tiff?|svg)$/i, Icon: FileImage, tone: "bg-file-image" },
  { pattern: /\.(zip|rar|7z|tar|gz)$/i, Icon: FileArchive, tone: "bg-file-archive" },
  { pattern: /\.(html?|xml|json|jsonl|ya?ml|sql|log)$/i, Icon: FileCode2, tone: "bg-file-web" },
  { pattern: /\.(docx?|odt|rtf)$/i, Icon: FileText, tone: "bg-file-doc" },
];

/**
 * A file's format as a small coloured mark. Decorative: the file name always
 * sits beside it, so it carries no text of its own.
 */
export function FileIcon({
  name,
  size = 20,
  className,
}: {
  name: string;
  size?: 16 | 20 | 28 | 36;
  className?: string;
}) {
  const { Icon, tone } = KINDS.find((kind) => kind.pattern.test(name.trim())) ?? { Icon: FileText, tone: "bg-file-text" };
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-grid shrink-0 place-items-center text-file-label",
        size <= 20 ? "rounded-xs" : "rounded-sm",
        tone,
        className,
      )}
      style={{ width: size, height: size }}
    >
      <Icon size={Math.round(size * 0.6)} strokeWidth={2} />
    </span>
  );
}
