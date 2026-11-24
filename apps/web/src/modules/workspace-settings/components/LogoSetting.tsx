"use client";

import { Button } from "@heroui/react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { AlertCircle, Upload } from "lucide-react";
import { useRef, useState, type ChangeEvent } from "react";

import { FormSection, toast, WorkspaceMark } from "@/components/ui";
import { errorMessage } from "@/lib/api/client";
import { relInline } from "@/lib/format";
import { patchWorkspaceContext, useWorkspace } from "@/lib/workspace";

import { removeLogo, uploadLogo, type WorkspaceSettings } from "../api";
import { logoFileError, logoToast } from "../model";

/** The saved image, fetched before a replace or remove so Undo can upload it again; null when it can't be read. */
async function keepImage(uri: string | undefined): Promise<Blob | null> {
  if (!uri) return null;
  try {
    const response = await fetch(uri);
    return response.ok ? await response.blob() : null;
  } catch {
    return null;
  }
}

/** The new settings everywhere the mark shows: the context (sidebar), and the chooser's and switcher's workspace lists. */
function applied(qc: QueryClient, settings: WorkspaceSettings) {
  patchWorkspaceContext(qc, { settings, workspace: { logoUri: settings.branding?.logo?.uri } });
  for (const queryKey of [["shell", "my-workspaces"], ["my-workspaces"], ["public-workspaces"]]) void qc.invalidateQueries({ queryKey });
}

/**
 * Settings › General › Logo (preview `logoHtml`): the mark as the sidebar shows it, what's set, and Upload / Replace /
 * Remove. Each change applies at once with Undo; the file is checked here first (type, size) so the message is immediate.
 * Shown to those who may update the settings.
 */
export function LogoSetting() {
  const qc = useQueryClient();
  const { workspace, id, settings, can } = useWorkspace();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!can("workspaces.updateSettings")) return null;

  const logo = settings?.branding?.logo;
  const uri = logo?.uri ?? workspace.logoUri;

  async function change(next: { image: Blob; name: string } | null) {
    const before = logo;
    setBusy(true);
    setError(null);
    try {
      const kept = before ? await keepImage(before.uri) : null;
      const saved = next ? await uploadLogo(id, next.image, next.name) : await removeLogo(id);
      applied(qc, saved);
      const undo = async () => {
        const restored = before ? (kept ? await uploadLogo(id, kept, before.fileName ?? "logo") : null) : await removeLogo(id);
        if (!restored) return;
        applied(qc, restored);
        toast("Đã hoàn tác thay đổi", { tone: "accent" });
      };
      toast(logoToast(Boolean(before), Boolean(next)), {
        undo: !before || kept ? () => void undo().catch((e: unknown) => toast(errorMessage(e), { tone: "danger" })) : undefined,
      });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  function picked(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const problem = logoFileError(file);
    if (problem) return setError(problem);
    void change({ image: file, name: file.name });
  }

  return (
    <FormSection title="Logo" description="Hiển thị thay cho chữ cái đầu ở thanh bên, danh sách không gian làm việc và trang tham gia. PNG, JPEG hoặc WebP, tối đa 1 MB; ảnh hình gì cũng được đặt trọn trong ô vuông.">
      <div className="set-logo">
        <WorkspaceMark name={workspace.displayName} logo={uri} size={48} />
        <div className="grow set-logo__text">
          {logo ? (
            <>
              <div className="medium truncate" translate="no">
                {logo.fileName}
              </div>
              {logo.updateTime ? <div className="t-xs muted">{`Đã cập nhật ${relInline(logo.updateTime)}`}</div> : null}
            </>
          ) : (
            <>
              <div className="medium">Chưa có logo</div>
              <div className="t-xs muted">Đang hiển thị chữ cái đầu của tên.</div>
            </>
          )}
        </div>
        <div className="row gap-8">
          <Button size="sm" variant="tertiary" isPending={busy} isDisabled={busy} onPress={() => input.current?.click()}>
            <Upload className="i" aria-hidden />
            {logo ? "Thay thế" : "Tải logo lên"}
          </Button>
          {logo ? (
            <Button size="sm" variant="ghost" isDisabled={busy} onPress={() => void change(null)}>
              Gỡ
            </Button>
          ) : null}
        </div>
        <input ref={input} type="file" className="sr-only" accept="image/*" tabIndex={-1} aria-hidden onChange={picked} />
      </div>
      {error ? (
        <div className="field-error" role="alert">
          <AlertCircle className="i" aria-hidden />
          <span>{error}</span>
        </div>
      ) : null}
    </FormSection>
  );
}
