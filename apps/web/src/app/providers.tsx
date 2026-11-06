"use client";

import { I18nProvider, RouterProvider } from "@heroui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { ConfirmHost } from "@/components/ui/Confirm";
import { ToastHost } from "@/components/ui/Toast";
import { ApiError } from "@/lib/api/client";
import { startLocalizer, useLanguage } from "@/lib/i18n";
import { useSession } from "@/lib/session";
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

  // A session ended (401, expiry, Sign out): the gate has already swapped the app for its redirect in
  // this commit, so stop in-flight requests and drop that user's data without triggering refetches.
  const sessionName = useSession()?.name;
  const previousSession = useRef(sessionName);
  useEffect(() => {
    const ended = previousSession.current && previousSession.current !== sessionName;
    previousSession.current = sessionName;
    if (!ended) return;
    void queryClient.cancelQueries();
    queryClient.clear();
  }, [sessionName, queryClient]);

  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider navigate={(href) => router.push(href)}>
        <I18nProvider locale={language === "vi" ? "vi-VN" : "en-US"}>
          {children}
          <ToastHost />
          <ConfirmHost />
        </I18nProvider>
      </RouterProvider>
    </QueryClientProvider>
  );
}
