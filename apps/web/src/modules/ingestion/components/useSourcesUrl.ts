"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback } from "react";

/**
 * The Sources page's addressable state. Every overlay is a link, so a toast,
 * the inbox, the overview or another page can open exactly it:
 *
 * - `?source=<id>` the source drawer (`&edit=schedule` opens its schedule editor), `?run=<id>` the sync detail drawer
 * - `?reconnect=<connection_id>` the reconnect dialog
 * - `?tab=accounts&connection=<id>` an account, highlighted
 * - `?tab=history&history_source=<id>` sync history for one source
 *
 * The tab itself is read and written by `useTabParam`.
 */
export function useSourcesUrl() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const update = useCallback(
    (patch: Record<string, string | null>) => {
      const next = new URLSearchParams(params.toString());
      for (const [key, value] of Object.entries(patch)) {
        if (value) next.set(key, value);
        else next.delete(key);
      }
      if (next.get("tab") === "sources") next.delete("tab");
      const query = next.toString();
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
    },
    [params, pathname, router],
  );

  return {
    source: params.get("source"),
    run: params.get("run"),
    connect: params.get("connect") === "1",
    collection: params.get("collection"),
    reconnect: params.get("reconnect"),
    connection: params.get("connection"),
    historySource: params.get("history_source"),
    editSchedule: params.get("edit") === "schedule",
    update,
  };
}
