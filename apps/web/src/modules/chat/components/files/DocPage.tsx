"use client";

import { forwardRef } from "react";

import { cn } from "@/lib/cn";

/**
 * Typography for a document page: Markdown the preview renders and the HTML
 * the editor holds share it, so editing does not change how a page looks.
 */
export const DOC_PROSE = cn(
  "text-[length:var(--text-size-body)] leading-[1.7] text-text-primary",
  "[&_h1]:mb-4 [&_h1]:text-[22px] [&_h1]:font-semibold [&_h1]:leading-tight [&_h1]:tracking-[-0.01em]",
  "[&_h2]:mb-3 [&_h2]:mt-6 [&_h2]:text-[20px] [&_h2]:font-semibold [&_h2]:leading-tight [&_h2]:tracking-[-0.01em]",
  "[&_h3]:mb-2 [&_h3]:mt-6 [&_h3]:text-[16px] [&_h3]:font-semibold",
  "[&_h4]:mb-2 [&_h4]:mt-5 [&_h4]:font-semibold",
  "[&>*:first-child]:mt-0 [&_p]:mb-3 [&_strong]:font-semibold",
  "[&_ul]:mb-3 [&_ul]:list-disc [&_ul]:pl-[22px] [&_ol]:mb-3 [&_ol]:list-decimal [&_ol]:pl-[22px] [&_li]:mb-1",
  "[&_table]:my-2 [&_table]:w-full [&_table]:border-collapse [&_table]:text-[13.5px]",
  "[&_td]:border [&_td]:border-border-default [&_td]:px-2.5 [&_td]:py-2 [&_td]:align-top",
  "[&_th]:border [&_th]:border-border-default [&_th]:bg-surface-subtle [&_th]:px-2.5 [&_th]:py-2 [&_th]:text-left [&_th]:font-semibold",
  "[&_a]:text-text-accent [&_a]:underline",
  "[&_code]:rounded-xs [&_code]:bg-surface-inset [&_code]:px-1 [&_code]:font-mono [&_code]:text-[0.9em]",
  "[&_pre]:my-3 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-surface-inset [&_pre]:p-3 [&_pre_code]:bg-transparent [&_pre_code]:p-0",
  "[&_blockquote]:mb-3 [&_blockquote]:border-l-[3px] [&_blockquote]:border-border-default [&_blockquote]:pl-3 [&_blockquote]:text-text-secondary",
);

/** A sheet of paper in the panel: the document view, the editor and the text changes all sit on one. */
export const DocPage = forwardRef<HTMLDivElement, React.ComponentProps<"div">>(function DocPage({ className, ...props }, ref) {
  return (
    <div
      className={cn(
        "mx-auto w-full max-w-[720px] rounded-[6px] border border-border-subtle bg-surface-base px-[42px] py-9 shadow-(--shadow-2)",
        "max-[700px]:px-6 max-[700px]:py-6",
        DOC_PROSE,
        className,
      )}
      ref={ref}
      {...props}
    />
  );
});
