"use client";

import { useSyncExternalStore } from "react";

import { cn } from "@/lib/cn";

/* Layout pieces of the gallery itself (prototype `.ds-sec`, `.ds-row`,
   `.swatch`). They only arrange specimens; every specimen is a real primitive. */

export function Section({
  id,
  title,
  description,
  children,
}: {
  id: string;
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section aria-labelledby={`${id}-title`} className="mb-10 scroll-mt-20" id={id}>
      <h2 className="mb-1 text-[1.125rem] font-semibold tracking-[-0.01em] text-text-primary" id={`${id}-title`}>
        {title}
      </h2>
      <p className="mb-4 text-[0.84375rem] text-text-secondary">{description}</p>
      {children}
    </section>
  );
}

/** A small heading inside a section, for groups of specimens. */
export function Group({ title, children, className }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("mt-6 first:mt-0", className)}>
      <h3 className="mb-2.5 text-meta font-medium text-text-tertiary">{title}</h3>
      {children}
    </div>
  );
}

/** One labelled line of specimens (prototype `.ds-row`). */
export function Row({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className="flex flex-col gap-3 border-b border-border-subtle py-4 last:border-b-0 min-[861px]:flex-row min-[861px]:items-center">
      <div className="w-[140px] flex-none text-meta text-text-tertiary">{label}</div>
      <div className={cn("flex min-w-0 flex-1 flex-wrap items-center gap-3", className)}>{children}</div>
    </div>
  );
}

/** A captioned specimen, for states that need a name under them. */
export function Specimen({ caption, children, className }: { caption: string; children: React.ReactNode; className?: string }) {
  return (
    <figure className={cn("m-0 grid gap-2", className)}>
      {children}
      <figcaption className="text-caption text-text-tertiary">{caption}</figcaption>
    </figure>
  );
}

export function Card({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("rounded-lg border border-border-subtle bg-surface-base", className)}>{children}</div>;
}

export function Grid({ cols, children, className }: { cols: 2 | 3 | 4 | 5; children: React.ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "grid gap-3",
        cols === 2 && "grid-cols-1 sm:grid-cols-2",
        cols === 3 && "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3",
        cols === 4 && "grid-cols-2 sm:grid-cols-3 lg:grid-cols-4",
        cols === 5 && "grid-cols-2 sm:grid-cols-3 lg:grid-cols-5",
        className,
      )}
    >
      {children}
    </div>
  );
}

/* ── Resolved token values ─────────────────────────────────────────────────
   The swatches print what each token resolves to under the current theme,
   accent and density. The boot script owns the <html> attributes, so the
   gallery re-reads whenever they change. */

const ROOT_ATTRIBUTES = ["data-theme", "data-accent", "data-bg", "data-density"];

function subscribeRoot(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ROOT_ATTRIBUTES });
  return () => observer.disconnect();
}

function rootSnapshot() {
  const root = document.documentElement;
  return ROOT_ATTRIBUTES.map((name) => root.getAttribute(name) ?? "").join("|");
}

/** Changes whenever the theme attributes on <html> change; `""` on the server. */
export function useRootAppearance(): string {
  return useSyncExternalStore(subscribeRoot, rootSnapshot, () => "");
}

export function readToken(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** A colour token as a card: the colour, its name, the variable and its current value. */
export function Swatch({
  name,
  token,
  note,
  appearance,
  className,
}: {
  name: string;
  token: string;
  note?: string;
  /** From `useRootAppearance()`; empty until mounted. */
  appearance: string;
  className?: string;
}) {
  const value = appearance ? readToken(token) : "";
  return (
    <div className={cn("overflow-hidden rounded-lg border border-border-subtle bg-surface-base", className)}>
      <div className="h-14 border-b border-border-subtle" style={{ background: `var(${token})` }} />
      <div className="grid gap-0.5 px-2.5 py-2 text-meta">
        <span className="font-medium text-text-primary">{name}</span>
        <span className="truncate font-[family-name:var(--font-mono)] text-[0.71875rem] text-text-tertiary">
          {token}
          {note ? ` · ${note}` : ""}
        </span>
        <span className="h-4 truncate font-[family-name:var(--font-mono)] text-[0.71875rem] text-text-tertiary">
          {value.toLowerCase()}
        </span>
      </div>
    </div>
  );
}
