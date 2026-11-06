"use client";

import { Button } from "@heroui/react";
import { GitCompare } from "lucide-react";

import { EmptyState, FileIcon, ItemIcon, KeyValue } from "@/components/ui";
import { fmtDateTime, fmtSize } from "@/lib/format";
import type { Item } from "@/modules/knowledge/api";
import { ResourceDetails } from "@/modules/knowledge/components/ResourceDetails";
import { clip, RESOURCE_KINDS } from "@/modules/knowledge/model";
import { useItem, useKnowledgeModel } from "@/modules/knowledge/queries";

import { suggestedKind } from "../model";
import type { Submission } from "../queries";
import { CurationDrawer } from "./CurationDrawer";
import { firstPageText, useFirstPage } from "./FirstPage";
import { versionOf } from "./ReviewDetail";

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
      title={unavailable ? "Comparison not available" : "Compare"}
      description={unavailable ? undefined : "The submission and the published document it resembles."}
      footer={
        <Button variant="secondary" onPress={onClose}>
          Close
        </Button>
      }
    >
      {unavailable ? (
        <EmptyState icon={GitCompare} title="One of these documents isn’t available" description="It may have been archived or decided already." />
      ) : submission && d ? (
        <div className="cur-cmp">
          <SubmissionColumn submission={submission} item={d} contributor={contributor} baseName={baseName} />
          {o ? <PublishedColumn item={o} label={`Published${ver ? ` · v${ver}` : ""}`} /> : <div className="cur-cmp__col" />}
        </div>
      ) : null}
    </CurationDrawer>
  );
}

function Excerpt({ item }: { item: Item }) {
  const page = useFirstPage(item);
  const text = clip(firstPageText(page.data), 420);
  return <p className="cur-cmp__text">{text ? <span translate="no">{text}</span> : <span className="muted">No text to show.</span>}</p>;
}

function SubmissionColumn({ submission, item, contributor, baseName }: { submission: Submission; item: Item; contributor: string; baseName: string }) {
  const kind = suggestedKind(submission.contribution, item);
  return (
    <div className="cur-cmp__col">
      <div className="t-label">Submission</div>
      <div className="row gap-8">
        <FileIcon name={item.document?.fileName} mime={item.document?.mimeType} />
        <span className="medium cur-cmp__name" translate="no">
          {item.displayName}
        </span>
      </div>
      <Excerpt item={item} />
      <KeyValue
        pairs={[
          ["Type", RESOURCE_KINDS[kind]?.label ?? kind],
          ["Knowledge base", baseName || "—"],
          ["Contributor", contributor || "—"],
          ["Submitted", fmtDateTime(submission.contribution.createTime)],
          ["Size", fmtSize(item.document?.sizeBytes)],
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
