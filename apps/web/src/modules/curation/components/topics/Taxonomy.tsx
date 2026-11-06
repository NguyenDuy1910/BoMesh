"use client";

import { Button, Input } from "@heroui/react";
import { Archive, CircleAlert, Pencil, Plus, Tag } from "lucide-react";
import NextLink from "next/link";
import { useState } from "react";

import { EmptyState, IconButton, Section, StatusChip, Tip, toast } from "@/components/ui";
import { errorMessage, resourceId } from "@/lib/api/client";
import { fmtNum, plural } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";
import { catalogHref } from "@/modules/knowledge/model";

import { createTopic, deleteTopic, renameTopic, undeleteTopic, type Topic } from "../../api";
import { activeDomains, cleanName, nameTaken, type TopicCounts } from "../../governance";
import { useInvalidateCuration } from "../../queries";

/** `""` = not editing; `new:` = new domain; `new:<domain name>` = new topic there; else the topic being renamed. */
interface EditState {
  edit: string;
  name: string;
  err: string;
}
const IDLE: EditState = { edit: "", name: "", err: "" };

/** "12 published · 2 in review": published links to Browse, in review to the queue. */
function CountLinks({ topic, published, inReview }: { topic: string; published: number; inReview: number }) {
  if (!published && !inReview) return <span className="kh-count muted">Unused</span>;
  return (
    <span className="gov-counts">
      {published ? (
        <NextLink className="kh-count link" href={catalogHref({ filters: { topic: [resourceId(topic)] } })}>
          {`${fmtNum(published)} published`}
        </NextLink>
      ) : null}
      {published && inReview ? (
        <span className="kh-count muted" aria-hidden>
          ·
        </span>
      ) : null}
      {inReview ? (
        <NextLink className="kh-count link gov-inreview" href="/documents?tab=review">
          {`${fmtNum(inReview)} in review`}
        </NextLink>
      ) : null}
    </span>
  );
}

function Editor({ state, label, busy, onChange, onSave, onCancel }: { state: EditState; label: string; busy: boolean; onChange: (name: string) => void; onSave: () => void; onCancel: () => void }) {
  return (
    <div className="kh-edit">
      <div className="kh-edit__row">
        <Input
          autoFocus
          aria-label={label}
          placeholder={label}
          value={state.name}
          maxLength={60}
          aria-invalid={state.err ? true : undefined}
          aria-describedby={state.err ? "kh-topic-name-err" : undefined}
          translate="no"
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onSave();
            if (e.key === "Escape") {
              e.stopPropagation();
              onCancel();
            }
          }}
        />
        <Button size="sm" variant="primary" isPending={busy} onPress={onSave}>
          Save
        </Button>
        <Button size="sm" variant="ghost" isDisabled={busy} onPress={onCancel}>
          Cancel
        </Button>
      </div>
      {state.err ? (
        <div className="field-error" id="kh-topic-name-err" role="alert">
          <CircleAlert className="i" aria-hidden />
          <span>{state.err}</span>
        </div>
      ) : null}
    </div>
  );
}

/** Taxonomy editor (preview `taxonomyHtml`): domains with their topics; admins add, rename, archive and restore. */
export function Taxonomy({ topics, counts, admin }: { topics: readonly Topic[]; counts: TopicCounts; admin: boolean }) {
  const { id: ws } = useWorkspace();
  const invalidate = useInvalidateCuration();
  const [state, setState] = useState<EditState>(IDLE);
  const [busy, setBusy] = useState(false);
  const domains = activeDomains(topics);
  const byName = new Map(topics.map((t) => [t.name ?? "", t]));
  const liveTopics = topics.filter((t) => t.kind === "TOPIC" && t.state === "ACTIVE").length;
  const fail = (error: unknown) => toast(errorMessage(error), { tone: "danger" });
  const start = (edit: string, name = "") => admin && setState({ edit, name, err: "" });
  const cancel = () => setState(IDLE);

  async function save() {
    if (!admin || busy) return;
    const name = cleanName(state.name);
    const isNew = state.edit.startsWith("new:");
    const cur = isNew ? null : byName.get(state.edit);
    if (!isNew && !cur) return cancel();
    const parent = isNew ? state.edit.slice(4) || null : cur?.kind === "TOPIC" ? (cur.parentTopic ?? null) : null;
    const parentLabel = parent ? (byName.get(parent)?.displayName ?? "") : "";
    if (!name) return setState((s) => ({ ...s, err: "Enter a name." }));
    if (nameTaken(topics, name, parent, cur?.name)) {
      return setState((s) => ({ ...s, err: parent ? `${parentLabel} already has “${name}”.` : `A domain called “${name}” already exists.` }));
    }
    if (cur && cur.displayName === name) return cancel();
    setBusy(true);
    try {
      if (cur) {
        const before = cur.displayName ?? "";
        const renamed = await renameTopic(ws, cur, name);
        cancel();
        invalidate();
        toast(`Renamed to “${name}”`, { undo: () => void renameTopic(ws, renamed, before).then(invalidate, fail) });
      } else {
        const created = await createTopic(ws, { displayName: name, kind: parent ? "TOPIC" : "DOMAIN", parentTopic: parent ?? undefined });
        cancel();
        invalidate();
        toast(parent ? `Added “${name}” to ${parentLabel}` : `Added the domain “${name}”`, {
          undo: () => void deleteTopic(ws, created.name ?? "").then(invalidate, fail),
        });
      }
    } catch (error) {
      setState((s) => ({ ...s, err: errorMessage(error) }));
    } finally {
      setBusy(false);
    }
  }

  async function archive(t: Topic) {
    try {
      await deleteTopic(ws, t.name ?? "");
      invalidate();
      toast(`Archived “${t.displayName}”`, { undo: () => void undeleteTopic(ws, t.name ?? "").then(invalidate, fail) });
    } catch (error) {
      invalidate();
      fail(error);
    }
  }

  async function restore(t: Topic) {
    try {
      await undeleteTopic(ws, t.name ?? "");
      invalidate();
      toast(`Restored “${t.displayName}”`);
    } catch (error) {
      fail(error);
    }
  }

  const editor = (label: string) => <Editor state={state} label={label} busy={busy} onChange={(name) => setState((s) => ({ ...s, name, err: "" }))} onSave={() => void save()} onCancel={cancel} />;

  const blocks = domains.map((dm) => {
    const list = topics.filter((t) => t.kind === "TOPIC" && t.parentTopic === dm.name && (t.state === "ACTIVE" || (admin && t.state === "DELETED")));
    const name = dm.name ?? "";
    return (
      <section key={name} className="kh-domain">
        <div className="kh-domain__head">
          {state.edit === name ? (
            editor("Domain name")
          ) : (
            <>
              <h3 className="kh-domain__name" translate="no">
                {dm.displayName}
              </h3>
              <CountLinks topic={name} published={counts.domain(name)} inReview={counts.reviewDomain(name)} />
              <span className="grow" />
              {admin ? (
                <>
                  <IconButton icon={Pencil} tip="Rename domain" size="sm" onPress={() => start(name, dm.displayName)} />
                  <Button size="sm" variant="ghost" onPress={() => start(`new:${name}`)}>
                    <Plus className="i" aria-hidden />
                    Add topic
                  </Button>
                </>
              ) : null}
            </>
          )}
        </div>
        {list.length || state.edit === `new:${name}` ? (
          <ul className="kh-topics">
            {list.map((t) => {
              const tn = t.name ?? "";
              if (state.edit === tn) {
                return (
                  <li key={tn} className="kh-topic">
                    {editor("Topic name")}
                  </li>
                );
              }
              if (t.state === "DELETED") {
                return (
                  <li key={tn} className="kh-topic is-archived">
                    <Archive className="i i-sm muted" aria-hidden />
                    <span className="grow truncate" translate="no">
                      {t.displayName}
                    </span>
                    <StatusChip label="Archived" size="sm" dot={false} />
                    <Button size="sm" variant="ghost" onPress={() => void restore(t)}>
                      Restore
                    </Button>
                  </li>
                );
              }
              const used = counts.topic(tn) + counts.review(tn);
              return (
                <li key={tn} className="kh-topic">
                  <Tag className="i i-sm muted" aria-hidden />
                  <span className="grow truncate kh-topic__name" translate="no">
                    {t.displayName}
                  </span>
                  <CountLinks topic={tn} published={counts.topic(tn)} inReview={counts.review(tn)} />
                  {admin ? (
                    <span className="kh-topic__acts">
                      <IconButton icon={Pencil} tip="Rename topic" size="sm" onPress={() => start(tn, t.displayName)} />
                      {used ? (
                        <Tip content={`Used by ${plural(used, "document")}. Move them to another topic first.`}>
                          <span className="kh-tipwrap">
                            <Button isIconOnly size="sm" variant="ghost" className="button--muted" isDisabled aria-label="Archive topic">
                              <Archive aria-hidden />
                            </Button>
                          </span>
                        </Tip>
                      ) : (
                        <IconButton icon={Archive} tip="Archive topic" size="sm" onPress={() => void archive(t)} />
                      )}
                    </span>
                  ) : null}
                </li>
              );
            })}
            {state.edit === `new:${name}` ? <li className="kh-topic">{editor("Topic name")}</li> : null}
          </ul>
        ) : (
          <p className="kh-domain__empty t-sm muted">No topics yet.</p>
        )}
      </section>
    );
  });
  if (state.edit === "new:") {
    blocks.push(
      <section key="new:" className="kh-domain">
        <div className="kh-domain__head">{editor("Domain name")}</div>
      </section>,
    );
  }

  return (
    <Section
      title="Topics"
      description={`${plural(liveTopics, "topic")} in ${plural(domains.length, "domain")}${admin ? "" : " · Only workspace admins change topics."}`}
      actions={
        admin ? (
          <Button size="sm" variant="tertiary" isDisabled={state.edit === "new:"} onPress={() => start("new:")}>
            <Plus className="i" aria-hidden />
            Add domain
          </Button>
        ) : null
      }
    >
      {blocks.length ? (
        <div className="kh-domains">{blocks}</div>
      ) : (
        <EmptyState
          icon={Tag}
          title="No topics yet"
          description={admin ? "Add a domain, then the topics people browse by." : "A workspace admin can add topics."}
          actions={
            admin ? (
              <Button variant="primary" onPress={() => start("new:")}>
                <Plus className="i" aria-hidden />
                Add domain
              </Button>
            ) : null
          }
          boxed
        />
      )}
    </Section>
  );
}
