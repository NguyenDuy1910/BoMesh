"use client";

import { Button, Description, FieldError, Header, Input, Label, ListBox, Select, Skeleton, TextArea, TextField } from "@heroui/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Eye, FileText, Paperclip, Plus, SlidersHorizontal, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";

import { ChoiceGroup, Disclosure, ErrorState, IconButton, Page, PageHeader, SaveBar, SkeletonCards, StatusChip, SwitchRow, toast } from "@/components/ui";
import { errorMessage } from "@/lib/api/client";
import { fmtNum, plural } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";
import { chatKeys, getAssistant } from "@/modules/chat/api";
import { SideDrawer } from "@/modules/people/components/SideDrawer";
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
  startersFor,
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

/** Select key for the Everyone list (its audience is ""). */
const EVERYONE = "everyone";

/**
 * Assistant (preview `P.assistant`): a local draft with a live preview; Publish writes the workspace assistant.
 * Below 1024 px the preview sits behind the header's Preview button (a drawer).
 */
export function AssistantPage() {
  const { id: ws } = useWorkspace();
  const query = useQuery({ queryKey: chatKeys.assistant(ws), queryFn: () => getAssistant(ws) });
  const [previewing, setPreviewing] = useState(false);
  return (
    <Page>
      <PageHeader
        title="Assistant"
        actions={
          query.data ? (
            <Button variant="secondary" className="asst-prev-open" onPress={() => setPreviewing(true)}>
              <Eye className="i" aria-hidden />
              Preview
            </Button>
          ) : null
        }
      />
      {query.data ? (
        <AssistantEditor key={query.data.etag} published={query.data as AssistantLike} previewing={previewing} onPreviewClose={() => setPreviewing(false)} />
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

function AssistantEditor({ published, previewing, onPreviewClose }: { published: AssistantLike; previewing: boolean; onPreviewClose: () => void }) {
  const router = useRouter();
  const qc = useQueryClient();
  const { id: ws } = useWorkspace();
  const workspaceRoles = useRolesQuery();
  const [draft, setDraft] = useState<AssistantDraft>(() => toDraft(published));
  const [tried, setTried] = useState(false);
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [audience, setAudience] = useState("");
  const own = Boolean(audience && draft.starters[audience]);
  const list = startersFor(draft, audience);
  const listKey = own ? audience : "";
  const errs = draftErrors(draft);
  const show = (k: string) => (errs[k] && (tried || touched[k] || k === "instructions") ? errs[k] : "");
  const nErr = Object.keys(errs).length;
  const dirty = draftKey(draft) !== draftKey(toDraft(published));
  const roles = workspaceRoles.data ?? [];
  const roleName = (name: string) => roles.find((r) => r.name === name)?.label ?? "Members";
  const ownCount = rolesOf(draft)?.length ?? 0;
  const touch = (k: string) => setTouched((t) => (t[k] ? t : { ...t, [k]: true }));
  const setList = (next: Starter[]) => setDraft((d) => ({ ...d, starters: { ...d.starters, [listKey]: next } }));

  async function publish() {
    if (busy) return;
    if (nErr) {
      setTried(true);
      // Show the list with the problem when the one on screen is fine.
      const bad = rolesOf(draft)?.find((r) => Object.keys(errs).some((k) => k.startsWith(`${r}-st`)));
      if (bad && !Object.keys(errs).some((k) => k.startsWith(`${listKey ? `${listKey}-` : ""}st`))) setAudience(bad);
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
    setAudience("");
    toast("Changes discarded", { tone: "accent" });
  };

  const note = !audience
    ? ownCount
      ? `Shown to anyone whose role doesn’t have its own (${plural(ownCount, "role")} do).`
      : "Shown to everyone in the workspace."
    : own
      ? `Shown to people with the ${roleName(audience)} role.`
      : `People with the ${roleName(audience)} role see Everyone’s starters.`;

  const starters =
    audience && !own ? (
      <div className="asst-aud-empty">
        <Button size="sm" variant="secondary" onPress={() => setDraft((d) => ({ ...d, starters: { ...d.starters, [audience]: (d.starters[""] ?? []).map((s) => ({ ...s })) } }))}>
          <Plus className="i" aria-hidden />
          {`Give ${roleName(audience)} their own starters`}
        </Button>
      </div>
    ) : (
      <>
        {list.length ? (
          <div className="asst-starters">
            {list.map((s, i) => {
              const tk = starterKey(listKey, i, "t");
              const pk = starterKey(listKey, i, "p");
              const edit = (patch: Partial<Starter>, key: string) => {
                setList(list.map((x, j) => (j === i ? { ...x, ...patch } : x)));
                touch(key);
              };
              return (
                <div key={i} className="asst-starter" role="group" aria-label={`Starter ${i + 1}`}>
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
          <p className="t-sm muted">{`No starters. ${audience ? roleName(audience) : "People"} see only the welcome message.`}</p>
        )}
        <div className="row between gap-8">
          {list.length < MAX_STARTERS ? (
            <Button
              size="sm"
              variant="secondary"
              onPress={() => {
                setList([...list, { title: "", prompt: "" }]);
                requestAnimationFrame(() => document.querySelectorAll<HTMLInputElement>(".asst-starter input")[list.length * 2]?.focus());
              }}
            >
              <Plus className="i" aria-hidden />
              Add starter
            </Button>
          ) : (
            <span />
          )}
          <span className="t-xs muted num">
            {list.length}/{MAX_STARTERS}
          </span>
        </div>
      </>
    );

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
          <Card title="Chat home" description="What people see when they start a new chat.">
            <TextField value={draft.welcome} onChange={(v) => (setDraft((d) => ({ ...d, welcome: v })), touch("welcome"))} isRequired isInvalid={Boolean(show("welcome"))}>
              <Label>Welcome message</Label>
              <Input placeholder="What can I help you find?" translate="no" />
              {show("welcome") ? (
                <FieldError>{show("welcome")}</FieldError>
              ) : (
                <div className="row end">
                  <Counter n={draft.welcome.length} max={MAX_WELCOME} />
                </div>
              )}
            </TextField>
            <div className="asst-aud-row">
              <span className="label" id="asst-aud-label">
                Starters for
              </span>
              <Select
                aria-labelledby="asst-aud-label"
                className="asst-aud"
                value={audience || EVERYONE}
                onChange={(key) => key != null && setAudience(key === EVERYONE ? "" : String(key))}
              >
                <Select.Trigger>
                  <Select.Value />
                  <Select.Indicator />
                </Select.Trigger>
                <Select.Popover>
                  <ListBox>
                    <ListBox.Item id={EVERYONE} textValue="Everyone">
                      Everyone
                      <ListBox.ItemIndicator />
                    </ListBox.Item>
                    {roles.length ? (
                      <ListBox.Section>
                        <Header>Roles</Header>
                        {roles.map((r) => {
                          const label = `${r.label}${draft.starters[r.name] ? ` · ${plural(draft.starters[r.name].length, "starter")}` : ""}`;
                          return (
                            <ListBox.Item key={r.name} id={r.name} textValue={label}>
                              {label}
                              <ListBox.ItemIndicator />
                            </ListBox.Item>
                          );
                        })}
                      </ListBox.Section>
                    ) : null}
                  </ListBox>
                </Select.Popover>
              </Select>
              {own ? (
                <button
                  type="button"
                  className="link-button"
                  onClick={() => {
                    setDraft((d) => {
                      const rest = { ...d.starters };
                      delete rest[audience];
                      return { ...d, starters: rest };
                    });
                    setTouched({});
                  }}
                >
                  Use Everyone’s instead
                </button>
              ) : null}
            </div>
            <p className="t-xs muted asst-aud-note">{note}</p>
            {starters}
          </Card>
          <Disclosure icon={SlidersHorizontal} title="Capabilities" summary={draft.fileWork ? "All on" : "1 of 2 on"}>
            <p className="t-sm muted asst-caps__note">Answers always come from your company knowledge.</p>
            <div className="asst-switches">
              <SwitchRow title="Cite sources" description="Every claim links to the passage it came from." isSelected isDisabled onChange={() => undefined} />
              <SwitchRow
                title="Analyze and create files"
                description="Read spreadsheets, calculate, and produce documents and spreadsheets."
                isSelected={draft.fileWork}
                onChange={(fileWork) => setDraft((d) => ({ ...d, fileWork }))}
              />
            </div>
          </Disclosure>
        </div>
        <aside className="asst-preview" aria-label="Preview">
          <div className="card asst-prev">
            <PreviewBody draft={draft} list={list} as={audience ? `As ${roleName(audience)} sees it` : "As everyone sees it"} />
          </div>
        </aside>
      </div>
      <SideDrawer
        isOpen={previewing}
        onClose={onPreviewClose}
        title="Preview"
        description="What people see with your unpublished changes."
        foot={
          <Button variant="primary" onPress={onPreviewClose}>
            Back to editing
          </Button>
        }
      >
        <div className="asst-prev asst-prev--sheet">
          <PreviewBody draft={draft} list={list} as={audience ? `As ${roleName(audience)} sees it` : "As everyone sees it"} />
        </div>
      </SideDrawer>
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

/** The live preview (preview `previewBody`): chat home with the welcome and starters, then a sample answer in the chosen style. */
function PreviewBody({ draft, list, as }: { draft: AssistantDraft; list: readonly Starter[]; as: string }) {
  const welcome = draft.welcome.trim();
  const tiles = list.filter((s) => s.title.trim() || s.prompt.trim());
  const cite = (n: number) => <sup className="asst-cite">{n}</sup>;
  return (
    <>
      <div className="row between gap-8">
        <span className="t-label asst-prev__title">
          <Eye className="i i-sm" aria-hidden />
          Live preview
        </span>
        <span className="t-xs muted truncate">{as}</span>
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
      <div className="t-xs muted">{`Sample answer · ${STYLES.find((s) => s.value === draft.style)?.title}`}</div>
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
    </>
  );
}
