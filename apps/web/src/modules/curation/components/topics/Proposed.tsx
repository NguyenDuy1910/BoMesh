"use client";

import { Button, FieldError, Input, Label, TextField } from "@heroui/react";
import { Check, Folder, GitCompare, Pencil, Sparkles, X } from "lucide-react";
import NextLink from "next/link";
import { useMemo, useState } from "react";

import { ItemIcon } from "@/components/ui";
import { resourceId } from "@/lib/api/client";
import { plural } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";
import { fold, topicTree } from "@/modules/knowledge/model";

import { acceptTopic, createTopic, mergeTopic, rejectTopic, updateTopic, type Topic } from "../../api";
import { holdDecision } from "../../decisions";
import { activeDomains, cleanName, nameTaken, topicSignals } from "../../governance";
import { docsHref } from "../../model";
import { useInvalidateCuration, useReviewQueue } from "../../queries";
import { PlainSelect } from "../parts";
import { ActionsMenu } from "../shared";

const NEW_DOMAIN = "__new";

/**
 * Topics → Suggestions → New topics the assistant proposes (preview `proposals`/`propCard`): a proposal reads as a
 * sentence (name, in which domain, why) with Accept; editing opens only when Rename, Change domain or Merge is chosen.
 * Proposals are decided only here, by workspace admins (`topics.accept`); publishing never waits for them.
 * `proposals` excludes the ones with a decision in its Undo window.
 */
export function ProposedList({ proposals, topics }: { proposals: readonly Topic[]; topics: readonly Topic[] }) {
  const { can } = useWorkspace();
  const queue = useReviewQueue();
  /** Contribution name → document title, for the submissions the caller reviews. */
  const titles = useMemo(
    () =>
      new Map(
        (queue.data ?? []).map((s) => [s.contribution.name ?? "", (s.item?.displayName || s.item?.document?.fileName || "Untitled document").replace(/\.[a-z0-9]{1,5}$/i, "")]),
      ),
    [queue.data],
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
  const docs = p.evidence ?? [];
  const seen = docs.filter((c) => titles.has(c));
  const tagged = docs.length ? ` · ${plural(docs.length, "document")} tagged` : "";
  const domain = domains.find((d) => d.name === parent);
  /** Accept, Merge and Dismiss are final in the API, so each is held for the Undo window and only then sent. */
  const hold = (message: string, undoneMessage: string, send: () => Promise<void>) =>
    holdDecision({ names: [p.name ?? ""], message, undoneMessage, send, onSent: invalidate, onFailed: invalidate });
  const open = (mode: typeof edit) => {
    setEdit(mode);
    setErr("");
  };

  function accept() {
    const clean = cleanName(name);
    const isNew = !domain;
    const domainName = cleanName(dname) || clean;
    if (!clean) {
      setErr("Enter a name.");
      setEdit("name");
      return;
    }
    if (!isNew && nameTaken(topics, clean, parent, p.name)) {
      setErr(`${domain.displayName} already has “${clean}”. Merge into it instead.`);
      setEdit("name");
      return;
    }
    if (isNew && domains.some((d) => fold(d.displayName ?? "") === fold(domainName))) {
      setErr(`A domain called “${domainName}” already exists. Pick it from the list.`);
      setEdit("domain");
      return;
    }
    hold(`Added “${clean}” to ${isNew ? domainName : (domain?.displayName ?? "")}${tagged}`, `“${clean}” is proposed again`, async () => {
      const made = isNew ? await createTopic(ws, { displayName: domainName, kind: "DOMAIN" }) : null;
      await acceptTopic(ws, p.name ?? "", { parentTopic: made?.name ?? parent, displayName: clean !== p.displayName ? clean : undefined, etag: p.etag });
    });
  }

  function merge() {
    const target = topics.find((t) => t.name === into);
    if (!target) {
      setErr("Choose the topic to merge into.");
      return;
    }
    // The proposal's name becomes a synonym of the topic it joins, so the next document like it is classified there.
    const synonym = (p.displayName ?? "").toLowerCase();
    const known = !synonym || topicSignals(target).some((k) => fold(k) === fold(synonym));
    hold(`Merged “${p.displayName}” into ${target.displayName}${tagged}`, `“${p.displayName}” is proposed again`, async () => {
      if (!known) await updateTopic(ws, target, { synonyms: [...(target.synonyms ?? []), synonym] });
      await mergeTopic(ws, p.name ?? "", target.name ?? "");
    });
  }

  const dismiss = () => hold(`Dismissed “${p.displayName}”`, `“${p.displayName}” is proposed again`, () => rejectTopic(ws, p.name ?? "").then(() => undefined));

  const where = domain ? (
    <>
      in <span translate="no">{domain.displayName}</span>
    </>
  ) : (
    <>
      as a new domain
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
            {`Suggested by ${plural(docs.length || 1, "document")}`}
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
          {seen.length && docs.length > seen.length ? <span>{`+${docs.length - seen.length} more`}</span> : null}
        </span>
        {edit ? (
          <div className="md-prop__edit">
            {edit === "name" ? (
              <TextField value={name} onChange={(v) => (setName(v), setErr(""))} isInvalid={!!err} maxLength={60} autoFocus className="field">
                <Label>Topic name</Label>
                <Input
                  translate="no"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") accept();
                  }}
                />
                <FieldError>{err}</FieldError>
              </TextField>
            ) : edit === "domain" ? (
              <>
                <div className="field">
                  <span className="label">Domain</span>
                  <PlainSelect
                    label="Domain"
                    value={parent}
                    options={[...domains.map((d) => [d.name ?? "", d.displayName ?? ""] as const), [NEW_DOMAIN, "New domain…"] as const]}
                    onChange={(v) => (setParent(v), setErr(""))}
                  />
                  {err ? <div className="field-error">{err}</div> : null}
                </div>
                {parent === NEW_DOMAIN ? (
                  <TextField value={dname} onChange={setDname} maxLength={60} className="field">
                    <Label>New domain name</Label>
                    <Input translate="no" />
                  </TextField>
                ) : null}
              </>
            ) : (
              <div className="field">
                <span className="label">Merge into</span>
                <PlainSelect
                  label="Merge into"
                  value={into}
                  placeholder="Choose a topic"
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
          <span className="t-xs muted">A workspace admin decides</span>
        ) : (
          <>
            {edit ? (
              <Button variant="ghost" size="sm" onPress={() => open("")}>
                Cancel
              </Button>
            ) : null}
            {edit === "merge" ? (
              <Button variant="secondary" size="sm" onPress={() => merge()}>
                <GitCompare className="i" aria-hidden />
                Merge
              </Button>
            ) : (
              <Button variant="secondary" size="sm" onPress={() => accept()}>
                <Check className="i" aria-hidden />
                Accept
              </Button>
            )}
            <ActionsMenu
              actions={[
                { id: "rename", label: "Rename…", icon: Pencil, onAction: () => open("name") },
                { id: "domain", label: "Change domain…", icon: Folder, onAction: () => open("domain") },
                { id: "merge", label: "Merge into…", icon: GitCompare, isDisabled: !tree.length, onAction: () => open("merge") },
                { id: "dismiss", label: "Dismiss", icon: X, danger: true, onAction: () => dismiss() },
              ]}
            />
          </>
        )}
      </div>
    </li>
  );
}
