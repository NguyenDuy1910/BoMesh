"use client";

import { Button } from "@heroui/react";
import { Pencil, Upload } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { FileIcon } from "@/components/ui/FileIcon";
import { List, ListItem } from "@/components/ui/List";
import { NoMatches } from "@/components/ui/NoMatches";
import { Page } from "@/components/ui/Page";
import { PageHeader } from "@/components/ui/PageHeader";
import { SearchInput } from "@/components/ui/SearchInput";
import { Segmented } from "@/components/ui/Segmented";
import { SkeletonRows } from "@/components/ui/SkeletonRows";
import { fmtNum } from "@/lib/format";
import { useMessages } from "@/lib/i18n";
import { useWorkspace } from "@/lib/workspace";

import { ContributeButton } from "../../components/KnowledgeHeader";
import { LifecycleChip } from "../../components/LifecycleChip";
import { ResDot } from "../../components/ResourceRow";
import { fold, tokens } from "../../model";
import { useMyContributions } from "../../queries";
import { CTB_GROUPS, eventLine, type ContributionGroup } from "../contributions";
import { useRemovingContributions } from "../useContributionActions";
import { useContributionViews, type ContributionView } from "../useContributionViews";
import { ContributionDrawer } from "./ContributionDrawer";
import { needsTools } from "./parts";

/**
 * My contributions (`/contributions`, preview `P.contributions`): what the member shared, where it stands and
 * what to do next. `?open=<id>` (Home, the bell, the Reader, the submit toast) opens that contribution once.
 */
export function ContributionsPage() {
  const { can } = useWorkspace();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const query = useMyContributions({ view: "FULL" });
  const removing = useRemovingContributions();
  const [seg, setSeg] = useState<ContributionGroup>("all");
  const m = useMessages();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<{ id: string; revise?: boolean } | null>(null);
  const canContribute = can("contributions.create");

  // ?open=<id> opens that contribution once, then leaves the address clean.
  const requested = params.get("open");
  useEffect(() => {
    if (!requested) return;
    setOpen({ id: requested });
    const next = new URLSearchParams(params.toString());
    next.delete("open");
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }, [requested, params, pathname, router]);

  const list = useMemo(() => (query.data ?? []).filter((c) => c.state !== "WITHDRAWN" && !removing.has(c.name ?? "")), [query.data, removing]);
  const views = useContributionViews(list);
  const all = useMemo(() => list.map(views.view), [list, views.view]);

  const drawer = open ? <ContributionDrawer key={open.id} id={open.id} focusRevise={open.revise} onClose={() => setOpen(null)} /> : null;
  const inGroup = (v: ContributionView, keys: readonly string[] | null) => !keys || keys.includes(v.life);

  let body;
  if (query.isError && !query.data) body = <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  else if (query.isPending || (views.isPending && list.length && !all.some((v) => v.candidate || v.revised))) body = <SkeletonRows rows={4} />;
  else if (!all.length) {
    body = (
      <EmptyState
        icon={Upload}
        title="No contributions yet"
        description={
          canContribute
            ? "Share a document with your team. You check what the assistant suggests, then a reviewer publishes it."
            : "Documents you share with your team show up here, with where they stand."
        }
        boxed
      />
    );
  } else {
    const group = CTB_GROUPS.find((g) => g[0] === seg) ?? CTB_GROUPS[0];
    const words = tokens(q);
    const rows = all.filter((v) => inGroup(v, group[1]) && words.every((w) => fold(`${v.title} ${v.base}`).includes(w)));
    // One filter per state a contribution can be in (counts only where there is something); search earns its place on a long list.
    const options = CTB_GROUPS.map(([id, keys]) => {
      const n = keys ? all.filter((v) => inGroup(v, keys)).length : 0;
      const label = m.knowledge.contributionGroups[id];
      return { value: id, label: n ? `${label} · ${fmtNum(n)}` : label };
    });
    body = (
      <>
        <div className="toolbar lib-bar">
          <div className="lib-ctb-seg">
            <Segmented value={seg} label="Show" onChange={setSeg} options={options} />
          </div>
          {needsTools(all.length, q) ? <SearchInput value={q} onChange={setQ} placeholder="Search contributions" /> : null}
        </div>
        {rows.length ? (
          <List className="lib-list">
            {rows.map((v) => (
              <ListItem
                key={v.id}
                className="lib-ctb"
                lead={<FileIcon name={v.fileName} mime={v.mime} />}
                title={v.title}
                contentTitle
                titleExtra={<LifecycleChip lifecycle={v.life} size="sm" />}
                description={
                  <span className="lib-ctb__desc">
                    {/* No collection yet (the assistant suggests one): the event says where it stands. */}
                    {v.base ? (
                      <>
                        <span className="lib-ctb__kb" translate="no">
                          {v.base}
                        </span>
                        <ResDot />
                      </>
                    ) : null}
                    <span className="truncate">{eventLine(v.contribution, v.ctx)}</span>
                  </span>
                }
                // The one row action, only when it waits on the member; everything else is in its panel.
                actions={
                  v.life === "changes" ? (
                    <Button size="sm" variant="secondary" onPress={() => setOpen({ id: v.id, revise: true })}>
                      <Pencil className="i" aria-hidden />
                      Revise
                    </Button>
                  ) : null
                }
                onPress={() => setOpen({ id: v.id })}
              />
            ))}
          </List>
        ) : (
          <NoMatches
            what="contributions"
            onClear={() => {
              setQ("");
              setSeg("all");
            }}
          />
        )}
      </>
    );
  }

  return (
    <Page width="wide" className="lib">
      <PageHeader title={m.nav.myContributions} actions={canContribute ? <ContributeButton variant="primary" /> : null} />
      {body}
      {drawer}
    </Page>
  );
}
