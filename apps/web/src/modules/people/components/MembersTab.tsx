"use client";

import { Button, Dropdown, Header, Label } from "@heroui/react";
import { Pause, Shield, UserPlus, Users } from "lucide-react";
import { useMemo, useState } from "react";

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
  paginate,
  type DataTableColumn,
  type DataTableSort,
} from "@/components/ui";
import { plural, rel } from "@/lib/format";

import { roleGuard } from "../model";
import type { Directory, Person } from "../queries";
import { RoleSelect } from "./RoleSelect";
import { useMemberActions } from "./useMemberActions";

const PAGE = 20;

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

export function MembersTab({
  query,
  filters,
  onFiltersChange,
  fresh,
  onOpen,
  onAdd,
  canAdd,
}: {
  query: { data?: Directory; isPending: boolean; isError: boolean; error: unknown; refetch: () => unknown };
  filters: MemberFilters;
  onFiltersChange: (next: MemberFilters) => void;
  fresh: ReadonlySet<string>;
  onOpen: (person: Person) => void;
  onAdd: () => void;
  canAdd: boolean;
}) {
  const dir = query.data;
  const actions = useMemberActions(dir);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sort, setSort] = useState<DataTableSort | null>(null);
  const [page, setPage] = useState(1);
  const set = (patch: Partial<MemberFilters>) => {
    onFiltersChange({ ...filters, ...patch });
    setPage(1);
  };

  const rows = useMemo(() => {
    if (!dir) return [];
    const q = filters.q.trim().toLowerCase();
    const list = dir.people.filter(
      (p) =>
        (!filters.role || p.role === filters.role) &&
        (!filters.status || p.state === filters.status) &&
        (!q || p.displayName.toLowerCase().includes(q) || p.email.toLowerCase().includes(q)),
    );
    if (!sort) return list;
    const value = (p: Person): string | number =>
      sort.column === "role" ? (dir.roleByName.get(p.role)?.label ?? "") : sort.column === "last" ? Date.parse(p.member.lastActiveTime ?? "") || 0 : p.displayName;
    const sign = sort.direction === "ascending" ? 1 : -1;
    return [...list].sort((a, b) => {
      const x = value(a);
      const y = value(b);
      return sign * (typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y)));
    });
  }, [dir, filters, sort]);

  const filtered = Boolean(filters.q || filters.role || filters.status);

  const columns: DataTableColumn<Person>[] = dir
    ? [
        {
          id: "name",
          header: "Person",
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
                  {p.user === dir.self ? <StatusChip label="You" dot={false} size="sm" /> : null}
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
          header: "Role",
          sortValue: (p) => dir.roleByName.get(p.role)?.label ?? "",
          cell: (p) => {
            const why = roleGuard(p, dir.people, dir.self);
            const select = (
              <RoleSelect
                className="ppl-role-select"
                ariaLabel={`Role for ${p.displayName}`}
                value={p.role}
                roles={dir.roles}
                isDisabled={Boolean(why) || !canAdd}
                onChange={(role) => void actions.setRole([p.id], role)}
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
        { id: "groups", header: "Groups", hideOnMobile: true, className: "hide-md", cell: (p) => <GroupChips ids={p.groups} dir={dir} /> },
        {
          id: "last",
          header: "Last active",
          sortValue: (p) => Date.parse(p.member.lastActiveTime ?? "") || 0,
          cell: (p) => <span className="ppl-nowrap muted">{p.member.lastActiveTime ? rel(p.member.lastActiveTime) : "Not yet"}</span>,
        },
        { id: "status", header: "Status", cell: (p) => <StatusChip kind="member" value={p.state?.toLowerCase()} /> },
      ]
    : [];

  return (
    <>
      <div className="toolbar">
        <SearchInput value={filters.q} onChange={(q) => set({ q })} placeholder="Search by name or email" label="Search people" />
        {dir ? (
          <>
            <FilterButton label="Role" value={filters.role} onChange={(role) => set({ role })} options={dir.roles.map((r) => ({ value: r.name, label: r.label }))} />
            <FilterButton
              label="Status"
              value={filters.status}
              onChange={(status) => set({ status })}
              options={[
                { value: "ACTIVE", label: "Active" },
                { value: "SUSPENDED", label: "Suspended" },
              ]}
            />
            <ClearFilters isActive={Boolean(filters.role || filters.status)} onClear={() => set({ role: "", status: "" })} />
            <span className="toolbar__end t-sm muted num">{plural(rows.length, "person", "people")}</span>
          </>
        ) : null}
      </div>
      <Gate
        query={query}
        skeleton={<SkeletonRows rows={8} />}
        isEmpty={(d) => d.people.length <= 1 && !filtered}
        empty={
          <EmptyState
            icon={Users}
            boxed
            title="Only you are here"
            description="Add people who already have a BoMesh account. They can start asking right away."
            actions={
              canAdd ? (
                <Button variant="primary" onPress={onAdd}>
                  <UserPlus className="i" aria-hidden />
                  Add people
                </Button>
              ) : null
            }
          />
        }
      >
        {() =>
          !rows.length ? (
            <NoMatches what="people" onClear={() => set({ q: "", role: "", status: "" })} />
          ) : (
            <DataTable
              label="Members"
              rows={paginate(rows, page, PAGE)}
              columns={columns}
              getRowId={(p) => p.id}
              sort={sort}
              onSortChange={(next) => {
                setSort(next);
                setPage(1);
              }}
              selectedIds={canAdd ? selected : undefined}
              onSelectionChange={canAdd ? setSelected : undefined}
              onRowAction={onOpen}
              rowClassName={(p) => (fresh.has(p.id) ? "table__row--new" : undefined)}
              footer={<Pager page={page} pageSize={PAGE} total={rows.length} onPageChange={setPage} />}
              bulkActions={(ids, clear) => (
                <>
                  <Dropdown>
                    <Button variant="ghost" size="sm">
                      <Shield className="i" aria-hidden />
                      Change role
                    </Button>
                    <Dropdown.Popover placement="top start">
                      <Dropdown.Menu aria-label="Change role to" onAction={(key) => void actions.setRole(ids, String(key), clear)}>
                        <Dropdown.Section>
                          <Header>Change role to</Header>
                          {(dir?.roles ?? []).map((r) => (
                            <Dropdown.Item key={r.name} id={r.name} textValue={r.label}>
                              <Label>{r.label}</Label>
                            </Dropdown.Item>
                          ))}
                        </Dropdown.Section>
                      </Dropdown.Menu>
                    </Dropdown.Popover>
                  </Dropdown>
                  <Button variant="ghost" size="sm" onPress={() => void actions.suspend(ids, clear)}>
                    <Pause className="i" aria-hidden />
                    Suspend
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
