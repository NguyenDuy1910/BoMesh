"use client";

import { Button, Modal } from "@heroui/react";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, X } from "lucide-react";
import { useRef, useState, type KeyboardEvent } from "react";

import { Tip, UserAvatar, toast } from "@/components/ui";
import { errorMessage } from "@/lib/api/client";
import { useWorkspace } from "@/lib/workspace";

import { addToGroup, createMember, deleteMember, lookupUser, type Member, type User } from "../api";
import { EMAIL_RE, MEMBER_ROLE, joinNames, nameFromEmail, splitEmails } from "../model";
import { usePeopleClient, type Directory } from "../queries";
import { GroupChecks } from "./GroupChecks";
import { RoleSelect } from "./RoleSelect";

const lookupKey = (email: string) => ["user-lookup", email] as const;

/** Add people (preview `M['ppl-add']`): existing accounts only, per-email validation, role and groups. */
export function AddPeopleDialog({ isOpen, onClose, dir, onAdded }: { isOpen: boolean; onClose: () => void; dir: Directory | undefined; onAdded: (ids: string[]) => void }) {
  return (
    <Modal.Backdrop isOpen={isOpen} onOpenChange={(open) => (open ? undefined : onClose())}>
      <Modal.Container size="lg">
        <Modal.Dialog>{isOpen && dir ? <AddPeopleForm dir={dir} onClose={onClose} onAdded={onAdded} /> : null}</Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}

function AddPeopleForm({ dir, onClose, onAdded }: { dir: Directory; onClose: () => void; onAdded: (ids: string[]) => void }) {
  const { workspace } = useWorkspace();
  const { ws, refresh } = usePeopleClient();
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState("");
  const [emails, setEmails] = useState<string[]>([]);
  const [role, setRole] = useState(MEMBER_ROLE);
  const [groups, setGroups] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const memberEmails = new Set(dir.people.map((p) => p.email.toLowerCase()));
  const checkable = (e: string) => EMAIL_RE.test(e) && !memberEmails.has(e);
  const lookups = useQueries({
    queries: emails.map((e) => ({ queryKey: lookupKey(e), queryFn: () => lookupUser(e), enabled: checkable(e), staleTime: 60_000, retry: false })),
  });
  const accountOf = new Map(emails.map((e, i) => [e, lookups[i]]));

  /** Why an email can't be added ('' when it can, null while its account is being looked up). */
  const problem = (e: string): string | null => {
    if (!EMAIL_RE.test(e)) return "Not a valid email address";
    if (memberEmails.has(e)) return "Already a member";
    const lookup = accountOf.get(e);
    if (!lookup || lookup.isPending) return null;
    if (lookup.isError) return errorMessage(lookup.error);
    return lookup.data ? "" : "No BoMesh account for this email";
  };
  const checks = emails.map((e) => [e, problem(e)] as const);
  const bad = checks.filter(([, why]) => why);
  const draftEmail = draft.trim().toLowerCase();
  const draftOk = Boolean(draftEmail) && EMAIL_RE.test(draftEmail) && !memberEmails.has(draftEmail) && !emails.includes(draftEmail);
  const n = checks.length - bad.length + (draftOk ? 1 : 0);
  const ready = n > 0 && !bad.length && (!draftEmail || draftOk || emails.includes(draftEmail));
  const roleDef = dir.roleByName.get(role);

  const commit = (text: string) => setEmails((cur) => [...cur, ...splitEmails(text).filter((e) => !cur.includes(e))]);
  const onInput = (value: string) => {
    if (!/[,;\s]/.test(value)) {
      setDraft(value);
      return;
    }
    const parts = value.split(/[,;\s]+/);
    const rest = /[,;\s]$/.test(value) ? "" : (parts.pop() ?? "");
    commit(parts.join(","));
    setDraft(rest);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      if (draft.trim()) {
        commit(draft);
        setDraft("");
      } else void submit();
    } else if (event.key === "Backspace" && !draft && emails.length) {
      setEmails((cur) => cur.slice(0, -1));
    }
  };

  async function submit() {
    if (busy) return;
    const all = draft.trim() ? [...emails, ...splitEmails(draft).filter((e) => !emails.includes(e))] : emails;
    if (draft.trim()) {
      setEmails(all);
      setDraft("");
    }
    if (!all.length || all.some((e) => !checkable(e))) {
      input.current?.focus();
      return;
    }
    setBusy(true);
    let accounts: (User | null)[];
    try {
      accounts = await Promise.all(all.map((e) => qc.fetchQuery({ queryKey: lookupKey(e), queryFn: () => lookupUser(e), staleTime: 60_000 })));
    } catch (error) {
      setBusy(false);
      toast(errorMessage(error), { tone: "danger" });
      return;
    }
    if (accounts.some((a) => !a?.name)) {
      setBusy(false);
      input.current?.focus();
      return;
    }
    const added: Member[] = [];
    try {
      for (const account of accounts) {
        const member = await createMember(ws, account!.name!, [role]);
        added.push(member);
        await Promise.all(groups.map((g) => addToGroup(ws, g, member.name ?? "")));
      }
    } catch (error) {
      toast(errorMessage(error), { tone: "danger" });
      setBusy(false);
      refresh();
      if (!added.length) return;
    }
    refresh();
    onAdded(added.map((m) => m.name?.split("/").pop() ?? ""));
    onClose();
    const names = added.map((m) => m.displayName || m.email || "");
    toast(added.length <= 2 ? `Added ${joinNames(names)}` : `Added ${added.length} people`, {
      undo: () =>
        void Promise.all(added.map((m) => deleteMember(ws, m.name ?? "")))
          .catch((error: unknown) => toast(errorMessage(error), { tone: "danger" }))
          .finally(refresh),
    });
  }

  return (
    <>
      <Modal.CloseTrigger aria-label="Close" />
      <Modal.Header>
        <Modal.Heading>Add people</Modal.Heading>
        <p className="modal__description">
          They join <span translate="no">{workspace.displayName}</span> right away.
        </p>
      </Modal.Header>
      <Modal.Body className="stack gap-16">
        <div className="field">
          <label className="label" htmlFor="ppl-add-email">
            Emails
          </label>
          <div className={bad.length ? "ppl-chipin is-invalid" : "ppl-chipin"} onClick={() => input.current?.focus()}>
            {checks.map(([e, why]) => {
              const chip = (
                <span key={e} className={why ? "ppl-chip is-invalid" : "ppl-chip"}>
                  {why ? <AlertCircle className="i i-xs" aria-hidden /> : <UserAvatar name={accountOf.get(e)?.data?.displayName || nameFromEmail(e)} size="xs" />}
                  <span className="truncate" translate="no">
                    {e}
                  </span>
                  <button
                    type="button"
                    className="ppl-chip__x"
                    aria-label={`Remove ${e}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      setEmails((cur) => cur.filter((x) => x !== e));
                      input.current?.focus();
                    }}
                  >
                    <X className="i i-xs" aria-hidden />
                  </button>
                </span>
              );
              return why ? (
                <Tip key={e} content={why}>
                  {chip}
                </Tip>
              ) : (
                chip
              );
            })}
            <input
              ref={input}
              id="ppl-add-email"
              className="ppl-chipin__input"
              type="text"
              value={draft}
              placeholder={emails.length ? "Add another" : "name@company.com"}
              onChange={(event) => onInput(event.target.value)}
              onKeyDown={onKeyDown}
              onBlur={() => {
                if (draft.trim()) {
                  commit(draft);
                  setDraft("");
                }
              }}
              onPaste={(event) => {
                const text = event.clipboardData.getData("text");
                if (/[,;\s]/.test(text.trim())) {
                  event.preventDefault();
                  commit(draft + text);
                  setDraft("");
                }
              }}
              autoComplete="off"
              spellCheck={false}
              autoFocus
              aria-label="Email addresses"
              aria-invalid={bad.length > 0}
            />
          </div>
          {bad.length ? (
            <div className="stack gap-4" role="alert">
              {bad.map(([e, why]) => (
                <div key={e} className="field-error">
                  <AlertCircle className="i" aria-hidden />
                  <span>
                    <span className="medium" translate="no">
                      {e}
                    </span>{" "}
                    · {why}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div className="description">Paste or type emails, separated by commas. Each person needs a BoMesh account.</div>
          )}
        </div>
        <RoleSelect label="Role" value={role} roles={dir.roles} onChange={setRole} description={roleDef?.description} fullWidth />
        {dir.groups.length ? (
          <div className="field">
            <span className="label">
              Groups<span className="label__opt">(optional)</span>
            </span>
            <GroupChecks groups={dir.groups} value={groups} onChange={setGroups} />
          </div>
        ) : null}
      </Modal.Body>
      <Modal.Footer>
        <Button variant="tertiary" slot="close">
          Cancel
        </Button>
        <Button variant="primary" isDisabled={!ready} isPending={busy} onPress={() => void submit()}>
          {n > 1 ? `Add ${n} people` : "Add person"}
        </Button>
      </Modal.Footer>
    </>
  );
}
