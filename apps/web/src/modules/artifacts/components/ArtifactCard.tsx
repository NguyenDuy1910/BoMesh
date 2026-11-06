"use client";

import { Skeleton } from "@heroui/react";
import clsx from "clsx";
import type { KeyboardEvent } from "react";

import { fmtSize } from "@/lib/format";
import { FileIcon } from "@/components/ui";

import { fileNameOf, formatLabel, revisionNumber } from "../model";
import { useArtifact, useVersions } from "../queries";
import { DownloadMenu } from "./ArtifactMenus";

export interface ArtifactCardProps {
  /** Artifact resource name (`Message.artifacts[]` entry). */
  artifact: string;
  /** The panel shows this file. */
  active?: boolean;
  onOpen: (artifact: string) => void;
}

/** A file inside an answer (preview `wk-card`): icon, title, version · format · size, download. */
export function ArtifactCard({ artifact: name, active, onOpen }: ArtifactCardProps) {
  const query = useArtifact(name);
  const artifact = query.data;
  const versions = useVersions(name, artifact?.revision);
  if (query.isError) return null;
  if (!artifact) {
    return (
      <div className="wk-card" aria-busy="true">
        <Skeleton className="h-10 w-10 rounded-lg" />
        <div className="grow stack gap-6">
          <Skeleton className="h-4 w-1/2 rounded" />
          <Skeleton className="h-3 w-1/3 rounded" />
        </div>
      </div>
    );
  }
  const n = revisionNumber(artifact.revision);
  const current = versions.versions.find((v) => v.n === n) ?? versions.versions.at(-1);
  const title = artifact.displayName || "Untitled file";
  const generating = artifact.state === "GENERATING";
  const open = () => onOpen(artifact.name ?? name);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      open();
    }
  };
  const meta = generating
    ? "Writing…"
    : artifact.state === "FAILED"
      ? "Couldn’t be written"
      : `Version ${n || 1} · ${formatLabel(artifact.mimeType)}${current ? ` · ${fmtSize(current.sizeBytes)}` : ""}`;
  return (
    <div
      className={clsx("wk-card", active && "is-on")}
      role="button"
      tabIndex={0}
      data-artifact={artifact.name}
      aria-label={`Open ${title}, version ${n || 1}`}
      onClick={open}
      onKeyDown={onKeyDown}
    >
      <FileIcon size="lg" mime={artifact.mimeType} name={fileNameOf(artifact)} />
      <div className="grow" style={{ minWidth: 0 }}>
        <div className="wk-card__title truncate" translate="no">
          {title}
        </div>
        <div className="t-xs muted truncate">{meta}</div>
      </div>
      {current ? (
        <span onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
          <DownloadMenu artifact={artifact} version={current} latest={n} />
        </span>
      ) : null}
    </div>
  );
}

/** The files of one answer (preview `cards(m)`). */
export function ArtifactCards({ artifacts, activeArtifact, onOpen }: { artifacts: readonly string[]; activeArtifact?: string | null; onOpen: (artifact: string) => void }) {
  if (!artifacts.length) return null;
  return (
    <div className="wk-cards" role="group" aria-label="Files from this answer">
      {artifacts.map((name) => (
        <ArtifactCard key={name} artifact={name} active={activeArtifact === name} onOpen={onOpen} />
      ))}
    </div>
  );
}
