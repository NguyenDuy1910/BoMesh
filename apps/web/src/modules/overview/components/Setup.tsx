"use client";

import clsx from "clsx";
import { List as ListIcon } from "lucide-react";
import type { ReactNode } from "react";

import { useWorkspace } from "@/lib/workspace";
import { LinkButton } from "@/modules/curation/components/parts";
import { AddSourceButton } from "@/modules/ingestion";

import type { WorkspaceOverview } from "../api";
import { useHasTopics, useSources } from "../queries";
import type { Attn } from "./Attention";

export interface SetupStep {
  id: "collections" | "taxonomy" | "sources" | "sync";
  done: boolean;
  title: string;
  desc: string;
  cta: ReactNode;
}

/**
 * The first-time order (preview `setupSteps()` in curation.js): one step per Studio setup section, then the first sync.
 * `steps` is undefined until every input has loaded, or when the caller isn't a workspace admin.
 */
export function useSetupSteps(overview: WorkspaceOverview | undefined): SetupStep[] | undefined {
  const { can } = useWorkspace();
  const admin = can("workspaces.updateSettings") && can("topics.update") && can("sources.create");
  const sources = useSources();
  const topics = useHasTopics({ enabled: admin });
  if (!admin || !overview || !sources.data || topics.data === undefined) return undefined;
  const collections = (overview.kpis?.find((k) => k.key === "rootCollections")?.value ?? 0) > 0;
  const synced = sources.data.some((s) => Boolean(s.lastSync?.endTime) || s.lastSync?.state === "SUCCEEDED");
  return [
    {
      id: "collections",
      done: collections,
      title: "Create collections",
      desc: "Where documents live and who can read them. Make one per access boundary — a team, a function, the whole company.",
      cta: (
        <LinkButton href="/studio?tab=collections&new=1" variant="secondary">
          New collection
        </LinkButton>
      ),
    },
    {
      id: "taxonomy",
      done: topics.data,
      title: "Load the taxonomy",
      desc: "The domains and topics documents are filed under, with the words that recognise them. Import them before the first sync, so every document is classified as it arrives.",
      cta: (
        <LinkButton href="/studio?tab=taxonomy&import=1" variant="secondary">
          Import taxonomy
        </LinkButton>
      ),
    },
    {
      id: "sources",
      done: sources.data.length > 0,
      title: "Add sources",
      desc: "Pick the folders, the collection they land in, how often they sync and how documents are published.",
      cta: <AddSourceButton variant="secondary" size="sm" />,
    },
    {
      id: "sync",
      done: synced,
      title: "Check the first sync",
      desc: "Watch it read, classify and publish. Review what the assistant wasn’t sure about, then let the schedule take over.",
      cta: (
        <LinkButton href="/studio?tab=sources" variant="secondary">
          Open Sources
        </LinkButton>
      ),
    },
  ];
}

/** Nothing set up yet: the full checklist is the page (preview `X.setupGuide`). */
export const isFreshWorkspace = (steps: SetupStep[] | undefined) => Boolean(steps && steps.every((s) => !s.done));

/** The next unfinished step as one Needs attention row once anything is done (preview `X.setupNext`). */
export function setupNext(steps: SetupStep[] | undefined): Attn | null {
  if (!steps) return null;
  const left = steps.filter((s) => !s.done);
  if (!left.length || left.length === steps.length) return null;
  const s = left[0];
  return { id: "setup", tone: "accent", icon: ListIcon, title: s.title, desc: s.desc, actions: s.cta };
}

/** The setup checklist (preview `X.setupGuide`): numbered steps, the next one carries its action. */
export function SetupGuide({ steps }: { steps: SetupStep[] }) {
  const next = steps.find((s) => !s.done);
  return (
    <section className="setup card" aria-label="Set up knowledge">
      <div className="setup__head">
        <h2 className="setup__heading grow">Set up knowledge</h2>
      </div>
      <ol className="setup__steps">
        {steps.map((s, i) => (
          <li key={s.id} className={clsx("setup__step", s === next && "is-next")}>
            <span className="setup__num" aria-hidden>
              {i + 1}
            </span>
            <div className="grow">
              <div className="setup__title">{s.title}</div>
              <p className="setup__desc">{s.desc}</p>
            </div>
            {s === next ? s.cta : null}
          </li>
        ))}
      </ol>
    </section>
  );
}
