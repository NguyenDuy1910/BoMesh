"use client";

import { Archive, Check, TriangleAlert } from "lucide-react";
import { useId, useState, useSyncExternalStore } from "react";

import { Page } from "@/components/shell/Page";
import { RequirePermission } from "@/components/shell/RequirePermission";
import { useCurrentWorkspace } from "@/components/shell/useCurrentWorkspace";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { ui } from "@/components/ui/design-system";
import { ErrorState } from "@/components/ui/ErrorState";
import { FormField } from "@/components/ui/FormField";
import { Input } from "@/components/ui/Input";
import { PageHeader } from "@/components/ui/PageHeader";
import { PreviewTag } from "@/components/ui/PreviewTag";
import { Skeleton } from "@/components/ui/Skeleton";
import { useToast } from "@/components/ui/Toast";
import { usePendingFeature } from "@/lib/api/pending";
import { ApiError } from "@/lib/api/request";
import { describeRequestFailure } from "@/lib/api/errors";
import { ACCENT_OPTIONS } from "@/lib/appearance";
import { getAuthSession, storeAuthSession } from "@/lib/auth/session";
import { cn } from "@/lib/cn";
import { useAccountPreferences } from "@/lib/hooks/useAccountPreferences";
import { workspaceDirectoryApi, type Workspace } from "@/modules/manage/access/directory";
import {
  archiveWorkspace,
  getWorkspaceArchive,
  getWorkspaceBranding,
  getWorkspaceCode,
  updateWorkspaceBranding,
  updateWorkspaceCode,
  type WorkspaceAccent,
} from "@/modules/manage/settings/api";
import { workspaceCodeProblem } from "@/modules/platform/workspace-code";
import { formatRelative } from "@/lib/format";
import { useApiData } from "@/lib/hooks/useApiData";

const NAME_LIMIT = 60;

/** `host/` before the address field; empty on the server, where there is no location. */
function useHostPrefix() {
  return useSyncExternalStore(
    () => () => {},
    () => `${window.location.host}/`,
    () => "",
  );
}

export function SettingsPage() {
  return (
    <RequirePermission anyOf={["tenant.manage"]}>
      <Settings />
    </RequirePermission>
  );
}

function Settings() {
  const { workspace } = useCurrentWorkspace();
  const workspaceId = workspace?.id ?? "";
  const codeEnabled = usePendingFeature("workspace.url_code");
  const brandingEnabled = usePendingFeature("workspace.branding");
  const archiveEnabled = usePendingFeature("workspace.archive");
  const detail = useApiData(
    async () => {
      if (!workspaceId) return null;
      const [real, code] = await Promise.all([
        workspaceDirectoryApi.workspace(workspaceId),
        codeEnabled ? getWorkspaceCode(workspaceId) : null,
      ]);
      // While the address change is pending, the address saved in this browser is the current one.
      return { workspace: real, code: code?.code ?? real.code };
    },
    workspaceId,
  );

  return (
    <Page width="narrow">
      <PageHeader sub="Name and address of this workspace." title="Workspace settings" />
      {detail.error ? (
        <ErrorState description={detail.error} onAction={detail.reload} title="Settings didn’t load" />
      ) : !detail.data ? (
        <div aria-busy="true" aria-label="Loading workspace settings" className={cn(ui.card, "flex flex-col gap-4 p-5")}>
          <Skeleton className="h-3.5 w-[30%]" />
          <Skeleton className="h-9" />
          <Skeleton className="h-3.5 w-[24%]" />
          <Skeleton className="h-9" />
        </div>
      ) : (
        <>
          <GeneralCard
            code={detail.data.code}
            codeEditable={codeEnabled}
            key={`${detail.data.workspace.name}:${detail.data.code}`}
            workspace={detail.data.workspace}
          />
          {brandingEnabled && <BrandCard workspace={detail.data.workspace} />}
          {archiveEnabled && <DangerZone code={detail.data.code} workspace={detail.data.workspace} />}
        </>
      )}
    </Page>
  );
}

function Card({ title, extra, danger = false, children, footer }: {
  title: string;
  extra?: React.ReactNode;
  danger?: boolean;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className={cn(ui.card, "mb-4 overflow-hidden", danger && "mt-5 border-status-danger-border")}>
      <div className={cn("flex items-center gap-2 border-b px-5 py-3.5", danger ? "border-status-danger-border" : "border-border-subtle")}>
        <h2 className={cn(ui.sectionTitle, danger && "text-status-danger")} id={headingId}>{title}</h2>
        {extra}
      </div>
      <div className="px-5 py-5">{children}</div>
      {footer && (
        <div className="flex justify-end gap-2 border-t border-border-subtle bg-surface-subtle px-5 py-3">{footer}</div>
      )}
    </section>
  );
}

function GeneralCard({ workspace, code: savedCode, codeEditable }: { workspace: Workspace; code: string; codeEditable: boolean }) {
  const toast = useToast();
  const prefix = useHostPrefix();
  const nameId = useId();
  const codeId = useId();
  const [name, setName] = useState(workspace.name);
  const [code, setCode] = useState(savedCode);
  const [touched, setTouched] = useState({ name: false, code: false });
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [serverCodeError, setServerCodeError] = useState<string | null>(null);

  const nameChanged = name.trim() !== workspace.name;
  const codeChanged = code.trim() !== savedCode;
  const dirty = nameChanged || codeChanged;
  const errors = {
    name: !name.trim() ? "Enter a workspace name." : name.trim().length > NAME_LIMIT ? `Keep the name to ${NAME_LIMIT} characters.` : null,
    // An address created before today's rule stays valid until someone changes it.
    code: codeChanged ? serverCodeError ?? workspaceCodeProblem(code.trim()) : null,
  };
  const show = (field: "name" | "code") => ((tried || touched[field]) && errors[field]) || undefined;

  function discard() {
    setName(workspace.name);
    setCode(savedCode);
    setTouched({ name: false, code: false });
    setTried(false);
    setServerCodeError(null);
  }

  async function save() {
    if (!dirty || busy) return;
    setTried(true);
    if (errors.name || errors.code) {
      document.getElementById(errors.name ? nameId : codeId)?.focus();
      return;
    }
    setBusy(true);
    try {
      // The address first: a refused address leaves nothing half-saved.
      if (codeChanged) await updateWorkspaceCode(workspace.id, { code: code.trim() });
      if (nameChanged) {
        const saved = await workspaceDirectoryApi.saveWorkspace(workspace.id, { name: name.trim() });
        // The sidebar names the workspace from the session; keep it in step with the rename.
        const session = getAuthSession();
        if (session) {
          storeAuthSession({
            ...session,
            workspaces: session.workspaces.map((item) => (item.id === saved.id ? { ...item, name: saved.name } : item)),
          });
        }
      }
      toast.show({ message: "Workspace settings saved" });
    } catch (cause) {
      setBusy(false);
      if (codeChanged && cause instanceof ApiError && (cause.status === 409 || cause.status === 422)) {
        setServerCodeError(cause.message);
        document.getElementById(codeId)?.focus();
        return;
      }
      toast.show({ tone: "err", message: describeRequestFailure(cause, "Saving the workspace settings") });
    }
  }

  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <Card
        footer={(
          <>
            {dirty && <Button disabled={busy} onClick={discard} variant="ghost">Discard</Button>}
            <Button disabled={!dirty} loading={busy} type="submit" variant={dirty ? "primary" : "secondary"}>Save changes</Button>
          </>
        )}
        title="General"
      >
        <FormField
          error={show("name")}
          help="Shown in the sidebar and in emails people get from BoMesh."
          htmlFor={nameId}
          label="Workspace name"
          required
        >
          <Input
            maxLength={80}
            onBlur={() => setTouched((current) => ({ ...current, name: true }))}
            onChange={(event) => setName(event.target.value)}
            value={name}
          />
        </FormField>
        <FormField
          className="mt-5"
          error={show("code")}
          help={codeEditable ? (
            codeChanged && !errors.code ? (
              <span className="inline-flex items-center gap-1.5 font-medium text-status-warning">
                <TriangleAlert aria-hidden="true" className="size-3.5" />
                Changing the address breaks saved links.
              </span>
            ) : "Lowercase letters, numbers and hyphens."
          ) : "Set when the workspace was created."}
          htmlFor={codeId}
          label={<span className="inline-flex items-center gap-2">Web address {codeEditable && <PreviewTag />}</span>}
          required
        >
          <Input
            maxLength={40}
            onBlur={() => setTouched((current) => ({ ...current, code: true }))}
            onChange={(event) => {
              setCode(event.target.value);
              setServerCodeError(null);
            }}
            prefix={prefix || undefined}
            readOnly={!codeEditable}
            spellCheck={false}
            value={code}
          />
        </FormField>
      </Card>
    </form>
  );
}

function BrandCard({ workspace }: { workspace: Workspace }) {
  const toast = useToast();
  const { preferences } = useAccountPreferences();
  const branding = useApiData(() => getWorkspaceBranding(workspace.id), workspace.id);
  const [picked, setPicked] = useState<WorkspaceAccent | null>(null);
  const [busy, setBusy] = useState(false);
  const saved = branding.data?.accent ?? "indigo";
  const accent = picked ?? saved;
  const dirty = picked !== null && picked !== saved;
  const swatch = ACCENT_OPTIONS.find((option) => option.value === accent)?.swatch ?? ACCENT_OPTIONS[0].swatch;

  async function save() {
    if (!dirty || busy) return;
    setBusy(true);
    try {
      await updateWorkspaceBranding(workspace.id, { accent });
      setPicked(null);
      toast.show(preferences.accent === "workspace"
        ? { message: "Brand color updated" }
        : {
          message: "Brand color updated",
          description: "You’re using your own accent. Choose Workspace brand in Preferences to see it.",
        });
    } catch (cause) {
      toast.show({ tone: "err", message: describeRequestFailure(cause, "Saving the brand color") });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      extra={<PreviewTag />}
      footer={(
        <>
          {dirty && <Button disabled={busy} onClick={() => setPicked(null)} variant="ghost">Discard</Button>}
          <Button disabled={!dirty} loading={busy} onClick={() => void save()} variant={dirty ? "primary" : "secondary"}>
            Save brand
          </Button>
        </>
      )}
      title="Brand"
    >
      {branding.error ? (
        <ErrorState description={branding.error} layout="inline" onAction={branding.reload} title="The brand color didn’t load" />
      ) : (
        <div className="flex flex-wrap items-start gap-4">
          <div className="min-w-60 flex-1">
            <p className={ui.label} id={`brand-${workspace.id}`}>Brand color</p>
            <p className={cn(ui.helper, "mt-0.5 mb-3")}>
              Used for buttons, selection and the workspace mark for everyone who follows the workspace brand. People can still pick their own accent.
            </p>
            <div aria-labelledby={`brand-${workspace.id}`} className="flex gap-2.5" role="radiogroup">
              {ACCENT_OPTIONS.map((option) => (
                <label className="relative cursor-pointer" key={option.value} title={option.label}>
                  <input
                    checked={accent === option.value}
                    className="peer sr-only"
                    disabled={!branding.data}
                    name={`brand-${workspace.id}`}
                    onChange={() => setPicked(option.value)}
                    type="radio"
                    value={option.value}
                  />
                  <span className="sr-only">{option.label}</span>
                  <span
                    aria-hidden="true"
                    className={cn(
                      "grid size-8 place-items-center rounded-full text-[var(--text-on-danger)] ring-offset-2 ring-offset-surface-base",
                      "peer-checked:ring-2 peer-checked:ring-border-strong peer-focus-visible:shadow-(--shadow-focus)",
                    )}
                    style={{ background: option.swatch }}
                  >
                    {accent === option.value && <Check className="size-4" strokeWidth={2.5} />}
                  </span>
                </label>
              ))}
            </div>
          </div>
          <div aria-label="Preview" className="w-60 rounded-lg border border-border-subtle bg-surface-subtle p-3.5" role="group">
            <p className="mb-2.5 text-caption text-text-tertiary">Preview</p>
            <p className="flex items-center gap-2.5">
              <span
                aria-hidden="true"
                className="grid size-8 place-items-center rounded-md text-body font-semibold text-[var(--text-on-danger)]"
                style={{ background: swatch }}
              >
                {workspace.name.trim().charAt(0).toUpperCase() || "W"}
              </span>
              <b className="truncate font-semibold text-text-primary">{workspace.name}</b>
            </p>
            <p className="mt-3 flex items-center gap-2">
              <span className="inline-flex h-(--control-sm) items-center rounded-sm px-2.5 text-meta font-medium text-[var(--text-on-danger)]" style={{ background: swatch }}>
                Primary action
              </span>
              <span
                className="inline-flex h-5.5 items-center rounded-full px-2 text-caption font-medium"
                style={{ background: `color-mix(in srgb, ${swatch} 12%, transparent)`, color: swatch }}
              >
                Selected
              </span>
            </p>
          </div>
        </div>
      )}
    </Card>
  );
}

function DangerZone({ workspace, code }: { workspace: Workspace; code: string }) {
  const toast = useToast();
  const archive = useApiData(() => getWorkspaceArchive(workspace.id), workspace.id);
  const [confirming, setConfirming] = useState(false);

  return (
    <Card danger extra={<PreviewTag />} title="Danger zone">
      {archive.data ? (
        <Callout title="Archive requested" tone="warn">
          {archive.data.archived_by.display_name ?? "An admin"} asked to archive this workspace {formatRelative(archive.data.archived_at)}.
          {" "}Platform admins finish archiving within 24 hours and can restore it for 30 days.
        </Callout>
      ) : (
        <div className="flex flex-wrap items-center gap-4">
          <div className="min-w-60 flex-1">
            <p className="text-body font-medium text-text-primary">Archive workspace</p>
            <p className="mt-0.5 text-body text-text-secondary">
              Everyone loses access, including you. Platform admins can restore it for 30 days.
            </p>
          </div>
          <Button
            disabled={!!archive.error || archive.loading}
            icon={<Archive aria-hidden="true" />}
            onClick={() => setConfirming(true)}
            variant="danger-ghost"
          >
            Archive workspace
          </Button>
        </div>
      )}
      <ConfirmDialog
        confirmLabel="Archive workspace"
        confirmText={code}
        description={(
          <>
            Everyone loses access right away, including you. Platform admins finish archiving within 24 hours and can
            restore it for 30 days. Type <b className="font-mono font-semibold">{code}</b> to confirm.
          </>
        )}
        onClose={() => setConfirming(false)}
        onConfirm={async () => {
          await archiveWorkspace(workspace.id, { confirm_code: code });
          toast.show({ message: "Archive requested", description: "Platform admins will finish it within 24 hours." });
        }}
        open={confirming}
        title={`Archive ${workspace.name}?`}
      />
    </Card>
  );
}
