"use client";

import { ArrowDown, ArrowUp, BookOpen, Eye, Paperclip, Plus, Sparkles, Trash2 } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";

import { SaveBar } from "@/components/patterns/SaveBar";
import { NoAccess } from "@/components/shell/NoAccess";
import { Page } from "@/components/shell/Page";
import { RequirePermission } from "@/components/shell/RequirePermission";
import { useCurrentWorkspace } from "@/components/shell/useCurrentWorkspace";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { ui } from "@/components/ui/design-system";
import { Dialog } from "@/components/ui/Dialog";
import { ErrorState } from "@/components/ui/ErrorState";
import { FormField } from "@/components/ui/FormField";
import { Input } from "@/components/ui/Input";
import { PageHeader } from "@/components/ui/PageHeader";
import { PreviewTag } from "@/components/ui/PreviewTag";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Skeleton } from "@/components/ui/Skeleton";
import { Switch } from "@/components/ui/Switch";
import { TabPanel, Tabs, useTabParam } from "@/components/ui/Tabs";
import { Textarea } from "@/components/ui/Textarea";
import { useToast } from "@/components/ui/Toast";
import { describeRequestFailure } from "@/lib/api/errors";
import { usePendingFeature } from "@/lib/api/pending";
import { cn } from "@/lib/cn";
import { useUnsavedChangesGuard } from "@/lib/hooks/useUnsavedChangesGuard";
import {
  ASSISTANT_LIMITS,
  getAssistantSettings,
  updateAssistantSettings,
  type AssistantAnswerLength,
  type AssistantCapabilities,
  type AssistantSettings,
} from "@/modules/manage/assistant/api";
import { useApiData } from "@/lib/hooks/useApiData";

const TABS = ["behavior", "home"] as const;
type AssistantTab = (typeof TABS)[number];

const ANSWER_LENGTH_HINT: Record<AssistantAnswerLength, string> = {
  concise: "A few sentences. Best for quick lookups.",
  balanced: "A direct answer first, then the key details.",
  detailed: "Thorough answers with steps and context.",
};

const CAPABILITIES: readonly { key: keyof AssistantCapabilities; title: string; description: string }[] = [
  { key: "file_work", title: "Work with files and data", description: "Lets it read spreadsheets, calculate, and create documents and spreadsheets." },
  { key: "charts", title: "Make charts", description: "Lets it draw charts from the numbers in an answer." },
  { key: "web_search", title: "Search the web", description: "Lets it look up public information when knowledge doesn’t cover a question." },
];

interface StarterDraft {
  /** Stable while the list is reordered; never sent. */
  key: string;
  title: string;
  prompt: string;
}

interface Draft {
  instructions: string;
  answer_length: AssistantAnswerLength;
  capabilities: AssistantCapabilities;
  welcome_message: string;
  starter_prompts: StarterDraft[];
}

type FieldKey = "instructions" | "welcome" | `starter:${string}:${"title" | "prompt"}`;

let starterKeys = 0;
const nextStarterKey = () => `starter-${(starterKeys += 1)}`;

function draftOf(settings: AssistantSettings): Draft {
  return {
    instructions: settings.instructions,
    answer_length: settings.answer_length,
    capabilities: { ...settings.capabilities },
    welcome_message: settings.welcome_message,
    starter_prompts: settings.starter_prompts.map((starter) => ({ ...starter, key: nextStarterKey() })),
  };
}

/** What a save would send, so "dirty" means "a save would change something". */
function comparable(draft: Draft) {
  return JSON.stringify([
    draft.instructions,
    draft.answer_length,
    draft.capabilities.web_search,
    draft.capabilities.file_work,
    draft.capabilities.charts,
    draft.welcome_message.trim(),
    draft.starter_prompts.map((starter) => [starter.title.trim(), starter.prompt.trim()]),
  ]);
}

function validate(draft: Draft): Partial<Record<FieldKey, string>> {
  const errors: Partial<Record<FieldKey, string>> = {};
  const over = draft.instructions.length - ASSISTANT_LIMITS.instructions;
  if (over > 0) errors.instructions = `Shorten the instructions by ${over.toLocaleString()} ${over === 1 ? "character" : "characters"}.`;
  const welcome = draft.welcome_message.trim();
  if (!welcome) errors.welcome = "Enter a welcome message.";
  else if (welcome.length > ASSISTANT_LIMITS.welcomeMessage) {
    errors.welcome = `Keep the welcome message to ${ASSISTANT_LIMITS.welcomeMessage} characters.`;
  }
  for (const starter of draft.starter_prompts) {
    if (!starter.title.trim()) errors[`starter:${starter.key}:title`] = "Add a title.";
    if (!starter.prompt.trim()) errors[`starter:${starter.key}:prompt`] = "Add the prompt it sends.";
  }
  return errors;
}

const tabOf = (field: FieldKey): AssistantTab => (field === "instructions" ? "behavior" : "home");

export function AssistantSetupPage() {
  const enabled = usePendingFeature("workspace.assistant_settings");
  if (!enabled) return <NoAccess />;
  return (
    <RequirePermission anyOf={["tenant.manage"]}>
      <AssistantSetup />
    </RequirePermission>
  );
}

function AssistantSetup() {
  const { workspace } = useCurrentWorkspace();
  const workspaceId = workspace?.id ?? "";
  // A save re-reads the settings (the client invalidates), and the new
  // `updated_at` remounts the form on what was saved.
  const settings = useApiData(
    async () => (workspaceId ? getAssistantSettings(workspaceId) : null),
    workspaceId,
  );
  const [previewOpen, setPreviewOpen] = useState(false);

  return (
    <Page className="@container max-w-[1120px]">
      <PageHeader
        actions={
          <Button
            className="@min-[1000px]:hidden"
            icon={<Eye aria-hidden="true" />}
            onClick={() => setPreviewOpen(true)}
            variant="secondary"
          >
            Preview
          </Button>
        }
        sub="How the assistant answers and what people see first."
        title="Assistant setup"
        titleExtra={<PreviewTag />}
      />
      {settings.error ? (
        <ErrorState description={settings.error} onAction={settings.reload} title="Assistant setup didn’t load" />
      ) : !settings.data || !workspace ? (
        <div aria-busy="true" aria-label="Loading assistant setup" className="flex flex-col gap-4">
          {[90, 60, 70, 50].map((width) => <Skeleton className="h-3.5" key={width} style={{ width: `${width}%` }} />)}
          <Skeleton className="h-40" />
        </div>
      ) : (
        <AssistantForm
          key={settings.data.updated_at ?? "defaults"}
          onPreviewClose={() => setPreviewOpen(false)}
          previewOpen={previewOpen}
          saved={settings.data}
          workspaceId={workspace.id}
          workspaceName={workspace.name}
        />
      )}
    </Page>
  );
}

function AssistantForm({
  saved,
  workspaceId,
  workspaceName,
  previewOpen,
  onPreviewClose,
}: {
  saved: AssistantSettings;
  workspaceId: string;
  workspaceName: string;
  previewOpen: boolean;
  onPreviewClose: () => void;
}) {
  const toast = useToast();
  const idBase = useId();
  const formRef = useRef<HTMLDivElement>(null);
  const [tab, setTab] = useTabParam(TABS, "behavior");
  const initial = useMemo(() => draftOf(saved), [saved]);
  const [draft, setDraft] = useState<Draft>(initial);
  const [touched, setTouched] = useState<ReadonlySet<FieldKey>>(new Set());
  const [tried, setTried] = useState(false);
  const [saving, setSaving] = useState(false);
  const [focusPending, setFocusPending] = useState(false);
  const [focusStarterKey, setFocusStarterKey] = useState<string | null>(null);

  const dirty = comparable(draft) !== comparable(initial);
  const errors = validate(draft);
  const errorKeys = Object.keys(errors) as FieldKey[];
  const guard = useUnsavedChangesGuard(dirty && !saving);

  const show = (field: FieldKey) => {
    const message = errors[field];
    if (!message) return undefined;
    const overLimit = field === "instructions" || (field === "welcome" && draft.welcome_message.trim().length > 0);
    return tried || touched.has(field) || overLimit ? message : undefined;
  };
  const touch = (field: FieldKey) => setTouched((current) => (current.has(field) ? current : new Set(current).add(field)));
  const update = (patch: Partial<Draft>) => setDraft((current) => ({ ...current, ...patch }));

  // After a failed save, focus the first field that needs fixing on the tab now showing.
  useEffect(() => {
    if (!focusPending) return;
    setFocusPending(false);
    formRef.current?.querySelector<HTMLElement>("[aria-invalid=true]")?.focus();
  }, [focusPending, tab]);

  // A starter added with "Add starter" takes focus once its row has rendered.
  useEffect(() => {
    if (!focusStarterKey) return;
    const field = document.getElementById(`${idBase}-${focusStarterKey}-title`);
    if (!field) return;
    field.focus();
    setFocusStarterKey(null);
  }, [draft.starter_prompts, focusStarterKey, idBase]);

  const otherTab: AssistantTab = tab === "home" ? "behavior" : "home";
  const otherErrors = tried ? errorKeys.filter((field) => tabOf(field) === otherTab).length : 0;

  async function save() {
    if (saving) return;
    if (errorKeys.length) {
      setTried(true);
      if (!errorKeys.some((field) => tabOf(field) === tab)) setTab(tabOf(errorKeys[0]));
      setFocusPending(true);
      return;
    }
    setSaving(true);
    try {
      await updateAssistantSettings(workspaceId, {
        instructions: draft.instructions,
        answer_length: draft.answer_length,
        capabilities: draft.capabilities,
        welcome_message: draft.welcome_message.trim(),
        starter_prompts: draft.starter_prompts.map(({ title, prompt }) => ({ title: title.trim(), prompt: prompt.trim() })),
      });
      // Saving stays on until the re-read remounts the form on the saved settings.
      toast.show({ message: "Assistant updated" });
    } catch (cause) {
      setSaving(false);
      toast.show({ tone: "err", message: describeRequestFailure(cause, "Saving the assistant setup") });
    }
  }

  function discard() {
    setDraft(draftOf(saved));
    setTouched(new Set());
    setTried(false);
    toast.show({ tone: "info", message: "Changes discarded" });
  }

  function moveStarter(index: number, offset: -1 | 1) {
    const starters = [...draft.starter_prompts];
    const target = index + offset;
    if (target < 0 || target >= starters.length) return;
    [starters[index], starters[target]] = [starters[target], starters[index]];
    update({ starter_prompts: starters });
  }

  function addStarter() {
    if (draft.starter_prompts.length >= ASSISTANT_LIMITS.starterPrompts) return;
    const starter = { key: nextStarterKey(), title: "", prompt: "" };
    update({ starter_prompts: [...draft.starter_prompts, starter] });
    setFocusStarterKey(starter.key);
  }

  return (
    <>
      <Tabs
        activeTab={tab}
        ariaLabel="Assistant setup sections"
        className="mb-5"
        idBase={`${idBase}-tabs`}
        onChange={setTab}
        tabs={[{ id: "behavior", label: "Behavior" }, { id: "home", label: "Home screen" }]}
      />
      <div className="grid grid-cols-[minmax(0,1fr)_340px] items-start gap-9 @max-[999px]:grid-cols-1">
        <TabPanel idBase={`${idBase}-tabs`} tab={tab}>
          <div ref={formRef}>
            {tab === "behavior" ? (
              <>
                <FormField
                  error={show("instructions")}
                  help="Written for the assistant. Say who it serves, what to prioritise and what to avoid."
                  htmlFor={`${idBase}-instructions`}
                  label="Instructions"
                >
                  <Textarea
                    counterLimit={ASSISTANT_LIMITS.instructions}
                    onBlur={() => touch("instructions")}
                    onChange={(event) => update({ instructions: event.target.value })}
                    rows={8}
                    value={draft.instructions}
                  />
                </FormField>
                <div className="mt-5">
                  <p className={ui.label} id={`${idBase}-length`}>Answer length</p>
                  <SegmentedControl
                    ariaLabel="Answer length"
                    className="mt-2"
                    onChange={(answer_length) => update({ answer_length })}
                    options={[
                      { value: "concise", label: "Short" },
                      { value: "balanced", label: "Balanced" },
                      { value: "detailed", label: "Detailed" },
                    ]}
                    value={draft.answer_length}
                  />
                  <p className={cn(ui.helper, "mt-1.5")}>{ANSWER_LENGTH_HINT[draft.answer_length]}</p>
                </div>
                <h2 className={cn(ui.sectionTitle, "mt-7 mb-1")}>Capabilities</h2>
                <ul className="border-b border-border-subtle">
                  <CapabilityRow
                    checked
                    description="Always on — answers come from your company knowledge first."
                    locked
                    title="Search company knowledge"
                  />
                  {CAPABILITIES.map((capability) => (
                    <CapabilityRow
                      checked={draft.capabilities[capability.key]}
                      description={capability.description}
                      key={capability.key}
                      onChange={(checked) => update({ capabilities: { ...draft.capabilities, [capability.key]: checked } })}
                      title={capability.title}
                    />
                  ))}
                </ul>
              </>
            ) : (
              <>
                <FormField
                  error={show("welcome")}
                  help="The heading people see above the message box."
                  htmlFor={`${idBase}-welcome`}
                  label="Welcome message"
                  labelAction={
                    <span className={cn(ui.counter, draft.welcome_message.trim().length > ASSISTANT_LIMITS.welcomeMessage && "font-medium text-status-danger")}>
                      {draft.welcome_message.trim().length}/{ASSISTANT_LIMITS.welcomeMessage}
                    </span>
                  }
                  required
                >
                  <Input
                    onBlur={() => touch("welcome")}
                    onChange={(event) => update({ welcome_message: event.target.value })}
                    placeholder="What can I help you find?"
                    value={draft.welcome_message}
                  />
                </FormField>
                <h2 className={cn(ui.sectionTitle, "mt-7")}>Starter prompts</h2>
                <p className={cn(ui.helper, "mt-1 mb-3")}>Shown as tiles under the welcome message, in this order.</p>
                {draft.starter_prompts.length ? (
                  <ol className="flex flex-col gap-2">
                    {draft.starter_prompts.map((starter, index) => (
                      <li
                        className={cn(ui.card, "grid grid-cols-[22px_minmax(0,1fr)_auto] items-start gap-3 p-3.5")}
                        key={starter.key}
                      >
                        <span aria-hidden="true" className="mt-7 grid size-5.5 place-items-center rounded-sm bg-surface-inset text-caption font-semibold text-text-secondary">
                          {index + 1}
                        </span>
                        <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)] gap-2.5 @max-[700px]:grid-cols-1">
                          <FormField error={show(`starter:${starter.key}:title`)} htmlFor={`${idBase}-${starter.key}-title`} label="Title" required>
                            <Input
                              maxLength={ASSISTANT_LIMITS.starterTitle}
                              onBlur={() => touch(`starter:${starter.key}:title`)}
                              onChange={(event) =>
                                update({
                                  starter_prompts: draft.starter_prompts.map((item) =>
                                    item.key === starter.key ? { ...item, title: event.target.value } : item,
                                  ),
                                })
                              }
                              placeholder="e.g. Find a policy"
                              value={starter.title}
                            />
                          </FormField>
                          <FormField error={show(`starter:${starter.key}:prompt`)} htmlFor={`${idBase}-${starter.key}-prompt`} label="Prompt it sends" required>
                            <Input
                              maxLength={ASSISTANT_LIMITS.starterPrompt}
                              onBlur={() => touch(`starter:${starter.key}:prompt`)}
                              onChange={(event) =>
                                update({
                                  starter_prompts: draft.starter_prompts.map((item) =>
                                    item.key === starter.key ? { ...item, prompt: event.target.value } : item,
                                  ),
                                })
                              }
                              placeholder="e.g. What does our travel policy say about per diem?"
                              value={starter.prompt}
                            />
                          </FormField>
                        </div>
                        <div className="mt-6 flex gap-0.5">
                          <Button
                            aria-label={`Move starter ${index + 1} up`}
                            disabled={index === 0}
                            icon={<ArrowUp aria-hidden="true" />}
                            iconOnly
                            onClick={() => moveStarter(index, -1)}
                            size="sm"
                            variant="ghost"
                          />
                          <Button
                            aria-label={`Move starter ${index + 1} down`}
                            disabled={index === draft.starter_prompts.length - 1}
                            icon={<ArrowDown aria-hidden="true" />}
                            iconOnly
                            onClick={() => moveStarter(index, 1)}
                            size="sm"
                            variant="ghost"
                          />
                          <Button
                            aria-label={`Remove starter ${index + 1}`}
                            icon={<Trash2 aria-hidden="true" />}
                            iconOnly
                            onClick={() => {
                              update({ starter_prompts: draft.starter_prompts.filter((item) => item.key !== starter.key) });
                              setTouched(new Set());
                            }}
                            size="sm"
                            variant="ghost"
                          />
                        </div>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p className="rounded-lg border border-dashed border-border-default px-5 py-5 text-center text-body text-text-tertiary">
                    No starters. People see only the welcome message.
                  </p>
                )}
                <div className="mt-3 flex items-center gap-3">
                  <Button
                    disabled={draft.starter_prompts.length >= ASSISTANT_LIMITS.starterPrompts}
                    icon={<Plus aria-hidden="true" />}
                    onClick={addStarter}
                    size="sm"
                    variant="secondary"
                  >
                    Add starter
                  </Button>
                  {draft.starter_prompts.length >= ASSISTANT_LIMITS.starterPrompts && (
                    <span className={ui.helper}>Up to {ASSISTANT_LIMITS.starterPrompts} keeps the home screen focused</span>
                  )}
                </div>
              </>
            )}
          </div>
        </TabPanel>
        <aside aria-label="Preview" className="sticky top-5 @max-[999px]:hidden">
          <div className="mb-2.5 flex items-center justify-between">
            <span className={ui.label}>Preview</span>
            <span className="text-meta text-text-tertiary">New chat</span>
          </div>
          <ChatHomePreview draft={draft} workspaceName={workspaceName} />
        </aside>
      </div>

      {dirty && (
        <SaveBar
          message={otherErrors ? (
            <Button onClick={() => { setTab(otherTab); setFocusPending(true); }} size="sm" variant="link">
              Fix {otherErrors === 1 ? "1 issue" : `${otherErrors} issues`} on {otherTab === "home" ? "Home screen" : "Behavior"}
            </Button>
          ) : undefined}
          onDiscard={discard}
          onSave={() => void save()}
          saving={saving}
        />
      )}

      <Dialog
        description="What people see when they start a new chat."
        footer={<Button onClick={onPreviewClose} variant="primary">Done</Button>}
        onClose={onPreviewClose}
        open={previewOpen}
        title="Preview"
      >
        <ChatHomePreview draft={draft} workspaceName={workspaceName} />
      </Dialog>

      <ConfirmDialog
        cancelLabel="Keep editing"
        confirmLabel="Leave without saving"
        description="Your changes to the assistant setup haven’t been saved."
        onClose={guard.stay}
        onConfirm={guard.leave}
        open={guard.pendingHref !== null}
        title="Leave without saving?"
      />
    </>
  );
}

function CapabilityRow({
  title,
  description,
  checked,
  onChange,
  locked = false,
}: {
  title: string;
  description: string;
  checked: boolean;
  onChange?: (checked: boolean) => void;
  locked?: boolean;
}) {
  const id = useId();
  return (
    <li className="flex items-start justify-between gap-5 border-t border-border-subtle py-3.5">
      <div>
        <p className={ui.label} id={`${id}-title`}>{title}</p>
        <p className={cn(ui.helper, "mt-0.5")} id={`${id}-description`}>{description}</p>
      </div>
      <Switch
        aria-labelledby={`${id}-title`}
        checked={checked}
        className="mt-0.5"
        describedBy={`${id}-description`}
        disabled={locked}
        onChange={onChange}
      />
    </li>
  );
}

/** The new-chat screen as people will see it, drawn from the unsaved draft. */
function ChatHomePreview({ draft, workspaceName }: { draft: Draft; workspaceName: string }) {
  const welcome = draft.welcome_message.trim();
  return (
    <figure aria-label="Preview of the new chat screen" className="m-0 rounded-xl border border-border-subtle bg-surface-subtle px-4.5 pt-8 pb-4.5">
      <p className={cn("text-[1.1875rem] font-semibold leading-tight tracking-tight break-words", welcome ? "text-text-primary" : "text-text-tertiary")}>
        {welcome || "Welcome message"}
      </p>
      <div aria-hidden="true" className="mt-3.5 rounded-[14px] border border-border-default bg-surface-base py-2.5 pr-2 pl-3 text-meta text-text-tertiary shadow-(--shadow-1)">
        <span>Ask anything about {workspaceName}…</span>
        <div className="mt-3.5 flex items-center justify-between [&_svg]:size-3.5">
          <span className="flex gap-1.5"><Paperclip /><BookOpen /></span>
          <span className="grid size-6 place-items-center rounded-[7px] bg-accent-primary text-text-on-accent"><ArrowUp /></span>
        </div>
      </div>
      {draft.starter_prompts.length > 0 && (
        <ul className="mt-3 grid gap-1.5">
          {draft.starter_prompts.map((starter) => (
            <li className="flex items-start gap-2 rounded-md border border-border-subtle bg-surface-base px-2.5 py-2" key={starter.key}>
              <Sparkles aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-text-tertiary" />
              <div className="min-w-0">
                <p className="truncate text-meta font-medium text-text-primary">{starter.title.trim() || "Untitled"}</p>
                <p className="truncate text-caption text-text-tertiary">{starter.prompt.trim() || "—"}</p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </figure>
  );
}
