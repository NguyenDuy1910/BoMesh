"use client";

import { Button, Dropdown, Header, Label } from "@heroui/react";
import { Pause, Shield, Users } from "lucide-react";
import { useState } from "react";

import {
  ClearFilters,
  DataTable,
  EmptyState,
  FilterButton,
  Gate,
  NoMatches,
  Pager,
  SearchInput,
  SkeletonRows,
  StatusChip,
  Tip,
  UserAvatar,
  type DataTableColumn,
  type DataTableSort,
} from "@/components/ui";
import { SEARCH_PAUSE_MS, useDebounced } from "@/lib/debounce";
import { plural, rel } from "@/lib/format";

import { memberFilter, needsTools, roleGuard } from "../model";
import { useMemberPages, type Directory, type Person } from "../queries";
import { RoleSelect } from "./RoleSelect";
import { useMemberActions } from "./useMemberActions";

const PAGE = 20;
/** Table columns → ListMembers `orderBy` fields. */
const ORDER: Record<string, string> = { name: "displayName", last: "lastActiveTime" };

export interface MemberFilters {
  q: string;
  role: string;
  status: string;
}

function GroupChips({ ids, dir, max = 2 }: { ids: readonly string[]; dir: Directory; max?: number }) {
  const names = ids.map((g) => dir.groupByName.get(g)?.displayName).filter((n): n is string => Boolean(n));
  if (!names.length) return <span className="muted">—</span>;
  const rest = names.slice(max);
  return (
    <span className="row gap-4 wrap">
      {names.slice(0, max).map((n) => (
        <span key={n} translate="no">
          <StatusChip label={n} dot={false} size="sm" />
        </span>
      ))}
      {rest.length ? <StatusChip label={`+${rest.length}`} variant="outline" dot={false} size="sm" tooltip={rest.join(", ")} /> : null}
    </span>
  );
}

/** Members (preview `membersTab`): search, filters and bulk role/suspend from 7 members; inline role, instant with Undo. */
export function MembersTab({
  query,
  filters,
  onFiltersChange,
  fresh,
  onOpen,
  canAdd,
}: {
  query: { data?: Directory; isPending: boolean; isError: boolean; error: unknown; refetch: () => unknown };
  filters: MemberFilters;
  onFiltersChange: (next: MemberFilters) => void;
  fresh: ReadonlySet<string>;
  onOpen: (person: Person) => void;
  canAdd: boolean;
}) {
  const dir = query.data;
  const actions = useMemberActions(dir);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sort, setSort] = useState<DataTableSort | null>(null);
  const q = useDebounced(filters.q.trim(), SEARCH_PAUSE_MS);
  const orderBy = sort ? `${ORDER[sort.column] ?? "displayName"}${sort.direction === "descending" ? " desc" : ""}` : "displayName";
  const members = useMemberPages(dir, memberFilter({ q, role: filters.role, state: filters.status }), { orderBy, pageSize: PAGE });
  const rows = members.rows ?? [];
  const set = (patch: Partial<MemberFilters>) => onFiltersChange({ ...filters, ...patch });
  const setPage = (p: number) => {
    members.setPage(p);
    setSelected(new Set());
  };
  const pick = (ids: Iterable<string>) => {
    const wanted = new Set(ids);
    return rows.filter((p) => wanted.has(p.id));
  };

  const filtered = Boolean(filters.q || filters.role || filters.status);
  // Without a total, a next page means there are more people than this page shows.
  const known = members.total ?? (members.page - 1) * PAGE + rows.length + (members.hasNext ? 1 : 0);
  const tools = needsTools(known, filtered);
  // Workspace memberships may carry no last-activity time at all; then the column would only repeat "Not yet".
  const tracksActivity = rows.some((p) => p.member.lastActiveTime);

  const columns: DataTableColumn<Person>[] = dir
    ? [
        {
          id: "name",
          header: "Người",
          primary: true,
          sortValue: (p) => p.displayName,
          cell: (p) => (
            <span className="row gap-12">
              <UserAvatar name={p.displayName} />
              <span className="stack" style={{ minWidth: 0 }}>
                <span className="row gap-6">
                  <span className="cell-title truncate" translate="no">
                    {p.displayName}
                  </span>
                  {p.user === dir.self ? <StatusChip label="Bạn" dot={false} size="sm" /> : p.state === "SUSPENDED" ? <StatusChip kind="member" value="suspended" size="sm" /> : null}
                </span>
                <span className="cell-sub truncate" translate="no">
                  {p.email}
                </span>
              </span>
            </span>
          ),
        },
        {
          id: "role",
          header: "Vai trò",
          cell: (p) => {
            const why = roleGuard(p, dir.admins, dir.self);
            const select = (
              <RoleSelect
                className="ppl-role-select"
                ariaLabel={`Vai trò của ${p.displayName}`}
                value={p.role}
                roles={dir.roles}
                isDisabled={Boolean(why) || !canAdd}
                onChange={(role) => void actions.setRole([p], role)}
              />
            );
            return why ? (
              <Tip content={why}>
                <span className="ppl-tip">{select}</span>
              </Tip>
            ) : (
              select
            );
          },
        },
        { id: "groups", header: "Nhóm", hideOnMobile: true, className: "hide-md", cell: (p) => <GroupChips ids={p.groups} dir={dir} /> },
        ...(tracksActivity
          ? [
              {
                id: "last",
                header: "Hoạt động lần cuối",
                sortValue: (p: Person) => Date.parse(p.member.lastActiveTime ?? "") || 0,
                cell: (p: Person) => <span className="ppl-nowrap muted">{p.member.lastActiveTime ? rel(p.member.lastActiveTime) : "Chưa"}</span>,
              },
            ]
          : []),
      ]
    : [];

  return (
    <>
      {tools ? (
        <div className="toolbar">
          <SearchInput value={filters.q} onChange={(q) => set({ q })} placeholder="Tìm theo tên hoặc email" label="Tìm kiếm người" />
          {dir ? (
            <>
              <FilterButton label="Vai trò" value={filters.role} onChange={(role) => set({ role })} options={dir.roles.map((r) => ({ value: r.name, label: r.label }))} />
              <FilterButton
                label="Trạng thái"
                value={filters.status}
                onChange={(status) => set({ status })}
                options={[
                  { value: "ACTIVE", label: "Đang hoạt động" },
                  { value: "SUSPENDED", label: "Đã tạm ngưng" },
                ]}
              />
              <ClearFilters isActive={Boolean(filters.role || filters.status)} onClear={() => set({ role: "", status: "" })} />
              {members.total !== undefined ? <span className="toolbar__end t-sm muted num">{plural(members.total, "person")}</span> : null}
            </>
          ) : null}
        </div>
      ) : null}
      <Gate
        query={{ data: dir && members.data ? members : undefined, isPending: query.isPending || members.isPending, isError: query.isError || members.isError, error: query.error ?? members.error, refetch: () => (query.isError ? query.refetch() : members.refetch()) }}
        skeleton={<SkeletonRows rows={8} />}
        isEmpty={(d) => d.page === 1 && !d.hasNext && (d.rows ?? []).length <= 1 && !filtered}
        empty={<EmptyState icon={Users} boxed title="Chỉ có bạn ở đây" description="Thêm người đã có tài khoản BoMesh. Họ có thể bắt đầu hỏi ngay." />}
      >
        {() =>
          !rows.length ? (
            <NoMatches what="người" onClear={() => set({ q: "", role: "", status: "" })} />
          ) : (
            <DataTable
              label="Thành viên"
              rows={rows}
              columns={columns}
              getRowId={(p) => p.id}
              sort={sort}
              onSortChange={setSort}
              selectedIds={canAdd && tools ? selected : undefined}
              onSelectionChange={canAdd && tools ? setSelected : undefined}
              onRowAction={onOpen}
              rowClassName={(p) => (fresh.has(p.id) ? "table__row--new" : undefined)}
              footer={
                members.page > 1 || members.hasNext ? (
                  <Pager page={members.page} pageSize={PAGE} total={members.total} pageCount={rows.length} hasNext={members.hasNext} onPageChange={setPage} />
                ) : undefined
              }
              bulkActions={(ids, clear) => (
                <>
                  <Dropdown>
                    <Button variant="ghost" size="sm">
                      <Shield className="i" aria-hidden />
                      Đổi vai trò
                    </Button>
                    <Dropdown.Popover placement="top start">
                      <Dropdown.Menu aria-label="Đổi vai trò thành" onAction={(key) => void actions.setRole(pick(ids), String(key), clear)}>
                        <Dropdown.Section>
                          <Header>Đổi vai trò thành</Header>
                          {(dir?.roles ?? []).map((r) => (
                            <Dropdown.Item key={r.name} id={r.name} textValue={r.label}>
                              <Label>{r.label}</Label>
                            </Dropdown.Item>
                          ))}
                        </Dropdown.Section>
                      </Dropdown.Menu>
                    </Dropdown.Popover>
                  </Dropdown>
                  <Button variant="ghost" size="sm" onPress={() => void actions.suspend(pick(ids), clear)}>
                    <Pause className="i" aria-hidden />
                    Tạm ngưng
                  </Button>
                </>
              )}
            />
          )
        }
      </Gate>
    </>
  );
}
