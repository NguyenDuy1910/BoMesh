"use client";

import { Button } from "@heroui/react";
import { AlertCircle, ArrowUpRight, CheckCircle2, ChevronDown, ChevronUp, Cpu, FileText, Layers, RefreshCw, Search, Server, Sparkles } from "lucide-react";
import { useState, type ReactNode } from "react";

import { Callout, DataTable, Disclosure, EmptyState, ErrorState, ItemIcon, LinkButton, List, ListItem, Page, PageHeader, PreviewChip, Section, SkeletonRows, StatusChip, toast } from "@/components/ui";
import { fmtDate, plural, rel, relInline } from "@/lib/format";
import { serverText, useMessages } from "@/lib/i18n";

import type { Component, Incident } from "../api";
import { errorCategoryLabel, fmtIncidentDuration, serviceStatus, unhealthyComponents, type ServiceStatus } from "../model";
import { useComponents, useIncidents } from "../queries";
import { PREVIEW_TIP } from "./shared";

/** Preview `D.pModels` names and descriptions, keyed by the deployment setting that configures each model. */
const MODEL_COPY: Record<string, { name: string; description: string; icon: typeof Sparkles }> = {
  OPENROUTER_MODEL: { name: "Trả lời và suy luận", description: "Viết câu trả lời và quyết định khi nào cần tìm kiếm.", icon: Sparkles },
  OPENAI_MODEL: { name: "Trả lời và suy luận", description: "Viết câu trả lời và quyết định khi nào cần tìm kiếm.", icon: Sparkles },
  EMBEDDING_MODEL: { name: "Hiểu truy vấn tìm kiếm", description: "Chuyển đoạn trích thành dạng có nghĩa để tra cứu.", icon: Search },
  BOMESH_DOCLING_MODEL: { name: "Đọc tài liệu", description: "Đọc bố cục, bảng và trang quét.", icon: FileText },
  BOMESH_CONTEXTUALIZATION_MODEL: { name: "Ngữ cảnh đoạn trích", description: "Bổ sung ngữ cảnh xung quanh cho từng đoạn trích trước khi lập chỉ mục.", icon: Layers },
};

/** Components whose trouble slows document processing: the banner then points to Indexing by workspace. */
const PROCESSING = ["components/vector-index", "components/embedding-model"];

/** Product words for the deployment's components (`bomesh/health.py`), keyed by resource name. */
const COMPONENT_NAME: Record<string, string> = {
  "components/api": "API",
  "components/vector-index": "Chỉ mục vector",
  "components/chat-model": "Mô hình trò chuyện",
  "components/embedding-model": "Mô hình nhúng",
  "components/observability": "Giám sát hệ thống",
};

/** A component's name: product words for the known ones, the server's name otherwise. */
function componentName(c: Pick<Component, "name" | "displayName">): string {
  return COMPONENT_NAME[c.name ?? ""] ?? serverText(c.displayName ?? "");
}

/** Preview services order: outages first, then anything not operational, healthy last. */
const SERVICE_RANK: Record<ServiceStatus, number> = { down: 0, degraded: 1, not_configured: 1, operational: 2 };

function ServiceChip({ state }: { state: Component["state"] }) {
  const s = serviceStatus(state);
  if (s === "not_configured") return <StatusChip label="Chưa cấu hình" tone="default" dot={false} />;
  return <StatusChip kind="service" value={s} />;
}

/** What an ongoing incident says about a component (expandable service note). */
function noteFor(component: Component, incidents: readonly Incident[]): string | null {
  const ongoing = incidents.find((i) => i.component === component.name && i.state === "ONGOING");
  if (ongoing) return `${errorCategoryLabel(ongoing.errorCategory)} từ ${relInline(ongoing.startTime)}.`;
  if (component.state === "NOT_CONFIGURED") return component.setting ? `Đặt ${component.setting} trong cấu hình triển khai.` : "Chưa được thiết lập trong bản triển khai này.";
  return null;
}

/** Preview `P.pHealth`: service health and impact, AI capabilities (read-only settings), incidents. */
export function HealthPage() {
  const msg = useMessages();
  const components = useComponents();
  const incidents = useIncidents();
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [refreshing, setRefreshing] = useState(false);

  const refresh = async () => {
    setRefreshing(true);
    try {
      await Promise.all([components.refetch(), incidents.refetch()]);
      toast("Đã làm mới trạng thái");
    } finally {
      setRefreshing(false);
    }
  };

  const updated = components.dataUpdatedAt ? `Đã cập nhật ${relInline(components.dataUpdatedAt)}` : undefined;
  const all = components.data ?? [];
  const incidentList = incidents.data ?? [];
  const services = all.filter((c) => c.kind === "SERVICE");
  const models = all.filter((c) => c.kind === "AI_MODEL");
  const bad = unhealthyComponents(all);
  const nameOf = (name: string | undefined) => {
    const c = all.find((x) => x.name === name);
    return c ? componentName(c) : "Một dịch vụ";
  };

  const banner = (): ReactNode => {
    if (!bad.length) return <Callout tone="success" title="Mọi hệ thống hoạt động bình thường" />;
    const tone = bad.some((c) => c.state === "DOWN") ? "danger" : "warning";
    const action = bad.some((c) => PROCESSING.includes(c.name ?? "")) ? (
      <LinkButton href="/p/indexing" icon={ArrowUpRight}>
        Lập chỉ mục theo không gian làm việc
      </LinkButton>
    ) : undefined;
    if (bad.length > 1) return <Callout tone={tone} title={`${plural(bad.length, "service")} cần chú ý`} description={bad.map(componentName).join(", ")} actions={action} />;
    const c = bad[0];
    return <Callout tone={tone} title={`${componentName(c)} ${c.state === "DOWN" ? "đang gặp sự cố" : "đang suy giảm"}`} description={noteFor(c, incidentList) ?? undefined} actions={action} />;
  };

  const resolved = incidentList.filter((i) => i.state === "RESOLVED");
  const ongoing = incidentList.filter((i) => i.state === "ONGOING");

  return (
    <Page>
      <PageHeader
        title={msg.nav.systemHealth}
        meta={updated}
        chips={<PreviewChip tooltip={PREVIEW_TIP} />}
        actions={
          <Button variant="tertiary" isPending={refreshing} onPress={() => void refresh()}>
            <RefreshCw className="i" aria-hidden />
            Làm mới
          </Button>
        }
      />
      {components.isError && !components.data ? (
        <ErrorState error={components.error} onRetry={components.refetch} />
      ) : components.isPending ? (
        <SkeletonRows rows={7} />
      ) : !all.length ? (
        <EmptyState icon={Server} title="Không có dịch vụ nào báo cáo" description="Trạng thái sẽ hiển thị khi bản triển khai gửi báo cáo." boxed />
      ) : (
        <>
          <div className="pf-banner">{banner()}</div>
          <Section title="Dịch vụ">
            <DataTable
              label="Dịch vụ"
              rows={[...services].sort((a, b) => SERVICE_RANK[serviceStatus(a.state)] - SERVICE_RANK[serviceStatus(b.state)])}
              getRowId={(c) => c.name ?? ""}
              onRowAction={(c) => {
                if (!noteFor(c, incidentList)) return;
                const key = c.name ?? "";
                setOpen((o) => ({ ...o, [key]: !(o[key] ?? c.state !== "HEALTHY") }));
              }}
              columns={[
                {
                  id: "name",
                  header: "Dịch vụ",
                  primary: true,
                  cell: (c) => {
                    const note = noteFor(c, incidentList);
                    const expanded = Boolean(note) && (open[c.name ?? ""] ?? c.state !== "HEALTHY");
                    return (
                      <div className="stack">
                        <span className="cell-title pf-svc" aria-expanded={note ? expanded : undefined}>
                          {componentName(c)}
                          {note ? expanded ? <ChevronUp className="i i-sm muted" aria-hidden /> : <ChevronDown className="i i-sm muted" aria-hidden /> : null}
                        </span>
                        {expanded ? <span className="pf-note">{note}</span> : null}
                      </div>
                    );
                  },
                },
                { id: "status", header: "Trạng thái", cell: (c) => <ServiceChip state={c.state} /> },
                {
                  id: "checked",
                  header: "Kiểm tra lần cuối",
                  align: "end",
                  mobileLabel: "Đã kiểm tra",
                  className: "pf-nowrap",
                  cell: (c) => <span className="muted num pf-checked">{c.checkTime ? rel(c.checkTime) : "—"}</span>,
                },
              ]}
            />
          </Section>
          <Section title="Khả năng AI" description="Mô hình được đặt trong cấu hình triển khai và thay đổi khi khởi động lại.">
            <List className="pf-models">
              {models.map((m) => {
                const copy = m.setting ? MODEL_COPY[m.setting] : undefined;
                return (
                  <ListItem
                    key={m.name}
                    lead={<ItemIcon icon={copy?.icon ?? Cpu} tone={m.state === "HEALTHY" ? undefined : "warning"} size="sm" />}
                    title={copy?.name ?? componentName(m)}
                    description={
                      <>
                        {copy?.description ?? componentName(m)}
                        {m.setting ? (
                          <span className="pf-setting">
                            Được cấu hình qua <code className="mono">{m.setting}</code>
                          </span>
                        ) : null}
                      </>
                    }
                    actions={
                      <span className="pf-model-trail">
                        <ServiceChip state={m.state} />
                        {m.model ? (
                          <span className="t-xs muted mono" translate="no">
                            {m.model}
                          </span>
                        ) : null}
                      </span>
                    }
                  />
                );
              })}
            </List>
          </Section>
          <section className="section" aria-label="Sự cố gần đây">
            <Disclosure
              icon={ongoing.length ? AlertCircle : CheckCircle2}
              title="Sự cố gần đây"
              summary={
                ongoing.length
                  ? `${plural(ongoing.length, "incident")} đang diễn ra · ${plural(resolved.length, "incident")} đã xử lý trong 30 ngày qua`
                  : `${plural(resolved.length, "incident")} đã xử lý trong 30 ngày qua`
              }
            >
              {incidents.isError && !incidents.data ? (
                <ErrorState error={incidents.error} onRetry={incidents.refetch} compact />
              ) : incidentList.length ? (
                <List>
                  {/* What's still going on comes first; then the resolved ones, newest first (API order). */}
                  {[...ongoing, ...resolved].map((i) => {
                    const end = i.endTime ? Date.parse(i.endTime) : Date.now();
                    const dur = end - Date.parse(i.startTime ?? "");
                    return (
                      <ListItem
                        key={i.name}
                        lead={<ItemIcon icon={i.state === "RESOLVED" ? CheckCircle2 : AlertCircle} tone={i.state === "RESOLVED" ? "success" : "warning"} size="sm" />}
                        title={`${nameOf(i.component)}: ${errorCategoryLabel(i.errorCategory).toLowerCase()}`}
                        description={i.state === "RESOLVED" ? "Đã khắc phục." : "Vẫn đang diễn ra."}
                        meta={`${fmtDate(i.startTime)} · ${Number.isFinite(dur) ? fmtIncidentDuration(dur) : "—"}`}
                      />
                    );
                  })}
                </List>
              ) : (
                <p className="t-sm muted">Không có sự cố trong 30 ngày qua.</p>
              )}
            </Disclosure>
          </section>
        </>
      )}
    </Page>
  );
}
