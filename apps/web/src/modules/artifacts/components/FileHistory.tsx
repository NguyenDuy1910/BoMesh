"use client";

import { Button, Chip } from "@heroui/react";
import NextLink from "next/link";

import { resourceId } from "@/lib/api/client";
import { fmtDateTime, fmtSize, plural } from "@/lib/format";
import { FileIcon, List, ListItem } from "@/components/ui";
import { useItem } from "@/modules/knowledge/queries";

import type { Artifact } from "../api";
import type { Version } from "../model";

/** History tab (preview `historyHtml`): versions newest first, and the documents the file was built from. */
export function FileHistory({
  artifact,
  versions,
  current,
  canRestore,
  onView,
  onRestore,
}: {
  artifact: Artifact;
  versions: readonly Version[];
  current: number;
  canRestore: boolean;
  onView: (n: number) => void;
  onRestore: (n: number) => void;
}) {
  const latest = versions.at(-1)?.n ?? 0;
  const sources = artifact.sourceItems ?? [];
  const hidden = artifact.hiddenSourceCount ?? 0;
  return (
    <div className="stack gap-24">
      <div>
        <div className="t-label mb-8">Phiên bản</div>
        <List>
          {[...versions].reverse().map((v) => (
            <ListItem
              key={v.n}
              className={v.n === current ? "wk-rev is-on" : "wk-rev"}
              lead={<span className="wk-rev-n num">v{v.n}</span>}
              title={v.summary}
              titleExtra={
                v.n === latest ? (
                  <Chip size="sm" color="accent" variant="soft">
                    Mới nhất
                  </Chip>
                ) : null
              }
              description={`${v.author === "you" ? "Do bạn chỉnh sửa" : "Do trợ lý tạo"} · ${fmtDateTime(v.createTime)} · ${fmtSize(v.sizeBytes)}`}
              actions={
                <>
                  {v.n !== current ? (
                    <Button size="sm" variant="ghost" onPress={() => onView(v.n)}>
                      Xem
                    </Button>
                  ) : null}
                  {canRestore && v.n !== latest ? (
                    <Button size="sm" variant="ghost" onPress={() => onRestore(v.n)}>
                      Khôi phục
                    </Button>
                  ) : null}
                </>
              }
            />
          ))}
        </List>
        <p className="t-xs muted mt-8">Khôi phục sẽ tạo phiên bản mới. Không có gì bị ghi đè.</p>
      </div>
      {sources.length || hidden ? (
        <div>
          <div className="t-label mb-8">Tạo từ</div>
          <div className="row gap-6 wrap">
            {sources.map((source) => (
              <SourceChip key={source} item={source} conversation={artifact.conversation} />
            ))}
            {hidden ? <span className="t-xs muted">{plural(hidden, "document")} bạn không mở được</span> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function SourceChip({ item, conversation }: { item: string; conversation?: string }) {
  const query = useItem(item);
  if (query.isError) return null;
  const doc = query.data;
  const from = conversation ? `?from=${resourceId(conversation)}` : "";
  return (
    <NextLink className="chat-source" href={`/doc/${resourceId(item)}${from}`}>
      <FileIcon size="sm" mime={doc?.document?.mimeType} name={doc?.document?.fileName} />
      <span className="truncate" translate="no">
        {doc?.displayName ?? "…"}
      </span>
    </NextLink>
  );
}
