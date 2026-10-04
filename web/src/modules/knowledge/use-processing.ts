"use client";

import { useRouter } from "next/navigation";
import { useCallback } from "react";

import { useToast } from "@/components/ui/Toast";
import { ApiError } from "@/lib/api/request";
import type { IngestionRunCreate } from "@/modules/ingestion/runs-api";
import { runHref } from "@/modules/knowledge/document-facts";
import { knowledgeActions, type UploadOutcome } from "@/modules/knowledge/queries";
import { pluralize } from "@/modules/workspace-control/format";

const ARCHIVE_NAME = /\.zip$/i;

/**
 * Starting processing, and saying what happened, the same way everywhere.
 *
 * Knowledge and Library both upload and both start runs; the words and the
 * follow-up ("View run") must not differ between them.
 */
export function useProcessing() {
  const router = useRouter();
  const { toast } = useToast();

  /** Starts one run; resolves true when it was created. */
  const startRun = useCallback(async (body: IngestionRunCreate) => {
    try {
      const run = await knowledgeActions.process(body);
      toast({
        action: { label: "View run", onClick: () => router.push(runHref(run.id)) },
        title: `Processing ${pluralize(run.counts.total, "document")}`,
        variant: "success",
      });
      return true;
    } catch (cause) {
      // 409: everything selected is already processed or being processed. The
      // API says so in words; nothing went wrong.
      if (cause instanceof ApiError && cause.status === 409) {
        toast({ title: cause.message, variant: "info" });
        return false;
      }
      toast({
        description: cause instanceof Error ? cause.message : undefined,
        title: "Processing couldn’t start",
        variant: "error",
      });
      return false;
    }
  }, [router, toast]);

  /**
   * "N files added", with Run processing for exactly those documents when the
   * caller may start one. Refused files get their own message.
   */
  const announceUpload = useCallback(({ documents, failures }: UploadOutcome, { canProcess }: { canProcess: boolean }) => {
    if (documents.length) {
      const archive = documents.some((document) => ARCHIVE_NAME.test(document.name));
      toast({
        action: canProcess
          ? {
              label: "Run processing",
              onClick: () => void startRun({ document_ids: documents.map((document) => document.id), trigger: "manual" }),
            }
          : undefined,
        description: archive
          ? "An archive’s files are unpacked when it’s processed."
          : `${documents.length === 1 ? "It stays" : "They stay"} pending until processed.`,
        duration: 10_000,
        title: documents.length === 1 ? `${documents[0].name} added` : `${documents.length} files added`,
        variant: "success",
      });
    }
    if (failures.length) {
      toast({
        description: failures.length === 1
          ? failures[0].reason
          : failures.map((failure) => `${failure.name}: ${failure.reason}`).join(" "),
        title: failures.length === 1
          ? `${failures[0].name} couldn’t be added`
          : `${failures.length} files couldn’t be added`,
        variant: "error",
      });
    }
  }, [startRun, toast]);

  return { startRun, announceUpload };
}
