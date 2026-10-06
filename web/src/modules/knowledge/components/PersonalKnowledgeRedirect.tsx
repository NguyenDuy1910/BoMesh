"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

import { Page } from "@/components/shell/Page";
import { ErrorState } from "@/components/ui/ErrorState";
import { PageLoadingSkeleton } from "@/components/ui/Skeleton";
import { knowledgeApi } from "@/modules/knowledge/knowledge-api";

/**
 * `/knowledge/personal`: My files has an id only once the server creates it,
 * so this address makes sure it exists (`PUT /collections/personal`) and
 * replaces itself with the real one, keeping the query (`?action=upload`).
 */
export function PersonalKnowledgeRedirect() {
  const router = useRouter();
  const params = useSearchParams();
  const query = params.toString();
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    setError(null);
    knowledgeApi.ensurePersonalCollection()
      .then(({ id }) => {
        if (active) router.replace(`/knowledge/${encodeURIComponent(id)}${query ? `?${query}` : ""}`);
      })
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : "My files couldn’t be opened.");
      });
    return () => {
      active = false;
    };
  }, [attempt, query, router]);

  return (
    <Page>
      {error ? (
        <ErrorState description={error} onAction={() => setAttempt((value) => value + 1)} title="My files didn’t open" />
      ) : (
        <PageLoadingSkeleton heading label="Opening My files" />
      )}
    </Page>
  );
}
