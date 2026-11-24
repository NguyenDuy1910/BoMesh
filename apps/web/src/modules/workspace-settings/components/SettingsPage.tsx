"use client";

import { Button, Checkbox, Description, FieldError, Input, InputGroup, Label, TextField } from "@heroui/react";
import { useQueryClient } from "@tanstack/react-query";
import { Archive, Building2, Copy, Globe, GraduationCap, Lock, Settings, type LucideIcon } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import { Callout, ChoiceGroup, Disclosure, ErrorState, FormSection, IconButton, Page, PageHeader, SaveBar, SwitchRow, Tip, confirm, dismissConfirm, toast } from "@/components/ui";
import { ApiError, errorMessage } from "@/lib/api/client";
import { fmtDate, plural, relInline } from "@/lib/format";
import { useMessages } from "@/lib/i18n";
import { sectionTitle, settingsSections, useSection } from "@/lib/navigation";
import { LATER_PHASE_MODULES } from "@/lib/modules";
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
import { LogoSetting } from "./LogoSetting";

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
  if (taken && draft.code.trim() === taken) errs.code = `bomesh.app/${taken} đã được sử dụng.`;
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
      toast("Đã lưu cài đặt");
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
        <FormSection title="Tên không gian làm việc" description="Hiển thị trong điều hướng, lời mời và email.">
          <TextField value={draft.name} onChange={(v) => edit("name", v)} isInvalid={Boolean(show("name"))} aria-label="Tên không gian làm việc" maxLength={MAX_NAME}>
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
        <LogoSetting />
        <FormSection title="Địa chỉ web" description="Nơi mọi người đăng nhập vào không gian làm việc này.">
          <TextField value={draft.code} onChange={(v) => edit("code", v)} isInvalid={Boolean(show("code"))} aria-label="Địa chỉ web sau bomesh.app/" maxLength={32}>
            <InputGroup fullWidth className="set-url">
              <InputGroup.Prefix className="set-url__prefix">bomesh.app/</InputGroup.Prefix>
              <InputGroup.Input id="set-code" spellCheck={false} onKeyDown={onEnter} />
            </InputGroup>
            {show("code") ? <FieldError>{show("code")}</FieldError> : null}
          </TextField>
          {codeChanged ? (
            <Callout
              tone="warning"
              title="Liên kết cũ sẽ ngừng hoạt động"
              description={
                <>
                  <span className="mono">bomesh.app/{current.code}</span> sẽ không chuyển hướng tới <span className="mono">bomesh.app/{code}</span>. Hãy chia sẻ địa chỉ mới sau khi lưu.
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
      toast("Đã khôi phục không gian làm việc");
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
        title="Đã lưu trữ"
        description={`${workspace.displayName} đã được lưu trữ ${relInline(since)}. Thành viên không thể mở. Quản trị viên nền tảng có thể khôi phục đến ${fmtDate(Date.parse(since) + 30 * 86_400_000)}.`}
        actions={
          isPlatformOperator(session) ? (
            <Button variant="secondary" size="sm" isPending={busy} onPress={() => void restore()}>
              Khôi phục không gian làm việc
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
      toast(next === "PUBLIC" ? `${name} đã công khai. Bất kỳ ai có tài khoản đều có thể tham gia với tư cách thành viên.` : `${name} đã chuyển sang riêng tư. Chỉ người được mời mới tham gia được.`, {
        undo: () => {
          void updateWorkspace(id, { visibility: previous, etag: latest.current.etag ?? saved.etag }, "visibility").then(
            (restored) => {
              patchWorkspaceContext(qc, { workspace: restored });
              toast("Đã hoàn tác thay đổi", { tone: "accent" });
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
            title: `Công khai ${name}?`,
            tone: "accent",
            confirmLabel: "Công khai",
            description: (
              <>
                <span>Bất kỳ ai có tài khoản BoMesh đều có thể tham gia và trở thành thành viên ngay.</span>{" "}
                <span>{`Thành viên mới đọc được ${plural(open.length, "collection")} mở cho mọi thành viên, gửi tài liệu để duyệt và dùng trợ lý.`}</span>
                {open.length && open.length <= MAX_LISTED_COLLECTIONS ? (
                  <span className="set-vis-names" translate="no">
                    {open.map((c) => c.displayName).join(" · ")}
                  </span>
                ) : null}
                <span className="set-vis-review">
                  <span>Nếu có kho nào không nên đến tay người ngoài tổ chức, hãy rà soát quyền truy cập kho tài liệu trước.</span>{" "}
                  <button type="button" className="link link-button" onClick={reviewCollections}>
                    Rà soát kho tài liệu
                  </button>
                </span>
              </>
            ),
          }
        : {
            title: `Chuyển ${name} sang riêng tư?`,
            tone: "accent",
            confirmLabel: "Đặt riêng tư",
            description: (
              <>
                <span>Người mới sẽ không thể tự tham gia nữa.</span> <span>Những người đã tham gia vẫn là thành viên cho đến khi quản trị viên gỡ họ.</span>
              </>
            ),
          },
    );
    if (ok) await apply(next);
  }

  return (
    <FormSection title="Ai được tham gia" description="Không gian làm việc công khai cho phép bất kỳ ai có tài khoản BoMesh tự tham gia với tư cách thành viên.">
      <div className="set-join">
        <ChoiceGroup<Visibility>
          label="Ai được tham gia"
          name="set-vis"
          columns={2}
          value={current}
          isDisabled={busy}
          onChange={(next) => void choose(next)}
          options={[
            { value: "PRIVATE", title: "Chỉ người được mời", description: "Quản trị viên thêm người hoặc gửi cho họ liên kết mời.", icon: Lock },
            { value: "PUBLIC", title: "Bất kỳ ai có tài khoản", description: "Họ tự tham gia và trở thành thành viên.", icon: Globe },
          ]}
        />
        {current === "PUBLIC" ? (
          <TextField value={link} isReadOnly aria-label="Liên kết tham gia">
            <Label>Liên kết tham gia</Label>
            <InputGroup fullWidth className="set-id">
              <InputGroup.Input className="mono" />
              <InputGroup.Suffix>
                <IconButton
                  icon={Copy}
                  tip="Sao chép liên kết tham gia"
                  size="sm"
                  onPress={() =>
                    void navigator.clipboard.writeText(link).then(
                      () => toast("Đã sao chép liên kết tham gia"),
                      () => toast("Không sao chép được. Hãy chọn liên kết rồi sao chép.", { tone: "danger" }),
                    )
                  }
                />
              </InputGroup.Suffix>
            </InputGroup>
            <Description>Chia sẻ trên website hoặc trong thông báo. Liên kết mở trang có nút Tham gia; mọi người đăng nhập hoặc tạo tài khoản trước.</Description>
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
      title: `Lưu trữ ${workspace.displayName}?`,
      description: "Mọi người mất quyền truy cập và việc đồng bộ nguồn dữ liệu tạm dừng. Quản trị viên nền tảng có thể khôi phục trong 30 ngày.",
      confirmLabel: "Lưu trữ không gian làm việc",
      tone: "danger",
      typed: workspace.code,
    });
    if (!ok) return;
    setBusy(true);
    try {
      patchWorkspaceContext(qc, { workspace: await archiveWorkspace(id, workspace.code, workspace.etag) });
      toast("Đã lưu trữ không gian làm việc", { tone: "accent" });
    } catch (error) {
      toast(errorMessage(error), { tone: "danger" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="set-advanced">
      <Disclosure icon={Settings} title="Nâng cao" summary={canArchive ? "ID không gian làm việc, lưu trữ" : "ID không gian làm việc"} defaultOpen={defaultOpen}>
        <TextField value={id} isReadOnly aria-label="ID không gian làm việc">
          <Label>ID không gian làm việc</Label>
          <InputGroup fullWidth className="set-id">
            <InputGroup.Input className="mono" />
            <InputGroup.Suffix>
              <IconButton
                icon={Copy}
                tip="Sao chép ID không gian làm việc"
                size="sm"
                onPress={() =>
                  void navigator.clipboard.writeText(id).then(
                    () => toast("Đã sao chép ID không gian làm việc"),
                    () => toast("Không sao chép được. Hãy chọn ID rồi tự sao chép.", { tone: "danger" }),
                  )
                }
              />
            </InputGroup.Suffix>
          </InputGroup>
          <Description>Dùng cho yêu cầu hỗ trợ và lệnh gọi API.</Description>
        </TextField>
        {canArchive ? (
          <div className="set-archive">
            <p className="grow t-sm muted">{`Lưu trữ ${workspace.displayName}. Không gian làm việc sẽ biến mất với mọi người; dữ liệu được giữ lại và quản trị viên nền tảng có thể khôi phục trong 30 ngày.`}</p>
            <Button variant="danger-soft" size="sm" isPending={busy} onPress={() => void archive()}>
              <Archive className="i" aria-hidden />
              Lưu trữ không gian làm việc
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
  // Space type names joined in Vietnamese ("Khóa học, Dự án hoặc Nhóm"): one placeholder value the sentence can carry.
  const list = (labels: string[], type: "conjunction" | "disjunction") => new Intl.ListFormat("vi", { type }).format(labels);
  const latest = useRef(settings);
  latest.current = settings;

  if (!settings) {
    return <ErrorState title="Không tải được cài đặt" description="Hãy thử lại. Cài đặt của bạn chưa thay đổi." onRetry={() => void qc.invalidateQueries({ queryKey: workspaceQueryKey })} />;
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
    void apply({ body: { modules: { [key]: on } }, updateMask: `modules.${key}` }, on ? `${label} đã bật cho mọi người trong ${name}` : `${label} đã tắt và ẩn khỏi điều hướng`);
  };

  const toggleSpaceType = (key: string) => {
    const next = toggled(setup.spaceTypes, key);
    if (!next) return void toast("Giữ ít nhất một loại cộng đồng khi Cộng đồng đang bật.", { tone: "danger" });
    const t = spaceType(key, settings);
    const added = next.length > setup.spaceTypes.length;
    void apply(
      { body: { spaceTypes: spaceTypesWith(settings, next, spaceTypeLabel) }, updateMask: "spaceTypes" },
      added ? `Mọi người giờ có thể tạo ${t.plural.toLowerCase()}` : `Không tạo được ${t.plural.toLowerCase()} mới. Các mục hiện có được giữ nguyên.`,
    );
  };

  const toggleWorkflow = (key: WorkflowKey, label: string) => {
    const next = toggled(setup.workflows, key);
    if (!next) return void toast("Giữ ít nhất một quy trình AI khi Công việc đang bật.", { tone: "danger" });
    const added = next.length > setup.workflows.length;
    void apply({ body: { workflows: workflowsWith(next) }, updateMask: "workflows" }, added ? `${label} đã có trong Công việc` : `${label} đã tắt. Công việc đã lưu được giữ nguyên.`);
  };

  const spaceCount = (key: string) => spaces.data?.filter((s) => s.spaceType === key).length ?? 0;
  const TemplateIcon = TEMPLATE_ICON[tplKey];

  return (
    <div className="set-form set-setup">
      <FormSection title="Mô-đun" description="Thay đổi áp dụng cho mọi người ngay lập tức. Tắt mô-đun sẽ ẩn nó; không có gì bị xóa.">
        <div className="set-switches">
          {/* Modules held back for a later phase have no switch: nobody can turn them on yet. */}
          {MODULES.filter((m) => !LATER_PHASE_MODULES[m.key]).map((m) => (
            <SwitchRow key={m.key} title={m.label} description={m.desc} isSelected={setup.modules[m.key]} isDisabled={busy} onChange={() => toggleModule(m.key, m.label)} />
          ))}
        </div>
      </FormSection>
      {setup.modules.spaces ? (
        <FormSection title="Loại cộng đồng" description="Cách mọi người nhóm thành viên, tài liệu và công việc.">
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
      {setup.modules.work && !LATER_PHASE_MODULES.work ? (
        <FormSection title="Quy trình AI" description="Quy trình có hướng dẫn mà mọi người bắt đầu từ Công việc hoặc từ cộng đồng của họ.">
          <div className="set-checks">
            {WORKFLOW_KEYS.map((key) => {
              const wf = workflowOf(key)!;
              // A workflow that only runs in space types that are off can't be used: disabled, with what turns it on.
              const off = wf.spaceTypes && !(setup.modules.spaces && wf.spaceTypes.some((t) => setup.spaceTypes.includes(t)));
              const why = off
                ? setup.modules.spaces
                  ? `Bật cộng đồng ${list(wf.spaceTypes!.map((t) => spaceType(t, settings).label), "disjunction")} để dùng`
                  : "Bật Cộng đồng để dùng"
                : "";
              const where = wf.spaceTypes ? list(wf.spaceTypes.map((t) => spaceType(t, settings).plural), "conjunction") : "Mọi nơi";
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
      <FormSection title="Ảnh nền bản đồ" description="Ảnh phía sau bản đồ tài liệu, cho mọi người trong không gian làm việc. Ảnh được làm dịu để bản đồ vẫn dễ đọc.">
        <MapBackgroundSetting />
      </FormSection>
      <FormSection title="Mẫu" description="Xác định các mô-đun, loại cộng đồng và quy trình AI mà không gian làm việc này bắt đầu với.">
        <Disclosure icon={TemplateIcon} title="Đổi mẫu" summary={changes ? `${tpl.label} · ${plural(changes, "change")}` : tpl.label}>
          <ChoiceGroup<TemplateKey>
            label="Mẫu"
            name="set-tpl"
            columns={2}
            value={tplKey}
            onChange={() => undefined}
            options={(Object.keys(TEMPLATES) as TemplateKey[]).map((k) => ({ value: k, title: TEMPLATES[k].label, description: TEMPLATES[k].desc, isDisabled: k !== tplKey }))}
          />
          <p className="t-xs muted mt-8">Mẫu được chọn khi tạo không gian làm việc.</p>
        </Disclosure>
        {changes ? (
          <div className="set-reset">
            <button type="button" className="link-button" disabled={busy} onClick={() => void apply(resetBody(settings, tpl, spaceTypeLabel), `Quay lại mặc định ${tpl.label}`)}>
              {`Đặt lại về mặc định ${tpl.label}`}
            </button>
          </div>
        ) : null}
      </FormSection>
    </div>
  );
}
