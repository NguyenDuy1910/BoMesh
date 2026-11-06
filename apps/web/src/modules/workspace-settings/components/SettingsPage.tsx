"use client";

import { Button, Checkbox, Description, FieldError, InputGroup, TextField, Input } from "@heroui/react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { Archive, Copy, History, Pause, Users } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import { PageChrome } from "@/components/shell/page-chrome";
import { Callout, ChoiceGroup, ErrorState, FormSection, IconButton, Page, PageHeader, PreviewChip, SaveBar, SectionTabs, SwitchRow, confirm, toast } from "@/components/ui";
import { ApiError, errorMessage } from "@/lib/api/client";
import { plural, rel } from "@/lib/format";
import { isPlatformOperator, useSession } from "@/lib/session";
import { useWorkspace, workspaceQueryKey } from "@/lib/workspace";
import { spaceType, useSpaces } from "@/modules/spaces";
import { workflowOf } from "@/modules/work/kinds";

import { activateWorkspace, archiveWorkspace, updateSettings, updateWorkspace, type Workspace, type WorkspaceSettings } from "../api";
import {
  MAX_NAME,
  MODULES,
  TEMPLATES,
  WORKFLOW_KEYS,
  identityDirty,
  identityErrors,
  identityPatch,
  isOverridden,
  moduleChanged,
  resetBody,
  setupBody,
  setupOf,
  spaceTypeKeys,
  spaceTypesWith,
  templateKey,
  toggled,
  workflowsWith,
  type IdentityDraft,
  type ModuleKey,
  type TemplateKey,
  type WorkflowKey,
} from "../model";

const TABS = ["general", "setup", "danger"] as const;
type Tab = (typeof TABS)[number];

/** Icon names stored with a space type the workspace adds (the API keeps a Lucide name). */
const SPACE_TYPE_ICONS: Readonly<Record<string, string>> = {
  course: "graduation-cap",
  research: "flask-conical",
  office: "building",
  team: "users",
  project: "route",
};

/** The cached workspace context (`lib/workspace.tsx`), patched in place so navigation follows a change at once. */
interface ContextData {
  workspace: Workspace;
  workspaces: Workspace[];
  settings: WorkspaceSettings | null;
}

function patchContext(qc: QueryClient, patch: { workspace?: Workspace; settings?: WorkspaceSettings }) {
  qc.setQueriesData<ContextData | null>({ queryKey: workspaceQueryKey }, (old) => {
    if (!old) return old;
    const workspace = patch.workspace ? { ...old.workspace, ...patch.workspace } : old.workspace;
    return {
      ...old,
      workspace,
      workspaces: old.workspaces.map((w) => (w.name === workspace.name ? workspace : w)),
      settings: patch.settings ?? old.settings,
    };
  });
  void qc.invalidateQueries({ queryKey: workspaceQueryKey });
}

/** Settings (preview `P.settings`, `/settings?tab=general|setup|danger`). */
export function SettingsPage() {
  const params = useSearchParams();
  const { workspace } = useWorkspace();
  const tab: Tab = (TABS as readonly string[]).includes(params.get("tab") ?? "") ? (params.get("tab") as Tab) : "general";
  return (
    <Page narrow>
      <PageChrome crumbs={[{ label: "Settings" }]} />
      <PageHeader title="Settings" description={<span translate="no">{workspace.displayName}</span>}>
        <SectionTabs
          base="/settings"
          active={tab}
          items={[
            { id: "general", label: "General" },
            { id: "setup", label: "Workspace setup" },
            { id: "danger", label: "Danger zone" },
          ]}
        />
      </PageHeader>
      {tab === "danger" ? <DangerZone /> : tab === "setup" ? <SetupTab /> : <GeneralTab key={workspace.etag} />}
    </Page>
  );
}

/* ── General: name, web address, workspace ID ── */

function GeneralTab() {
  const qc = useQueryClient();
  const { workspace, id } = useWorkspace();
  const current: IdentityDraft = { name: workspace.displayName, code: workspace.code };
  const [draft, setDraft] = useState<IdentityDraft>(current);
  const [touched, setTouched] = useState<Partial<Record<keyof IdentityDraft, boolean>>>({});
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [taken, setTaken] = useState<string | null>(null);
  const errs = identityErrors(draft, current);
  if (taken && draft.code.trim() === taken) errs.code = `bomesh.app/${taken} is already taken.`;
  const show = (k: keyof IdentityDraft) => ((tried || touched[k]) && errs[k]) || "";
  const dirty = identityDirty(draft, current);
  const code = draft.code.trim();
  const codeChanged = code !== current.code && !errs.code;
  const edit = (k: keyof IdentityDraft, value: string) => {
    setDraft((d) => ({ ...d, [k]: value }));
    setTouched((t) => (t[k] ? t : { ...t, [k]: true }));
  };

  async function save() {
    if (busy || !dirty) return;
    setTried(true);
    if (Object.keys(errs).length) {
      document.getElementById(errs.name ? "set-name" : "set-code")?.focus();
      return;
    }
    setBusy(true);
    try {
      const { updateMask, ...body } = identityPatch(draft, current);
      const saved = await updateWorkspace(id, { ...body, etag: workspace.etag }, updateMask);
      toast("Settings saved");
      patchContext(qc, { workspace: saved });
    } catch (error) {
      setBusy(false);
      if (error instanceof ApiError && error.code === "ALREADY_EXISTS") {
        setTaken(code);
        document.getElementById("set-code")?.focus();
      } else toast(errorMessage(error), { tone: "danger" });
    }
  }

  const onEnter = (e: KeyboardEvent) => {
    if (e.key === "Enter") void save();
  };

  return (
    <>
      <div className="set-form">
        <FormSection title="Workspace name" description="Shown in navigation, invitations and emails.">
          <TextField value={draft.name} onChange={(v) => edit("name", v)} isInvalid={Boolean(show("name"))} aria-label="Workspace name" maxLength={MAX_NAME}>
            <Input id="set-name" onKeyDown={onEnter} translate="no" />
            {show("name") ? (
              <FieldError>{show("name")}</FieldError>
            ) : (
              <div className="row end">
                <span className="counter">{`${draft.name.length}/${MAX_NAME}`}</span>
              </div>
            )}
          </TextField>
        </FormSection>
        <FormSection title="Web address" description="Where people sign in to this workspace.">
          <TextField value={draft.code} onChange={(v) => edit("code", v)} isInvalid={Boolean(show("code"))} aria-label="Web address after bomesh.app/" maxLength={32}>
            <InputGroup fullWidth className="set-url">
              <InputGroup.Prefix className="set-url__prefix">bomesh.app/</InputGroup.Prefix>
              <InputGroup.Input id="set-code" spellCheck={false} onKeyDown={onEnter} />
            </InputGroup>
            {show("code") ? <FieldError>{show("code")}</FieldError> : <Description>3–32 lowercase letters, numbers or hyphens.</Description>}
          </TextField>
          {codeChanged ? (
            <Callout
              tone="warning"
              title="Old links will stop working"
              description={
                <>
                  <span className="mono">bomesh.app/{current.code}</span> won’t redirect to <span className="mono">bomesh.app/{code}</span>. Share the new address after saving.
                </>
              }
            />
          ) : null}
        </FormSection>
        <FormSection title="Workspace ID" description="For support requests and API calls.">
          <TextField value={id} isReadOnly aria-label="Workspace ID">
            <InputGroup fullWidth className="set-id">
              <InputGroup.Input className="mono" />
              <InputGroup.Suffix>
                <IconButton
                  icon={Copy}
                  tip="Copy workspace ID"
                  size="sm"
                  onPress={() =>
                    void navigator.clipboard.writeText(id).then(
                      () => toast("Workspace ID copied"),
                      () => toast("Couldn’t copy. Select the ID and copy it.", { tone: "danger" }),
                    )
                  }
                />
              </InputGroup.Suffix>
            </InputGroup>
          </TextField>
        </FormSection>
      </div>
      <SaveBar
        isDirty={dirty}
        isSaving={busy}
        onSave={() => void save()}
        onDiscard={() => {
          setDraft(current);
          setTouched({});
          setTried(false);
          setTaken(null);
        }}
      />
    </>
  );
}

/* ── Workspace setup: template, modules, space types, AI workflows ── */

const spaceTypeLabel = (key: string) => ({ displayName: spaceType(key).label, icon: SPACE_TYPE_ICONS[key] ?? "layers" });

function OptionLabel({ title, desc, meta }: { title: string; desc: string; meta?: string }) {
  return (
    <span className="set-opt">
      <span className="set-opt__title">
        {title}
        {meta ? <span className="set-opt__meta">{meta}</span> : null}
      </span>
      <span className="set-opt__desc">{desc}</span>
    </span>
  );
}

function Check({ label, isSelected, isDisabled, onChange }: { label: ReactNode; isSelected: boolean; isDisabled?: boolean; onChange: () => void }) {
  return (
    <Checkbox isSelected={isSelected} isDisabled={isDisabled} onChange={onChange}>
      <Checkbox.Content>
        <Checkbox.Control>
          <Checkbox.Indicator />
        </Checkbox.Control>
        {label}
      </Checkbox.Content>
    </Checkbox>
  );
}

function SetupTab() {
  const qc = useQueryClient();
  const { workspace, id, settings } = useWorkspace();
  const spaces = useSpaces();
  const [busy, setBusy] = useState(false);
  const latest = useRef(settings);
  latest.current = settings;

  if (!settings) {
    return (
      <ErrorState
        title="Settings didn’t load"
        description="Try again. Your settings haven’t changed."
        onRetry={() => void qc.invalidateQueries({ queryKey: workspaceQueryKey })}
      />
    );
  }

  const tplKey = templateKey(workspace.template);
  const tpl = TEMPLATES[tplKey];
  const setup = setupOf(settings);
  const name = workspace.displayName;

  /** Applies a setup change now (navigation follows at once); Undo restores the previous setup. */
  async function apply(change: { body: WorkspaceSettings; updateMask: string }, message: string) {
    if (busy || !latest.current) return;
    const snapshot = latest.current;
    setBusy(true);
    try {
      const saved = await updateSettings(id, { ...change.body, etag: snapshot.etag }, change.updateMask);
      patchContext(qc, { settings: saved });
      toast(message, {
        undo: () => {
          const { body, updateMask } = setupBody(snapshot);
          void updateSettings(id, { ...body, etag: latest.current?.etag ?? saved.etag }, updateMask).then(
            (restored) => {
              patchContext(qc, { settings: restored });
              toast("Change undone", { tone: "accent" });
            },
            (error: unknown) => toast(errorMessage(error), { tone: "danger" }),
          );
        },
      });
    } catch (error) {
      toast(errorMessage(error), { tone: "danger" });
    } finally {
      setBusy(false);
    }
  }

  const toggleModule = (key: ModuleKey, label: string) => {
    const on = !setup.modules[key];
    void apply(
      { body: { modules: { [key]: on } }, updateMask: `modules.${key}` },
      on ? `${label} is on for everyone in ${name}` : `${label} is off and hidden from navigation`,
    );
  };

  const toggleSpaceType = (key: string) => {
    const next = toggled(setup.spaceTypes, key);
    if (!next) return void toast("Keep at least one space type while Spaces is on.", { tone: "danger" });
    const t = spaceType(key, settings);
    const added = next.length > setup.spaceTypes.length;
    void apply(
      { body: { spaceTypes: spaceTypesWith(settings, next, spaceTypeLabel) }, updateMask: "spaceTypes" },
      added ? `People can now create ${t.plural.toLowerCase()}` : `New ${t.plural.toLowerCase()} can’t be created. Existing ones stay.`,
    );
  };

  const toggleWorkflow = (key: WorkflowKey, label: string) => {
    const next = toggled(setup.workflows, key);
    if (!next) return void toast("Keep at least one AI workflow while Work is on.", { tone: "danger" });
    const added = next.length > setup.workflows.length;
    void apply({ body: { workflows: workflowsWith(next) }, updateMask: "workflows" }, added ? `${label} is available in Work` : `${label} is off. Saved work stays.`);
  };

  const spaceCount = (key: string) => spaces.data?.filter((s) => s.spaceType === key).length ?? 0;

  return (
    <div className="set-form set-setup">
      <FormSection title="Template" description="Sets which modules, space types and AI workflows this workspace starts with.">
        <div>
          <ChoiceGroup<TemplateKey>
            label="Template"
            name="set-tpl"
            columns={2}
            value={tplKey}
            onChange={() => undefined}
            options={(Object.keys(TEMPLATES) as TemplateKey[]).map((k) => ({
              value: k,
              title: TEMPLATES[k].label,
              description: TEMPLATES[k].desc,
              isDisabled: k !== tplKey,
            }))}
          />
          <p className="t-xs muted mt-8">The template is chosen when the workspace is created.</p>
          {isOverridden(setup, tpl) ? (
            <div className="set-reset">
              <button type="button" className="link-button" disabled={busy} onClick={() => void apply(resetBody(settings, tpl, spaceTypeLabel), `Back to the ${tpl.label} defaults`)}>
                Reset to {tpl.label} defaults
              </button>
            </div>
          ) : null}
        </div>
      </FormSection>
      <FormSection title="Modules" description="Changes apply to everyone right away. Turning a module off hides it; nothing is deleted.">
        <div className="set-switches">
          {MODULES.map((m) => (
            <SwitchRow
              key={m.key}
              title={m.label}
              description={
                <>
                  {m.desc}
                  {moduleChanged(setup, tpl, m.key) ? <span className="set-changed">Changed from {tpl.label}</span> : null}
                </>
              }
              isSelected={setup.modules[m.key]}
              isDisabled={busy}
              onChange={() => toggleModule(m.key, m.label)}
            />
          ))}
        </div>
      </FormSection>
      <FormSection title="Space types" description="How people group members, materials and work.">
        {setup.modules.spaces ? (
          <div className="set-checks">
            {spaceTypeKeys(settings).map((key) => {
              const t = spaceType(key, settings);
              const n = spaceCount(key);
              return (
                <Check
                  key={key}
                  isSelected={setup.spaceTypes.includes(key)}
                  isDisabled={busy}
                  onChange={() => toggleSpaceType(key)}
                  label={<OptionLabel title={t.label} desc={t.desc} meta={n ? plural(n, "space") : undefined} />}
                />
              );
            })}
          </div>
        ) : (
          <p className="t-sm muted">Turn on Spaces to choose how people organise their work.</p>
        )}
      </FormSection>
      <FormSection title="AI workflows" description="Guided tasks people start from Work and from their spaces.">
        {setup.modules.work ? (
          <div className="set-checks">
            {WORKFLOW_KEYS.map((key) => {
              const wf = workflowOf(key)!;
              const where = wf.spaceTypes ? wf.spaceTypes.map((t) => spaceType(t, settings).plural).join(", ") : "Anywhere";
              return (
                <Check
                  key={key}
                  isSelected={setup.workflows.includes(key)}
                  isDisabled={busy}
                  onChange={() => toggleWorkflow(key, wf.label)}
                  label={<OptionLabel title={wf.label} desc={wf.desc} meta={where} />}
                />
              );
            })}
          </div>
        ) : (
          <p className="t-sm muted">Turn on Work to offer AI workflows.</p>
        )}
      </FormSection>
    </div>
  );
}

/* ── Danger zone: archive ── */

function DangerZone() {
  const qc = useQueryClient();
  const session = useSession();
  const { workspace, id } = useWorkspace();
  const [busy, setBusy] = useState(false);
  const archived = workspace.state === "ARCHIVED";
  const operator = isPlatformOperator(session);

  async function archive() {
    const ok = await confirm({
      title: `Archive ${workspace.displayName}?`,
      description: "Everyone loses access and source syncs pause. Platform admins can restore it for 30 days.",
      confirmLabel: "Archive workspace",
      tone: "danger",
      typed: workspace.code,
    });
    if (!ok) return;
    setBusy(true);
    try {
      const saved = await archiveWorkspace(id, workspace.code, workspace.etag);
      patchContext(qc, { workspace: saved });
      toast("Workspace archived", { tone: "accent", ...(operator ? { undo: () => void restore() } : {}) });
    } catch (error) {
      toast(errorMessage(error), { tone: "danger" });
    } finally {
      setBusy(false);
    }
  }

  async function restore() {
    setBusy(true);
    try {
      patchContext(qc, { workspace: await activateWorkspace(id) });
      toast("Workspace restored");
    } catch (error) {
      toast(errorMessage(error), { tone: "danger" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card card--lg set-danger">
      <div className="card__header">
        <span className="item-icon item-icon--danger">
          <Archive className="i" aria-hidden />
        </span>
        <div className="grow">
          <div className="row gap-8">
            <h3 className="card__title">Archive workspace</h3>
            <PreviewChip tooltip="Design proposal — backend contract pending" />
          </div>
          <p className="card__description">
            Removes <span translate="no">{workspace.displayName}</span> for everyone without deleting its data.
          </p>
        </div>
      </div>
      {archived ? (
        <Callout
          tone="warning"
          title="Workspace archived"
          description={`Archived ${rel(workspace.updateTime ?? "").toLowerCase()}. It’s read-only; platform admins can restore it for 30 days.`}
          actions={
            operator ? (
              <Button variant="secondary" size="sm" isPending={busy} onPress={() => void restore()}>
                Restore workspace
              </Button>
            ) : undefined
          }
        />
      ) : (
        <>
          <ul className="set-impact">
            <li>
              <Users className="i i-sm" aria-hidden />
              <span>Everyone loses access, including you.</span>
            </li>
            <li>
              <Pause className="i i-sm" aria-hidden />
              <span>Source syncs pause.</span>
            </li>
            <li>
              <History className="i i-sm" aria-hidden />
              <span>Platform admins can restore it for 30 days.</span>
            </li>
          </ul>
          <div className="card__footer">
            <span className="grow t-sm muted">
              You’ll confirm by typing <span className="mono strong">{workspace.code}</span>.
            </span>
            <Button variant="danger-soft" isPending={busy} onPress={() => void archive()}>
              <Archive className="i" aria-hidden />
              Archive workspace
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
