"use client";

import { Button, Dropdown, FieldError, Header, Input, Label, ListBox, Select, TextField } from "@heroui/react";
import { Check, ChevronDown, Sparkles, Tag } from "lucide-react";
import NextLink from "next/link";
import { useMemo, useState } from "react";

import { FileIcon, ItemIcon, Section, StatusChip, toast } from "@/components/ui";
import { errorMessage, resourceId } from "@/lib/api/client";
import { fmtNum, plural } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";
import { fold, topicTree, type Resource } from "@/modules/knowledge/model";

import { acceptTopic, createTopic, mergeTopic, rejectTopic, type Topic } from "../../api";
import { activeDomains, cleanName, nameTaken } from "../../governance";
import { useInvalidateCuration } from "../../queries";

const NEW = "__new";

/** What a proposal's evidence (contribution names) resolves to: documents the caller can open in the queue. */
export type EvidenceIndex = ReadonlyMap<string, Resource>;

interface ProposalsProps {
  proposals: readonly Topic[];
  topics: readonly Topic[];
  evidence: EvidenceIndex;
  admin: boolean;
}

/** "Proposed by the assistant" (preview `proposalsHtml`): accept, merge into an existing topic or dismiss. */
export function Proposals({ proposals, topics, evidence, admin }: ProposalsProps) {
  if (!proposals.length) return null;
  return (
    <Section
      title="Proposed by the assistant"
      description={admin ? "Accepting adds the topic and tags the documents that suggested it." : "Only workspace admins change topics."}
      actions={<StatusChip label={fmtNum(proposals.length)} size="sm" tone="accent" dot={false} />}
    >
      <div className="gov-props">
        {proposals.map((p) => (admin ? <ProposalForm key={p.name} p={p} topics={topics} evidence={evidence} /> : <ProposalCard key={p.name} p={p} topics={topics} evidence={evidence} />))}
      </div>
    </Section>
  );
}

function ProposalDocs({ p, evidence }: { p: Topic; evidence: EvidenceIndex }) {
  const names = p.evidence ?? [];
  const seen = names.flatMap((c) => {
    const r = evidence.get(c);
    return r ? [{ contribution: c, r }] : [];
  });
  const hidden = names.length - seen.length;
  const from = seen.length ? `Suggested by ${plural(names.length, "document")}` : `Suggested by ${plural(names.length, "document")} in knowledge bases you don’t review`;
  return (
    <div className="gov-prop__docs">
      <span className="t-xs muted gov-prop__from">{from}</span>
      {seen.map(({ contribution, r }) => (
        <NextLink key={contribution} className="gov-prop__doc link" href={`/documents?tab=review&sel=${resourceId(contribution)}`} title={r.title}>
          <FileIcon name={r.fileName} mime={r.mime} size="sm" />
          <span className="truncate" translate="no">
            {r.title}
          </span>
        </NextLink>
      ))}
      {hidden && seen.length ? <span className="t-xs muted">{`+${hidden} you can’t see`}</span> : null}
    </div>
  );
}

/** Read-only card for people who can see proposals but not decide them. */
function ProposalCard({ p, topics, evidence }: { p: Topic; topics: readonly Topic[]; evidence: EvidenceIndex }) {
  const domain = topics.find((t) => t.name === p.parentTopic && t.state === "ACTIVE");
  return (
    <article className="gov-prop">
      <div className="gov-prop__main">
        <div className="gov-prop__title">
          <ItemIcon icon={Sparkles} tone="accent" size="sm" />
          <span className="medium truncate" translate="no">
            {p.displayName}
          </span>
          <span className="t-sm muted truncate">{domain ? <>in <span translate="no">{domain.displayName}</span></> : "New domain"}</span>
        </div>
        <ProposalDocs p={p} evidence={evidence} />
      </div>
    </article>
  );
}

function ProposalForm({ p, topics, evidence }: { p: Topic; topics: readonly Topic[]; evidence: EvidenceIndex }) {
  const { id: ws } = useWorkspace();
  const invalidate = useInvalidateCuration();
  const domains = useMemo(() => activeDomains(topics), [topics]);
  const tree = useMemo(() => topicTree(topics).filter((d) => d.children.length), [topics]);
  const [name, setName] = useState(p.displayName ?? "");
  const [parent, setParent] = useState(p.parentTopic && domains.some((d) => d.name === p.parentTopic) ? p.parentTopic : NEW);
  const [dname, setDname] = useState(p.displayName ?? "");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const tagged = p.evidence?.length ?? 0;
  const taggedNote = tagged ? ` · ${plural(tagged, "document")} tagged` : "";
  const fail = (error: unknown) => toast(errorMessage(error), { tone: "danger" });

  async function accept() {
    const clean = cleanName(name);
    const isNew = parent === NEW || !domains.some((d) => d.name === parent);
    const domainName = cleanName(dname) || clean;
    if (!clean) return setErr("Enter a name.");
    const parentLabel = domains.find((d) => d.name === parent)?.displayName ?? "";
    if (!isNew && nameTaken(topics, clean, parent, p.name)) return setErr(`${parentLabel} already has “${clean}”. Merge into it instead.`);
    if (isNew && domains.some((d) => fold(d.displayName ?? "") === fold(domainName))) return setErr(`A domain called “${domainName}” already exists. Pick it from the list.`);
    setErr("");
    setBusy(true);
    try {
      const domain = isNew ? await createTopic(ws, { displayName: domainName, kind: "DOMAIN" }) : null;
      const target = domain?.name ?? parent;
      await acceptTopic(ws, p.name ?? "", { parentTopic: target, displayName: clean !== p.displayName ? clean : undefined });
      invalidate();
      toast(`Added “${clean}” to ${domain?.displayName ?? parentLabel}${taggedNote}`);
    } catch (error) {
      invalidate();
      fail(error);
    } finally {
      setBusy(false);
    }
  }

  async function merge(target: string) {
    const label = topics.find((t) => t.name === target)?.displayName ?? "the topic";
    setBusy(true);
    try {
      await mergeTopic(ws, p.name ?? "", target);
      invalidate();
      toast(`Merged “${p.displayName}” into ${label}${taggedNote}`);
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  }

  async function dismiss() {
    setBusy(true);
    try {
      await rejectTopic(ws, p.name ?? "");
      invalidate();
      toast(`Dismissed “${p.displayName}”`);
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="gov-prop">
      <div className="gov-prop__main">
        <div className="gov-prop__fields">
          <ItemIcon icon={Sparkles} tone="accent" size="sm" />
          <TextField
            value={name}
            onChange={(v) => {
              setName(v);
              setErr("");
            }}
            isInvalid={!!err}
            maxLength={60}
            className="gov-prop__field"
          >
            <Label>Topic name</Label>
            <Input
              translate="no"
              onKeyDown={(e) => {
                if (e.key === "Enter") void accept();
              }}
            />
            <FieldError>{err}</FieldError>
          </TextField>
          <Select value={parent} onChange={(v) => setParent(String(v))} className="gov-prop__field">
            <Label>Domain</Label>
            <Select.Trigger>
              <Select.Value translate="no" />
              <Select.Indicator />
            </Select.Trigger>
            <Select.Popover>
              <ListBox>
                {domains.map((d) => (
                  <ListBox.Item key={d.name} id={d.name ?? ""} textValue={d.displayName}>
                    <span translate="no">{d.displayName}</span>
                    <ListBox.ItemIndicator />
                  </ListBox.Item>
                ))}
                <ListBox.Item id={NEW} textValue="New domain…">
                  New domain…
                  <ListBox.ItemIndicator />
                </ListBox.Item>
              </ListBox>
            </Select.Popover>
          </Select>
          {parent === NEW ? (
            <TextField value={dname} onChange={setDname} maxLength={60} className="gov-prop__field">
              <Label>New domain name</Label>
              <Input translate="no" />
            </TextField>
          ) : null}
        </div>
        <ProposalDocs p={p} evidence={evidence} />
      </div>
      <div className="gov-prop__acts">
        <Button size="sm" variant="primary" isPending={busy} onPress={() => void accept()}>
          <Check className="i" aria-hidden />
          Accept
        </Button>
        <Dropdown>
          <Button size="sm" variant="tertiary" isDisabled={busy}>
            Merge into…
            <ChevronDown className="i" aria-hidden />
          </Button>
          <Dropdown.Popover placement="bottom end">
            {tree.length ? (
              <Dropdown.Menu aria-label="Merge into" onAction={(key) => void merge(String(key))}>
                {tree.map((d) => (
                  <Dropdown.Section key={d.name}>
                    <Header translate="no">{d.displayName}</Header>
                    {d.children.map((t) => (
                      <Dropdown.Item key={t.name} id={t.name ?? ""} textValue={t.displayName}>
                        <Tag className="i" aria-hidden />
                        <Label translate="no">{t.displayName}</Label>
                      </Dropdown.Item>
                    ))}
                  </Dropdown.Section>
                ))}
              </Dropdown.Menu>
            ) : (
              <Dropdown.Menu aria-label="Merge into" disabledKeys={["none"]}>
                <Dropdown.Item id="none" textValue="No topics yet">
                  <Label>No topics yet</Label>
                </Dropdown.Item>
              </Dropdown.Menu>
            )}
          </Dropdown.Popover>
        </Dropdown>
        <Button size="sm" variant="ghost" isDisabled={busy} onPress={() => void dismiss()}>
          Dismiss
        </Button>
      </div>
    </article>
  );
}
