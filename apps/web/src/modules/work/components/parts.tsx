"use client";

import Link from "next/link";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { ItemIcon, StatusChip } from "@/components/ui";
import type { Schema } from "@/lib/api/client";
import { spaceColor } from "@/modules/spaces";

import { kindMeta } from "../kinds";
import { workStatus, type Artifact } from "../model";

/** Kind tile (preview `tile(w, size)`). */
export function WorkTile({ kind, size }: { kind: string | undefined; size?: "sm" | "md" }) {
  const meta = kindMeta(kind);
  return <ItemIcon icon={meta.icon} tone={meta.tone} size={size} />;
}

/** Work status (preview `statusChip(w)`). */
export function WorkStatusChip({ artifact, staffQuiz }: { artifact: Artifact; staffQuiz?: boolean }) {
  const s = workStatus(artifact, { staffQuiz });
  return <StatusChip label={s.label} tone={s.tone} variant={s.variant} live={s.live} dot />;
}

/** Space name with its colour dot (preview `spaceTag(sp)`). */
export function SpaceTag({ space }: { space: Schema<"Space"> }) {
  return (
    <span className="work-space">
      <span className="space-dot" style={{ background: spaceColor(space) }} aria-hidden />
      <span className="truncate" translate="no">
        {space.displayName}
      </span>
    </span>
  );
}

/** Generated Markdown (drafts, guides, quizzes, synthesis). Workspace content: never localized. */
export function WorkMarkdown({ text, className }: { text: string; className?: string }) {
  return (
    <div className={className} translate="no">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) =>
            href?.startsWith("/") ? (
              <Link href={href} className="link">
                {children}
              </Link>
            ) : (
              <a href={href} target="_blank" rel="noreferrer" className="link">
                {children}
              </a>
            ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
