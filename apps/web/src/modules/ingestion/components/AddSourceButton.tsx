"use client";

import { Button, Dropdown, Header, Label, Separator } from "@heroui/react";
import { Plug, Plus } from "lucide-react";

import { useWorkspace } from "@/lib/workspace";

import { accountLabel, appName } from "../model";
import { openWizard } from "../overlays";
import { useConnections } from "../queries";
import { IngestionDialogs } from "./IngestionDialogs";

export interface AddSourceButtonProps {
  /** Collection item name to preselect as the destination. */
  collection?: string;
  variant?: "primary" | "secondary" | "ghost";
  size?: "sm" | "md";
}

/**
 * "Add source", the one way to add a source anywhere (preview `X.src.addBtn` + `MENUS['src-add']`).
 * A source is one folder or space synced into one collection, read with an account, so once accounts are
 * connected it is a menu: Use a connected account (each opens the wizard at Content with that account and
 * the collection preselected) · Connect another account…. With none connected it opens the wizard at the app.
 */
export function AddSourceButton({ collection, variant = "primary", size }: AddSourceButtonProps) {
  const { can } = useWorkspace();
  const connections = useConnections();
  if (!can("sources.create")) return null;
  const reusable = (connections.data ?? []).filter((c) => c.state === "ACTIVE");

  if (!reusable.length)
    return (
      <>
        <Button variant={variant} size={size} onPress={() => openWizard({ collection })}>
          <Plus className="i" aria-hidden />
          Thêm nguồn dữ liệu
        </Button>
        <IngestionDialogs />
      </>
    );

  return (
    <>
      <Dropdown>
        <Button variant={variant} size={size}>
          <Plus className="i" aria-hidden />
          Thêm nguồn dữ liệu
        </Button>
        <Dropdown.Popover placement="bottom end">
          <Dropdown.Menu
            aria-label="Thêm nguồn dữ liệu"
            onAction={(key) => {
              const id = String(key);
              if (id === "__connect") return openWizard({ collection });
              const connection = reusable.find((c) => c.name === id);
              if (connection) openWizard({ collection, connector: connection.connector, connection: connection.name });
            }}
          >
            <Dropdown.Section>
              <Header>Dùng tài khoản đã kết nối</Header>
              {reusable.map((c) => (
                <Dropdown.Item key={c.name} id={c.name ?? ""} textValue={accountLabel(c)}>
                  <Label className="grow truncate" translate="no">
                    {accountLabel(c)}
                  </Label>
                  <span className="menu-item__meta">{appName(c.connector)}</span>
                </Dropdown.Item>
              ))}
            </Dropdown.Section>
            <Separator />
            <Dropdown.Section>
              <Dropdown.Item id="__connect" textValue="Kết nối tài khoản khác…">
                <Plug className="i" aria-hidden />
                <Label>Kết nối tài khoản khác…</Label>
              </Dropdown.Item>
            </Dropdown.Section>
          </Dropdown.Menu>
        </Dropdown.Popover>
      </Dropdown>
      <IngestionDialogs />
    </>
  );
}
