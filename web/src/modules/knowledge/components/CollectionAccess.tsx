"use client";

import { LoaderCircle, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Select } from "@/components/ui/Select";
import { useToast } from "@/components/ui/Toast";
import {
  knowledgeApi,
  type CollectionGrant,
  type CollectionRole,
} from "@/modules/knowledge/knowledge-api";
import type { WorkspaceKnowledgeCollection } from "@/modules/knowledge/workspace-repository";
import { memberName, workspaceDirectoryApi } from "@/modules/workspace-control/directory";

/** What each role lets someone do with the collection, in their words. */
const COLLECTION_ROLES: readonly { value: CollectionRole; label: string; description: string }[] = [
  { value: "viewer", label: "Viewer", description: "Can read it and ask the assistant about it." },
  { value: "editor", label: "Editor", description: "Can also add, change and remove its knowledge." },
  { value: "owner", label: "Owner", description: "Can also decide who else can open it." },
];

const ROLE_OPTIONS = COLLECTION_ROLES.map(({ value, label }) => ({ value, label }));

interface Principal {
  key: string;
  type: "user" | "group";
  id: string;
  label: string;
}

const principalKey = (grant: Pick<CollectionGrant, "principal_type" | "principal_id">) =>
  `${grant.principal_type}:${grant.principal_id}`;

/** Who can open one collection; loads only while `enabled`. */
function useCollectionAccess(collectionId: string, enabled: boolean) {
  const [grants, setGrants] = useState<CollectionGrant[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setGrants(await knowledgeApi.collectionAccess(collectionId));
      setError(null);
    } catch (cause) {
      // The API's wording is for operators; this list just could not load.
      setError(cause instanceof Error && cause.message.length < 160
        ? cause.message
        : "Who can open this collection couldn’t be loaded. Try again later.");
    }
  }, [collectionId]);
  useEffect(() => {
    if (enabled) void load();
  }, [enabled, load]);
  return { grants, error, reload: load };
}

/** The workspace's people and groups, for choosing who to share with. */
function usePrincipals(enabled: boolean) {
  const [principals, setPrincipals] = useState<Principal[] | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    if (!enabled || principals) return;
    // Someone who may share a collection but not read the directory is told so.
    void Promise.allSettled([workspaceDirectoryApi.groups(), workspaceDirectoryApi.members()]).then(
      ([groups, members]) => {
        setUnavailable(groups.status === "rejected" && members.status === "rejected");
        setPrincipals([
          ...(groups.status === "fulfilled"
            ? groups.value.items
              .filter((group) => group.status === "active")
              .map((group) => ({ key: `group:${group.id}`, type: "group" as const, id: group.id, label: `${group.display_name} (group)` }))
            : []),
          ...(members.status === "fulfilled"
            ? members.value.items.map((member) => ({
              key: `user:${member.id}`,
              type: "user" as const,
              id: member.id,
              label: memberName(member as { display_name: string | null; email: string }),
            }))
            : []),
        ]);
      },
    );
  }, [enabled, principals]);
  return { principals, unavailable };
}

/**
 * Share a collection: add a person or group at the top, change or remove
 * everyone who already has access below — one place, like sharing a folder.
 * Grants reach the collections nested inside it too.
 */
export function CollectionShareDialog({
  collection,
  open,
  onClose,
}: {
  collection: WorkspaceKnowledgeCollection;
  open: boolean;
  onClose: () => void;
}) {
  const { grants, error, reload } = useCollectionAccess(collection.id, open);
  const { principals, unavailable } = usePrincipals(open);
  const { toast } = useToast();
  const [choice, setChoice] = useState("");
  const [role, setRole] = useState<CollectionRole>("viewer");
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setChoice("");
    setRole("viewer");
  }, [open]);

  const held = new Set((grants ?? []).map(principalKey));
  const candidates = (principals ?? []).filter((principal) => !held.has(principal.key));
  const chosen = candidates.find((principal) => principal.key === choice);

  const apply = async (key: string, action: () => Promise<unknown>, failure: string) => {
    setBusy(key);
    try {
      await action();
      await reload();
      return true;
    } catch (cause) {
      toast({ title: failure, description: cause instanceof Error ? cause.message : undefined, variant: "error" });
      return false;
    } finally {
      setBusy(null);
    }
  };

  const add = async () => {
    if (!chosen) return;
    const grant = { principal_type: chosen.type, principal_id: chosen.id, role };
    if (await apply("add", () => knowledgeApi.setCollectionAccess(collection.id, grant), "Access couldn’t be given")) {
      setChoice("");
    }
  };

  return (
    <Dialog
      footer={<Button onClick={onClose} variant="primary">Done</Button>}
      onClose={onClose}
      open={open}
      title={`Share “${collection.name}”`}
    >
      <div className="knowledge-share">
        {unavailable ? (
          <p className="knowledge-share__note">
            Your role can’t list the workspace’s people and groups. Ask a workspace administrator to share it.
          </p>
        ) : (
          <div className="knowledge-share__add">
            <Select
              aria-label="Person or group"
              disabled={principals === null}
              onChange={(event) => setChoice(event.target.value)}
              options={candidates.map((principal) => ({ value: principal.key, label: principal.label }))}
              placeholder={principals === null ? "Loading people…" : "Add a person or group"}
              value={choice}
            />
            <Select
              aria-label="Role"
              className="knowledge-share__role"
              onChange={(event) => setRole(event.target.value as CollectionRole)}
              options={ROLE_OPTIONS}
              value={role}
            />
            <Button disabled={!chosen} loading={busy === "add"} onClick={() => void add()} variant="secondary">
              Add
            </Button>
          </div>
        )}
        {chosen && (
          <p className="knowledge-share__note">
            {COLLECTION_ROLES.find((option) => option.value === role)?.description}
          </p>
        )}

        <section aria-label="People with access" className="knowledge-share__people">
          <h3 className="knowledge-eyebrow">People with access</h3>
          {error ? (
            <p className="knowledge-share__note">{error}</p>
          ) : grants === null ? (
            <p className="knowledge-share__note">
              <LoaderCircle aria-hidden="true" className="motion-safe:animate-spin" size={14} /> Loading…
            </p>
          ) : grants.length === 0 ? (
            <p className="knowledge-share__note">
              Not shared yet. Only people whose workspace role opens every collection can see it.
            </p>
          ) : (
            <ul className="knowledge-share__list">
              {grants.map((grant) => {
                const key = principalKey(grant);
                const name = grant.principal_name ?? "Someone no longer in the workspace";
                return (
                  <li key={key}>
                    <Avatar name={name} size="lg" />
                    <span className="knowledge-share__who">
                      <strong>{name}</strong>
                      <small>{grant.principal_type === "group" ? "Group" : "Person"}</small>
                    </span>
                    <Select
                      aria-label={`Role of ${name}`}
                      className="knowledge-share__role"
                      disabled={busy === key}
                      onChange={(event) => void apply(
                        key,
                        () => knowledgeApi.setCollectionAccess(collection.id, { ...grant, role: event.target.value as CollectionRole }),
                        "Access couldn’t be changed",
                      )}
                      options={ROLE_OPTIONS}
                      value={grant.role}
                    />
                    <Button
                      aria-label={`Remove ${name}`}
                      disabled={busy === key}
                      icon={<X size={16} />}
                      iconOnly
                      onClick={() => void apply(
                        key,
                        () => knowledgeApi.removeCollectionAccess(collection.id, grant),
                        "Access couldn’t be removed",
                      )}
                      size="sm"
                      title="Remove access"
                      variant="ghost"
                    />
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <p className="knowledge-share__note">
          Access also reaches the collections inside it. Workspace-wide roles are managed in{" "}
          <a href="/workspace-control/access">Access</a>.
        </p>
      </div>
    </Dialog>
  );
}
