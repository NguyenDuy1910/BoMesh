"use client";

import { Button, Checkbox, Description, FieldError, Input, InputGroup, Label, TextField } from "@heroui/react";
import { useQueryClient } from "@tanstack/react-query";
import { Archive, Building2, Copy, Globe, GraduationCap, Lock, Settings, type LucideIcon } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import { Callout, ChoiceGroup, Disclosure, ErrorState, FormSection, IconButton, Page, PageHeader, SaveBar, SwitchRow, Tip, confirm, dismissConfirm, toast } from "@/components/ui";
import { ApiError, errorMessage } from "@/lib/api/client";
import { fmtDate, plural, relInline } from "@/lib/format";
import { tr, useLanguage, useMessages } from "@/lib/i18n";
import { sectionTitle, settingsSections, useSection } from "@/lib/navigation";
import { isPlatformOperator, useSession } from "@/lib/session";
import { patchWorkspaceContext, useWorkspace, workspaceQueryKey } from "@/lib/workspace";
import { COLLECTIONS_HREF } from "@/modules/knowledge/bases/model";
import { useAllMembersCollections } from "@/modules/knowledge/bases/queries";
import { MapBackgroundSetting } from "@/modules/knowledge/map/MapBackground";
import { spaceType, useSpaces } from "@/modules/spaces";
import { workflowOf } from "@/modules/work/kinds";

import { activateWorkspace, archiveWorkspace, updateSettings, updateWorkspace, type WorkspaceSettings } from "../api";
import {
  MAX_LISTED_COLLECTIONS,
  MAX_NAME,
  MODULES,
  TEMPLATES,
  WORKFLOW_KEYS,
  identityDirty,
  identityErrors,
  identityPatch,
  joinLink,
  resetBody,
  setupBody,
  setupChanges,
  setupOf,
  spaceTypeKeys,
  spaceTypesWith,
  templateKey,
  toggled,
  workflowsWith,
  type IdentityDraft,
  type ModuleKey,
  type TemplateKey,
  type Visibility,
  type WorkflowKey,
} from "../model";

/** Icon names stored with a space type the workspace adds (the API keeps a Lucide name). */
const SPACE_TYPE_ICONS: Readonly<Record<string, string>> = {
  course: "graduation-cap",
  research: "flask-conical",
  office: "building",
  team: "users",
  project: "route",
};

/** Template marks: the icons the domain uses elsewhere (office building, course cap). */
const TEMPLATE_ICON: Readonly<Record<TemplateKey, typeof Building2>> = { ENTERPRISE: Building2, CAMPUS: GraduationCap };

/**
 * Settings (preview `P.settings`): sections General · Workspace setup are sidebar sub-rows (`?tab=`), each titled by
 * its name. Archiving lives under General › Advanced; the old `?tab=danger` link opens it there.
 */
export function SettingsPage() {
  const params = useSearchParams();
  const { workspace } = useWorkspace();
  const legacyDanger = params.get("tab") === "danger";
  const tab = useSection(settingsSections, "general");
  const m = useMessages();
  return (
    <Page width="narrow">
      <PageHeader title={sectionTitle(settingsSections, tab, m)} />
      {tab === "setup" ? <SetupTab /> : <GeneralTab key={workspace.etag} advancedOpen={legacyDanger} />}
    </Page>
  );
}

/* ── General: name, web address; Advanced: workspace ID, archive ── */

function GeneralTab({ advancedOpen }: { advancedOpen: boolean }) {
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
      patchWorkspaceContext(qc, { workspace: saved });
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
      <ArchiveNotice />
      <div className="set-form">
        <FormSection title="Workspace name" description="Shown in navigation, invitations and emails.">
          <TextField value={draft.name} onChange={(v) => edit("name", v)} isInvalid={Boolean(show("name"))} aria-label="Workspace name" maxLength={MAX_NAME}>
            <Input id="set-name" onKeyDown={onEnter} translate="no" />
            {show("name") ? (
              <FieldError>{show("name")}</FieldError>
            ) : draft.name.length >= MAX_NAME - 10 ? (
              <div className="row end">
                <span className="counter">{`${draft.name.length}/${MAX_NAME}`}</span>
              </div>
            ) : null}
          </TextField>
        </FormSection>
        <FormSection title="Web address" description="Where people sign in to this workspace.">
          <TextField value={draft.code} onChange={(v) => edit("code", v)} isInvalid={Boolean(show("code"))} aria-label="Web address after bomesh.app/" maxLength={32}>
            <InputGroup fullWidth className="set-url">
              <InputGroup.Prefix className="set-url__prefix">bomesh.app/</InputGroup.Prefix>
              <InputGroup.Input id="set-code" spellCheck={false} onKeyDown={onEnter} />
            </InputGroup>
            {show("code") ? <FieldError>{show("code")}</FieldError> : null}
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
        <WhoCanJoin />
      </div>
      <Advanced defaultOpen={advancedOpen} />
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

/** An archived workspace is status, not an option: it stays above the form (preview `archiveNotice`). */
function ArchiveNotice() {
  const qc = useQueryClient();
  const session = useSession();
  const { workspace, id } = useWorkspace();
  const [busy, setBusy] = useState(false);
  if (workspace.state !== "ARCHIVED") return null;
  const since = workspace.updateTime ?? "";
  const restore = async () => {
    setBusy(true);
    try {
      patchWorkspaceContext(qc, { workspace: await activateWorkspace(id) });
      toast("Workspace restored");
    } catch (error) {
      toast(errorMessage(error), { tone: "danger" });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="set-notice">
      <Callout
        tone="danger"
        title="Archived"
        description={`${workspace.displayName} was archived ${relInline(since)}. Members can’t open it. A platform admin can restore it until ${fmtDate(Date.parse(since) + 30 * 86_400_000)}.`}
        actions={
          isPlatformOperator(session) ? (
            <Button variant="secondary" size="sm" isPending={busy} onPress={() => void restore()}>
              Restore workspace
            </Button>
          ) : undefined
        }
      />
    </div>
  );
}

/**
 * Who can join (preview `joinHtml`): invited people only, or anyone with an account, who joins by themselves as a member.
 * Each change applies at once through UpdateWorkspace with Undo; going public says what new members get, with the
 * collections open to all members; going private keeps everyone who already joined. Shown to those who may update the workspace.
 */
function WhoCanJoin() {
  const qc = useQueryClient();
  const router = useRouter();
  const { workspace, id, can } = useWorkspace();
  const open = useAllMembersCollections();
  const [busy, setBusy] = useState(false);
  const latest = useRef(workspace);
  latest.current = workspace;
  if (!can("workspaces.update")) return null;

  const name = workspace.displayName;
  const current: Visibility = workspace.visibility ?? "PRIVATE";
  const link = typeof window === "undefined" ? "" : joinLink(window.location.origin, workspace.code);

  async function apply(next: Visibility) {
    const previous = latest.current.visibility ?? "PRIVATE";
    setBusy(true);
    try {
      const saved = await updateWorkspace(id, { visibility: next, etag: latest.current.etag }, "visibility");
      patchWorkspaceContext(qc, { workspace: saved });
      toast(next === "PUBLIC" ? `${name} is public. Anyone with an account can join as a member.` : `${name} is private. Only invited people can join.`, {
        undo: () => {
          void updateWorkspace(id, { visibility: previous, etag: latest.current.etag ?? saved.etag }, "visibility").then(
            (restored) => {
              patchWorkspaceContext(qc, { workspace: restored });
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

  async function choose(next: Visibility) {
    if (busy || next === current) return;
    const reviewCollections = () => {
      dismissConfirm();
      router.push(`${COLLECTIONS_HREF}&access=workspace`);
    };
    const ok = await confirm(
      next === "PUBLIC"
        ? {
            title: `Make ${name} public?`,
            tone: "accent",
            confirmLabel: "Make public",
            description: (
              <>
                <span>Anyone with a BoMesh account can join and becomes a member right away.</span>{" "}
                <span>{`New members read the ${plural(open.length, "collection")} open to all members, contribute documents for review and use the assistant.`}</span>
                {open.length && open.length <= MAX_LISTED_COLLECTIONS ? (
                  <span className="set-vis-names" translate="no">
                    {open.map((c) => c.displayName).join(" · ")}
                  </span>
                ) : null}
                <span className="set-vis-review">
                  <span>If any of them shouldn’t reach people outside your organization, review collection access first.</span>{" "}
                  <button type="button" className="link link-button" onClick={reviewCollections}>
                    Review collections
                  </button>
                </span>
              </>
            ),
          }
        : {
            title: `Make ${name} private?`,
            tone: "accent",
            confirmLabel: "Make private",
            description: (
              <>
                <span>New people can no longer join by themselves.</span> <span>Everyone who already joined stays a member until an admin removes them.</span>
              </>
            ),
          },
    );
    if (ok) await apply(next);
  }

  return (
    <FormSection title="Who can join" description="A public workspace lets anyone with a BoMesh account join by themselves as a member.">
      <div className="set-join">
        <ChoiceGroup<Visibility>
          label="Who can join"
          name="set-vis"
          columns={2}
          value={current}
          isDisabled={busy}
          onChange={(next) => void choose(next)}
          options={[
            { value: "PRIVATE", title: "Invited people only", description: "Admins add people or send them an invite link.", icon: Lock },
            { value: "PUBLIC", title: "Anyone with an account", description: "They join by themselves and become members.", icon: Globe },
          ]}
        />
        {current === "PUBLIC" ? (
          <TextField value={link} isReadOnly aria-label="Join link">
            <Label>Join link</Label>
            <InputGroup fullWidth className="set-id">
              <InputGroup.Input className="mono" />
              <InputGroup.Suffix>
                <IconButton
                  icon={Copy}
                  tip="Copy join link"
                  size="sm"
                  onPress={() =>
                    void navigator.clipboard.writeText(link).then(
                      () => toast("Join link copied"),
                      () => toast("Couldn’t copy. Select the link and copy it.", { tone: "danger" }),
                    )
                  }
                />
              </InputGroup.Suffix>
            </InputGroup>
            <Description>Share it on your website or in announcements. It opens a page with Join; people sign in or create an account first.</Description>
          </TextField>
        ) : null}
      </div>
    </FormSection>
  );
}

/** Rare and administrative: the workspace ID and archiving, behind one disclosure (preview `advancedHtml`). */
function Advanced({ defaultOpen }: { defaultOpen: boolean }) {
  const qc = useQueryClient();
  const { workspace, id, can } = useWorkspace();
  const [busy, setBusy] = useState(false);
  const canArchive = can("workspaces.archive") && workspace.state !== "ARCHIVED";

  async function archive() {
    const ok = await confirm({
      title: `Archive ${workspace.displayName}?`,
      description: "Everyone loses access and source syncs pause. A platform admin can restore it for 30 days.",
      confirmLabel: "Archive workspace",
      tone: "danger",
      typed: workspace.code,
    });
    if (!ok) return;
    setBusy(true);
    try {
      patchWorkspaceContext(qc, { workspace: await archiveWorkspace(id, workspace.code, workspace.etag) });
      toast("Workspace archived", { tone: "accent" });
    } catch (error) {
      toast(errorMessage(error), { tone: "danger" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="set-advanced">
      <Disclosure icon={Settings} title="Advanced" summary={canArchive ? "Workspace ID, archive" : "Workspace ID"} defaultOpen={defaultOpen}>
        <TextField value={id} isReadOnly aria-label="Workspace ID">
          <Label>Workspace ID</Label>
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
          <Description>For support requests and API calls.</Description>
        </TextField>
        {canArchive ? (
          <div className="set-archive">
            <p className="grow t-sm muted">{`Archive ${workspace.displayName}. It disappears for everyone; its data is kept and a platform admin can restore it for 30 days.`}</p>
            <Button variant="danger-soft" size="sm" isPending={busy} onPress={() => void archive()}>
              <Archive className="i" aria-hidden />
              Archive workspace
            </Button>
          </div>
        ) : null}
      </Disclosure>
    </div>
  );
}

/* ── Workspace setup: modules, space types, AI workflows, map background, template ── */

const spaceTypeLabel = (key: string) => ({ displayName: spaceType(key).label, icon: SPACE_TYPE_ICONS[key] ?? "layers" });

function OptionLabel({ title, desc, meta, icon: Icon }: { title: string; desc: string; meta?: string; icon?: LucideIcon }) {
  return (
    <span className="set-opt">
      <span className="set-opt__title">
        {Icon ? <Icon className="i-sm set-opt__icon" aria-hidden /> : null}
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
  const [lang] = useLanguage();
  // Space type names joined in the interface language ("Khóa học, Dự án hoặc Nhóm"): one placeholder value the sentence can carry.
  const list = (labels: string[], type: "conjunction" | "disjunction") => new Intl.ListFormat(lang, { type }).format(labels.map((l) => tr(l) ?? l));
  const latest = useRef(settings);
  latest.current = settings;

  if (!settings) {
    return <ErrorState title="Settings didn’t load" description="Try again. Your settings haven’t changed." onRetry={() => void qc.invalidateQueries({ queryKey: workspaceQueryKey })} />;
  }

  const tplKey = templateKey(workspace.template);
  const tpl = TEMPLATES[tplKey];
  const setup = setupOf(settings);
  const changes = setupChanges(setup, tpl);
  const name = workspace.displayName;

  /** Applies a setup change now (navigation follows at once); Undo restores the previous setup. */
  async function apply(change: { body: WorkspaceSettings; updateMask: string }, message: string) {
    if (busy || !latest.current) return;
    const snapshot = latest.current;
    setBusy(true);
    try {
      const saved = await updateSettings(id, { ...change.body, etag: snapshot.etag }, change.updateMask);
      patchWorkspaceContext(qc, { settings: saved });
      toast(message, {
        undo: () => {
          const { body, updateMask } = setupBody(snapshot);
          void updateSettings(id, { ...body, etag: latest.current?.etag ?? saved.etag }, updateMask).then(
            (restored) => patchWorkspaceContext(qc, { settings: restored }),
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
    void apply({ body: { modules: { [key]: on } }, updateMask: `modules.${key}` }, on ? `${label} is on for everyone in ${name}` : `${label} is off and hidden from navigation`);
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
  const TemplateIcon = TEMPLATE_ICON[tplKey];

  return (
    <div className="set-form set-setup">
      <FormSection title="Modules" description="Changes apply to everyone right away. Turning a module off hides it; nothing is deleted.">
        <div className="set-switches">
          {MODULES.map((m) => (
            <SwitchRow key={m.key} title={m.label} description={m.desc} isSelected={setup.modules[m.key]} isDisabled={busy} onChange={() => toggleModule(m.key, m.label)} />
          ))}
        </div>
      </FormSection>
      {setup.modules.spaces ? (
        <FormSection title="Space types" description="How people group members, materials and work.">
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
                  label={<OptionLabel title={t.label} desc={t.desc} meta={n ? plural(n, "space") : undefined} icon={t.icon} />}
                />
              );
            })}
          </div>
        </FormSection>
      ) : null}
      {setup.modules.work ? (
        <FormSection title="AI workflows" description="Guided tasks people start from Work and from their spaces.">
          <div className="set-checks">
            {WORKFLOW_KEYS.map((key) => {
              const wf = workflowOf(key)!;
              // A workflow that only runs in space types that are off can't be used: disabled, with what turns it on.
              const off = wf.spaceTypes && !(setup.modules.spaces && wf.spaceTypes.some((t) => setup.spaceTypes.includes(t)));
              const why = off
                ? setup.modules.spaces
                  ? `Turn on ${list(wf.spaceTypes!.map((t) => spaceType(t, settings).label), "disjunction")} spaces to use this`
                  : "Turn on Spaces to use this"
                : "";
              const where = wf.spaceTypes ? list(wf.spaceTypes.map((t) => spaceType(t, settings).plural), "conjunction") : "Anywhere";
              const box = (
                <Check
                  isSelected={!off && setup.workflows.includes(key)}
                  isDisabled={busy || Boolean(off)}
                  onChange={() => toggleWorkflow(key, wf.label)}
                  label={<OptionLabel title={wf.label} desc={wf.desc} meta={off ? why : where} icon={wf.icon} />}
                />
              );
              return off ? (
                <Tip key={key} content={why}>
                  <span className="set-opt-off">{box}</span>
                </Tip>
              ) : (
                <span key={key}>{box}</span>
              );
            })}
          </div>
        </FormSection>
      ) : null}
      <FormSection title="Map background" description="An image behind the knowledge map, for everyone in this workspace. It’s softened so the map stays readable.">
        <MapBackgroundSetting />
      </FormSection>
      <FormSection title="Template" description="Sets which modules, space types and AI workflows this workspace starts with.">
        <Disclosure icon={TemplateIcon} title="Change template" summary={changes ? `${tpl.label} · ${plural(changes, "change")}` : tpl.label}>
          <ChoiceGroup<TemplateKey>
            label="Template"
            name="set-tpl"
            columns={2}
            value={tplKey}
            onChange={() => undefined}
            options={(Object.keys(TEMPLATES) as TemplateKey[]).map((k) => ({ value: k, title: TEMPLATES[k].label, description: TEMPLATES[k].desc, isDisabled: k !== tplKey }))}
          />
          <p className="t-xs muted mt-8">The template is chosen when the workspace is created.</p>
        </Disclosure>
        {changes ? (
          <div className="set-reset">
            <button type="button" className="link-button" disabled={busy} onClick={() => void apply(resetBody(settings, tpl, spaceTypeLabel), `Back to the ${tpl.label} defaults`)}>
              {`Reset to ${tpl.label} defaults`}
            </button>
          </div>
        ) : null}
      </FormSection>
    </div>
  );
}
