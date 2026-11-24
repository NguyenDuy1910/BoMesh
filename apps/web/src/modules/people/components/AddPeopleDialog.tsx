"use client";

import { Button, Modal } from "@heroui/react";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, UserPlus, Users, X } from "lucide-react";
import { useRef, useState, type KeyboardEvent } from "react";

import { Disclosure, Tip, UserAvatar, toast } from "@/components/ui";
import { errorMessage, resourceId } from "@/lib/api/client";
import { plural } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";
import { batchGetMembers } from "@/modules/knowledge/api";

import { addToGroup, createMember, deleteMember, lookupUser, type Member, type User } from "../api";
import { EMAIL_RE, MEMBER_ROLE, joinNames, nameFromEmail, splitEmails } from "../model";
import { peopleKeys, usePeopleClient, type Directory } from "../queries";
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
  const [tried, setTried] = useState(false);

  const lookups = useQueries({
    queries: emails.map((e) => ({ queryKey: lookupKey(e), queryFn: () => lookupUser(e), enabled: EMAIL_RE.test(e), staleTime: 60_000, retry: false })),
  });
  const accountOf = new Map(emails.map((e, i) => [e, lookups[i]]));
  // The accounts found that already belong to the workspace: one batch read of their member names.
  const users = [...new Set(lookups.map((l) => resourceId(l.data?.name)).filter(Boolean))].sort();
  const existing = useQuery({
    queryKey: [...peopleKeys.members(ws), "byUser", users],
    queryFn: async () => new Set((await batchGetMembers(ws, users)).map((m) => resourceId(m.user))),
    enabled: users.length > 0,
    staleTime: 60_000,
  });

  /** Why an email can't be added ('' when it can, null while its account or membership is being looked up). */
  const problem = (e: string): string | null => {
    if (!EMAIL_RE.test(e)) return "Địa chỉ email không hợp lệ";
    const lookup = accountOf.get(e);
    if (!lookup || lookup.isPending) return null;
    if (lookup.isError) return errorMessage(lookup.error);
    if (!lookup.data) return "Không có tài khoản BoMesh nào với email này";
    if (existing.isError) return errorMessage(existing.error);
    if (!existing.data) return null;
    return existing.data.has(resourceId(lookup.data.name)) ? "Đã là thành viên" : "";
  };
  const checks = emails.map((e) => [e, problem(e)] as const);
  const bad = checks.filter(([, why]) => why);
  const draftEmail = draft.trim().toLowerCase();
  const draftOk = Boolean(draftEmail) && EMAIL_RE.test(draftEmail) && !emails.includes(draftEmail);
  const n = checks.length - bad.length + (draftOk ? 1 : 0);
  const none = tried && !emails.length && !draftEmail;
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
      event.preventDefault();
      setDraft(emails[emails.length - 1]);
      setEmails((cur) => cur.slice(0, -1));
    }
  };

  async function submit() {
    if (busy) return;
    setTried(true);
    const all = draft.trim() ? [...emails, ...splitEmails(draft).filter((e) => !emails.includes(e))] : emails;
    if (draft.trim()) {
      setEmails(all);
      setDraft("");
    }
    if (!all.length || all.some((e) => !EMAIL_RE.test(e))) {
      input.current?.focus();
      return;
    }
    setBusy(true);
    let accounts: (User | null)[];
    let members: Set<string>;
    try {
      accounts = await Promise.all(all.map((e) => qc.fetchQuery({ queryKey: lookupKey(e), queryFn: () => lookupUser(e), staleTime: 60_000 })));
      members = new Set((await batchGetMembers(ws, accounts.map((a) => resourceId(a?.name)).filter(Boolean))).map((m) => resourceId(m.user)));
    } catch (error) {
      setBusy(false);
      toast(errorMessage(error), { tone: "danger" });
      return;
    }
    if (accounts.some((a) => !a?.name || members.has(resourceId(a.name)))) {
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
    toast(added.length <= 2 ? `Đã thêm ${joinNames(names)}` : `Đã thêm ${added.length} người`, {
      undo: () =>
        void Promise.all(added.map((m) => deleteMember(ws, m.name ?? "")))
          .catch((error: unknown) => toast(errorMessage(error), { tone: "danger" }))
          .finally(refresh),
    });
  }

  return (
    <>
      <Modal.CloseTrigger aria-label="Đóng" />
      <Modal.Header>
        <span className="modal__icon" aria-hidden>
          <UserPlus />
        </span>
        <div className="grow" style={{ minWidth: 0 }}>
          <Modal.Heading>Thêm người</Modal.Heading>
          <p className="modal__description">{`Họ sẽ tham gia ${workspace.displayName} ngay lập tức.`}</p>
        </div>
      </Modal.Header>
      <Modal.Body className="stack gap-16">
        <div className="field">
          <label className="label" htmlFor="ppl-add-email">
            Email
          </label>
          <div className={bad.length || none ? "ppl-chipin is-invalid" : "ppl-chipin"} onClick={() => input.current?.focus()}>
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
                    aria-label={`Gỡ ${e}`}
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
              placeholder={emails.length ? "Thêm người khác" : "name@company.com"}
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
              aria-label="Địa chỉ email"
              aria-invalid={bad.length > 0 || none}
            />
          </div>
          {none ? (
            <div className="field-error" role="alert">
              <AlertCircle className="i" aria-hidden />
              <span>Thêm ít nhất một địa chỉ email.</span>
            </div>
          ) : bad.length ? (
            <div className="stack gap-4" role="alert">
              {bad.map(([e, why]) => (
                <div key={e} className="field-error">
                  <AlertCircle className="i" aria-hidden />
                  <span>
                    <span className="medium" translate="no">
                      {e}
                    </span>
                    {" · "}
                    <span>{why}</span>
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div className="description">Dán hoặc nhập email, cách nhau bằng dấu phẩy. Mỗi người cần có tài khoản BoMesh.</div>
          )}
        </div>
        <RoleSelect label="Vai trò" value={role} roles={dir.roles} onChange={setRole} description={roleDef?.description} fullWidth />
        {dir.groups.length ? (
          <Disclosure
            icon={Users}
            title="Thêm vào nhóm"
            summary={
              groups.length
                ? groups.length <= 2
                  ? groups.map((g) => dir.groupByName.get(g)?.displayName ?? "").join(", ")
                  : plural(groups.length, "group")
                : "Không có"
            }
          >
            <GroupChecks groups={dir.groups} value={groups} onChange={setGroups} />
          </Disclosure>
        ) : null}
      </Modal.Body>
      <Modal.Footer>
        <span className="grow t-sm muted">Bạn có thể đổi vai trò và nhóm sau.</span>
        <Button variant="ghost" slot="close">
          Hủy
        </Button>
        <Button variant="primary" isPending={busy} onPress={() => void submit()}>
          <UserPlus className="i" aria-hidden />
          {n > 1 ? `Thêm ${n} người` : n === 1 ? "Thêm người" : "Thêm người"}
        </Button>
      </Modal.Footer>
    </>
  );
}
