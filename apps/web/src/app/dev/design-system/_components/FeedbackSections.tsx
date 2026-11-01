"use client";

import { FolderOpen, Upload } from "lucide-react";
import { useState } from "react";

import { BarsChart } from "@/components/ui/BarsChart";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { Legend, Meter } from "@/components/ui/Meter";
import { Progress } from "@/components/ui/Progress";
import { PageLoadingSkeleton, Skeleton, SkeletonCards, SkeletonRows } from "@/components/ui/Skeleton";
import { useToast } from "@/components/ui/Toast";

import { Card, Grid, Group, Section, Specimen } from "./kit";

/* A deterministic month of questions per day, so screenshots are stable. */
const QUESTIONS = Array.from({ length: 30 }, (_, index) => ({
  label: index + 6 <= 30 ? `Sep ${index + 6}` : `Oct ${index - 24}`,
  value: 40 + ((index * 37) % 53) + (index % 7 === 5 || index % 7 === 6 ? -28 : 0) + index,
}));

export function FeedbackSection() {
  const toast = useToast();
  return (
    <Section
      description="Callouts for page-level status, toasts to confirm an action, progress for work in flight. Status tones only — never the evidence amber."
      id="feedback"
      title="Feedback"
    >
      <Group title="Callout">
        <div className="grid gap-2">
          <Callout title="Syncing Product Docs space">19 of 28 documents processed.</Callout>
          <Callout title="Everything is running smoothly" tone="ok" />
          <Callout
            actions={
              <Button onClick={() => toast.show({ message: "Retrying 2 documents", tone: "info" })} size="sm" variant="secondary">
                Retry all
              </Button>
            }
            title="2 documents couldn’t be processed"
            tone="warn"
          >
            One is password-protected and one has no readable text.
          </Callout>
          <Callout
            actions={
              <Button onClick={() => toast.show({ message: "Reconnected Google Drive" })} size="sm">
                Reconnect
              </Button>
            }
            title="Sales Enablement stopped syncing"
            tone="err"
          >
            Google Drive access expired.
          </Callout>
          <Callout tone="neutral">Assistant settings apply to new chats. Existing chats keep the settings they started with.</Callout>
        </div>
      </Group>
      <Group title="Progress">
        <Grid cols={2}>
          <Progress label="Syncing People Ops" showLabel value={68} valueText="19 of 28" />
          <Progress label="Preparing upload" showLabel />
          <Progress label="Sync finished" showLabel tone="ok" value={100} />
          <Progress label="Sync stopped with failures" showLabel tone="err" value={42} />
        </Grid>
      </Group>
      <Group title="Meter and legend">
        <Grid cols={2}>
          <Card className="px-4 py-3.5">
            <Meter
              label="Knowledge health"
              segments={[
                { label: "Ready", value: 142, tone: "ok" },
                { label: "Processing", value: 12, tone: "info" },
                { label: "Needs update", value: 6, tone: "warn" },
                { label: "Failed", value: 3, tone: "err" },
                { label: "Not searchable", value: 4, tone: "neutral" },
              ]}
            />
          </Card>
          <Card className="grid gap-3 px-4 py-3.5">
            <Meter
              formatValue={(value) => `${value} GB`}
              label="Storage used"
              legend={false}
              max={50}
              segments={[{ label: "Used", value: 31, tone: "accent" }]}
            />
            <Legend
              items={[
                { label: "Used", tone: "accent", value: "31 GB" },
                { label: "Free", tone: "neutral", value: "19 GB" },
              ]}
            />
          </Card>
        </Grid>
      </Group>
      <Group title="Bars chart · hover a bar">
        <Card className="px-4 py-3.5">
          <BarsChart data={QUESTIONS} label="Questions per day, last 30 days" />
        </Card>
      </Group>
    </Section>
  );
}

export function StatesSection() {
  const [retried, setRetried] = useState(0);
  return (
    <Section
      description="Every data region has all of them. Empty states invite the next action; errors say what to do and offer Retry; loading keeps the layout."
      id="states"
      title="Empty, loading, error"
    >
      <Grid cols={3}>
        <Card>
          <EmptyState
            action={
              <Button icon={<Upload aria-hidden="true" />} size="sm">
                Upload files
              </Button>
            }
            description="Upload files or connect a source."
            icon={<Upload />}
            size="md"
            title="Add your first documents"
          />
        </Card>
        <Card className="p-4">
          <SkeletonRows columns={2} label="Loading documents" rows={3} />
        </Card>
        <Card>
          <ErrorState boxed={false} onAction={() => setRetried((count) => count + 1)} />
        </Card>
      </Grid>
      <Grid className="mt-3" cols={3}>
        <Specimen caption="Empty · small, boxed drop target">
          <EmptyState
            boxed
            description="Drag files here or choose them."
            icon={<FolderOpen />}
            size="sm"
            title="This folder is empty"
          />
        </Specimen>
        <Specimen caption={`Error · inline, inside a form (retried ${retried}×)`}>
          <ErrorState
            description="The members list didn’t load. Nothing was changed."
            layout="inline"
            onAction={() => setRetried((count) => count + 1)}
            title="Couldn’t load members"
          />
        </Specimen>
        <Specimen caption="Skeleton blocks">
          <div className="grid gap-2">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-20 w-full rounded-lg" />
          </div>
        </Specimen>
      </Grid>
      <Grid className="mt-3" cols={2}>
        <Specimen caption="Skeleton cards">
          <SkeletonCards className="lg:grid-cols-2" count={4} label="Loading knowledge bases" />
        </Specimen>
        <Specimen caption="Page skeleton">
          <Card className="p-4">
            <PageLoadingSkeleton controls heading label="Loading page" />
          </Card>
        </Specimen>
      </Grid>
    </Section>
  );
}
