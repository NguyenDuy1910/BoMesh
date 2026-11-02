"use client";

import { BookOpen, Sparkles } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Page } from "@/components/shell/Page";
import { ButtonLink } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { PageHeader } from "@/components/ui/PageHeader";
import { PageLoadingSkeleton } from "@/components/ui/Skeleton";
import { TabPanel, Tabs, useTabParam } from "@/components/ui/Tabs";
import { useToast } from "@/components/ui/Toast";
import { usePendingFeature } from "@/lib/api/pending";
import { ApiError } from "@/lib/api/request";
import { invalidateApiData } from "@/lib/api/revision";
import { hasSessionPermission } from "@/lib/auth/session";
import { useAuthSession } from "@/lib/hooks/useAuthSession";
import { useRouteState } from "@/lib/hooks/useRouteState";
import { ingestionRunsApi, type IngestionRun } from "@/modules/ingestion/runs-api";
import {
  forgetUnreadableCollection,
  listLocalDocumentMoves,
  localCollectionGeneralAccess,
  rememberUnreadableCollection,
} from "@/modules/knowledge/api";
import { useArchivedDocuments } from "@/modules/knowledge/archive-queue";
import type { ContractDocument } from "@/modules/knowledge/knowledge-api";
import { accessSummary, applyMoves } from "@/modules/knowledge/model";
import { useCollectionSources, useCollectionView, useDiscoverableCollections, useKnowledgeHome } from "@/modules/knowledge/queries";
import { useWatchedRuns, watchRun, type WatchedRun } from "@/modules/knowledge/run-watch";
import { pluralize } from "@/lib/format";

import { AccessTab } from "./AccessTab";
import { AddContentAction, DocumentsTab } from "./DocumentsTab";
import { AccessBadge } from "./KnowledgeBaseMark";
import { MY_FILES } from "./KnowledgeList";
import { AccessRequestState, RESTRICTED_NAME } from "./RequestAccessDialog";
import { SettingsTab } from "./SettingsTab";
import { SourcesTab } from "./SourcesTab";
import { UploadDialog } from "./UploadDialog";

const TABS = ["documents", "sources", "access", "settings"] as const;
type KbTab = (typeof TABS)[number];
const TAB_LABEL: Record<KbTab, string> = { documents: "Documents", sources: "Sources", access: "Access", settings: "Settings" };

/**
 * One knowledge base: its documents for everyone who can read it, and — by
 * what the caller may do there — its sources, access and settings.
 */
export function KnowledgeBasePage({ collectionId }: { collectionId: string }) {
  const router = useRouter();
  const toast = useToast();
  const session = useAuthSession();
  const workspaceName = session?.workspaces.find((workspace) => workspace.id === session.active_workspace_id)?.name ?? "";
  const generalEnabled = usePendingFeature("collection.general_access");
  const discoveryEnabled = usePendingFeature("collection.discovery");
  const moveEnabled = usePendingFeature("document.move");
  const query = useCollectionView(collectionId);
  const home = useKnowledgeHome();
  const archived = useArchivedDocuments();
  const [missing, setMissing] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [generalVersion, setGeneralVersion] = useState(0);
  const [action, setAction] = useRouteState("action");

  const view = query.data;
  const unavailable = view?.kind === "unavailable";
  const collection = view?.kind === "ready" ? view.collection : null;
  const discovered = useDiscoverableCollections(discoveryEnabled && unavailable);

  // Remember a knowledge base the caller met but cannot read, so Knowledge lists it as locked.
  useEffect(() => {
    if (!discoveryEnabled || !view) return;
    if (view.kind === "unavailable") rememberUnreadableCollection(collectionId);
    else forgetUnreadableCollection(collectionId);
  }, [collectionId, discoveryEnabled, view?.kind]); // eslint-disable-line react-hooks/exhaustive-deps

  const permissions = new Set(collection?.permissions ?? []);
  const personal = Boolean(collection && collection.id === home.data?.personal_collection_id);
  const canEdit = permissions.has("collection.update");
  const canRun = permissions.has("ingestion.run");
  const canShare = permissions.has("collection.share");
  const canDelete = permissions.has("collection.delete");
  const canManageSources = hasSessionPermission(session, "source.manage");
  const canConnect = canManageSources && !personal;
  const title = collection ? (personal ? MY_FILES : collection.title) : "";

  const visibleTabs = useMemo<KbTab[]>(() => {
    if (!collection || personal) return ["documents"];
    return TABS.filter((tab) =>
      tab === "documents"
      || (tab === "sources" && (canEdit || canManageSources))
      || (tab === "access" && canShare)
      || (tab === "settings" && (canEdit || canDelete)));
  }, [canDelete, canEdit, canManageSources, canShare, collection, personal]);
  const [tab, setTab] = useTabParam(visibleTabs, "documents");

  const sources = useCollectionSources(collectionId, visibleTabs.includes("sources"));

  const local = useMemo(
    () => (generalEnabled && collection && !personal ? localCollectionGeneralAccess()[collection.id] : undefined),
    // `generalVersion` moves when this page changes general access in the browser store.
    [collection, generalEnabled, generalVersion, personal], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const general = local?.general_access ?? "restricted";
  const access = accessSummary({ personal, general }, workspaceName);

  const documents = useMemo(() => {
    if (view?.kind !== "ready" || !view.documents) return null;
    const moves = moveEnabled ? listLocalDocumentMoves() : [];
    return applyMoves(collectionId, view.documents, moves).filter((entry) => !archived.has(entry.document.id));
  }, [archived, collectionId, moveEnabled, view]);

  const moveTargets = useMemo(
    () => (home.data?.collections ?? []).filter((candidate) =>
      candidate.id !== collectionId
      && candidate.id !== home.data?.personal_collection_id
      && candidate.permissions.includes("collection.update")),
    [collectionId, home.data],
  );

  // Deep links: `?action=upload` opens the upload dialog for people who can add.
  useEffect(() => {
    if (action !== "upload" || !collection) return;
    if (canEdit) setUploading(true);
    setAction("");
  }, [action, canEdit, collection, setAction]);

  const runFinished = useCallback((watch: WatchedRun, run: IngestionRun) => {
    invalidateApiData();
    const { succeeded, failed } = run.counts;
    const noun = watch.kind === "upload" ? "file" : "document";
    if (run.status === "failed") {
      toast.show({ tone: "err", message: "Processing stopped", description: run.error ?? undefined });
      return;
    }
    if (failed > 0) {
      toast.show({
        tone: "err",
        message: `${succeeded ? `${pluralize(succeeded, noun)} ready. ` : ""}${failed === 1 && watch.singleName ? watch.singleName : pluralize(failed, noun)} couldn’t be processed.`,
        action: { label: "Show", onClick: () => router.replace(`/knowledge/${encodeURIComponent(collectionId)}?status=failed`, { scroll: false }) },
      });
      return;
    }
    if (succeeded > 0) {
      toast.show({ message: succeeded === 1 && watch.singleName ? `${watch.singleName} is ready` : `${pluralize(succeeded, noun)} are ready` });
    }
  }, [collectionId, router, toast]);
  const watching = useWatchedRuns(collectionId, { onProgress: query.reload, onFinished: runFinished });

  /** Start one run over `picked`; resolves true when it was created. */
  const startRun = async (picked: { id: string; name: string }[], kind: WatchedRun["kind"]) => {
    try {
      const run = await ingestionRunsApi.create({ document_ids: picked.map((document) => document.id), trigger: "manual" });
      watchRun({ runId: run.id, collectionId, kind, singleName: picked.length === 1 ? picked[0].name : null });
      query.reload();
      return true;
    } catch (cause) {
      // 409: everything selected is already processing; the API says so in words.
      if (cause instanceof ApiError && cause.status === 409) toast.show({ tone: "info", message: cause.message });
      else toast.show({ tone: "err", message: "Processing couldn’t start", description: cause instanceof Error ? cause.message : undefined });
      return false;
    }
  };

  const process = async (picked: ContractDocument[], kind: "reprocess" | "retry") => {
    const started = await startRun(picked, kind);
    if (started) {
      const subject = picked.length === 1 ? picked[0].name : pluralize(picked.length, "document");
      toast.show({ tone: "info", message: `${kind === "retry" ? "Retrying" : "Reprocessing"} ${subject}` });
    }
    return started;
  };

  const uploaded = async (files: { id: string; name: string }[]) => {
    invalidateApiData();
    setTab("documents");
    const what = pluralize(files.length, "file");
    if (!canRun) {
      toast.show({ message: `Uploaded ${what}`, description: "They’re waiting to be processed." });
      return;
    }
    if (await startRun(files, "upload")) {
      toast.show({ message: `Uploaded ${what}. ${files.length === 1 ? "It’ll" : "They’ll"} be searchable in a few minutes.` });
    }
  };

  const crumbs = [{ label: "Knowledge", href: "/knowledge" }, { label: title || RESTRICTED_NAME }];
  const connectHref = `/manage/sources?connect=1&collection=${encodeURIComponent(collectionId)}`;

  if (query.error && !view) {
    return (
      <Page>
        <PageHeader crumbs={[{ label: "Knowledge", href: "/knowledge" }]} title="Knowledge base" />
        <ErrorState description={query.error} onAction={query.reload} title="This knowledge base didn’t load" />
      </Page>
    );
  }
  if (!view) {
    return (
      <Page>
        <PageLoadingSkeleton controls heading label="Loading knowledge base" />
      </Page>
    );
  }
  if (unavailable || !collection) {
    const known = discovered.data?.find((candidate) => candidate.id === collectionId);
    const name = known?.title ?? null;
    return (
      <Page>
        <PageHeader crumbs={[{ label: "Knowledge", href: "/knowledge" }, { label: name ?? RESTRICTED_NAME }]} title={name ?? RESTRICTED_NAME} />
        {missing ? (
          <EmptyState
            action={<ButtonLink href="/knowledge" variant="primary">Go to Knowledge</ButtonLink>}
            boxed
            description="It may have been archived, or the link is wrong."
            icon={<BookOpen />}
            title="This knowledge base isn’t available"
          />
        ) : (
          <AccessRequestState collectionId={collectionId} collectionName={name} onMissing={() => setMissing(true)} />
        )}
      </Page>
    );
  }

  const documentCount = documents?.length ?? collection.document_count;
  const hasDocuments = documentCount > 0;
  const onDocuments = tab === "documents";
  const ask = (variant: "primary" | "secondary") => (
    <ButtonLink href={`/chat?scope=${encodeURIComponent(collection.id)}`} icon={<Sparkles aria-hidden="true" size={16} />} variant={variant}>
      {variant === "primary" ? "Ask about this knowledge base" : "Ask"}
    </ButtonLink>
  );
  const actions = canEdit ? (
    // On an empty Documents tab the empty state carries the call to action.
    onDocuments && !hasDocuments ? null : (
      <>
        {hasDocuments && ask("secondary")}
        <AddContentAction
          canConnect={canConnect}
          connectHref={connectHref}
          onUpload={() => setUploading(true)}
          variant={onDocuments ? "primary" : "secondary"}
        />
      </>
    )
  ) : hasDocuments ? ask("primary") : null;

  return (
    <Page>
      <PageHeader
        actions={actions}
        crumbs={crumbs}
        sub={personal ? "Only you can see these. Use them in your own chats." : collection.description || undefined}
        title={title}
        titleExtra={<AccessBadge access={access} local={Boolean(local)} pill />}
      />
      {visibleTabs.length > 1 && (
        <Tabs
          activeTab={tab}
          ariaLabel="Knowledge base sections"
          className="mb-5"
          idBase="kb"
          onChange={setTab}
          tabs={visibleTabs.map((id) => ({
            id,
            label: TAB_LABEL[id],
            count: id === "documents" ? documentCount : id === "sources" && sources.data?.length ? sources.data.length : undefined,
          }))}
        />
      )}
      <TabPanel idBase="kb" tab={tab}>
        {tab === "documents" && (
          <DocumentsTab
            access={access}
            collection={collection}
            collectionTitle={title}
            documents={documents}
            documentsError={view.documentsError}
            localAccess={Boolean(local)}
            moveTargets={moveTargets}
            onConnect={() => router.push(connectHref)}
            onProcess={process}
            onRetryLoad={query.reload}
            onUpload={() => setUploading(true)}
            permissions={{ canEdit, canRun, canShare, canConnect }}
            personal={personal}
          />
        )}
        {tab === "sources" && (
          <SourcesTab
            canManage={canManageSources}
            collectionId={collection.id}
            error={sources.error}
            loading={sources.loading}
            onRetry={sources.reload}
            sources={sources.data}
          />
        )}
        {tab === "access" && (
          <AccessTab
            collectionId={collection.id}
            collectionTitle={title}
            generalAccess={general}
            onGeneralAccessChanged={() => setGeneralVersion((value) => value + 1)}
            workspaceName={workspaceName}
          />
        )}
        {tab === "settings" && (
          <SettingsTab
            canDelete={canDelete}
            canEdit={canEdit}
            collection={collection}
            documentCount={documentCount}
            existing={home.data?.collections ?? []}
          />
        )}
      </TabPanel>
      {watching.length > 0 && (
        <p aria-live="polite" className="sr-only">Processing in progress</p>
      )}
      <UploadDialog
        collectionId={collection.id}
        collectionTitle={title}
        onClose={() => setUploading(false)}
        onUploaded={(files) => void uploaded(files)}
        open={uploading}
        personal={personal}
      />
    </Page>
  );
}
