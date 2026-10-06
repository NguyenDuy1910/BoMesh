"use client";

import { Check, Globe, Lock, UserPlus, Users, X } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { PreviewTag } from "@/components/ui/PreviewTag";
import { Select } from "@/components/ui/Select";
import { SkeletonRows } from "@/components/ui/Skeleton";
import { useToast } from "@/components/ui/Toast";
import { usePendingFeature } from "@/lib/api/pending";
import { invalidateApiData } from "@/lib/api/revision";
import { getAuthSession, hasSessionPermission } from "@/lib/auth/session";
import { useAuthSession } from "@/lib/hooks/useAuthSession";
import { decideAccessRequest, requestedRole, requestedVerb, usePendingAccessRequests } from "@/modules/knowledge/access-requests";
import { setCollectionGeneralAccess, type GeneralAccess } from "@/modules/knowledge/api";
import { knowledgeApi, type CollectionGrant, type CollectionRole } from "@/modules/knowledge/knowledge-api";
import { lastOwnerProblem } from "@/modules/knowledge/model";
import { principalKey, useCollectionGrants } from "@/modules/knowledge/queries";
import { formatRelative } from "@/lib/format";

import { PrincipalAvatar, ROLE_OPTIONS, ShareDialog } from "./ShareDialog";

const ROLE_NAME: Record<CollectionRole, string> = { owner: "an owner", editor: "an editor", viewer: "a viewer" };

/**
 * Who can open a knowledge base: the requests waiting for a decision, the
 * general access, and the people and groups it is shared with, each with a
 * role.
 */
export function AccessTab({
  collectionId,
  collectionTitle,
  workspaceName,
  generalAccess,
  onGeneralAccessChanged,
}: {
  collectionId: string;
  collectionTitle: string;
  workspaceName: string;
  generalAccess: GeneralAccess;
  onGeneralAccessChanged: () => void;
}) {
  const toast = useToast();
  const session = useAuthSession();
  const canReview = hasSessionPermission(session, "access.manage");
  const generalEnabled = usePendingFeature("collection.general_access");
  const grants = useCollectionGrants(collectionId, true);
  const requests = usePendingAccessRequests(collectionId, canReview);
  const [sharing, setSharing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ key: string; message: string } | null>(null);
  const [removingSelf, setRemovingSelf] = useState<CollectionGrant | null>(null);
  const [savingGeneral, setSavingGeneral] = useState(false);

  const list = grants.data ?? [];
  const owners = list.filter((grant) => grant.role === "owner").length;
  const nameOf = (grant: CollectionGrant) => grant.principal_name ?? "Someone no longer in the workspace";
  const isMe = (grant: CollectionGrant) => grant.principal_type === "user" && grant.principal_id === getAuthSession()?.user_id;

  const changeRole = async (grant: CollectionGrant, role: CollectionRole) => {
    const key = principalKey(grant);
    const problem = lastOwnerProblem(list, grant, role);
    if (problem) {
      setRowError({ key, message: problem });
      return;
    }
    setRowError(null);
    setBusy(key);
    try {
      await knowledgeApi.setAccess(collectionId, { ...grant, role });
      invalidateApiData();
      toast.show({ message: `${nameOf(grant)} is now ${ROLE_NAME[role]}` });
    } catch (cause) {
      setRowError({ key, message: cause instanceof Error ? cause.message : "The role couldn’t be changed." });
    } finally {
      setBusy(null);
    }
  };

  const remove = async (grant: CollectionGrant) => {
    const key = principalKey(grant);
    setBusy(key);
    try {
      await knowledgeApi.removeAccess(collectionId, grant);
      invalidateApiData();
      toast.show({
        message: `Removed ${nameOf(grant)}`,
        action: {
          label: "Undo",
          onClick: () => {
            void knowledgeApi.setAccess(collectionId, grant).then(
              () => {
                invalidateApiData();
                toast.show({ message: `Restored ${nameOf(grant)}` });
              },
              (cause: unknown) => toast.show({ tone: "err", message: `${nameOf(grant)} couldn’t be restored`, description: cause instanceof Error ? cause.message : undefined }),
            );
          },
        },
      });
    } catch (cause) {
      setRowError({ key, message: cause instanceof Error ? cause.message : "Access couldn’t be removed." });
    } finally {
      setBusy(null);
    }
  };

  const requestRemove = (grant: CollectionGrant) => {
    const problem = lastOwnerProblem(list, grant, null);
    if (problem) {
      setRowError({ key: principalKey(grant), message: problem });
      return;
    }
    setRowError(null);
    if (isMe(grant)) setRemovingSelf(grant);
    else void remove(grant);
  };

  const decide = async (requestId: string, who: string, status: "approved" | "denied") => {
    setBusy(requestId);
    try {
      await decideAccessRequest(requestId, status);
      toast.show({ message: `${status === "approved" ? "Approved" : "Denied"} ${who}` });
    } catch (cause) {
      toast.show({ tone: "err", message: "The request couldn’t be updated", description: cause instanceof Error ? cause.message : undefined });
    } finally {
      setBusy(null);
    }
  };

  const changeGeneral = async (next: GeneralAccess) => {
    setSavingGeneral(true);
    try {
      await setCollectionGeneralAccess(collectionId, { general_access: next });
      onGeneralAccessChanged();
      toast.show({
        message: next === "workspace"
          ? `Everyone in ${workspaceName || "the workspace"} can now view ${collectionTitle}`
          : `Only people added can now view ${collectionTitle}`,
      });
    } catch (cause) {
      toast.show({ tone: "err", message: "General access couldn’t be changed", description: cause instanceof Error ? cause.message : undefined });
    } finally {
      setSavingGeneral(false);
    }
  };

  if (grants.error && !grants.data) return <ErrorState description={grants.error} onAction={grants.reload} title="Access didn’t load" />;
  if (!grants.data) return <SkeletonRows columns={3} label="Loading access" rows={4} />;

  return (
    <div className="grid max-w-[760px] gap-5">
      {(requests.data ?? []).length > 0 && (
        <div className="grid gap-2">
          {requests.data!.map((request) => {
            const who = request.requester.display_name?.trim() || request.requester.email;
            return (
              <Callout
                actions={(
                  <>
                    <Button disabled={busy === request.id} onClick={() => void decide(request.id, who, "denied")} size="sm" variant="ghost">Deny</Button>
                    <Button
                      icon={<Check aria-hidden="true" size={15} />}
                      loading={busy === request.id}
                      onClick={() => void decide(request.id, who, "approved")}
                      size="sm"
                      variant="secondary"
                    >
                      Approve
                    </Button>
                  </>
                )}
                key={request.id}
                title={`${who} asked to ${requestedVerb(request)} ${collectionTitle}`}
                tone="info"
              >
                {request.reason ? `“${request.reason}” · ` : ""}
                <span className="text-[var(--text-tertiary)]">{formatRelative(request.created_at)}</span>
                {requestedRole(request) === "owner" && <span> · Asks to own it</span>}
              </Callout>
            );
          })}
        </div>
      )}

      {generalEnabled && (
        <div className="flex flex-wrap items-center gap-3 rounded-[var(--radius-lg)] border border-[var(--border-subtle)] bg-[var(--surface-base)] px-4 py-3">
          <span aria-hidden="true" className="grid size-9 shrink-0 place-items-center rounded-full bg-[var(--surface-inset)] text-[var(--text-secondary)]">
            {generalAccess === "workspace" ? <Globe size={16} /> : <Lock size={16} />}
          </span>
          <div className="min-w-[180px] flex-1">
            <div className="flex items-center gap-2 font-medium text-[var(--text-primary)]">General access <PreviewTag /></div>
            <div className="text-[length:var(--text-size-meta)] text-[var(--text-tertiary)]">
              {generalAccess === "workspace"
                ? "Anyone in the workspace can find it and ask about it."
                : "Only the people and groups below can find it."}
            </div>
          </div>
          <Select
            aria-label="General access"
            className="w-auto max-w-[280px]"
            disabled={savingGeneral}
            onChange={(event) => void changeGeneral(event.target.value as GeneralAccess)}
            options={[
              { value: "workspace", label: `Everyone in ${workspaceName || "the workspace"} can view` },
              { value: "restricted", label: "Only people added" },
            ]}
            size="sm"
            value={generalAccess}
          />
        </div>
      )}

      <section aria-labelledby="kb-people-heading" className="grid gap-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-[length:var(--text-size-section)] font-semibold text-[var(--text-primary)]" id="kb-people-heading">People and groups</h2>
            <p className="text-[length:var(--text-size-meta)] text-[var(--text-tertiary)]">
              {owners ? "Owners manage access and settings. Editors add and organize documents." : "Workspace admins manage this knowledge base."}
            </p>
          </div>
          <Button icon={<UserPlus aria-hidden="true" size={16} />} onClick={() => setSharing(true)} variant="primary">Share</Button>
        </div>
        {list.length ? (
          <ul className="divide-y divide-[var(--border-subtle)] overflow-hidden rounded-[var(--radius-lg)] border border-[var(--border-subtle)] bg-[var(--surface-base)]">
            {list.map((grant) => {
              const key = principalKey(grant);
              const name = nameOf(grant);
              const error = rowError?.key === key ? rowError.message : null;
              return (
                <li className="flex items-start gap-3 px-4 py-3" key={key}>
                  <span className="mt-0.5"><PrincipalAvatar name={name} type={grant.principal_type} /></span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium text-[var(--text-primary)]">
                      {name}
                      {isMe(grant) && <span className="font-normal text-[var(--text-tertiary)]"> (you)</span>}
                    </div>
                    <div className="text-[length:var(--text-size-meta)] text-[var(--text-tertiary)]">
                      {grant.principal_type === "group" ? "Group" : "Person"}
                    </div>
                    {error && (
                      <p className="mt-1 text-[length:var(--text-size-meta)] text-[var(--status-danger-text)]" role="alert">{error}</p>
                    )}
                  </div>
                  <Select
                    aria-label={`Role for ${name}`}
                    className="w-auto"
                    disabled={busy === key}
                    onChange={(event) => void changeRole(grant, event.target.value as CollectionRole)}
                    options={ROLE_OPTIONS}
                    size="sm"
                    value={grant.role}
                  />
                  <Button
                    aria-label={`Remove ${name}`}
                    disabled={busy === key}
                    icon={<X size={16} />}
                    iconOnly
                    onClick={() => requestRemove(grant)}
                    size="sm"
                    variant="ghost"
                  />
                </li>
              );
            })}
          </ul>
        ) : (
          <EmptyState
            boxed
            description={generalAccess === "workspace" ? "Everyone can view it. Share it to give someone edit rights." : "Share it so people can find it."}
            icon={<Users />}
            size="md"
            title="Not shared with anyone yet"
          />
        )}
        <p className="text-[length:var(--text-size-meta)] text-[var(--text-tertiary)]">Workspace admins can always manage every knowledge base.</p>
      </section>

      <ShareDialog
        collectionId={collectionId}
        collectionTitle={collectionTitle}
        grants={list}
        onClose={() => setSharing(false)}
        open={sharing}
      />
      <ConfirmDialog
        confirmLabel="Remove"
        description="You won’t be able to open it unless someone shares it with you again, or your workspace role covers every knowledge base."
        onClose={() => setRemovingSelf(null)}
        onConfirm={async () => {
          if (removingSelf) await remove(removingSelf);
        }}
        open={Boolean(removingSelf)}
        title="Remove your access?"
      />
    </div>
  );
}
