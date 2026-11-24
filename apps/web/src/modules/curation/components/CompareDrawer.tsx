"use client";

import { Button } from "@heroui/react";
import { GitCompare } from "lucide-react";

import { EmptyState, FileIcon, ItemIcon, KeyValue } from "@/components/ui";
import { fmtDateTime, fmtSize } from "@/lib/format";
import type { Item } from "@/modules/knowledge/api";
import { ResourceDetails } from "@/modules/knowledge/components/ResourceDetails";
import { clip, DOC_TYPES, docTypeOf } from "@/modules/knowledge/model";
import { useItem, useKnowledgeModel } from "@/modules/knowledge/queries";

import { versionOf } from "../model";
import type { Submission } from "../queries";
import { CurationDrawer } from "./CurationDrawer";
import { useFirstPageText } from "./FirstPage";

/** Compare a submission with the published document it resembles (preview `DR['cur-compare']`). */
export function CompareDrawer({
  submission,
  related,
  contributor,
  baseName,
  onClose,
}: {
  submission: Submission | null;
  related: string;
  contributor: string;
  baseName: string;
  onClose: () => void;
}) {
  const other = useItem(submission ? related : null);
  const o = other.data;
  const d = submission?.item;
  const unavailable = !!submission && (other.isError || !d);
  const ver = versionOf(o?.document?.revision);
  return (
    <CurationDrawer
      isOpen={!!submission}
      onClose={onClose}
      size="xl"
      lead={<ItemIcon icon={GitCompare} tone="warning" />}
      title={unavailable ? "Không so sánh được" : "So sánh"}
      description={unavailable ? undefined : "Tài liệu chờ duyệt và tài liệu đã công bố tương tự."}
      footer={
        <Button variant="secondary" onPress={onClose}>
          Đóng
        </Button>
      }
    >
      {unavailable ? (
        <EmptyState icon={GitCompare} title="Một trong các tài liệu này không khả dụng" description="Có thể tài liệu đã được lưu trữ hoặc đã có quyết định." />
      ) : submission && d ? (
        <div className="cur-cmp">
          <SubmissionColumn submission={submission} item={d} contributor={contributor} baseName={baseName} />
          {o ? <PublishedColumn item={o} label={`Đã công bố${ver ? ` · v${ver}` : ""}`} /> : <div className="cur-cmp__col" />}
        </div>
      ) : null}
    </CurationDrawer>
  );
}

function Excerpt({ item }: { item: Item }) {
  const page = useFirstPageText(item);
  const text = clip(page.data ?? "", 420);
  return <p className="cur-cmp__text">{text ? <span translate="no">{text}</span> : <span className="muted">Không có nội dung để hiển thị.</span>}</p>;
}

function SubmissionColumn({ submission, item, contributor, baseName }: { submission: Submission; item: Item; contributor: string; baseName: string }) {
  return (
    <div className="cur-cmp__col">
      <div className="t-label">Tài liệu chờ duyệt</div>
      <div className="row gap-8">
        <FileIcon name={item.document?.fileName} mime={item.document?.mimeType} />
        <span className="medium cur-cmp__name" translate="no">
          {item.displayName}
        </span>
      </div>
      <Excerpt item={item} />
      <KeyValue
        pairs={[
          ["Loại", DOC_TYPES[docTypeOf(item.itemType)].label],
          ["Kho tài liệu", baseName ? <span translate="no">{baseName}</span> : "—"],
          ["Người gửi", contributor ? <span translate="no">{contributor}</span> : "—"],
          ["Đã gửi", fmtDateTime(submission.contribution.createTime)],
          ["Kích thước", fmtSize(item.document?.sizeBytes)],
        ]}
      />
    </div>
  );
}

function PublishedColumn({ item, label }: { item: Item; label: string }) {
  const { toResource } = useKnowledgeModel();
  return (
    <div className="cur-cmp__col">
      <div className="t-label">{label}</div>
      <div className="row gap-8">
        <FileIcon name={item.document?.fileName} mime={item.document?.mimeType} />
        <span className="medium cur-cmp__name" translate="no">
          {item.displayName}
        </span>
      </div>
      <Excerpt item={item} />
      <ResourceDetails resource={toResource(item)} />
    </div>
  );
}
