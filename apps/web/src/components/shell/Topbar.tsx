"use client";

import { Breadcrumbs, Button, Separator, Tooltip } from "@heroui/react";
import { ChevronRight, PanelLeft } from "lucide-react";

import type { RouteInfo } from "@/lib/navigation";

import { usePageChrome } from "./page-chrome";

/** Sidebar toggle, breadcrumbs (the page's, else the route title) and page actions (preview `topbar()`). */
export function Topbar({ route, onToggleNav }: { route: RouteInfo; onToggleNav: () => void }) {
  const chrome = usePageChrome();
  const crumbs = chrome.crumbs?.length ? chrome.crumbs : [{ label: route.title }];
  return (
    <header className="topbar">
      <Tooltip>
        <Button isIconOnly size="sm" variant="ghost" className="button--muted" aria-label="Toggle sidebar" onPress={onToggleNav}>
          <PanelLeft className="i" aria-hidden />
        </Button>
        <Tooltip.Content>Toggle sidebar</Tooltip.Content>
      </Tooltip>
      <Separator orientation="vertical" style={{ height: 16, alignSelf: "center" }} />
      <Breadcrumbs aria-label="Breadcrumb" separator={<ChevronRight className="i" aria-hidden />}>
        {crumbs.map((c, i) => {
          const last = i === crumbs.length - 1;
          return (
            <Breadcrumbs.Item key={`${i}:${c.label}`} href={last ? undefined : c.href} className={last ? "truncate" : undefined}>
              {c.label}
            </Breadcrumbs.Item>
          );
        })}
      </Breadcrumbs>
      <div className="topbar__end" id="topbar-end">
        {chrome.actions}
      </div>
    </header>
  );
}
