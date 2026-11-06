"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useCallback } from "react";

import { confirm, toast } from "@/components/ui";
import { errorMessage, resourceId } from "@/lib/api/client";
import { useWorkspace } from "@/lib/workspace";
import {
  commitArtifact,
  createArtifact,
  deleteArtifact,
  exportArtifact,
  operationArtifact,
  reviseArtifact,
  saveFile,
  undeleteArtifact,
  updateArtifact,
  waitForOperation,
  type ReviseArtifactRequest,
} from "@/modules/artifacts/api";
import { MIME } from "@/modules/artifacts/model";
import { artifactKeys } from "@/modules/artifacts/queries";

import { kindMeta } from "./kinds";
import { dropRecipe, saveRecipe, type Artifact, type Recipe } from "./model";

export type DownloadFormat = "word" | "pdf" | "markdown" | "csv";
const EXPORT_MIME: Record<DownloadFormat, (typeof MIME)[keyof typeof MIME]> = {
  word: MIME.docx,
  pdf: MIME.pdf,
  markdown: MIME.markdown,
  csv: MIME.csv,
};

/** Starts a generation (CreateArtifact) and lands on its page; says so when it finishes elsewhere. */
export function useStartWork() {
  const { id } = useWorkspace();
  const qc = useQueryClient();
  const router = useRouter();

  return useCallback(
    async (recipe: Recipe, { replace = false }: { replace?: boolean } = {}): Promise<string> => {
      const space = recipe.space ? (recipe.space.includes("/") ? recipe.space : `workspaces/${id}/spaces/${recipe.space}`) : undefined;
      const op = await createArtifact(id, {
        kind: recipe.kind,
        displayName: recipe.title,
        space,
        audience: "PRIVATE",
        sourceItems: recipe.sources,
        generationInstructions: recipe.instructions,
        evidenceReview: recipe.kind === "EVIDENCE_REVIEW" ? { options: recipe.options ?? [], criteria: recipe.criteria ?? [] } : undefined,
      });
      const name = operationArtifact(op) ?? "";
      const artifact = resourceId(name);
      saveRecipe(name, { ...recipe, space, operation: op.name });
      void qc.invalidateQueries({ queryKey: artifactKeys.all(id) });
      if (replace) router.replace(`/work/${artifact}`);
      else router.push(`/work/${artifact}`);
      void waitForOperation(op)
        .then((done) => {
          void qc.invalidateQueries({ queryKey: artifactKeys.all(id) });
          /* The starting page has usually unmounted by now: read where the person is at completion. */
          if (window.location.pathname === `/work/${artifact}` || done.error) return;
          toast(`“${recipe.title}” is ready`, { action: { label: "Open", onPress: () => router.push(`/work/${artifact}`) } });
        })
        .catch(() => undefined);
      return artifact;
    },
    [id, qc, router],
  );
}

/** What a work page can do to its artifact. */
export interface WorkActions {
  patch: (change: Artifact, mask: string[]) => Promise<Artifact>;
  /** Puts `next` in the cache (when given) and refreshes every artifact query. */
  refresh: (next?: Artifact) => void;
  rename: (title: string) => Promise<void>;
  setAudience: (audience: "SPACE" | "PRIVATE", message: string, options?: { undo?: boolean }) => Promise<boolean>;
  remove: () => Promise<void>;
  discard: () => Promise<void>;
  download: (format: DownloadFormat) => Promise<void>;
  revise: (body: ReviseArtifactRequest, options?: { failure?: string }) => Promise<boolean>;
  commit: (text: string, changeSummary: string) => Promise<Artifact>;
}

/** Rename, share, delete, download, revise and commit one piece of work. */
export function useWorkActions(artifact: Artifact): WorkActions {
  const { id } = useWorkspace();
  const qc = useQueryClient();
  const router = useRouter();
  const key = resourceId(artifact.name);
  const label = kindMeta(artifact.kind).label;

  const refresh = useCallback(
    (next?: Artifact) => {
      if (next) qc.setQueryData(artifactKeys.one(id, key), next);
      void qc.invalidateQueries({ queryKey: artifactKeys.all(id) });
    },
    [id, key, qc],
  );

  const patch = useCallback(
    async (change: Artifact, mask: string[]) => {
      const next = await updateArtifact(id, key, change, mask);
      refresh(next);
      return next;
    },
    [id, key, refresh],
  );

  const rename = useCallback(
    async (title: string) => {
      const prev = artifact.displayName ?? "";
      try {
        await patch({ displayName: title }, ["displayName"]);
        toast("Renamed", { undo: () => void patch({ displayName: prev }, ["displayName"]).catch((e) => toast(errorMessage(e), { tone: "danger" })) });
      } catch (e) {
        toast(errorMessage(e), { tone: "danger" });
      }
    },
    [artifact.displayName, patch],
  );

  /** Share with the space (SPACE) or keep to the owner (PRIVATE); `message` is the toast. */
  const setAudience = useCallback(
    async (audience: "SPACE" | "PRIVATE", message: string, { undo = true }: { undo?: boolean } = {}) => {
      const prev = artifact.audience ?? "PRIVATE";
      try {
        await patch({ audience }, ["audience"]);
        toast(message, undo ? { undo: () => void patch({ audience: prev }, ["audience"]).catch((e) => toast(errorMessage(e), { tone: "danger" })) } : {});
        return true;
      } catch (e) {
        toast(errorMessage(e), { tone: "danger" });
        return false;
      }
    },
    [artifact.audience, patch],
  );

  const remove = useCallback(async () => {
    const published = artifact.kind === "QUIZ" && artifact.audience === "SPACE";
    const ok = await confirm({
      title: `Delete “${artifact.displayName}”?`,
      description: published ? "Students lose access and its results are deleted." : "You can undo this right after.",
      confirmLabel: "Delete",
      tone: "danger",
    });
    if (!ok) return;
    try {
      await deleteArtifact(id, key);
      refresh();
      router.push("/work");
      toast(`Deleted “${artifact.displayName}”`, {
        undo: () =>
          void undeleteArtifact(id, key)
            .then((a) => {
              refresh(a);
              toast("Restored");
            })
            .catch((e) => toast(errorMessage(e), { tone: "danger" })),
      });
    } catch (e) {
      toast(errorMessage(e), { tone: "danger" });
    }
  }, [artifact.audience, artifact.displayName, artifact.kind, id, key, refresh, router]);

  /** Deletes a failed attempt without asking (it holds nothing). */
  const discard = useCallback(async () => {
    await deleteArtifact(id, key).catch(() => undefined);
    if (artifact.name) dropRecipe(artifact.name);
    refresh();
  }, [artifact.name, id, key, refresh]);

  const download = useCallback(
    async (format: DownloadFormat) => {
      try {
        saveFile(await exportArtifact(id, key, EXPORT_MIME[format], { fallbackName: artifact.displayName || label }));
      } catch (e) {
        toast(errorMessage(e), { tone: "danger" });
      }
    },
    [artifact.displayName, id, key, label],
  );

  /**
   * ReviseArtifact, then follow its operation. The artifact shows GENERATING (or its cells
   * GENERATING) meanwhile; a failure is explained in a toast. Resolves true on success.
   */
  const revise = useCallback(
    async (body: ReviseArtifactRequest, { failure = "Couldn’t revise it" }: { failure?: string } = {}): Promise<boolean> => {
      try {
        const op = await reviseArtifact(id, key, body);
        refresh();
        const done = await waitForOperation(op);
        refresh();
        if (done.error) {
          toast(failure, { tone: "danger", description: done.error.message || "The assistant is unavailable right now. Try again later." });
          return false;
        }
        return true;
      } catch (e) {
        refresh();
        toast(errorMessage(e), { tone: "danger" });
        return false;
      }
    },
    [id, key, refresh],
  );

  /** CommitArtifact: a person's edit becomes a new revision. */
  const commit = useCallback(
    async (text: string, changeSummary: string) => {
      const next = await commitArtifact(id, key, { text, changeSummary });
      refresh(next);
      return next;
    },
    [id, key, refresh],
  );

  return { patch, refresh, rename, setAudience, remove, discard, download, revise, commit };
}
