"use client";

import { Button, Description, FieldError, Input, Label, Modal, Radio, RadioGroup, Spinner, TextField } from "@heroui/react";
import { Check, ExternalLink, KeyRound, ShieldCheck } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { AppIcon, Callout, List, ListItem, StatusChip, toast } from "@/components/ui";
import { ApiError, errorMessage } from "@/lib/api/client";
import { plural } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";

import { connectConfluence, isCancelled, signInAgain, signInNew, TokenRejected } from "../accounts";
import { createSync, type Connection, type Connector } from "../api";
import { confluenceErrors, connectedConfluenceHosts, EMPTY_CONFLUENCE, type ConfluenceErrors, type ConfluenceInput } from "../connect-form";
import { accountLabel, accountStatus, accountUser, appKey, appName, providerOf, sourceHref, sourceName } from "../model";
import { closeIngestionOverlay, openWizard } from "../overlays";
import type { PendingAuthorization } from "../oauth";
import { useConnections, useConnectors, useInvalidateIngestion, useSources } from "../queries";

export const CONFLUENCE = "connectors/confluence";

/** Connectors people can connect now (ACTIVE in the platform catalog). */
export const connectable = (connectors: readonly Connector[] | undefined) => (connectors ?? []).filter((c) => c.state === "ACTIVE");

/** "Site and API token" / "Sign in with Google". */
export const authHint = (connector: string) => (connector === CONFLUENCE ? "Địa chỉ trang và API token" : `Đăng nhập bằng ${providerOf(connector)}`);

/** After a failed submit, focus the first invalid field in the open dialog (preview validate-on-submit). */
export const focusInvalid = () => requestAnimationFrame(() => document.querySelector<HTMLElement>('.modal__dialog [aria-invalid="true"]')?.focus());

/** Site, email and API token (preview `confForm`). The token is never shown again. */
export function ConfluenceFields({ value, errors, onChange, onSubmit, isDisabled }: { value: ConfluenceInput; errors: ConfluenceErrors; onChange: (value: ConfluenceInput, field: keyof ConfluenceInput) => void; onSubmit: () => void; isDisabled?: boolean }) {
  const field = (key: keyof ConfluenceInput, label: string, placeholder: string, type: string, description?: string) => (
    <TextField
      className="field"
      value={value[key]}
      onChange={(v) => onChange({ ...value, [key]: v }, key)}
      isInvalid={!!errors[key]}
      isRequired
      isDisabled={isDisabled}
      type={type}
      autoComplete={type === "password" ? "new-password" : "off"}
      fullWidth
    >
      <Label>{label}</Label>
      <Input
        placeholder={placeholder}
        onKeyDown={(e) => {
          if (e.key === "Enter") onSubmit();
        }}
      />
      {description ? <Description>{description}</Description> : null}
      <FieldError>{errors[key]}</FieldError>
    </TextField>
  );
  return (
    <div className="stack gap-12">
      {field("site", "Địa chỉ site", "yourcompany.atlassian.net", "text")}
      {field("email", "Email", "you@company.com", "email")}
      {field("token", "Mã API", "Dán mã", "password", "Tạo mã trong cài đặt tài khoản Atlassian. BoMesh lưu mã ở dạng mã hóa và sẽ không hiển thị lại.")}
    </div>
  );
}

/** Field-level revalidation once an error is showing (preview `acc-c-input`). */
export function revalidate(next: ConfluenceInput, errors: ConfluenceErrors, field: keyof ConfluenceInput, hosts: readonly string[]): ConfluenceErrors {
  if (!errors[field]) return errors;
  return { ...errors, [field]: confluenceErrors(next, hosts)[field] };
}

/** Sign-in waiting state (preview `.src-wait`). */
export function WaitingState({ title, description }: { title: string; description: string }) {
  return (
    <div className="src-wait" role="status">
      <Spinner size="lg" />
      <div className="t-subheading">{title}</div>
      <p className="description">{description}</p>
    </div>
  );
}

/** Cancels an open sign-in when the component unmounts. */
export function usePendingSignIn() {
  const ref = useRef<PendingAuthorization | null>(null);
  useEffect(() => () => ref.current?.cancel(), []);
  return ref;
}

/* ═══════════════ Connect account ═══════════════ */

export function ConnectAccountDialog({ connector: fixed }: { connector?: string }) {
  const { id } = useWorkspace();
  const connectors = useConnectors();
  const connections = useConnections();
  const refresh = useInvalidateIngestion();
  const apps = connectable(connectors.data);
  const [app, setApp] = useState(fixed ?? "");
  const current = app || apps.find((c) => c.name === "connectors/google_drive")?.name || apps[0]?.name || "";
  const [conf, setConf] = useState(EMPTY_CONFLUENCE);
  const [errors, setErrors] = useState<ConfluenceErrors>({});
  const [phase, setPhase] = useState<"idle" | "waiting" | "error">("idle");
  const [busy, setBusy] = useState(false);
  const pending = usePendingSignIn();
  const hosts = connectedConfluenceHosts(connections.data ?? []);
  const provider = providerOf(current);

  const done = (connection: Connection) => {
    refresh();
    closeIngestionOverlay();
    toast(`Đã kết nối ${accountLabel(connection)}`, { action: { label: "Thêm nguồn dữ liệu", onPress: () => openWizard({ connector: connection.connector, connection: connection.name }) } });
  };

  async function go() {
    if (busy || !current) return;
    if (current === CONFLUENCE) {
      const found = confluenceErrors(conf, hosts);
      setErrors(found);
      if (Object.keys(found).length) return focusInvalid();
      setBusy(true);
      try {
        done(await connectConfluence(id, conf));
      } catch (error) {
        setErrors({ token: error instanceof TokenRejected ? error.message : errorMessage(error) });
        focusInvalid();
      } finally {
        setBusy(false);
      }
      return;
    }
    try {
      pending.current = signInNew(id, current);
    } catch (error) {
      toast(errorMessage(error), { tone: "danger" });
      return;
    }
    setPhase("waiting");
    try {
      done(await pending.current.done);
    } catch (error) {
      if (error instanceof ApiError) toast(errorMessage(error), { tone: "danger" });
      setPhase(isCancelled(error) || error instanceof ApiError ? "idle" : "error");
    } finally {
      pending.current = null;
    }
  }

  const title = fixed ? `Kết nối tài khoản ${appName(fixed)}` : "Kết nối tài khoản";
  const waiting = phase === "waiting";
  return (
    <Modal.Backdrop isOpen isDismissable={!waiting && !busy} isKeyboardDismissDisabled={waiting || busy} onOpenChange={(o) => !o && closeIngestionOverlay()}>
      <Modal.Container size="md" scroll="inside">
        <Modal.Dialog>
          {waiting ? null : <Modal.CloseTrigger aria-label="Đóng" />}
          <Modal.Header>
            {fixed ? (
              <AppIcon app={appKey(fixed)} size="lg" className="modal__icon" />
            ) : (
              <span className="modal__icon" aria-hidden>
                <KeyRound />
              </span>
            )}
            <div className="grow">
              <Modal.Heading>{title}</Modal.Heading>
              {waiting ? null : <p className="modal__description">Các nguồn dữ liệu dùng tài khoản này để đọc các thư mục và cộng đồng bạn chọn.</p>}
            </div>
          </Modal.Header>
          <Modal.Body>
            {waiting ? (
              <WaitingState title={`Hoàn tất đăng nhập bằng ${provider}`} description={`Một cửa sổ ${provider} đã mở. Hãy quay lại đây khi hoàn tất.`} />
            ) : (
              <div className="stack gap-16">
                {phase === "error" ? <Callout tone="danger" description={`${provider} chưa xác nhận đăng nhập. Hãy thử lại.`} /> : null}
                {fixed ? null : (
                  <div className="field">
                    <span className="label">Ứng dụng</span>
                    <RadioGroup
                      aria-label="Ứng dụng"
                      value={current}
                      isDisabled={busy}
                      onChange={(v) => {
                        setApp(v);
                        setErrors({});
                        setPhase("idle");
                      }}
                      className="choice-group"
                      style={{ gridTemplateColumns: `repeat(${Math.min(2, apps.length) || 1}, minmax(0, 1fr))` }}
                    >
                      {apps.map((c) => (
                        <Radio key={c.name} value={c.name ?? ""} className="choice acc-app">
                          <Radio.Content className="choice__content">
                            <AppIcon app={appKey(c.name)} />
                            <span className="grow src-min">
                              <span className="choice__title" style={{ display: "block" }}>
                                {appName(c.name, apps)}
                              </span>
                              <span className="choice__desc" style={{ display: "block" }}>
                                {authHint(c.name ?? "")}
                              </span>
                            </span>
                          </Radio.Content>
                        </Radio>
                      ))}
                    </RadioGroup>
                  </div>
                )}
                {current === CONFLUENCE ? (
                  <ConfluenceFields
                    value={conf}
                    errors={errors}
                    isDisabled={busy}
                    onSubmit={() => void go()}
                    onChange={(next, f) => {
                      setConf(next);
                      setErrors(revalidate(next, errors, f, hosts));
                    }}
                  />
                ) : (
                  <div className="acc-note">
                    <ShieldCheck className="i i-sm" aria-hidden />
                    <span>
                      Bạn sẽ đăng nhập {provider} trong một cửa sổ mới. BoMesh chỉ đọc các {current === "connectors/google_drive" ? "thư mục" : "nội dung"} bạn chọn.
                    </span>
                  </div>
                )}
              </div>
            )}
          </Modal.Body>
          <Modal.Footer>
            {waiting ? (
              <Button variant="ghost" onPress={() => pending.current?.cancel()}>
                Hủy
              </Button>
            ) : (
              <>
                <Button slot="close" variant="ghost" isDisabled={busy}>
                  Hủy
                </Button>
                {current === CONFLUENCE ? (
                  <Button variant="primary" isPending={busy} onPress={() => void go()}>
                    {busy ? null : <Check className="i" aria-hidden />}
                    Xác minh và kết nối
                  </Button>
                ) : (
                  <Button variant="primary" isDisabled={!current} onPress={() => void go()}>
                    Tiếp tục với {provider}
                    <ExternalLink className="i" aria-hidden />
                  </Button>
                )}
              </>
            )}
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}

/* ═══════════════ Reconnect ═══════════════ */

export function ReconnectDialog({ connection: name }: { connection: string }) {
  const { id } = useWorkspace();
  const router = useRouter();
  const connections = useConnections();
  const sources = useSources();
  const refresh = useInvalidateIngestion();
  const [phase, setPhase] = useState<"idle" | "waiting" | "error">("idle");
  const pending = usePendingSignIn();
  const connection = connections.byName.get(name);
  const used = (sources.data ?? []).filter((s) => s.connection === name);
  const app = appName(connection?.connector);
  const provider = providerOf(connection?.connector);
  const title = `Kết nối lại ${app}`;

  async function go() {
    if (!connection) return;
    try {
      pending.current = signInAgain(id, connection);
    } catch (error) {
      toast(errorMessage(error), { tone: "danger" });
      return;
    }
    setPhase("waiting");
    try {
      await pending.current.done;
    } catch (error) {
      // A cancelled or failed sign-in can leave the account waiting for authorization.
      refresh();
      if (error instanceof ApiError) toast(errorMessage(error), { tone: "danger" });
      setPhase(isCancelled(error) || error instanceof ApiError ? "idle" : "error");
      return;
    } finally {
      pending.current = null;
    }
    // Sources that waited for this account sync again.
    const fixed = used.filter((s) => s.state !== "PAUSED");
    await Promise.all(fixed.map((s) => createSync(id, s.name ?? "").catch(() => null)));
    refresh();
    closeIngestionOverlay();
    if (!fixed.length) toast(`Đã kết nối lại ${app}`);
    else
      toast(`Đã kết nối lại ${app}. Đang đồng bộ ${sourceName(fixed[0]!)}${fixed.length > 1 ? ` và ${plural(fixed.length - 1, "nguồn khác")}` : ""}…`, {
        action: { label: "Mở", onPress: () => router.push(sourceHref(fixed[0]!.name)) },
      });
  }

  const waiting = phase === "waiting";
  if (!connection)
    return (
      <Modal.Backdrop isOpen onOpenChange={(o) => !o && closeIngestionOverlay()}>
        <Modal.Container size="sm" scroll="inside">
          <Modal.Dialog>
            <Modal.CloseTrigger aria-label="Đóng" />
            <Modal.Header>
              <span className="modal__icon modal__icon--default" aria-hidden>
                <KeyRound />
              </span>
              <div className="grow">
                <Modal.Heading>Đã gỡ tài khoản</Modal.Heading>
                <p className="modal__description">Tài khoản đã bị ngắt kết nối trong lúc đó.</p>
              </div>
            </Modal.Header>
            <Modal.Footer>
              <Button slot="close" variant="primary">
                Đóng
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    );
  return (
    <Modal.Backdrop isOpen isDismissable={!waiting} isKeyboardDismissDisabled={waiting} onOpenChange={(o) => !o && closeIngestionOverlay()}>
      <Modal.Container size="md" scroll="inside">
        <Modal.Dialog>
          {waiting ? null : <Modal.CloseTrigger aria-label="Đóng" />}
          <Modal.Header>
            <AppIcon app={appKey(connection.connector)} size="lg" className="modal__icon" />
            <div className="grow">
              <Modal.Heading>{title}</Modal.Heading>
              {waiting ? null : <p className="modal__description">{`Đăng nhập lại bằng ${accountUser(connection)} để tiếp tục đồng bộ. Tài liệu đã đồng bộ vẫn tra cứu được.`}</p>}
            </div>
          </Modal.Header>
          <Modal.Body>
            {waiting ? (
              <WaitingState title={`Hoàn tất đăng nhập bằng ${provider}`} description={`Đăng nhập bằng ${accountUser(connection)}, sau đó quay lại đây.`} />
            ) : (
              <>
                {phase === "error" ? (
                  <div className="mb-12">
                    <Callout tone="danger" description={`${provider} chưa xác nhận đăng nhập. Hãy thử lại.`} />
                  </div>
                ) : null}
                <List>
                  <ListItem
                    title={accountLabel(connection)}
                    contentTitle
                    description={used.length ? `${used.map(sourceName).join(", ")} đang sử dụng` : "Không có nguồn dữ liệu nào sử dụng"}
                    actions={<StatusChip kind="account" value={accountStatus(connection)} />}
                  />
                </List>
              </>
            )}
          </Modal.Body>
          <Modal.Footer>
            {waiting ? (
              <Button variant="ghost" onPress={() => pending.current?.cancel()}>
                Hủy
              </Button>
            ) : (
              <>
                <Button slot="close" variant="ghost">
                  Hủy
                </Button>
                <Button variant="primary" onPress={() => void go()}>
                  {phase === "error" ? "Thử lại" : `Tiếp tục với ${provider}`}
                  <ExternalLink className="i" aria-hidden />
                </Button>
              </>
            )}
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}
