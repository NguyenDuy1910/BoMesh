"use client";

import { Drawer } from "@heroui/react";
import { Layers } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { WorkspaceMark } from "@/components/ui";
import type { Schema } from "@/lib/api/client";

/** Every platform page is a proposal on top of the API; each header carries one Preview chip (SCREEN_INVENTORY). */
export const PREVIEW_TIP = "The platform console is a design proposal; some numbers the preview shows aren’t in the API yet.";

/**
 * Filters, tabs and open drawers live in the query string (`?q=&status=&open=`), like the preview's
 * hash routes. `set` merges a patch (empty values are removed) and applies it at once: the pending
 * query is kept locally until the router catches up, so typing into a search field never drops keys.
 */
export function useUrlState() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const current = params.toString();
  const [pending, setPending] = useState<string | null>(null);
  const latest = useRef(current);
  useEffect(() => {
    // Navigation from elsewhere (links, back/forward) wins only when no local write is in flight.
    if (pending === null || pending === current) {
      latest.current = current;
      setPending(null);
    }
  }, [current, pending]);
  const effective = new URLSearchParams(pending ?? current);
  const get = (key: string) => effective.get(key) ?? "";
  const set = (patch: Record<string, string | null | undefined>) => {
    const next = new URLSearchParams(latest.current);
    for (const [key, value] of Object.entries(patch)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    const query = next.toString();
    latest.current = query;
    setPending(query);
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  };
  return { get, set };
}

/** Workspace web address as shown in the console (preview `wsUrl`). */
export function workspaceUrl(w: Pick<Schema<"Workspace">, "code">): string {
  const host = typeof window === "undefined" ? "bomesh.app" : window.location.host;
  return `${host}/${w.code ?? ""}`;
}

/** Preview `wsCell`: mark + name, or the platform marker when the row belongs to no workspace. */
export function WsCell({ workspace, size = 20, platform = "Platform" }: { workspace?: Schema<"Workspace"> | null; size?: number; platform?: string }) {
  if (!workspace) {
    return (
      <span className="row gap-8">
        <span className="pf-plat">
          <Layers className="i i-xs" aria-hidden />
        </span>
        <span className="muted">{platform}</span>
      </span>
    );
  }
  return (
    <span className="row gap-8 pix-min">
      <WorkspaceMark name={workspace.displayName ?? ""} size={size} />
      <span className="truncate" translate="no">
        {workspace.displayName}
      </span>
    </span>
  );
}

export interface PlatformDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  title: ReactNode;
  lead?: ReactNode;
  description?: ReactNode;
  footerStart?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
}

/** Right-side drawer with the preview's anatomy: lead mark, title, description, body sections, split footer. */
export function PlatformDrawer({ isOpen, onClose, title, lead, description, footerStart, footer, children }: PlatformDrawerProps) {
  return (
    <Drawer.Backdrop isOpen={isOpen} onOpenChange={(open) => !open && onClose()}>
      <Drawer.Content placement="right">
        <Drawer.Dialog>
          <Drawer.CloseTrigger aria-label="Close" />
          <Drawer.Header>
            <div className="row gap-12">
              {lead}
              <div className="grow">
                <Drawer.Heading>{title}</Drawer.Heading>
                {description ? <p className="drawer__description">{description}</p> : null}
              </div>
            </div>
          </Drawer.Header>
          <Drawer.Body>{children}</Drawer.Body>
          {footer || footerStart ? (
            <Drawer.Footer>
              {footerStart ? <div className="drawer__footer-start row gap-8">{footerStart}</div> : null}
              {footer}
            </Drawer.Footer>
          ) : null}
        </Drawer.Dialog>
      </Drawer.Content>
    </Drawer.Backdrop>
  );
}

/** Saves text as a file the browser downloads (client-side CSV of what the page shows). */
export function saveFile(filename: string, content: string, type = "text/csv;charset=utf-8") {
  const url = URL.createObjectURL(new Blob(["\ufeff", content], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Opens a signed download URI (server exports). */
export function openDownload(uri: string) {
  const a = document.createElement("a");
  a.href = uri;
  a.rel = "noopener";
  a.click();
}
