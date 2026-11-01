"use client";

import { AlertCircle, Check, Copy, LoaderCircle, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Dialog } from "@/components/ui/Dialog";
import { FormField } from "@/components/ui/FormField";
import { Select } from "@/components/ui/Select";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/cn";
import { useClipboard } from "@/lib/hooks/useClipboard";
import {
  accessErrorMessage,
  defaultRoleId,
  EMAIL_PATTERN,
  roleOptions,
  type RoleChoice,
} from "@/modules/manage/access/access-model";
import { describeAccess } from "@/modules/manage/access/capabilities";
import { memberName, workspaceDirectoryApi, type Account, type GroupRef, type Member } from "@/modules/manage/access/directory";

/** What one typed address turned out to be. */
type Check =
  | { state: "checking" }
  | { state: "ok"; account: Account }
  | { state: "member"; account: Account }
  | { state: "suspended"; account: Account }
  | { state: "disabled"; account: Account }
  | { state: "missing" }
  | { state: "invalid" }
  | { state: "error"; message: string };

const SEPARATORS = /[\s,;]+/;

/**
 * Add people who already have a BoMesh account. A workspace never creates
 * identities: each address is looked up (`GET /accounts?email=`) and shown
 * back as the person it names, and an address without an account explains
 * that they sign up first, with the sign-up link to send them.
 */
export function AddMemberDialog({
  open,
  roles,
  groups,
  members,
  callerPermissions,
  onClose,
  onOpenMember,
}: {
  open: boolean;
  roles: RoleChoice[];
  groups: GroupRef[];
  members: Member[];
  callerPermissions: readonly string[];
  onClose: () => void;
  onOpenMember: (memberId: string) => void;
}) {
  const toast = useToast();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [draft, setDraft] = useState("");
  const [emails, setEmails] = useState<string[]>([]);
  const [checks, setChecks] = useState<Record<string, Check>>({});
  const [roleId, setRoleId] = useState("");
  const [groupIds, setGroupIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const chosenRole = roleId || defaultRoleId(roles, callerPermissions);
  const role = roles.find((item) => item.id === chosenRole);

  // Each address is looked up once; a result for an address since removed is ignored.
  const lookups = useRef<Record<string, AbortController>>({});
  useEffect(() => {
    for (const email of emails) {
      if (checks[email] || lookups.current[email]) continue;
      if (!EMAIL_PATTERN.test(email)) {
        setChecks((current) => ({ ...current, [email]: { state: "invalid" } }));
        continue;
      }
      const controller = new AbortController();
      lookups.current[email] = controller;
      setChecks((current) => ({ ...current, [email]: { state: "checking" } }));
      workspaceDirectoryApi
        .lookupAccount(email, controller.signal)
        .then((account): Check => {
          if (!account) return { state: "missing" };
          if (account.status === "disabled") return { state: "disabled", account };
          if (account.workspace_membership === "active") return { state: "member", account };
          if (account.workspace_membership === "suspended") return { state: "suspended", account };
          return { state: "ok", account };
        })
        .catch((cause: unknown): Check => ({ state: "error", message: accessErrorMessage(cause, "The address couldn’t be checked.") }))
        .then((check) => {
          if (controller.signal.aborted) return;
          delete lookups.current[email];
          setChecks((current) => ({ ...current, [email]: check }));
        });
    }
  }, [emails, checks]);

  const reset = () => {
    for (const controller of Object.values(lookups.current)) controller.abort();
    lookups.current = {};
    setDraft("");
    setEmails([]);
    setChecks({});
    setRoleId("");
    setGroupIds([]);
  };
  const close = () => {
    reset();
    onClose();
  };

  const commit = (text: string) => {
    const parts = text.split(SEPARATORS).map((part) => part.trim().toLowerCase()).filter(Boolean);
    if (parts.length) setEmails((current) => [...current, ...parts.filter((part) => !current.includes(part))]);
  };
  const remove = (email: string) => {
    lookups.current[email]?.abort();
    delete lookups.current[email];
    setEmails((current) => current.filter((item) => item !== email));
    setChecks((current) => {
      const next = { ...current };
      delete next[email];
      return next;
    });
    inputRef.current?.focus();
  };

  const entries = emails.map((email) => [email, checks[email] ?? { state: "checking" }] as const);
  const ready = entries.filter(([, check]) => check.state === "ok");
  const problems = entries.filter(([, check]) => check.state !== "ok" && check.state !== "checking");
  const checking = entries.some(([, check]) => check.state === "checking");
  const draftPending = draft.trim().length > 0;
  const canSubmit = ready.length > 0 && !problems.length && !checking && !draftPending && Boolean(chosenRole);

  const submit = async () => {
    if (draftPending) {
      commit(draft);
      setDraft("");
      return;
    }
    if (!canSubmit) {
      inputRef.current?.focus();
      return;
    }
    setBusy(true);
    const results = await Promise.allSettled(
      ready.map(([, check]) =>
        workspaceDirectoryApi.addMember({ email: (check as { account: Account }).account.email, role_ids: [chosenRole], group_ids: groupIds }),
      ),
    );
    setBusy(false);
    const added: Member[] = [];
    const failures: Record<string, Check> = {};
    results.forEach((result, index) => {
      const email = ready[index][0];
      if (result.status === "fulfilled") added.push(result.value);
      else failures[email] = { state: "error", message: accessErrorMessage(result.reason, "They couldn’t be added.") };
    });
    if (added.length) {
      toast.show({
        message:
          added.length === 1 ? `Added ${memberName(added[0])}`
            : added.length === 2 ? `Added ${memberName(added[0])} and ${memberName(added[1])}`
              : `Added ${added.length} members`,
        description: role ? `They can use this workspace as ${role.name}.` : undefined,
      });
    }
    if (!Object.keys(failures).length) {
      close();
      return;
    }
    // Keep only the addresses that failed, each with its reason.
    setEmails(Object.keys(failures));
    setChecks(failures);
  };

  const problemMessage = (email: string, check: Check) => {
    switch (check.state) {
      case "invalid":
        return `${email} isn’t a valid email address.`;
      case "member":
        return `${check.account.display_name || email} is already a member.`;
      case "disabled":
        return `${email} belongs to a disabled account, so it can’t be added.`;
      case "error":
        return `${email}: ${check.message}`;
      default:
        return "";
    }
  };
  const missing = problems.filter(([, check]) => check.state === "missing").map(([email]) => email);
  const suspended = problems.filter((entry): entry is readonly [string, Extract<Check, { state: "suspended" }>] => entry[1].state === "suspended");
  const others = problems.filter(([, check]) => check.state !== "missing" && check.state !== "suspended");
  const knownMembers = new Set(members.map((member) => member.email.toLowerCase()));

  return (
    <Dialog
      busy={busy}
      description="Add people who already have a BoMesh account."
      footer={
        <>
          <Button onClick={close} variant="secondary">Cancel</Button>
          <Button disabled={!canSubmit && !draftPending} loading={busy} onClick={() => void submit()}>
            {ready.length > 1 ? `Add ${ready.length} members` : "Add member"}
          </Button>
        </>
      }
      initialFocusRef={inputRef}
      onClose={close}
      open={open}
      size="md"
      title="Add members"
    >
      <div className="grid gap-5">
        <div className="grid gap-1.5">
          <label className="text-[length:var(--text-size-body)] font-medium text-[var(--text-primary)]" htmlFor="add-member-email">
            Email addresses
          </label>
          <div
            className={cn(
              "flex min-h-[38px] cursor-text flex-wrap items-center gap-1.5 rounded-[var(--radius-md)] border bg-[var(--surface-base)] px-1.5 py-[5px]",
              "transition-[border-color,box-shadow] duration-[var(--duration-fast)] focus-within:border-[var(--accent-primary)] focus-within:shadow-[var(--shadow-focus)]",
              problems.length ? "border-[var(--status-danger-text)]" : "border-[var(--border-default)] hover:border-[var(--border-strong)]",
            )}
            onClick={() => inputRef.current?.focus()}
          >
            {entries.map(([email, check]) => (
              <EmailChip check={check} email={email} key={email} onRemove={() => remove(email)} />
            ))}
            <input
              aria-describedby="add-member-email-help"
              aria-invalid={problems.length > 0 || undefined}
              autoComplete="off"
              className="h-[26px] min-w-[180px] flex-1 border-0 bg-transparent px-1.5 text-[length:var(--text-size-body)] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-tertiary)]"
              id="add-member-email"
              onBlur={() => {
                if (!draftPending) return;
                commit(draft);
                setDraft("");
              }}
              onChange={(event) => {
                const value = event.target.value;
                if (!SEPARATORS.test(value)) {
                  setDraft(value);
                  return;
                }
                const parts = value.split(SEPARATORS);
                const rest = /[\s,;]$/.test(value) ? "" : parts.pop() ?? "";
                commit(parts.join(","));
                setDraft(rest);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void submit();
                } else if (event.key === "Backspace" && !draft && emails.length) {
                  remove(emails[emails.length - 1]);
                }
              }}
              placeholder={emails.length ? "Add another" : "name@company.com"}
              ref={inputRef}
              spellCheck={false}
              type="text"
              value={draft}
            />
          </div>
          <div aria-live="polite" className="grid gap-2" id="add-member-email-help">
            {!problems.length && (
              <p className="text-[length:var(--text-size-meta)] text-[var(--text-tertiary)]">
                Separate several with commas. Each person needs a BoMesh account first.
              </p>
            )}
            {others.map(([email, check]) => (
              <p className="flex items-start gap-1.5 text-[length:var(--text-size-meta)] text-[var(--status-danger-text)]" key={email} role="alert">
                <AlertCircle aria-hidden="true" className="mt-0.5 shrink-0" size={14} />
                <span>{problemMessage(email, check)}</span>
              </p>
            ))}
            {suspended.map(([email, check]) => (
              <Callout
                actions={
                  knownMembers.has(email) && (
                    <Button onClick={() => onOpenMember(check.account.id)} size="sm" variant="secondary">Open member</Button>
                  )
                }
                key={email}
                tone="warn"
              >
                {check.account.display_name || email} is a suspended member. Reactivate them instead of adding them again.
              </Callout>
            ))}
            {missing.length > 0 && <NeedsAccount emails={missing} />}
          </div>
        </div>

        <FormField htmlFor="add-member-role" help={role?.permissions ? describeAccess(role.permissions) : undefined} label="Role" required>
          <Select id="add-member-role" onChange={(event) => setRoleId(event.target.value)} options={roleOptions(roles, "", callerPermissions)} value={chosenRole} />
        </FormField>

        {groups.length > 0 && (
          <fieldset className="grid gap-2">
            <legend className="mb-2 flex items-baseline gap-2 text-[length:var(--text-size-body)] font-medium text-[var(--text-primary)]">
              Groups <span className="text-[length:var(--text-size-caption)] font-normal text-[var(--text-tertiary)]">Optional</span>
            </legend>
            <div className="flex flex-wrap gap-1.5">
              {groups.map((group) => {
                const on = groupIds.includes(group.id);
                return (
                  <button
                    aria-pressed={on}
                    className={cn(
                      "inline-flex h-[30px] items-center gap-1.5 rounded-[var(--radius-full)] border px-3 text-[13px] font-medium",
                      "transition-colors duration-[var(--duration-fast)] focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]",
                      on
                        ? "border-[var(--accent-primary)] bg-[var(--accent-soft)] text-[var(--text-accent)]"
                        : "border-[var(--border-default)] text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]",
                    )}
                    key={group.id}
                    onClick={() => setGroupIds((current) => (on ? current.filter((id) => id !== group.id) : [...current, group.id]))}
                    type="button"
                  >
                    {on && <Check aria-hidden="true" size={14} />}
                    {group.display_name}
                  </button>
                );
              })}
            </div>
          </fieldset>
        )}
      </div>
    </Dialog>
  );
}

function EmailChip({ email, check, onRemove }: { email: string; check: Check; onRemove: () => void }) {
  const ok = check.state === "ok";
  const name = ok ? check.account.display_name : null;
  return (
    <span
      className={cn(
        "inline-flex h-[26px] max-w-full items-center gap-1.5 rounded-[var(--radius-sm)] pr-0.5 text-[13px]",
        check.state === "checking" || ok
          ? "bg-[var(--surface-inset)] pl-1 text-[var(--text-primary)]"
          : "bg-[var(--status-danger-bg)] pl-1.5 text-[var(--status-danger-text)] shadow-[inset_0_0_0_1px_var(--status-danger-border)]",
      )}
      title={name ? `${name} · ${email}` : email}
    >
      {check.state === "checking" ? (
        <LoaderCircle aria-label={`Checking ${email}`} className="animate-spin text-[var(--text-tertiary)]" size={14} />
      ) : ok ? (
        <Avatar className="h-[18px] w-[18px] text-[8px]" name={name || email} />
      ) : (
        <AlertCircle aria-hidden="true" size={14} />
      )}
      <span className="truncate">{name ? `${name}` : email}</span>
      {name && <span className="truncate text-[var(--text-tertiary)]">{email}</span>}
      <button
        aria-label={`Remove ${email}`}
        className="grid h-5 w-5 place-items-center rounded-[var(--radius-xs)] opacity-70 hover:bg-[var(--surface-hover)] hover:opacity-100 focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
        onClick={(event) => {
          event.stopPropagation();
          onRemove();
        }}
        type="button"
      >
        <X aria-hidden="true" size={12} />
      </button>
    </span>
  );
}

/** No account uses these addresses: they sign up first, then an admin adds them. */
function NeedsAccount({ emails }: { emails: string[] }) {
  const { copy, copied } = useClipboard();
  const list = emails.length === 1 ? emails[0] : `${emails.slice(0, -1).join(", ")} and ${emails.at(-1)}`;
  return (
    <Callout
      actions={
        <Button
          icon={copied ? <Check aria-hidden="true" size={14} /> : <Copy aria-hidden="true" size={14} />}
          onClick={() => void copy(`${window.location.origin}/auth/signup`)}
          size="sm"
          variant="secondary"
        >
          {copied ? "Link copied" : "Copy sign-up link"}
        </Button>
      }
      title={emails.length === 1 ? "This person needs an account first" : "These people need an account first"}
      tone="info"
    >
      No BoMesh account uses {list}. Send them the sign-up link; once they’ve created an account, add them here.
      Remove {emails.length === 1 ? "the address" : "these addresses"} to add everyone else now.
    </Callout>
  );
}
