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
import { SearchInput } from "@/components/ui/SearchInput";
import { Segmented } from "@/components/ui/Segmented";
import { SkeletonRows } from "@/components/ui/SkeletonRows";
import { useWorkspace } from "@/lib/workspace";

import { openContribute } from "../../components/Contribute";
import { LifecycleChip } from "../../components/LifecycleChip";
import { ResDot } from "../../components/ResourceRow";
import { fold, tokens } from "../../model";
import { useMyContributions } from "../../queries";
import { CTB_GROUPS, eventLine, PUBLISHED_KEYS, type ContributionGroup } from "../contributions";
import { useContributionActions, useRemovingContributions } from "../useContributionActions";
import { useContributionViews, type ContributionView } from "../useContributionViews";
import { ContributionDrawer } from "./ContributionDrawer";

/** Contributions: what you shared, where it stands, what to do next (preview `contributionsTab`). `?open=<id>` opens one. */
export function ContributionsTab() {
  const { can } = useWorkspace();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const query = useMyContributions({ view: "FULL" });
  const removing = useRemovingContributions();
  const actions = useContributionActions();
  const [seg, setSeg] = useState<ContributionGroup>("all");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<{ id: string; revise?: boolean } | null>(null);

  // ?open=<id> (Inbox, Reader "Track") opens that contribution once, then leaves the address clean.
  const requested = params.get("open");
  useEffect(() => {
    if (!requested) return;
    setOpen({ id: requested });
    const next = new URLSearchParams(params.toString());
    next.delete("open");
    router.replace(`${pathname}?${next.toString()}`, { scroll: false });
  }, [requested, params, pathname, router]);

  const list = useMemo(() => (query.data ?? []).filter((c) => c.state !== "WITHDRAWN" && !removing.has(c.name ?? "")), [query.data, removing]);
  const views = useContributionViews(list);
  const all = useMemo(() => list.map(views.view), [list, views.view]);

  const contribute = can("contributions.create") ? (
    <Button variant="primary" onPress={() => openContribute()}>
      <Upload className="i" aria-hidden />
      Contribute
    </Button>
  ) : null;

  const drawer = open ? <ContributionDrawer key={open.id} id={open.id} focusRevise={open.revise} onClose={() => setOpen(null)} /> : null;

  if (query.isError && !query.data) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  if (query.isPending || (views.isPending && list.length && !all.some((v) => v.candidate || v.revised))) {
    return (
      <>
        <SkeletonRows rows={4} />
        {drawer}
      </>
    );
  }
  if (!all.length) {
    return (
      <>
        <EmptyState icon={Upload} title="No contributions yet" description="Share a document with your team. A reviewer checks it before it’s published." actions={contribute} boxed />
        {drawer}
      </>
    );
  }

  const inGroup = (v: ContributionView, id: ContributionGroup) => {
    const keys = CTB_GROUPS.find((g) => g[0] === id)?.[2];
    return !keys || keys.includes(v.life);
  };
  const needs = all.filter((v) => inGroup(v, "changes")).length;
  const words = tokens(q);
  const rows = all.filter((v) => inGroup(v, seg) && words.every((w) => fold(`${v.title} ${v.base}`).includes(w)));

  const action = (v: ContributionView) => {
    switch (v.life) {
      case "changes":
        return (
          <Button size="sm" variant="secondary" onPress={() => setOpen({ id: v.id, revise: true })}>
            <Pencil className="i" aria-hidden />
            Revise
          </Button>
        );
      case "review":
        return (
          <Button size="sm" variant="ghost" onPress={() => void actions.withdraw(v)}>
            Withdraw
          </Button>
        );
      case "rejected":
        return (
          <Button size="sm" variant="ghost" onPress={() => actions.remove(v)}>
            Remove
          </Button>
        );
      default:
        return PUBLISHED_KEYS.includes(v.life) && v.published ? (
          <Button size="sm" variant="ghost" onPress={() => router.push(`/doc/${v.published?.name?.split("/").pop()}`)}>
            Open
          </Button>
        ) : null;
    }
  };

  return (
    <>
      <div className="toolbar lib-ctb-bar">
        <div className="lib-ctb-seg">
          <Segmented
            value={seg}
            label="Show"
            onChange={setSeg}
            options={CTB_GROUPS.map(([id, label]) => ({ value: id, label: id === "changes" && needs ? `${label} (${needs})` : label }))}
          />
        </div>
        <SearchInput value={q} onChange={setQ} placeholder="Search contributions" />
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
                  <span className="lib-ctb__kb" translate="no">
                    {v.base || "—"}
                  </span>
                  <ResDot />
                  <span className="truncate">{eventLine(v.contribution, v.ctx)}</span>
                </span>
              }
              actions={action(v)}
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
      {drawer}
    </>
  );
}
