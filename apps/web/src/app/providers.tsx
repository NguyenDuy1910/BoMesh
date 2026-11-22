"use client";

import { I18nProvider, RouterProvider } from "@heroui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";

import { ConfirmHost } from "@/components/ui/Confirm";
import { ToastHost } from "@/components/ui/Toast";
import { localeOf } from "@/i18n/messages";
import { ApiError } from "@/lib/api/client";
import { startLocalizer, useLanguage } from "@/lib/i18n";
import { sessionTransition, watchSession } from "@/lib/session";
import { applyTheme } from "@/lib/theme";

/** 4xx answers are final; only transient failures are retried. */
function shouldRetry(failureCount: number, error: unknown): boolean {
  if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false;
  return failureCount < 2;
}

export function Providers({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [language] = useLanguage();
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { retry: shouldRetry, refetchOnWindowFocus: false, staleTime: 30_000 },
          mutations: { retry: false },
        },
      }),
  );

  useEffect(() => {
    // The boot script painted the stored appearance; this loads its font and starts the DOM localizer.
    applyTheme();
    startLocalizer();
  }, []);

  // Caches follow the session, synchronously before the shell re-renders (lib/session.ts `watchSession`): an expired
  // session keeps every result on screen and only stops in-flight requests; the same person signing in again refetches
  // what is shown; another account or Sign out drops the previous user's data (the gate has left the page by then).
  useEffect(
    () =>
      watchSession((prev, next) => {
        const change = sessionTransition(prev, next);
        if (change === "expired") void queryClient.cancelQueries();
        else if (change === "renewed") void queryClient.invalidateQueries();
        else if (change === "switched" || change === "ended") {
          void queryClient.cancelQueries();
          queryClient.clear();
        }
      }),
    [queryClient],
  );

  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider navigate={(href) => router.push(href)}>
        <I18nProvider locale={localeOf(language)}>
          {children}
          <ToastHost />
          <ConfirmHost />
        </I18nProvider>
      </RouterProvider>
    </QueryClientProvider>
  );
}
