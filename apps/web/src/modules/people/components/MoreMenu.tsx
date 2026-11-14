"use client";

import { Dropdown, Label, Separator } from "@heroui/react";
import { MoreHorizontal, type LucideIcon } from "lucide-react";
import { Fragment } from "react";

import { IconButton } from "@/components/ui";

export interface MenuAction {
  id: string;
  label: string;
  icon?: LucideIcon;
  danger?: boolean;
  /** Draws a separator above this entry (preview `{ sep: true }`). */
  sep?: boolean;
  onAction: () => void;
}

/** ⋯ menu (preview `iconBtn('more', …, { menu })`): the rarer actions of a row, drawer or card. */
export function MoreMenu({ actions, label = "More actions", size = "sm" }: { actions: readonly MenuAction[]; label?: string; size?: "sm" | "md" }) {
  if (!actions.length) return null;
  return (
    <Dropdown>
      <IconButton icon={MoreHorizontal} tip={label} size={size} showTip={false} />
      <Dropdown.Popover placement="bottom end">
        <Dropdown.Menu aria-label={label} onAction={(key) => actions.find((a) => a.id === key)?.onAction()}>
          {actions.map((action) => {
            const Icon = action.icon;
            return (
              <Fragment key={action.id}>
                {action.sep ? <Separator /> : null}
                <Dropdown.Item id={action.id} textValue={action.label} variant={action.danger ? "danger" : "default"}>
                  {Icon ? <Icon className="i" aria-hidden /> : null}
                  <Label>{action.label}</Label>
                </Dropdown.Item>
              </Fragment>
            );
          })}
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  );
}
