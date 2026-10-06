"use client";

import {
  ArrowDownUp,
  Copy,
  Download,
  FileText,
  Link2,
  LogOut,
  MoreHorizontal,
  Pencil,
  Settings,
  Share2,
  Trash2,
} from "lucide-react";
import { useState } from "react";

import { FileTypeIcon } from "@/modules/knowledge/components/FileTypeIcon";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Dialog, type DialogSize } from "@/components/ui/Dialog";
import { Drawer, DrawerSection } from "@/components/ui/Drawer";
import { FormField } from "@/components/ui/FormField";
import { Input } from "@/components/ui/Input";
import { Kbd } from "@/components/ui/Kbd";
import { Menu, MenuCheckboxItem, MenuItem, MenuLabel, MenuRadioItem, MenuSeparator } from "@/components/ui/Menu";
import { Textarea } from "@/components/ui/Textarea";
import { useToast } from "@/components/ui/Toast";
import { Tooltip } from "@/components/ui/Tooltip";

import { Row, Section } from "./kit";

const DIALOG_COPY: Record<DialogSize, { title: string; description: string; body: string }> = {
  sm: {
    title: "Rename chat",
    description: "Small · 420. Short forms and confirmations.",
    body: "One field and two buttons fit without scrolling.",
  },
  md: {
    title: "Create knowledge base",
    description: "Medium · 520. The default form dialog.",
    body: "A few fields, help text and a footer with the primary action last.",
  },
  lg: {
    title: "Connect a source",
    description: "Large · 720. Pickers and two-column choices.",
    body: "Room for a grid of connectors or a list with details beside it.",
  },
  xl: {
    title: "Review changes",
    description: "Extra large · 960 with a fixed height. Side-by-side work.",
    body: "The body scrolls inside a fixed frame so the header and footer never move.",
  },
};

type ConfirmKind = "destructive" | "typed" | "fails" | "plain";

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function OverlaysSection() {
  const toast = useToast();
  const [dialog, setDialog] = useState<DialogSize | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [drawer, setDrawer] = useState<"md" | "lg" | null>(null);
  const [confirm, setConfirm] = useState<ConfirmKind | null>(null);
  const [columns, setColumns] = useState({ type: true, updated: true, size: false });
  const [sort, setSort] = useState<"updated" | "name" | "size">("updated");

  const undoable = (message: string, restored: string) =>
    toast.show({ message, action: { label: "Undo", onClick: () => toast.show({ message: restored }) } });

  const submitForm = async () => {
    setBusy(true);
    await wait(1600);
    setBusy(false);
    setFormOpen(false);
    toast.show({ message: "Created HR Policies" });
  };

  return (
    <Section
      description="Dialogs to decide, drawers to read or edit one record beside the list, confirmations before destruction. Escape closes the top layer and focus returns to the trigger. Busy layers cannot be dismissed."
      id="overlays"
      title="Overlays"
    >
      <Row label="Dialog sizes">
        {(Object.keys(DIALOG_COPY) as DialogSize[]).map((size) => (
          <Button key={size} onClick={() => setDialog(size)} variant="secondary">
            Dialog {size}
          </Button>
        ))}
        <Button onClick={() => setFormOpen(true)} variant="secondary">
          Form with busy state
        </Button>
      </Row>
      <Row label="Drawer">
        <Button onClick={() => setDrawer("md")} variant="secondary">
          Drawer
        </Button>
        <Button onClick={() => setDrawer("lg")} variant="secondary">
          Wide drawer
        </Button>
      </Row>
      <Row label="Confirm">
        <Button onClick={() => setConfirm("destructive")} variant="secondary">
          Confirm dialog
        </Button>
        <Button onClick={() => setConfirm("typed")} variant="secondary">
          Typed confirmation
        </Button>
        <Button onClick={() => setConfirm("fails")} variant="secondary">
          Confirm that fails
        </Button>
        <Button onClick={() => setConfirm("plain")} variant="secondary">
          Non-destructive
        </Button>
      </Row>
      <Row label="Menu">
        <Menu label="Actions">
          <MenuItem icon={<Pencil />} onSelect={() => toast.show({ message: "Renamed chat" })} shortcut="R">
            Rename
          </MenuItem>
          <MenuItem icon={<Share2 />} onSelect={() => toast.show({ message: "Copied share link" })}>
            Share
          </MenuItem>
          <MenuItem icon={<Download />} onSelect={() => toast.show({ message: "Downloaded transcript" })}>
            Download
          </MenuItem>
          <MenuItem disabled icon={<Link2 />}>
            Copy link (disabled)
          </MenuItem>
          <MenuSeparator />
          <MenuItem danger icon={<Trash2 />} onSelect={() => setConfirm("destructive")}>
            Delete chat
          </MenuItem>
        </Menu>
        <Menu
          align="end"
          ariaLabel="More actions"
          trigger={(props, open) => (
            <Tooltip disabled={open} label="More actions">
              <Button {...props} aria-label="More actions" icon={<MoreHorizontal aria-hidden="true" />} iconOnly variant="ghost" />
            </Tooltip>
          )}
        >
          <MenuLabel>Account</MenuLabel>
          <MenuItem href="/chat" icon={<FileText />}>
            Go to chat (link)
          </MenuItem>
          <MenuItem icon={<Settings />} shortcut="⌘,">
            Settings
          </MenuItem>
          <MenuSeparator />
          <MenuItem icon={<LogOut />}>Sign out</MenuItem>
        </Menu>
        <Menu label="Columns">
          <MenuLabel>Show columns</MenuLabel>
          <MenuCheckboxItem checked={columns.type} onCheckedChange={(type) => setColumns((current) => ({ ...current, type }))}>
            Type
          </MenuCheckboxItem>
          <MenuCheckboxItem checked={columns.updated} onCheckedChange={(updated) => setColumns((current) => ({ ...current, updated }))}>
            Updated
          </MenuCheckboxItem>
          <MenuCheckboxItem checked={columns.size} onCheckedChange={(size) => setColumns((current) => ({ ...current, size }))}>
            Size
          </MenuCheckboxItem>
        </Menu>
        <Menu label={<><ArrowDownUp aria-hidden="true" className="size-4" /> Sort</>} ariaLabel="Sort">
          <MenuRadioItem checked={sort === "updated"} onSelect={() => setSort("updated")}>
            Recently updated
          </MenuRadioItem>
          <MenuRadioItem checked={sort === "name"} onSelect={() => setSort("name")}>
            Name
          </MenuRadioItem>
          <MenuRadioItem checked={sort === "size"} onSelect={() => setSort("size")}>
            Size
          </MenuRadioItem>
        </Menu>
        <Menu disabled label="Disabled">
          <MenuItem>Never shown</MenuItem>
        </Menu>
      </Row>
      <Row label="Tooltip">
        {(["top", "right", "bottom", "left"] as const).map((side) => (
          <Tooltip key={side} label={`Tooltip on the ${side}`} side={side}>
            <Button variant="secondary">{side[0].toUpperCase() + side.slice(1)}</Button>
          </Tooltip>
        ))}
        <Tooltip label="Copy answer">
          <Button aria-label="Copy answer" icon={<Copy aria-hidden="true" />} iconOnly variant="ghost" />
        </Tooltip>
        <span className="inline-flex items-center gap-1 text-meta text-text-tertiary">
          Keyboard hints <Kbd>⌘</Kbd>
          <Kbd>K</Kbd>
        </span>
      </Row>
      <Row label="Toast">
        <Button onClick={() => toast.show({ message: "Saved changes" })} variant="secondary">
          Success toast
        </Button>
        <Button
          onClick={() => toast.show({ message: "Couldn’t save. Check your connection and try again.", tone: "err" })}
          variant="secondary"
        >
          Error toast
        </Button>
        <Button onClick={() => toast.show({ message: "Sync started", tone: "info", description: "People Ops · 28 documents" })} variant="secondary">
          Info with description
        </Button>
        <Button onClick={() => toast.show({ message: "Copied to clipboard", tone: "neutral" })} variant="secondary">
          Neutral toast
        </Button>
        <Button onClick={() => undoable("Archived 3 documents", "Restored 3 documents")} variant="secondary">
          Toast with Undo
        </Button>
      </Row>

      {dialog && (
        <Dialog
          description={DIALOG_COPY[dialog].description}
          footer={
            <>
              <Button onClick={() => setDialog(null)} variant="secondary">
                Cancel
              </Button>
              <Button onClick={() => setDialog(null)}>Done</Button>
            </>
          }
          footerStart={dialog === "xl" ? "Changes save for everyone" : undefined}
          onClose={() => setDialog(null)}
          open
          size={dialog}
          title={DIALOG_COPY[dialog].title}
        >
          <p className="text-text-secondary">{DIALOG_COPY[dialog].body}</p>
          {dialog === "xl" && (
            <div className="mt-4 grid gap-2">
              {Array.from({ length: 24 }, (_, index) => (
                <p className="rounded-md bg-surface-subtle px-3 py-2 text-meta text-text-secondary" key={index}>
                  Row {index + 1} · the body scrolls; the frame stays put.
                </p>
              ))}
            </div>
          )}
        </Dialog>
      )}

      <Dialog
        busy={busy}
        description="Saving takes a moment: Escape, the scrim and Close are blocked until it settles."
        footer={
          <>
            <Button disabled={busy} onClick={() => setFormOpen(false)} variant="secondary">
              Cancel
            </Button>
            <Button loading={busy} onClick={submitForm}>
              Create
            </Button>
          </>
        }
        onClose={() => setFormOpen(false)}
        open={formOpen}
        title="Create knowledge base"
      >
        <div className="grid gap-4">
          <FormField htmlFor="ds-dialog-name" label="Name" required>
            <Input defaultValue="HR Policies" disabled={busy} />
          </FormField>
          <FormField htmlFor="ds-dialog-description" label="Description">
            <Textarea counterLimit={200} disabled={busy} placeholder="What belongs here?" rows={3} />
          </FormField>
        </div>
      </Dialog>

      <Drawer
        description="HR Policies"
        footer={
          <>
            <Button onClick={() => setDrawer(null)} variant="secondary">
              Close
            </Button>
            <Button onClick={() => setDrawer(null)}>Open document</Button>
          </>
        }
        headerActions={
          <Tooltip label="Copy link">
            <Button aria-label="Copy link" icon={<Link2 aria-hidden="true" />} iconOnly onClick={() => toast.show({ message: "Copied link" })} size="sm" variant="ghost" />
          </Tooltip>
        }
        icon={<FileTypeIcon decorative kind="pdf" label="PDF" size="lg" />}
        onClose={() => setDrawer(null)}
        open={drawer !== null}
        size={drawer ?? "md"}
        title="Employee Handbook 2026.pdf"
      >
        <DrawerSection title="Details">
          <dl className="grid grid-cols-[120px_1fr] gap-x-4 gap-y-2 text-body">
            <dt className="text-text-tertiary">Source</dt>
            <dd>People Ops space</dd>
            <dt className="text-text-tertiary">Updated</dt>
            <dd>30 days ago</dd>
            <dt className="text-text-tertiary">Size</dt>
            <dd>3.4 MB · 48 pages</dd>
          </dl>
        </DrawerSection>
        <DrawerSection
          actions={
            <Button onClick={() => toast.show({ message: "Copied summary" })} size="sm" variant="ghost">
              Copy
            </Button>
          }
          title="Summary"
        >
          <p className="text-text-secondary">
            Covers leave, benefits, travel and conduct for every employee. Updated each January.
          </p>
        </DrawerSection>
      </Drawer>

      <ConfirmDialog
        confirmLabel="Archive"
        description="They’ll be removed from answers. You can restore them for 30 days."
        onClose={() => setConfirm(null)}
        onConfirm={async () => {
          await wait(900);
          undoable("Archived 3 documents", "Restored 3 documents");
        }}
        open={confirm === "destructive"}
        title="Archive 3 documents?"
      />
      <ConfirmDialog
        confirmLabel="Archive workspace"
        confirmText="northwind"
        description="Everyone loses access to Northwind Group and its sources stop syncing. Type the workspace code to confirm."
        onClose={() => setConfirm(null)}
        onConfirm={async () => {
          await wait(900);
          toast.show({ message: "Archived workspace" });
        }}
        open={confirm === "typed"}
        title="Archive Northwind Group?"
      />
      <ConfirmDialog
        confirmLabel="Remove member"
        description="Lan Tran loses access to this workspace. Their chats stay on their devices."
        onClose={() => setConfirm(null)}
        onConfirm={async () => {
          await wait(900);
          throw new Error("Couldn’t remove Lan Tran. Check your connection and try again.");
        }}
        open={confirm === "fails"}
        title="Remove Lan Tran?"
      />
      <ConfirmDialog
        confirmLabel="Start sync"
        description="People Ops syncs now instead of at 02:00. It takes a few minutes."
        destructive={false}
        onClose={() => setConfirm(null)}
        onConfirm={() => {
          toast.show({ message: "Started sync", tone: "info" });
        }}
        open={confirm === "plain"}
        title="Sync People Ops now?"
      />
    </Section>
  );
}
