"use client";

import { FileText, ShieldCheck } from "lucide-react";
import { useState } from "react";

import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { Tag } from "@/components/ui/Tag";
import { STATUS, type StatusKind } from "@/lib/status";

import { Group, Row, Section } from "./kit";

const BADGE_TONES: readonly [BadgeTone, string][] = [
  ["ok", "Ready"],
  ["warn", "Needs update"],
  ["err", "Failed"],
  ["info", "Syncing"],
  ["neutral", "Paused"],
  ["accent", "New"],
  ["outline", "Draft"],
];

/** What each vocabulary describes, in the words a reviewer would use. */
const KIND_LABEL: Record<StatusKind, string> = {
  doc: "Documents",
  source: "Sources",
  account: "Connected accounts",
  run: "Syncs",
  member: "Members",
  request: "Requests",
  outcome: "Activity outcome",
  ws: "Workspaces",
  service: "Services",
  schedule: "Schedules",
  session: "Sign-ins",
};

const KINDS = Object.keys(STATUS) as StatusKind[];

export function StatusSection() {
  const [tags, setTags] = useState(["Finance", "Vietnam", "2026"]);
  return (
    <Section
      description="Text plus colour, never colour alone. Healthy steady states stay quiet: a plain dot and text. Live states pulse only when motion is allowed. Every label comes from lib/status.ts."
      id="status"
      title="Status"
    >
      <Group title="Badge tones">
        <Row label="Pill">
          {BADGE_TONES.map(([tone, label]) => (
            <Badge key={tone} tone={tone}>
              {label}
            </Badge>
          ))}
        </Row>
        <Row label="Variants">
          <Badge tone="info" live>
            Live · Processing
          </Badge>
          <Badge plain tone="ok">
            Plain · Up to date
          </Badge>
          <Badge dot={false} tone="warn">
            No dot
          </Badge>
          <Badge icon={<ShieldCheck aria-hidden="true" className="size-3.5" />} tone="ok">
            With icon
          </Badge>
          <span className="inline-flex items-center gap-2 text-meta text-text-tertiary">
            Dot only
            <Badge dotOnly tone="err">
              Failed
            </Badge>
            <Badge dotOnly tone="ok">
              Ready
            </Badge>
          </span>
        </Row>
      </Group>
      <Group title="Status vocabulary · every kind and value">
        {KINDS.map((kind) => (
          <Row key={kind} label={KIND_LABEL[kind]}>
            {Object.keys(STATUS[kind]).map((value) => (
              <StatusBadge key={value} kind={kind} value={value} />
            ))}
          </Row>
        ))}
        <Row label="Unknown value">
          <StatusBadge kind="doc" value="quarantined_by_admin" />
          <StatusBadge kind="source" value={null} />
          <span className="text-meta text-text-tertiary">Neutral, humanised — never a guessed colour.</span>
        </Row>
      </Group>
      <Group title="Tags · metadata, never status">
        <Row label="Tag">
          <Tag>PDF</Tag>
          <Tag icon={<FileText aria-hidden="true" className="size-3.5" />}>48 pages</Tag>
          <Tag title="Shown in answers">Searchable</Tag>
          {tags.map((tag) => (
            <Tag key={tag} onRemove={() => setTags((current) => current.filter((item) => item !== tag))} removeLabel={`Remove ${tag}`}>
              {tag}
            </Tag>
          ))}
          {tags.length < 3 && (
            <Button onClick={() => setTags(["Finance", "Vietnam", "2026"])} size="sm" variant="link">
              Reset tags
            </Button>
          )}
        </Row>
      </Group>
    </Section>
  );
}
