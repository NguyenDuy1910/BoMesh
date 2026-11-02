"use client";

import { Cpu, FileText, Layers, Search, Sparkles } from "lucide-react";

import { Page } from "@/components/shell/Page";
import { Callout } from "@/components/ui/Callout";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { PageHeader } from "@/components/ui/PageHeader";
import { PreviewTag } from "@/components/ui/PreviewTag";
import { SkeletonRows } from "@/components/ui/Skeleton";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { usePendingFeature } from "@/lib/api/pending";
import { listPlatformCapabilities, type PlatformCapability, type PlatformCapabilityKey } from "@/modules/platform/api";
import { RowList, RowListItem } from "@/modules/platform/components/Facts";
import { formatDateTime, formatRelative } from "@/lib/format";
import { useApiData } from "@/lib/hooks/useApiData";

const ICON: Record<PlatformCapabilityKey, React.ReactNode> = {
  chat: <Sparkles aria-hidden="true" className="size-4" />,
  embeddings: <Search aria-hidden="true" className="size-4" />,
  vision_parsing: <FileText aria-hidden="true" className="size-4" />,
  contextualization: <Layers aria-hidden="true" className="size-4" />,
};

/** What a person notices when a capability is not working, by capability. */
const IMPACT: Record<PlatformCapabilityKey, { degraded: string; down: string }> = {
  chat: {
    degraded: "Answers take longer than usual to start.",
    down: "The assistant can’t write answers until this is fixed.",
  },
  embeddings: {
    degraded: "Search is slower and new documents take longer to become searchable.",
    down: "New documents can’t be made searchable, and searching knowledge may fail.",
  },
  vision_parsing: {
    degraded: "New documents wait longer before they’re searchable.",
    down: "Scanned pages and complex layouts can’t be read.",
  },
  contextualization: {
    degraded: "New documents take longer to index.",
    down: "Passages are indexed without their surrounding context.",
  },
};

/**
 * Platform → AI capabilities: what powers answers and document reading, and
 * whether it works. Read-only by design: models are a deployment setting, so
 * the screen names the setting instead of offering a switch that would not hold.
 */
export function PlatformCapabilitiesPage() {
  const enabled = usePendingFeature("platform.capabilities");
  const query = useApiData(() => (enabled ? listPlatformCapabilities() : Promise.resolve([])), String(enabled));

  if (!enabled) {
    return (
      <Page>
        <PageHeader sub="What powers answers and document reading." title="AI capabilities" />
        <EmptyState
          description="Capability status isn’t part of this deployment yet."
          icon={<Cpu aria-hidden="true" />}
          title="AI capabilities aren’t available here"
        />
      </Page>
    );
  }

  return (
    <Page>
      <PageHeader sub="What powers answers and document reading." title="AI capabilities" titleExtra={<PreviewTag />} />
      <Callout className="mb-4" tone="info">Models are chosen in the deployment configuration. Changes need a restart.</Callout>
      {query.error ? (
        <ErrorState onAction={query.reload} />
      ) : !query.data ? (
        <SkeletonRows columns={3} label="Loading AI capabilities" rows={4} />
      ) : !query.data.length ? (
        <EmptyState
          boxed
          description="Set the models in the deployment configuration, then restart."
          icon={<Cpu aria-hidden="true" />}
          title="No AI capabilities configured"
        />
      ) : (
        <RowList label="AI capabilities">
          {query.data.map((capability) => <CapabilityRow capability={capability} key={capability.key} />)}
        </RowList>
      )}
    </Page>
  );
}

function CapabilityRow({ capability }: { capability: PlatformCapability }) {
  const impact = capability.status === "degraded" || capability.status === "down" ? IMPACT[capability.key][capability.status] : null;
  return (
    <RowListItem className="flex-wrap items-start">
      <span aria-hidden="true" className="grid size-7 shrink-0 place-items-center rounded-md bg-surface-inset text-text-secondary">
        {ICON[capability.key]}
      </span>
      <div className="min-w-0 flex-1">
        <h2 className="font-medium text-text-primary">{capability.name}</h2>
        <p className="text-[0.84375rem] text-text-secondary">{capability.description}</p>
        <p className="mt-1 text-caption text-text-tertiary">
          Set by <code className="rounded-xs bg-surface-inset px-1.5 py-px font-mono text-[0.71875rem] text-text-secondary">{capability.setting}</code>
          {capability.model && <> · Using <span className="font-mono text-text-secondary">{capability.model}</span></>}
        </p>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1">
        <StatusBadge kind="service" value={capability.status} />
        {capability.checked_at && (
          <span className="text-meta text-text-tertiary" title={formatDateTime(capability.checked_at)}>
            Checked {formatRelative(capability.checked_at)}
          </span>
        )}
      </div>
      {impact && (
        <div className="basis-full pl-10">
          <Callout title={capability.status === "down" ? "Not working" : "Slower than usual"} tone={capability.status === "down" ? "err" : "warn"}>
            {impact}
          </Callout>
        </div>
      )}
    </RowListItem>
  );
}
