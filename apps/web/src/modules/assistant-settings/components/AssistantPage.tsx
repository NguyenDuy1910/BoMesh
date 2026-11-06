"use client";

import { Button, Description, FieldError, Input, Label, Skeleton, TextArea, TextField } from "@heroui/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, FileText, Paperclip, Plus, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";

import { PageChrome } from "@/components/shell/page-chrome";
import { ChoiceGroup, ErrorState, IconButton, Page, PageHeader, SaveBar, Segmented, SkeletonCards, StatusChip, SwitchRow, toast } from "@/components/ui";
import { errorMessage } from "@/lib/api/client";
import { fmtNum, plural } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";
import { chatKeys, getAssistant } from "@/modules/chat/api";
import { useRolesQuery } from "@/modules/people/queries";

import { updateAssistant } from "../api";
import {
  MAX_INSTRUCTIONS,
  MAX_STARTERS,
  MAX_WELCOME,
  STYLES,
  draftErrors,
  draftKey,
  moveStarter,
  rolesOf,
  starterKey,
  toDraft,
  toPatch,
  type AssistantDraft,
  type AssistantLike,
  type Starter,
} from "../model";

function Card({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <div className="card">
      <div className="card__header">
        <div className="grow">
          <h3 className="card__title">{title}</h3>
          {description ? <p className="card__description">{description}</p> : null}
        </div>
      </div>
      {children}
    </div>
  );
}

const Counter = ({ n, max }: { n: number; max: number }) => <span className={n > max ? "counter asst-over" : "counter"}>{`${fmtNum(n)}/${fmtNum(max)}`}</span>;

/** Assistant (preview `P.assistant`): a local draft with a live preview; Publish writes the workspace assistant. */
export function AssistantPage() {
  const { id: ws } = useWorkspace();
  const query = useQuery({ queryKey: chatKeys.assistant(ws), queryFn: () => getAssistant(ws) });
  return (
    <Page>
      <PageChrome crumbs={[{ label: "Assistant" }]} />
      <PageHeader title="Assistant" description="How it answers and what people see first." />
      {query.data ? (
        <AssistantEditor key={query.data.etag} published={query.data as AssistantLike} />
      ) : query.isError ? (
        <ErrorState error={query.error} title="Assistant settings didn’t load" onRetry={() => void query.refetch()} />
      ) : (
        <div className="asst-layout">
          <div className="stack gap-16">
            <SkeletonCards cards={2} columns="cols-auto" />
          </div>
          <div className="card">
            <Skeleton style={{ height: 280 }} />
          </div>
        </div>
      )}
    </Page>
  );
}

function AssistantEditor({ published }: { published: AssistantLike }) {
  const router = useRouter();
  const qc = useQueryClient();
  const { id: ws } = useWorkspace();
  const workspaceRoles = useRolesQuery();
  const [draft, setDraft] = useState<AssistantDraft>(() => toDraft(published));
  const [tried, setTried] = useState(false);
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const roles = rolesOf(draft);
  const [role, setRole] = useState(roles?.[0] ?? "");
  const current = roles ? (roles.includes(role) ? role : roles[0]) : "";
  const list = draft.starters[current] ?? [];
  const errs = draftErrors(draft);
  const show = (k: string) => (errs[k] && (tried || touched[k] || k === "instructions") ? errs[k] : "");
  const nErr = Object.keys(errs).length;
  const dirty = draftKey(draft) !== draftKey(toDraft(published));
  const roleLabel = (name: string) => workspaceRoles.data?.find((r) => r.name === name)?.label ?? "Members";
  const touch = (k: string) => setTouched((t) => (t[k] ? t : { ...t, [k]: true }));
  const setList = (next: Starter[]) => setDraft((d) => ({ ...d, starters: { ...d.starters, [current]: next } }));

  async function publish() {
    if (busy) return;
    if (nErr) {
      setTried(true);
      const bad = roles?.find((r) => Object.keys(errs).some((k) => k.startsWith(`${r}-st`)));
      if (bad && !Object.keys(errs).some((k) => k.startsWith(`${current}-st`))) setRole(bad);
      requestAnimationFrame(() => document.querySelector<HTMLElement>('.asst-form [aria-invalid="true"]')?.focus());
      return;
    }
    setBusy(true);
    try {
      const { body, updateMask } = toPatch(draft, published);
      const saved = await updateAssistant(ws, body, updateMask);
      qc.setQueryData(chatKeys.assistant(ws), saved);
      toast("Assistant published", { action: { label: "Open chat", onPress: () => router.push("/chat") } });
    } catch (error) {
      toast(errorMessage(error), { tone: "danger" });
      setBusy(false);
    }
  }

  const discard = () => {
    setDraft(toDraft(published));
    setTried(false);
    setTouched({});
    toast("Changes discarded", { tone: "accent" });
  };

  const welcome = draft.welcome.trim();
  const tiles = list.filter((s) => s.title.trim() || s.prompt.trim());
  const cite = (n: number) => <sup className="asst-cite">{n}</sup>;

  return (
    <>
      <div className="asst-layout">
        <div className="asst-form">
          <Card title="Instructions">
            <TextField value={draft.instructions} onChange={(instructions) => setDraft((d) => ({ ...d, instructions }))} isInvalid={Boolean(show("instructions"))} aria-label="Instructions">
              <TextArea rows={7} />
              {show("instructions") ? (
                <FieldError>{show("instructions")}</FieldError>
              ) : (
                <div className="row between gap-12">
                  <Description>Who it serves, what to prioritise, what to avoid.</Description>
                  <Counter n={draft.instructions.length} max={MAX_INSTRUCTIONS} />
                </div>
              )}
            </TextField>
          </Card>
          <Card title="Answer style">
            <div className="asst-style">
              <ChoiceGroup
                label="Answer style"
                name="asst-style"
                columns={3}
                value={draft.style}
                onChange={(style) => setDraft((d) => ({ ...d, style }))}
                options={STYLES.map((s) => ({ value: s.value, title: s.title, description: s.description }))}
              />
            </div>
          </Card>
          <Card title="Capabilities">
            <div className="asst-switches">
              <SwitchRow title="Search company knowledge" description="Always on. Answers come from your knowledge." isSelected isDisabled onChange={() => undefined} />
              <SwitchRow title="Cite sources" description="Every claim links to the passage it came from." isSelected isDisabled onChange={() => undefined} />
              <SwitchRow title="Analyze files and data" description="Read spreadsheets and calculate." isSelected={draft.fileWork} onChange={(fileWork) => setDraft((d) => ({ ...d, fileWork }))} />
              <SwitchRow title="Create files" description="Produce documents and spreadsheets." isSelected={draft.fileWork} onChange={(fileWork) => setDraft((d) => ({ ...d, fileWork }))} />
            </div>
          </Card>
          <Card title="Chat home" description={roles ? "What people see when they start a new chat. Each role gets its own starters." : "What people see when they start a new chat."}>
            <TextField value={draft.welcome} onChange={(v) => (setDraft((d) => ({ ...d, welcome: v })), touch("welcome"))} isRequired isInvalid={Boolean(show("welcome"))}>
              <Label>Welcome message</Label>
              <Input placeholder="What can I help you find?" translate="no" />
              {show("welcome") ? (
                <FieldError>{show("welcome")}</FieldError>
              ) : (
                <div className="row between gap-12">
                  <span />
                  <Counter n={draft.welcome.length} max={MAX_WELCOME} />
                </div>
              )}
            </TextField>
            <div className="row between mt-8">
              <span className="label">{roles ? "Starters by role" : "Starters"}</span>
              <span className="t-xs muted">
                {list.length}/{MAX_STARTERS}
              </span>
            </div>
            {roles ? (
              <div className="asst-roles">
                <Segmented label="Starters for" value={current} onChange={setRole} options={roles.map((r) => ({ value: r, label: roleLabel(r) }))} />
              </div>
            ) : null}
            {list.length ? (
              <div className="asst-starters">
                {list.map((s, i) => {
                  const tk = starterKey(current, i, "t");
                  const pk = starterKey(current, i, "p");
                  const edit = (patch: Partial<Starter>, key: string) => {
                    setList(list.map((x, j) => (j === i ? { ...x, ...patch } : x)));
                    touch(key);
                  };
                  return (
                    <div key={i} className="asst-starter" role="group" aria-label={`Starter ${i + 1}`}>
                      <span className="asst-starter__n" aria-hidden>
                        {i + 1}
                      </span>
                      <div className="asst-starter__fields">
                        <TextField value={s.title} onChange={(title) => edit({ title }, tk)} isInvalid={Boolean(show(tk))} maxLength={40}>
                          <Label>Title</Label>
                          <Input placeholder="Find a policy" translate="no" />
                          <FieldError>{show(tk)}</FieldError>
                        </TextField>
                        <TextField value={s.prompt} onChange={(prompt) => edit({ prompt }, pk)} isInvalid={Boolean(show(pk))} maxLength={160}>
                          <Label>Prompt</Label>
                          <Input placeholder="What does our travel policy say about per diem?" translate="no" />
                          <FieldError>{show(pk)}</FieldError>
                        </TextField>
                      </div>
                      <div className="asst-starter__actions">
                        <IconButton icon={ArrowUp} tip="Move up" size="sm" isDisabled={i === 0} onPress={() => (setList(moveStarter(list, i, -1)), setTouched({}))} />
                        <IconButton icon={ArrowDown} tip="Move down" size="sm" isDisabled={i === list.length - 1} onPress={() => (setList(moveStarter(list, i, 1)), setTouched({}))} />
                        <IconButton icon={Trash2} tip="Remove starter" size="sm" onPress={() => (setList(list.filter((_, j) => j !== i)), setTouched({}))} />
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="t-sm muted">No starters. {roles ? `${roleLabel(current)}s see` : "People see"} only the welcome message.</p>
            )}
            <div>
              <Button
                size="sm"
                variant="secondary"
                isDisabled={list.length >= MAX_STARTERS}
                onPress={() => {
                  setList([...list, { title: "", prompt: "" }]);
                  requestAnimationFrame(() => document.querySelectorAll<HTMLInputElement>(".asst-starter input")[list.length * 2]?.focus());
                }}
              >
                <Plus className="i" aria-hidden />
                Add starter
              </Button>
            </div>
          </Card>
        </div>
        <aside className="asst-preview" aria-label="Preview">
          <div className="card asst-prev">
            <div className="row between">
              <span className="t-label">Preview</span>
              <span className="t-xs muted">{roles ? `As a ${roleLabel(current).toLowerCase()} sees it` : "As members see it"}</span>
            </div>
            <div className="asst-prev__home">
              <div className={welcome ? "asst-prev__welcome" : "asst-prev__welcome is-empty"} translate={welcome ? "no" : undefined}>
                {welcome || "Welcome message"}
              </div>
              <div className="asst-prev__composer">
                <span className="truncate">Ask anything…</span>
                <span className="row gap-6">
                  {draft.fileWork ? <Paperclip className="i i-sm" aria-hidden /> : null}
                  <span className="asst-prev__send">
                    <ArrowUp className="i i-sm" aria-hidden />
                  </span>
                </span>
              </div>
              {tiles.length ? (
                <div className="asst-prev__tiles">
                  {tiles.map((s, i) => (
                    <div key={i} className="asst-prev__tile" translate="no">
                      <div className="medium truncate">{s.title.trim() || "Untitled"}</div>
                      <div className="t-xs muted truncate">{s.prompt.trim() || "—"}</div>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
            <hr className="separator" />
            <div className="t-xs muted">Sample answer · {STYLES.find((s) => s.value === draft.style)?.title}</div>
            <div className="asst-prev__chat">
              <div className="asst-prev__q">What’s our per diem?</div>
              <div className="asst-prev__a">
                {draft.style === "CONCISE" ? (
                  <p>Domestic trips get $75 a day and international trips $110 a day for meals.{cite(1)}</p>
                ) : (
                  <>
                    <p>Per diem covers meals and incidentals on business trips.{cite(1)}</p>
                    <ul>
                      <li>Domestic: $75 a day</li>
                      <li>International: $110 a day{cite(1)}</li>
                      <li>Travel days are paid at 75%</li>
                    </ul>
                    {draft.style === "DETAILED" ? (
                      <>
                        <p className="asst-prev__sub">How to claim</p>
                        <ol>
                          <li>Log the trip in Concur within 30 days.{cite(2)}</li>
                          <li>Attach receipts only for lodging.</li>
                          <li>Your manager approves; Finance pays in the next cycle.</li>
                        </ol>
                        <p>For exceptions, ask Finance before you travel.</p>
                      </>
                    ) : null}
                  </>
                )}
                <div className="asst-prev__sources">
                  <StatusChip label="1 Travel & Expense Policy.pdf" icon={FileText} size="sm" />
                  {draft.style === "DETAILED" ? <StatusChip label="2 Expense How-to.docx" icon={FileText} size="sm" /> : null}
                </div>
              </div>
            </div>
          </div>
        </aside>
      </div>
      <SaveBar
        isDirty={dirty}
        isSaving={busy}
        onDiscard={discard}
        onSave={() => void publish()}
        saveLabel="Publish"
        message={`Unsaved changes${tried && nErr ? ` · ${plural(nErr, "field")} to fix` : ""}`}
      />
    </>
  );
}
