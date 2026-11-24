"use client";

import { Button, FieldError, Input, Label, TextField } from "@heroui/react";
import { useQuery } from "@tanstack/react-query";
import { Check, Folder, GitCompare, Pencil, Sparkles, X } from "lucide-react";
import NextLink from "next/link";
import { useMemo, useState } from "react";

import { ItemIcon, toast } from "@/components/ui";
import { errorMessage, resourceId } from "@/lib/api/client";
import { plural } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";
import { fold, topicTree } from "@/modules/knowledge/model";

import { acceptTopic, createTopic, deleteTopic, listContributionsPage, mergeTopic, rejectTopic, updateTopic, type Topic } from "../../api";
import { holdDecision, type SendInit } from "../../decisions";
import { activeDomains, cleanName, nameTaken, topicSignals } from "../../governance";
import { docsHref } from "../../model";
import { useInvalidateCuration } from "../../queries";
import { PlainSelect } from "../parts";
import { ActionsMenu } from "../shared";

const NEW_DOMAIN = "__new";
/** Proposing submissions read per proposal for their titles; the rest count in "+n more". */
const EVIDENCE_SHOWN = 5;

/**
 * Topics → Suggestions → New topics the assistant proposes (preview `proposals`/`propCard`): a proposal reads as a
 * sentence (name, in which domain, why) with Accept; editing opens only when Rename, Change domain or Merge is chosen.
 * Proposals are decided only here, by workspace admins (`topics.accept`); publishing never waits for them.
 * `proposals` excludes the ones with a decision in its Undo window.
 */
export function ProposedList({ proposals, topics }: { proposals: readonly Topic[]; topics: readonly Topic[] }) {
  const { id: ws, can } = useWorkspace();
  // The first few submissions behind each proposal, in one batch read (ListContributions by name): their titles, while they're still open.
  const evidence = [...new Set(proposals.flatMap((p) => (p.evidence ?? []).slice(0, EVIDENCE_SHOWN)))].sort();
  const reads = useQuery({
    queryKey: [ws, "contributions", "proposal-evidence", evidence],
    queryFn: async () =>
      (await listContributionsPage(ws, { filter: evidence.map((name) => `name = ${JSON.stringify(name)}`).join(" OR "), view: "BASIC", pageSize: evidence.length })).contributions ?? [],
    enabled: evidence.length > 0,
    staleTime: 60_000,
    retry: false,
  });
  /** Contribution name → document title, for the open submissions the caller reviews. */
  const titles = new Map(
    (reads.data ?? []).flatMap((c) =>
      c.name && (c.state === "IN_REVIEW" || c.state === "ANALYZING") ? [[c.name, (c.itemDisplayName || "Tài liệu chưa đặt tên").replace(/\.[a-z0-9]{1,5}$/i, "")] as const] : [],
    ),
  );
  return (
    <ul className="md-props">
      {proposals.map((p) => (
        <ProposalCard key={p.name} p={p} topics={topics} titles={titles} canDecide={can("topics.accept")} />
      ))}
    </ul>
  );
}

function ProposalCard({ p, topics, titles, canDecide }: { p: Topic; topics: readonly Topic[]; titles: ReadonlyMap<string, string>; canDecide: boolean }) {
  const { id: ws } = useWorkspace();
  const invalidate = useInvalidateCuration();
  const domains = useMemo(() => activeDomains(topics), [topics]);
  const tree = useMemo(() => topicTree(topics).filter((d) => d.children.length), [topics]);
  const [edit, setEdit] = useState<"" | "name" | "domain" | "merge">("");
  const [name, setName] = useState(p.displayName ?? "");
  const [parent, setParent] = useState(p.parentTopic && domains.some((d) => d.name === p.parentTopic) ? p.parentTopic : NEW_DOMAIN);
  const [dname, setDname] = useState(p.displayName ?? "");
  const [into, setInto] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const docs = p.evidence ?? [];
  const seen = docs.filter((c) => titles.has(c));
  const tagged = docs.length ? `· đã gắn thẻ ${plural(docs.length, "document")}` : "";
  const domain = domains.find((d) => d.name === parent);
  /**
   * Accept, Merge and Dismiss are final in the API, so each is held for the Undo window and only then sent, as ONE
   * round of requests: a page leave inside the window sends them `keepalive`, and nothing runs after the page is gone.
   * `revert` undoes what was saved up front (a new domain) on Undo or when the decision fails.
   */
  const hold = (message: string, undoneMessage: string, send: (init: SendInit) => Promise<unknown>, revert?: () => Promise<unknown>) =>
    holdDecision({
      names: [p.name ?? ""],
      message,
      undoneMessage,
      send: (init) => send(init).then(() => undefined),
      onSent: invalidate,
      onUndo: revert
        ? () =>
            void revert().then(invalidate, (error: unknown) => {
              invalidate();
              toast(errorMessage(error), { tone: "danger" });
            })
        : undefined,
      onFailed: () => void (revert ? revert().catch(() => undefined) : Promise.resolve()).finally(invalidate),
    });
  const open = (mode: typeof edit) => {
    setEdit(mode);
    setErr("");
  };

  async function accept() {
    if (busy) return;
    const clean = cleanName(name);
    const isNew = !domain;
    const domainName = cleanName(dname) || clean;
    if (!clean) {
      setErr("Nhập tên.");
      setEdit("name");
      return;
    }
    if (!isNew && nameTaken(topics, clean, parent, p.name)) {
      setErr(`${domain.displayName} đã có “${clean}”. Hãy hợp nhất vào đó.`);
      setEdit("name");
      return;
    }
    if (isNew && domains.some((d) => fold(d.displayName ?? "") === fold(domainName))) {
      setErr(`Lĩnh vực “${domainName}” đã tồn tại. Hãy chọn trong danh sách.`);
      setEdit("domain");
      return;
    }
    // A new domain is created now (Undo deletes it), so the held decision is the accept alone.
    let made: Topic | null = null;
    if (isNew) {
      setBusy(true);
      try {
        made = await createTopic(ws, { displayName: domainName, kind: "DOMAIN" });
      } catch (error) {
        toast(errorMessage(error), { tone: "danger" });
        return;
      } finally {
        setBusy(false);
      }
    }
    const created = made;
    hold(
      `Đã thêm “${clean}” vào ${isNew ? domainName : (domain?.displayName ?? "")}${tagged}`,
      `“${clean}” được đề xuất lại`,
      (init) => acceptTopic(ws, p.name ?? "", { parentTopic: created?.name ?? parent, displayName: clean !== p.displayName ? clean : undefined, etag: p.etag }, init),
      created ? () => deleteTopic(ws, created.name ?? "") : undefined,
    );
  }

  function merge() {
    const target = topics.find((t) => t.name === into);
    if (!target) {
      setErr("Chọn chủ đề để hợp nhất vào.");
      return;
    }
    // The proposal's name becomes a synonym of the topic it joins, so the next document like it is classified there.
    const synonym = (p.displayName ?? "").toLowerCase();
    const known = !synonym || topicSignals(target).some((k) => fold(k) === fold(synonym));
    // Both in one round (the merge doesn't change the target topic, so the synonym's etag stays valid).
    hold(`Đã hợp nhất “${p.displayName}” vào ${target.displayName}${tagged}`, `“${p.displayName}” được đề xuất lại`, (init) =>
      Promise.all([known ? null : updateTopic(ws, target, { synonyms: [...(target.synonyms ?? []), synonym] }, init), mergeTopic(ws, p.name ?? "", target.name ?? "", init)]),
    );
  }

  const dismiss = () => hold(`Đã bỏ qua “${p.displayName}”`, `“${p.displayName}” được đề xuất lại`, (init) => rejectTopic(ws, p.name ?? "", init));

  const where = domain ? (
    <>
      in <span translate="no">{domain.displayName}</span>
    </>
  ) : (
    <>
      dưới dạng lĩnh vực mới
      {cleanName(dname) && cleanName(dname) !== cleanName(name) ? (
        <>
          {" "}
          “<span translate="no">{cleanName(dname)}</span>”
        </>
      ) : null}
    </>
  );

  return (
    <li className="md-prop">
      <ItemIcon icon={Sparkles} tone="accent" size="sm" />
      <div className="md-prop__main">
        <div className="md-prop__title">
          <span className="medium" translate="no">
            {cleanName(name) || p.displayName}
          </span>{" "}
          <span className="muted">{where}</span>
        </div>
        <span className="md-prop__docs">
          <span>
            {`Do ${plural(docs.length || 1, "document")} đề xuất`}
            {seen.length ? ":" : ""}
          </span>
          {seen.map((c, i) => (
            <span key={c} className="row">
              {i ? <span aria-hidden="true">,</span> : null}
              <NextLink className="md-prop__doc link" href={docsHref("review", { sel: resourceId(c) })}>
                <span className="truncate" translate="no">
                  {titles.get(c)}
                </span>
              </NextLink>
            </span>
          ))}
          {seen.length && docs.length > seen.length ? <span>{`+${docs.length - seen.length} nữa`}</span> : null}
        </span>
        {edit ? (
          <div className="md-prop__edit">
            {edit === "name" ? (
              <TextField value={name} onChange={(v) => (setName(v), setErr(""))} isInvalid={!!err} maxLength={60} autoFocus className="field">
                <Label>Tên chủ đề</Label>
                <Input
                  translate="no"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void accept();
                  }}
                />
                <FieldError>{err}</FieldError>
              </TextField>
            ) : edit === "domain" ? (
              <>
                <div className="field">
                  <span className="label">Lĩnh vực</span>
                  <PlainSelect
                    label="Lĩnh vực"
                    value={parent}
                    options={[...domains.map((d) => [d.name ?? "", d.displayName ?? ""] as const), [NEW_DOMAIN, "Lĩnh vực mới…"] as const]}
                    onChange={(v) => (setParent(v), setErr(""))}
                  />
                  {err ? <div className="field-error">{err}</div> : null}
                </div>
                {parent === NEW_DOMAIN ? (
                  <TextField value={dname} onChange={setDname} maxLength={60} className="field">
                    <Label>Tên lĩnh vực mới</Label>
                    <Input translate="no" />
                  </TextField>
                ) : null}
              </>
            ) : (
              <div className="field">
                <span className="label">Hợp nhất vào</span>
                <PlainSelect
                  label="Hợp nhất vào"
                  value={into}
                  placeholder="Chọn một chủ đề"
                  options={tree.flatMap((d) => d.children.map((t) => [t.name ?? "", `${d.displayName} · ${t.displayName}`] as const))}
                  onChange={(v) => (setInto(v), setErr(""))}
                />
                {err ? <div className="field-error">{err}</div> : null}
              </div>
            )}
          </div>
        ) : null}
      </div>
      <div className="md-prop__acts">
        {!canDecide ? (
          <span className="t-xs muted">Quản trị viên không gian làm việc quyết định</span>
        ) : (
          <>
            {edit ? (
              <Button variant="ghost" size="sm" onPress={() => open("")}>
                Hủy
              </Button>
            ) : null}
            {edit === "merge" ? (
              <Button variant="secondary" size="sm" onPress={() => merge()}>
                <GitCompare className="i" aria-hidden />
                Hợp nhất
              </Button>
            ) : (
              <Button variant="secondary" size="sm" onPress={() => void accept()} isPending={busy}>
                <Check className="i" aria-hidden />
                Chấp nhận
              </Button>
            )}
            <ActionsMenu
              actions={[
                { id: "rename", label: "Đổi tên…", icon: Pencil, onAction: () => open("name") },
                { id: "domain", label: "Đổi lĩnh vực…", icon: Folder, onAction: () => open("domain") },
                { id: "merge", label: "Hợp nhất vào…", icon: GitCompare, isDisabled: !tree.length, onAction: () => open("merge") },
                { id: "dismiss", label: "Bỏ qua", icon: X, danger: true, onAction: () => dismiss() },
              ]}
            />
          </>
        )}
      </div>
    </li>
  );
}
