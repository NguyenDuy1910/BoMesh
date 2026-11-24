"use client";

import clsx from "clsx";
import {
  Briefcase,
  Building2,
  ClipboardList,
  Clock,
  Files,
  Folder,
  GraduationCap,
  Landmark,
  Layers,
  Library,
  Lock,
  Minus,
  Network,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react";
import { createContext, memo, useContext, useEffect, useRef, useState, type CSSProperties } from "react";

import { FileIcon, WorkspaceMark } from "@/components/ui";
import { fmtNum, plural, rel } from "@/lib/format";

import type { Resource } from "../model";
import { openDocumentPreview } from "../preview/store";
import { CLUSTER_SHOW, type AtlasNode } from "./layout";
import { splitMatches } from "./match";
import { useContainerDocs } from "./queries";

/** What each level is: one icon per kind (identity), whatever territory it sits in (accent). */
const LEVEL_ICON: Record<string, LucideIcon> = {
  Faculty: Building2,
  "Academic department": Network,
  "Program group": Layers,
  Major: GraduationCap,
  "Administrative office": Briefcase,
  Forms: ClipboardList,
  Area: Library,
  Section: Layers,
  Subsection: Network,
  Folder,
};
const DEPTH_ICON: LucideIcon[] = [Landmark, Building2, Network, Layers, Folder];
export const levelIcon = (label: string, depth: number) => LEVEL_ICON[label] ?? DEPTH_ICON[Math.min(depth, DEPTH_ICON.length - 1)];

const NEW_DAYS = 14;
const DAY = 86_400_000;
const box = (n: AtlasNode, tone?: string): CSSProperties => ({
  left: n.x,
  top: n.y,
  width: n.w,
  height: n.h,
  ...(tone ? ({ "--tone": tone } as CSSProperties) : {}),
});

/** Text with the matched words marked. */
export function Marked({ text, words }: { text: string; words: readonly string[] }) {
  if (!words.length) return <>{text}</>;
  return (
    <>
      {splitMatches(text, words).map((p, i) =>
        p.hit ? (
          <mark key={i} className="srch-hl">
            {p.text}
          </mark>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </>
  );
}

/** Verified or review due · new (preview `docMarks`). */
export function DocMarks({ r }: { r: Resource }) {
  return (
    <>
      {r.trust.state === "verified" ? (
        <span className="an-mark" title="Verified">
          <ShieldCheck className="i i-xs an-ok" aria-hidden />
          <span className="sr-only">Verified</span>
        </span>
      ) : r.trust.state === "review" ? (
        <span className="an-mark" title="Review due">
          <Clock className="i i-xs an-due" aria-hidden />
          <span className="sr-only">Review due</span>
        </span>
      ) : null}
      {r.updated && Date.now() - Date.parse(r.updated) < NEW_DAYS * DAY ? <span className="an-new">New</span> : null}
    </>
  );
}

/** Opens the shared document preview; the root collection lets a locked document offer Request access. */
export const openDoc = (r: Resource, root?: string) =>
  openDocumentPreview({
    item: r.item.name ?? r.id,
    from: "map",
    collection: root,
  });

/** A document row inside a cluster or the inspector. */
export function DocRow({ r, words = [], root }: { r: Resource; words?: readonly string[]; root?: string }) {
  return (
    <button type="button" className="an-row" onClick={() => openDoc(r, root)}>
      <FileIcon size="sm" name={r.fileName} mime={r.mime} />
      <span className="an-row__title" translate="no" title={r.title.length > 30 ? r.title : undefined}>
        <Marked text={r.title} words={words} />
      </span>
      <DocMarks r={r} />
    </button>
  );
}

export interface ShellProps {
  node: AtlasNode;
  dim: boolean;
}

export const WorkspaceNode = memo(function WorkspaceNode({ node, dim, name, logo }: ShellProps & { name: string; logo?: string }) {
  return (
    <div className={clsx("an an--ws", dim && "is-dim")} style={box(node)} data-node="ws">
      <WorkspaceMark name={name} logo={logo} size={32} />
      <span className="an__text">
        <span className="an__type">Workspace</span>
        <span className="an__title" translate="no">
          {name}
        </span>
      </span>
    </div>
  );
});

export interface OrgNodeProps extends ShellProps {
  label: string;
  selected: boolean;
  words: readonly string[];
  onSelect: (id: string) => void;
  onToggle: (id: string) => void;
}

/** A collection or folder: the whole box selects; the handle on its right edge folds it. */
export const OrgNode = memo(function OrgNode({ node, dim, label, selected, words, onSelect, onToggle }: OrgNodeProps) {
  const c = node.coll!;
  const locked = node.kind === "locked";
  const Icon = locked ? Lock : levelIcon(label, c.depth);
  return (
    <div
      className={clsx(
        "an an--org",
        node.kind === "root" && "an--root",
        locked && "an--locked",
        dim && "is-dim",
        !dim && selected && "is-sel",
      )}
      style={box(node, locked ? undefined : node.tone)}
      data-node={node.id}
      data-anc={node.anc.join(" ")}
    >
      <button type="button" className="an__main" aria-pressed={selected} onClick={() => onSelect(node.id)}>
        <span className="an__icon">
          <Icon className="i" aria-hidden />
        </span>
        <span className="an__text">
          <span className="an__type">{locked ? "Restricted" : label}</span>
          <span className="an__title" translate="no">
            <Marked text={c.displayName} words={words} />
          </span>
        </span>
        {locked ? null : (
          <span className="an__count num" title={plural(c.count, "document")}>
            {fmtNum(c.count)}
          </span>
        )}
      </button>
      {node.hasKids ? (
        <button
          type="button"
          className="an__handle"
          aria-expanded={!!node.open}
          aria-label={`${node.open ? "Collapse" : "Expand"} ${c.displayName}`}
          title={node.open ? "Collapse" : "Expand"}
          onClick={() => onToggle(node.id)}
        >
          {node.open ? <Minus className="i i-xs" aria-hidden /> : <span className="num">{node.hidden}</span>}
        </button>
      ) : null}
    </div>
  );
});

/* ═══════════════ Documents: loaded per container once its boxes come near the view ═══════════════ */

/** Calls back once when an element comes within 600 px of the canvas (IntersectionObserver rooted at the viewport). */
export const NearViewContext = createContext<HTMLElement | null>(null);
function useNearView<T extends Element>(): [React.RefObject<T | null>, boolean] {
  const ref = useRef<T | null>(null);
  const root = useContext(NearViewContext);
  const [near, setNear] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || near) return;
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && setNear(true), { root, rootMargin: "600px" });
    io.observe(el);
    return () => io.disconnect();
  }, [root, near]);
  return [ref, near];
}

export interface DocGroupProps {
  /** The container's document boxes (one by one) or its cluster, laid out. */
  nodes: readonly AtlasNode[];
  container: string;
  root: string;
  tone: string;
  dim: boolean;
  onMore: (container: string) => void;
}

/** One container's documents: individual boxes or a cluster, filled in when they come near the view. */
export const DocGroup = memo(function DocGroup({ nodes, container, root, tone, dim, onMore }: DocGroupProps) {
  const [ref, near] = useNearView<HTMLDivElement>();
  const { docs, isError } = useContainerDocs(container, near);
  const cluster = nodes[0]?.kind === "cluster" ? nodes[0] : null;
  if (cluster) {
    const rows = cluster.all ? docs : docs.slice(0, CLUSTER_SHOW);
    const shown = cluster.rows ?? CLUSTER_SHOW;
    const rest = (cluster.total ?? 0) - (cluster.all ? (cluster.total ?? 0) : CLUSTER_SHOW);
    return (
      <div
        className={clsx("an an--cluster", dim && "is-dim")}
        style={box(cluster, tone)}
        data-node={cluster.id}
        data-anc={cluster.anc.join(" ")}
      >
        <div ref={ref} className="an-sentinel" aria-hidden />
        <div className="an-cluster__head">
          <Files className="i i-sm" aria-hidden />
          <span className="an__title">{plural(cluster.total ?? 0, "document")}</span>
        </div>
        <div className="an-cluster__rows">
          {rows.length
            ? rows.map((r) => <DocRow key={r.id} r={r} root={root} />)
            : Array.from({ length: Math.min(shown, 12) }, (_, i) => (
                <span key={i} className="an-row an-row--skel" aria-hidden>
                  <span className="skeleton" />
                </span>
              ))}
          {isError ? <span className="an-row an-row--note">These documents didn’t load.</span> : null}
        </div>
        <button type="button" className="an-cluster__more" aria-expanded={!!cluster.all} onClick={() => onMore(container)}>
          {cluster.all ? "Show fewer" : `+${rest} more`}
        </button>
      </div>
    );
  }
  return (
    <>
      <div ref={ref} className="an-sentinel" style={box(nodes[0])} aria-hidden />
      {nodes.map((n, i) => {
        const r = docs[n.index ?? i];
        return r ? (
          <button
            key={n.id}
            type="button"
            className={clsx("an an--doc", dim && "is-dim")}
            style={box(n, tone)}
            data-node={n.id}
            data-anc={n.anc.join(" ")}
            onClick={() => openDoc(r, root)}
          >
            <FileIcon size="sm" name={r.fileName} mime={r.mime} />
            <span className="an__text">
              <span className="an__title" translate="no" title={r.title.length > 30 ? r.title : undefined}>
                {r.title}
              </span>
              <span className="an__meta">{rel(r.updated)}</span>
            </span>
            <DocMarks r={r} />
          </button>
        ) : (
          <div key={n.id} className={clsx("an an--doc an--skel", dim && "is-dim")} style={box(n, tone)} data-node={n.id} aria-hidden>
            <span className="skeleton an-skel__icon" />
            <span className="skeleton an-skel__line" />
          </div>
        );
      })}
    </>
  );
});

/** A matched document while searching (its item came with the search results). */
export const SearchDoc = memo(function SearchDoc({
  node,
  r,
  words,
  root,
  dim,
}: {
  node: AtlasNode;
  r: Resource;
  words: readonly string[];
  root: string;
  dim: boolean;
}) {
  return (
    <button
      type="button"
      className={clsx("an an--doc", dim && "is-dim")}
      style={box(node, node.tone)}
      data-node={node.id}
      data-anc={node.anc.join(" ")}
      onClick={() => openDoc(r, root)}
    >
      <FileIcon size="sm" name={r.fileName} mime={r.mime} />
      <span className="an__text">
        <span className="an__title" translate="no">
          <Marked text={r.title} words={words} />
        </span>
        <span className="an__meta">{rel(r.updated)}</span>
      </span>
      <DocMarks r={r} />
    </button>
  );
});
