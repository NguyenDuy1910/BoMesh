"use client";

import { Button, Dropdown, Header, Label, Separator } from "@heroui/react";
import { BookOpen, Check, ChevronDown, Download, File, FileText, GitCompare, History, MessageSquare, MoreHorizontal, Pencil, Table } from "lucide-react";

import { errorMessage } from "@/lib/api/client";
import { rel } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";
import { toast } from "@/components/ui";

import { downloadArtifactMedia, exportArtifact, getRevision, saveFile, type Artifact } from "../api";
import { baseName, downloadOptions, fileNameOf, fileViewOf, type DownloadOption, type Version } from "../model";

const OPTION_ICON = { table: Table, file: File, "file-text": FileText } as const;

/** Downloads one version in one format (export, or the stored original). */
async function downloadVersion(workspace: string, artifact: Artifact, version: Version, latest: number, option: DownloadOption) {
  const name = `${baseName(fileNameOf(artifact))}.${option.ext}`;
  try {
    let file;
    if (option.format !== "original") {
      file = await exportArtifact(workspace, artifact.name ?? "", option.format, { revision: version.name, fallbackName: name });
    } else if (version.n === latest) {
      file = await downloadArtifactMedia(workspace, artifact.name ?? "", name);
    } else {
      const uri = version.revision.snapshot?.contentUri ?? (await getRevision(workspace, artifact.name ?? "", version.n)).snapshot?.contentUri;
      if (!uri) throw new Error("This version can’t be downloaded.");
      const response = await fetch(uri);
      if (!response.ok) throw new Error("This version can’t be downloaded.");
      file = { blob: await response.blob(), fileName: name };
    }
    saveFile(file);
    toast(`Downloaded ${file.fileName} (version ${version.n})`);
  } catch (error) {
    toast("Download failed", { tone: "danger", description: errorMessage(error) });
  }
}

/** Download menu of a version (preview `wk-dl`). */
export function DownloadMenu({ artifact, version, latest }: { artifact: Artifact; version: Version | undefined; latest: number }) {
  const { id } = useWorkspace();
  const options = version ? downloadOptions(fileViewOf(version.mimeType || artifact.mimeType), version.mimeType || artifact.mimeType) : [];
  return (
    <Dropdown>
      <Button isIconOnly size="sm" variant="ghost" className="button--muted" aria-label="Download" isDisabled={!version}>
        <Download aria-hidden />
      </Button>
      <Dropdown.Popover placement="bottom end">
        <Dropdown.Menu aria-label="Download" onAction={(key) => {
          const option = options.find((o) => o.id === key);
          if (option && version) void downloadVersion(id, artifact, version, latest, option);
        }}>
          <Dropdown.Section>
            <Header>Version {version?.n}</Header>
            {options.map((option) => {
              const Icon = OPTION_ICON[option.icon];
              return (
                <Dropdown.Item key={option.id} id={option.id} textValue={option.label}>
                  <Icon className="i" aria-hidden />
                  <Label>{option.label}</Label>
                  <span className="t-xs muted ms-auto">{option.meta}</span>
                </Dropdown.Item>
              );
            })}
          </Dropdown.Section>
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  );
}

/** Version picker in the panel header (preview `wk-ver`). */
export function VersionMenu({
  versions,
  current,
  onPick,
  onCompare,
  onAll,
}: {
  versions: readonly Version[];
  current: Version;
  onPick: (n: number) => void;
  onCompare: () => void;
  onAll: () => void;
}) {
  const latest = versions.at(-1)?.n ?? current.n;
  return (
    <Dropdown>
      <Button size="sm" variant="outline" className="wk-ver" aria-label="Versions">
        <span>
          v{current.n}
          {current.n === latest ? " · Latest" : ""}
        </span>
        <ChevronDown aria-hidden />
      </Button>
      <Dropdown.Popover placement="bottom end" className="min-w-[260px]">
        <Dropdown.Menu
          aria-label="Versions"
          disabledKeys={current.n === 1 ? ["compare"] : []}
          onAction={(key) => {
            const k = String(key);
            if (k === "compare") onCompare();
            else if (k === "all") onAll();
            else onPick(Number(k.slice(1)));
          }}
        >
          <Dropdown.Section>
            <Header>Versions</Header>
            {[...versions].reverse().map((v) => (
              <Dropdown.Item key={v.n} id={`v${v.n}`} textValue={`Version ${v.n}`}>
                <span className="stack grow" style={{ minWidth: 0 }}>
                  <Label>
                    Version {v.n}
                    {v.n === latest ? " · Latest" : ""}
                  </Label>
                  <span className="t-xs muted truncate">
                    {v.summary} · {rel(v.createTime).toLowerCase()}
                  </span>
                </span>
                {v.n === current.n ? <Check className="i i-sm" aria-label="Current" /> : null}
              </Dropdown.Item>
            ))}
          </Dropdown.Section>
          <Separator />
          <Dropdown.Item id="compare" textValue="Compare with previous">
            <GitCompare className="i" aria-hidden />
            <Label>Compare with previous</Label>
          </Dropdown.Item>
          <Dropdown.Item id="all" textValue="All versions">
            <History className="i" aria-hidden />
            <Label>All versions</Label>
          </Dropdown.Item>
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  );
}

/** The panel's ⋯ menu (preview `wk-file-more`). */
export function FileMoreMenu({
  canPublish,
  isOwner,
  inConversation,
  onPublish,
  onRename,
  onShowInConversation,
}: {
  canPublish: boolean;
  /** Publish and rename are the owner's. */
  isOwner: boolean;
  inConversation: boolean;
  onPublish: () => void;
  onRename: () => void;
  onShowInConversation: () => void;
}) {
  const disabled = [canPublish ? null : "publish"].filter((k): k is string => !!k);
  return (
    <Dropdown>
      <Button isIconOnly size="sm" variant="ghost" className="button--muted" aria-label="More">
        <MoreHorizontal aria-hidden />
      </Button>
      <Dropdown.Popover placement="bottom end">
        <Dropdown.Menu
          aria-label="More"
          disabledKeys={disabled}
          onAction={(key) => {
            if (key === "publish") onPublish();
            else if (key === "rename") onRename();
            else if (key === "show") onShowInConversation();
          }}
        >
          {isOwner ? (
            <Dropdown.Item id="publish" textValue="Save to knowledge…">
              <BookOpen className="i" aria-hidden />
              <Label>Save to knowledge…</Label>
            </Dropdown.Item>
          ) : null}
          {isOwner ? (
            <Dropdown.Item id="rename" textValue="Rename">
              <Pencil className="i" aria-hidden />
              <Label>Rename</Label>
            </Dropdown.Item>
          ) : null}
          {isOwner && inConversation ? <Separator /> : null}
          {inConversation ? (
            <Dropdown.Item id="show" textValue="Show in conversation">
              <MessageSquare className="i" aria-hidden />
              <Label>Show in conversation</Label>
            </Dropdown.Item>
          ) : null}
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  );
}
