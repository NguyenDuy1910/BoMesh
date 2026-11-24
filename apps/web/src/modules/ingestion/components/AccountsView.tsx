"use client";

import { Button, Spinner } from "@heroui/react";
import { KeyRound, LogIn, Plug, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";

import { AppIcon, confirm, DataTable, EmptyState, Gate, SkeletonRows, StatusChip, toast, type DataTableColumn, type RowAction } from "@/components/ui";
import { errorMessage } from "@/lib/api/client";
import { plural, rel } from "@/lib/format";
import { serverText } from "@/lib/i18n";
import { useWorkspace } from "@/lib/workspace";

import { deleteConnection, testConnection, type Connection } from "../api";
import { accountLabel, accountStatus, accountSub, appKey, appName, sourceName } from "../model";
import { openConnectAccount, openReconnect, openWizard } from "../overlays";
import { sourcesByConnection, useConnections, useInvalidateIngestion, useSources } from "../queries";
import { useParamState } from "./shared";

/**
 * Studio → Sources → Accounts (preview `X.acc.view`): the app sign-ins sources read with. Test, reconnect,
 * disconnect; ⋯ Add source with this account. Secrets are never shown; a token is sent once when connecting.
 */
export function AccountsView() {
  const { id, can } = useWorkspace();
  const { set } = useParamState();
  const connections = useConnections();
  const sources = useSources();
  const refresh = useInvalidateIngestion();
  const [checking, setChecking] = useState<ReadonlySet<string>>(new Set());
  const manage = can("connections.create");
  const canSources = can("sources.create");
  const used = useMemo(() => sourcesByConnection(sources.data), [sources.data]);
  /** Sources view searched for the account's sources. */
  const showSources = (c: Connection) => set({ view: null, q: accountLabel(c), status: null, source: null, page: null });

  async function test(c: Connection) {
    const name = c.name ?? "";
    if (checking.has(name)) return;
    setChecking((s) => new Set(s).add(name));
    try {
      const result = await testConnection(id, name);
      if (result.ok) toast(`${accountLabel(c)} hoạt động bình thường`);
      else if (result.connection?.state === "REAUTHORIZATION_REQUIRED")
        toast(`Quyền truy cập ${appName(c.connector)} đã hết hạn. Hãy kết nối lại để tiếp tục đồng bộ.`, {
          tone: "danger",
          action: { label: "Kết nối lại", onPress: () => openReconnect(name) },
        });
      else toast(result.message ? serverText(result.message) : `Hiện BoMesh không kết nối được với ${appName(c.connector)}.`, { tone: "danger" });
    } catch (error) {
      toast(errorMessage(error), { tone: "danger" });
    } finally {
      setChecking((s) => {
        const next = new Set(s);
        next.delete(name);
        return next;
      });
      refresh();
    }
  }

  async function disconnect(c: Connection) {
    const users = used.get(c.name ?? "") ?? [];
    if (users.length) {
      // The API keeps a connection while sources read through it (a source's account is fixed).
      const go = await confirm({
        title: `Ngắt kết nối ${accountLabel(c)}?`,
        description: `${users.map(sourceName).join(", ")} đang đồng bộ bằng tài khoản này. Hãy ngắt kết nối ${users.length === 1 ? "nguồn dữ liệu đó" : "các nguồn dữ liệu đó"} trước; tài liệu đã đồng bộ vẫn được giữ lại.`,
        confirmLabel: "Hiện các nguồn",
        tone: "accent",
      });
      if (go) showSources(c);
      return;
    }
    const ok = await confirm({ title: `Ngắt kết nối ${accountLabel(c)}?`, description: "BoMesh sẽ ngừng dùng thông tin đăng nhập này. Bạn có thể kết nối lại bất cứ lúc nào.", confirmLabel: "Ngắt kết nối", tone: "danger" });
    if (!ok) return;
    try {
      await deleteConnection(id, c.name ?? "");
      toast(`Đã ngắt kết nối ${accountLabel(c)}`);
    } catch (error) {
      toast(errorMessage(error), { tone: "danger" });
    } finally {
      refresh();
    }
  }

  const columns: DataTableColumn<Connection>[] = [
    {
      id: "account",
      header: "Tài khoản",
      primary: true,
      cell: (c) => (
        <div className="row gap-12">
          <AppIcon app={appKey(c.connector)} />
          <div className="stack src-min">
            <span className="cell-title truncate" translate="no">
              {accountLabel(c)}
            </span>
            <span className="cell-sub truncate" translate="no">
              {accountSub(c)}
            </span>
          </div>
        </div>
      ),
    },
    {
      id: "status",
      header: "Trạng thái",
      cell: (c) =>
        checking.has(c.name ?? "") ? (
          <span className="row gap-6 t-sm muted">
            <Spinner size="sm" />
            Đang kiểm tra…
          </span>
        ) : accountStatus(c) === "authorizing" ? (
          <StatusChip label="Đang chờ đăng nhập" tone="accent" />
        ) : (
          <StatusChip kind="account" value={accountStatus(c)} />
        ),
    },
    {
      id: "used",
      header: "Đang được dùng ở",
      cell: (c) => {
        const n = used.get(c.name ?? "")?.length ?? 0;
        return n ? (
          <button type="button" className="link-button" onClick={() => showSources(c)}>
            {plural(n, "source")}
          </button>
        ) : (
          <span className="muted">Chưa dùng</span>
        );
      },
    },
    { id: "checked", header: "Kiểm tra lần cuối", hideOnMobile: true, className: "muted", cell: (c) => rel(c.lastCheckTime ?? c.updateTime) },
  ];

  const menu = (c: Connection): RowAction[] => {
    const expired = c.state === "REAUTHORIZATION_REQUIRED";
    const reconnect: RowAction = { id: "reconnect", label: "Kết nối lại", icon: LogIn, onAction: () => openReconnect(c.name ?? "") };
    const testItem: RowAction = { id: "test", label: "Kiểm tra kết nối", icon: RefreshCw, isDisabled: c.state !== "ACTIVE" || checking.has(c.name ?? ""), onAction: () => void test(c) };
    return [
      ...(expired ? [reconnect, testItem] : [testItem, reconnect]),
      ...(canSources
        ? [{ id: "source", label: "Thêm nguồn dữ liệu bằng tài khoản này", icon: Plug, isDisabled: c.state !== "ACTIVE", onAction: () => openWizard({ connector: c.connector, connection: c.name }) }]
        : []),
      { id: "disconnect", label: "Ngắt kết nối", icon: Trash2, danger: true, onAction: () => void disconnect(c) },
    ];
  };

  const none = (
    <EmptyState
      icon={KeyRound}
      title="Chưa có tài khoản kết nối"
      description="Tài khoản được thêm khi bạn thêm nguồn dữ liệu lần đầu: đăng nhập một lần, rồi chọn nội dung cần đồng bộ."
      boxed
      actions={
        canSources ? (
          <Button variant="primary" onPress={() => openWizard()}>
            <Plus className="i" aria-hidden />
            Thêm nguồn dữ liệu
          </Button>
        ) : undefined
      }
    />
  );

  return (
    <Gate query={connections} skeleton={<SkeletonRows rows={3} />} isEmpty={(d) => d.length === 0} empty={none}>
      {(data) => (
        <>
          {manage ? (
            <div className="toolbar">
              <div className="toolbar__end">
                <Button variant="ghost" size="sm" onPress={() => openConnectAccount()}>
                  <Plus className="i" aria-hidden />
                  Kết nối tài khoản
                </Button>
              </div>
            </div>
          ) : null}
          <DataTable label="Tài khoản đã kết nối" rows={data} columns={columns} getRowId={(c) => c.name ?? ""} rowActions={manage ? menu : undefined} actionsClassName="src-actions" />
        </>
      )}
    </Gate>
  );
}
