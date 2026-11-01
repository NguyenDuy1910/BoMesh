"use client";

import { Archive, FolderInput, MoreHorizontal, Pencil, SquareArrowOutUpRight, Upload } from "lucide-react";
import { useState } from "react";

import { FileTypeIcon, fileTypeOf } from "@/modules/knowledge/components/FileTypeIcon";
import { Button } from "@/components/ui/Button";
import { BulkActionButton, CellTitle, DataTable, type DataTableColumn } from "@/components/ui/DataTable";
import { Drawer, DrawerSection } from "@/components/ui/Drawer";
import { EmptyState } from "@/components/ui/EmptyState";
import { ClearFilters, FilterChip } from "@/components/ui/FilterChip";
import { Menu, MenuItem, MenuSeparator } from "@/components/ui/Menu";
import { PageHeader } from "@/components/ui/PageHeader";
import { PreviewTag } from "@/components/ui/PreviewTag";
import { SearchInput } from "@/components/ui/SearchInput";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { TabPanel, Tabs, useTabParam } from "@/components/ui/Tabs";
import { Tag } from "@/components/ui/Tag";
import { useToast } from "@/components/ui/Toast";
import { Toolbar } from "@/components/ui/Toolbar";
import { statusOf } from "@/lib/status";

import { Card, Group, Section } from "./kit";

const PAGE_TABS = ["documents", "sources", "access"] as const;
type PageTab = (typeof PAGE_TABS)[number];
type PanelTab = "preview" | "changes" | "history";

export function NavigationSection() {
  const [tab, setTab] = useTabParam(PAGE_TABS, "documents");
  const [panelTab, setPanelTab] = useState<PanelTab>("preview");
  return (
    <Section
      description="A page opens with crumbs, one title, one line saying what it is for, and its actions. Page tabs are deep links (?tab=); a tab row inside a panel keeps local state."
      id="navigation"
      title="Page header and tabs"
    >
      <Card className="px-6 pb-2 pt-5">
        <PageHeader
          actions={
            <>
              <Button variant="secondary">Share</Button>
              <Button icon={<Upload aria-hidden="true" />}>Upload files</Button>
            </>
          }
          crumbs={[{ label: "Knowledge", href: "/knowledge" }, { label: "HR Policies" }]}
          sub="Policies, handbooks and forms for every employee."
          title="HR Policies"
          titleExtra={<PreviewTag />}
        />
        <Tabs<PageTab>
          activeTab={tab}
          ariaLabel="Knowledge base sections"
          idBase="ds-page-tabs"
          onChange={setTab}
          tabs={[
            { id: "documents", label: "Documents", count: 18 },
            { id: "sources", label: "Sources", count: 1 },
            { id: "access", label: "Access" },
          ]}
        />
        {PAGE_TABS.map(
          (id) =>
            id === tab && (
              <TabPanel className="py-5 text-text-secondary" idBase="ds-page-tabs" key={id} tab={id}>
                {id === "documents" && "18 documents · this panel is the Documents tab. The URL now carries ?tab=documents only when another tab is chosen."}
                {id === "sources" && "1 source · Google Drive “People Ops” syncs daily at 02:00."}
                {id === "access" && "Everyone in Northwind Group can find and ask about this knowledge base."}
              </TabPanel>
            ),
        )}
      </Card>
      <Group className="mt-6" title="Small tabs · inside a panel">
        <Card className="px-4 pt-1">
          <Tabs<PanelTab>
            activeTab={panelTab}
            ariaLabel="File panel"
            idBase="ds-panel-tabs"
            onChange={setPanelTab}
            size="sm"
            tabs={[
              { id: "preview", label: "Preview" },
              { id: "changes", label: "Changes", count: 3 },
              { id: "history", label: "History" },
            ]}
          />
          <TabPanel className="py-4 text-meta text-text-secondary" idBase="ds-panel-tabs" tab={panelTab}>
            {panelTab === "preview" && "The current version of the file."}
            {panelTab === "changes" && "3 cells changed since version 2."}
            {panelTab === "history" && "Version 3 · saved by Duy Nguyen 2 h ago."}
          </TabPanel>
        </Card>
      </Group>
    </Section>
  );
}

interface DemoDocument {
  id: string;
  title: string;
  collection: string;
  status: "ready" | "processing" | "pending" | "failed" | "outdated" | "unsupported";
  updated: string;
  /** Minutes ago, for sorting. */
  age: number;
  sizeKb: number;
}

const DOCUMENTS = ([

  { id: "d1", title: "Travel & Expense Policy.pdf", collection: "HR Policies", status: "ready", updated: "18 days ago", age: 25_920, sizeKb: 1_240 },
  { id: "d2", title: "Benefits Overview FY26.pptx", collection: "HR Policies", status: "processing", updated: "12 min ago", age: 12, sizeKb: 8_420 },
  { id: "d3", title: "Onboarding Checklist.xlsx", collection: "People Ops", status: "failed", updated: "2 h ago", age: 120, sizeKb: 86 },
  { id: "d4", title: "Employee Handbook 2026.pdf", collection: "HR Policies", status: "ready", updated: "30 days ago", age: 43_200, sizeKb: 3_480 },
  { id: "d5", title: "Leave Policy Vietnam.docx", collection: "People Ops", status: "outdated", updated: "3 months ago", age: 129_600, sizeKb: 212 },
  { id: "d6", title: "Payroll Calendar 2026.xlsx", collection: "Finance", status: "pending", updated: "Just now", age: 1, sizeKb: 54 },
  { id: "d7", title: "Brand Assets.zip", collection: "Marketing", status: "unsupported", updated: "5 days ago", age: 7_200, sizeKb: 48_600 },
  { id: "d8", title: "Security Awareness.pdf", collection: "IT", status: "ready", updated: "1 week ago", age: 10_080, sizeKb: 2_100 },
  { id: "d9", title: "Code of Conduct.pdf", collection: "HR Policies", status: "ready", updated: "2 months ago", age: 86_400, sizeKb: 640 },
  { id: "d10", title: "Q3 Sales Playbook.docx", collection: "Sales", status: "ready", updated: "4 days ago", age: 5_760, sizeKb: 930 },
  { id: "d11", title: "Office Locations.xlsx", collection: "Facilities", status: "ready", updated: "6 days ago", age: 8_640, sizeKb: 31 },
  { id: "d12", title: "Remote Work Guidelines.pdf", collection: "People Ops", status: "processing", updated: "4 min ago", age: 4, sizeKb: 410 },
] satisfies DemoDocument[]).map((document) => ({ ...document, file: fileTypeOf(null, document.title) }));

type DemoRow = (typeof DOCUMENTS)[number];

const STATUS_FILTER = (["ready", "processing", "pending", "failed", "outdated", "unsupported"] as const).map((value) => ({
  value,
  label: statusOf("doc", value).label,
}));

const TYPE_FILTER = ["PDF", "DOCX", "PPTX", "XLSX", "ZIP"].map((value) => ({ value, label: value }));

type TableState = "rows" | "loading" | "empty" | "error";

function formatSize(sizeKb: number) {
  return sizeKb >= 1024 ? `${(sizeKb / 1024).toFixed(1)} MB` : `${sizeKb} KB`;
}

export function TableSection() {
  const toast = useToast();
  const [state, setState] = useState<TableState>("rows");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const [types, setTypes] = useState<string[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<DemoRow | null>(null);

  const filtered = Boolean(query || status || types.length);
  const needle = query.trim().toLowerCase();
  const rows = DOCUMENTS.filter(
    (document) =>
      (!needle || document.title.toLowerCase().includes(needle)) &&
      (!status || document.status === status) &&
      (types.length === 0 || types.includes(document.file.label)),
  );
  const data = state === "rows" ? rows : [];

  const clearFilters = () => {
    setQuery("");
    setStatus("");
    setTypes([]);
    setPage(1);
  };
  const act = (verb: string, count: number) =>
    toast.show({
      message: `${verb} ${count === 1 ? "1 document" : `${count} documents`}`,
      action: verb === "Archived" ? { label: "Undo", onClick: () => toast.show({ message: `Restored ${count === 1 ? "1 document" : `${count} documents`}` }) } : undefined,
    });

  const columns: DataTableColumn<DemoRow>[] = [
    {
      id: "title",
      header: "Name",
      sortable: true,
      cell: (row) => <CellTitle icon={<FileTypeIcon decorative kind={row.file.kind} label={row.file.label} />} subtitle={row.collection} title={row.title} />,
    },
    { id: "status", header: "Status", cell: (row) => <StatusBadge kind="doc" value={row.status} />, width: 170 },
    { id: "format", header: "Type", cell: (row) => <Tag>{row.file.label}</Tag>, hideBelow: 900, width: 90 },
    {
      id: "updated",
      header: "Updated",
      sortable: true,
      sortValue: (row) => -row.age,
      cell: (row) => <span className="text-text-tertiary">{row.updated}</span>,
      hideBelow: 1080,
      width: 140,
    },
    {
      id: "size",
      header: "Size",
      align: "right",
      sortable: true,
      sortValue: (row) => row.sizeKb,
      cell: (row) => formatSize(row.sizeKb),
      hideBelow: 1080,
      width: 100,
    },
  ];

  return (
    <Section
      description="One table for every list: sortable headers, selection with a bulk bar, quiet row actions on hover, a pager, and every list state — loading, empty, no matches and failed. Detail columns drop out at 1080 and 900 px."
      id="table"
      title="Toolbar, filters and table"
    >
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <span className="text-meta text-text-tertiary">Show state</span>
        <SegmentedControl
          ariaLabel="Table state"
          onChange={(next) => {
            setState(next);
            setSelected([]);
          }}
          options={[
            { value: "rows", label: "Rows" },
            { value: "loading", label: "Loading" },
            { value: "empty", label: "Empty" },
            { value: "error", label: "Error" },
          ]}
          size="sm"
          value={state}
        />
        <span className="text-meta text-text-tertiary">Filter to nothing (e.g. search “zzz”) for the no-matches state.</span>
      </div>
      <Toolbar
        end={
          <Button icon={<Upload aria-hidden="true" />} variant="secondary">
            Upload files
          </Button>
        }
        filters={
          <>
            <FilterChip
              label="Status"
              onChange={(value) => {
                setStatus(value);
                setPage(1);
              }}
              options={STATUS_FILTER}
              value={status}
            />
            <FilterChip
              label="Type"
              multiple
              onChange={(value) => {
                setTypes(value);
                setPage(1);
              }}
              options={TYPE_FILTER}
              value={types}
            />
            <ClearFilters active={filtered} onClear={clearFilters} />
          </>
        }
        search={
          <SearchInput
            ariaLabel="Search documents"
            onChange={(value) => {
              setQuery(value);
              setPage(1);
            }}
            placeholder="Search documents"
            value={query}
          />
        }
      />
      <DataTable
        activeRowId={open?.id ?? null}
        ariaLabel="Documents"
        bulkActions={(ids) => (
          <>
            <BulkActionButton icon={<FolderInput />} onClick={() => act("Moved", ids.length)}>
              Move
            </BulkActionButton>
            <BulkActionButton
              icon={<Archive />}
              onClick={() => {
                act("Archived", ids.length);
                setSelected([]);
              }}
            >
              Archive
            </BulkActionButton>
          </>
        )}
        columns={columns}
        data={data}
        emptyState={
          <EmptyState
            action={<Button size="sm">Upload files</Button>}
            description="Upload files or connect a source. Documents show here once they are processed."
            icon={<Upload />}
            size="md"
            title="Add your first documents"
          />
        }
        error={state === "error" ? "The document list didn’t load. Check your connection and try again." : null}
        filtered={filtered}
        loading={state === "loading"}
        onClearFilters={clearFilters}
        onRetry={() => setState("rows")}
        onRowClick={setOpen}
        onSelectionChange={setSelected}
        pagination={{ page, pageSize: 5, total: data.length, onPageChange: setPage }}
        rowActions={(row) => (
          <Menu
            align="end"
            ariaLabel={`Actions for ${row.title}`}
            trigger={(props) => (
              <Button {...props} aria-label={`Actions for ${row.title}`} icon={<MoreHorizontal aria-hidden="true" />} iconOnly size="sm" variant="ghost" />
            )}
          >
            <MenuItem icon={<SquareArrowOutUpRight />} onSelect={() => setOpen(row)}>
              Open
            </MenuItem>
            <MenuItem icon={<Pencil />} onSelect={() => act("Renamed", 1)}>
              Rename
            </MenuItem>
            <MenuItem icon={<FolderInput />} onSelect={() => act("Moved", 1)}>
              Move to…
            </MenuItem>
            <MenuSeparator />
            <MenuItem danger icon={<Archive />} onSelect={() => act("Archived", 1)}>
              Archive
            </MenuItem>
          </Menu>
        )}
        rowLabel={(row) => row.title}
        selectable
        selectedIds={selected}
      />
      <Drawer
        description={open?.collection}
        footer={
          <>
            <Button onClick={() => setOpen(null)} variant="secondary">
              Close
            </Button>
            <Button onClick={() => setOpen(null)}>Open document</Button>
          </>
        }
        icon={open && <FileTypeIcon decorative kind={open.file.kind} label={open.file.label} size="lg" />}
        onClose={() => setOpen(null)}
        open={open !== null}
        title={open?.title ?? ""}
      >
        {open && (
          <DrawerSection title="Details">
            <dl className="grid grid-cols-[120px_1fr] gap-x-4 gap-y-2 text-body">
              <dt className="text-text-tertiary">Status</dt>
              <dd>
                <StatusBadge kind="doc" value={open.status} />
              </dd>
              <dt className="text-text-tertiary">Knowledge base</dt>
              <dd>{open.collection}</dd>
              <dt className="text-text-tertiary">Updated</dt>
              <dd>{open.updated}</dd>
              <dt className="text-text-tertiary">Size</dt>
              <dd>{formatSize(open.sizeKb)}</dd>
            </dl>
          </DrawerSection>
        )}
      </Drawer>
    </Section>
  );
}
