"use client";

import { Check, ChevronDown } from "lucide-react";
import Link from "next/link";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

import { nextMenuIndex, typeaheadIndex } from "@/components/ui/interaction";
import { Tooltip } from "@/components/ui/Tooltip";
import { cn } from "@/lib/cn";
import { useModalLayer } from "@/lib/hooks/useModalLayer";

/** Spread onto a custom trigger button: `<Menu trigger={(props) => <button {...props}>…</button>}>`. */
export interface MenuTriggerProps {
  ref: React.Ref<HTMLButtonElement>;
  id: string;
  type: "button";
  "aria-haspopup": "menu";
  "aria-expanded": boolean;
  "aria-controls": string | undefined;
  disabled: boolean | undefined;
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>) => void;
}

interface MenuProps {
  /** Content of the default trigger button. Ignored when `trigger` is given. */
  label?: React.ReactNode;
  /** Render a custom trigger. Spread the props onto a `<button>`; `open` is for styling only. */
  trigger?: (props: MenuTriggerProps, open: boolean) => React.ReactNode;
  /** Accessible name of the default trigger. Required when `label` is an icon. */
  ariaLabel?: string;
  /** Label shown on hover/focus of the default trigger. Never the only label. */
  tooltip?: string;
  /** Which trigger edge the menu lines up with. Flips and clamps to stay in the viewport. */
  align?: "start" | "end";
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  disabled?: boolean;
  /** Wrapper around the trigger. */
  className?: string;
  /** Classes merged onto the default trigger button. */
  triggerClassName?: string;
  menuClassName?: string;
  /** Chevron after the default trigger's label. Defaults to `true`. */
  showChevron?: boolean;
  children: React.ReactNode;
}

interface MenuContextValue {
  /** Close the menu; `focusTrigger` returns focus to the trigger (keyboard activation, Escape). */
  close: (focusTrigger: boolean) => void;
}

const MenuContext = createContext<MenuContextValue | null>(null);

const ITEM_SELECTOR = '[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"]';
const VIEWPORT_MARGIN = 8;
const TRIGGER_GAP = 4;
const TYPEAHEAD_RESET_MS = 500;

function enabledItems(menu: HTMLElement | null): HTMLElement[] {
  if (!menu) return [];
  return Array.from(menu.querySelectorAll<HTMLElement>(ITEM_SELECTOR)).filter(
    (item) => !item.matches(":disabled,[aria-disabled='true']"),
  );
}

interface Position {
  top: number;
  left: number;
  maxHeight: number;
  placement: "top" | "bottom";
}

/**
 * A button that opens a list of actions or choices.
 *
 * Follows the WAI-ARIA menu button pattern: ArrowDown/ArrowUp on the trigger
 * open on the first/last item; inside, arrows, Home/End and type-ahead move
 * focus, Enter/Space activate, Escape closes and returns focus to the trigger,
 * Tab closes and lets focus continue from the trigger. The menu is portalled
 * to the body and positioned against the viewport, so it is never clipped by
 * a scrolling table or panel.
 */
export function Menu({
  label,
  trigger,
  ariaLabel,
  tooltip,
  align = "start",
  open: controlledOpen,
  onOpenChange,
  disabled,
  className,
  triggerClassName,
  menuClassName,
  showChevron = true,
  children,
}: MenuProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const [position, setPosition] = useState<Position | null>(null);
  const triggerId = useId();
  const menuId = useId();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const focusOnOpen = useRef<"first" | "last">("first");
  const typeahead = useRef({ query: "", timer: 0 });

  const setOpen = useCallback(
    (next: boolean) => {
      if (controlledOpen === undefined) setInternalOpen(next);
      onOpenChange?.(next);
    },
    [controlledOpen, onOpenChange],
  );

  const close = useCallback(
    (focusTrigger: boolean) => {
      setOpen(false);
      if (focusTrigger) triggerRef.current?.focus({ preventScroll: true });
    },
    [setOpen],
  );

  useModalLayer({
    open,
    onClose: () => close(true),
    panelRef: menuRef,
    initialFocusRef: false,
    modal: false,
    restoreFocus: false,
  });

  const place = useCallback(() => {
    const anchor = triggerRef.current;
    const menu = menuRef.current;
    if (!anchor || !menu) return;
    const rect = anchor.getBoundingClientRect();
    const width = menu.offsetWidth;
    const height = menu.scrollHeight;
    const below = window.innerHeight - rect.bottom - TRIGGER_GAP - VIEWPORT_MARGIN;
    const above = rect.top - TRIGGER_GAP - VIEWPORT_MARGIN;
    const placement = height > below && above > below ? "top" : "bottom";
    const space = placement === "bottom" ? below : above;
    const shown = Math.min(height, space);
    const preferredLeft = align === "end" ? rect.right - width : rect.left;
    setPosition({
      placement,
      maxHeight: Math.max(120, space),
      top: placement === "bottom" ? rect.bottom + TRIGGER_GAP : rect.top - TRIGGER_GAP - shown,
      left: Math.min(
        Math.max(VIEWPORT_MARGIN, preferredLeft),
        Math.max(VIEWPORT_MARGIN, window.innerWidth - width - VIEWPORT_MARGIN),
      ),
    });
  }, [align]);

  useLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, place]);

  // Focus the first (or last) item once the menu is placed.
  useEffect(() => {
    if (!open || !position) return;
    const menu = menuRef.current;
    if (!menu || menu.contains(document.activeElement)) return;
    const items = enabledItems(menu);
    (focusOnOpen.current === "last" ? items.at(-1) : items[0])?.focus({ preventScroll: true });
  }, [open, position]);

  // A press outside closes without moving focus: the press already put it where the person wanted.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [open, setOpen]);

  useEffect(() => () => window.clearTimeout(typeahead.current.timer), []);

  const triggerProps: MenuTriggerProps = {
    ref: triggerRef,
    id: triggerId,
    type: "button",
    "aria-haspopup": "menu",
    "aria-expanded": open,
    "aria-controls": open ? menuId : undefined,
    disabled,
    onClick: () => {
      focusOnOpen.current = "first";
      setOpen(!open);
    },
    onKeyDown: (event) => {
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      event.preventDefault();
      focusOnOpen.current = event.key === "ArrowUp" ? "last" : "first";
      setOpen(true);
    },
  };

  function onMenuKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const items = enabledItems(menuRef.current);
    const current = items.indexOf(document.activeElement as HTMLElement);
    if (event.key === "Tab") {
      // Focus the trigger and let the browser's Tab continue from there.
      close(true);
      return;
    }
    if ((event.key === " " || event.key === "Enter") && current >= 0 && items[current].tagName === "A") {
      // Links do not activate on Space natively; buttons handle both keys themselves.
      event.preventDefault();
      items[current].click();
      return;
    }
    const next = nextMenuIndex(event.key, current, items.length);
    if (next !== null) {
      event.preventDefault();
      items[next]?.focus();
      return;
    }
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey && event.key !== " ") {
      const state = typeahead.current;
      window.clearTimeout(state.timer);
      state.query += event.key;
      state.timer = window.setTimeout(() => {
        state.query = "";
      }, TYPEAHEAD_RESET_MS);
      const labels = items.map((item) => item.dataset.label ?? item.textContent ?? "");
      const match = typeaheadIndex(labels, state.query, current);
      if (match >= 0) items[match].focus();
    }
  }

  const defaultTrigger = (
    <button
      {...triggerProps}
      aria-label={ariaLabel}
      className={cn(
        "inline-flex h-[var(--control-md)] items-center justify-center gap-1.5 rounded-[var(--radius-md)] px-3",
        "bg-[var(--surface-base)] text-[length:var(--text-size-body)] font-medium text-[var(--text-secondary)] shadow-[inset_0_0_0_1px_var(--border-default)]",
        "transition-colors duration-[var(--duration-fast)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]",
        "focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]",
        "disabled:pointer-events-none disabled:opacity-45",
        open && "bg-[var(--surface-hover)] text-[var(--text-primary)]",
        triggerClassName,
      )}
    >
      {label}
      {showChevron && (
        <ChevronDown
          aria-hidden="true"
          className={cn(
            "h-4 w-4 shrink-0 text-[var(--text-tertiary)] transition-transform duration-[var(--duration-fast)]",
            open && "rotate-180",
          )}
        />
      )}
    </button>
  );

  return (
    <span className={cn("relative inline-flex", className)}>
      {trigger ? (
        trigger(triggerProps, open)
      ) : tooltip ? (
        <Tooltip disabled={open} label={tooltip} side="bottom">
          {defaultTrigger}
        </Tooltip>
      ) : (
        defaultTrigger
      )}
      {open &&
        createPortal(
          <MenuContext.Provider value={{ close }}>
            <div
              aria-labelledby={triggerId}
              className={cn(
                "fixed z-[80] w-max min-w-[200px] max-w-[min(300px,calc(100vw-16px))] overflow-y-auto overscroll-contain",
                "rounded-[var(--radius-lg)] bg-[var(--surface-raised)] p-[5px] shadow-[var(--shadow-pop)]",
                "focus:outline-none motion-safe:animate-ui-pop",
                menuClassName,
              )}
              data-placement={position?.placement}
              id={menuId}
              onKeyDown={onMenuKeyDown}
              ref={menuRef}
              role="menu"
              style={
                position
                  ? { top: position.top, left: position.left, maxHeight: position.maxHeight }
                  : { top: 0, left: 0, visibility: "hidden" }
              }
              tabIndex={-1}
            >
              {children}
            </div>
          </MenuContext.Provider>,
          document.body,
        )}
    </span>
  );
}

function useMenuClose() {
  const context = useContext(MenuContext);
  if (!context) throw new Error("Menu items must be rendered inside <Menu>.");
  return context.close;
}

const itemClass = cn(
  "flex min-h-[34px] w-full items-center gap-2.5 rounded-[var(--radius-sm)] px-2.5 py-1.5 text-left",
  "text-[length:var(--text-size-body)] text-[var(--text-primary)] outline-none",
  "hover:bg-[var(--surface-hover)] focus:bg-[var(--surface-hover)]",
  "disabled:pointer-events-none disabled:opacity-45 aria-disabled:pointer-events-none aria-disabled:opacity-45",
);

/** Moves focus with the mouse so hover and keyboard focus are always the same item. */
function followPointer(event: React.PointerEvent<HTMLElement>) {
  if (event.pointerType === "mouse" && document.activeElement !== event.currentTarget) {
    event.currentTarget.focus({ preventScroll: true });
  }
}

interface ItemContentProps {
  icon?: React.ReactNode;
  shortcut?: string;
  danger?: boolean;
  children: React.ReactNode;
}

function ItemContent({ icon, shortcut, danger, children }: ItemContentProps) {
  return (
    <>
      {icon && (
        <span
          aria-hidden="true"
          className={cn(
            "inline-flex shrink-0 [&>svg]:h-4 [&>svg]:w-4",
            danger ? "text-[var(--status-danger-text)]" : "text-[var(--text-tertiary)]",
          )}
        >
          {icon}
        </span>
      )}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {shortcut && (
        <span className="ml-auto shrink-0 pl-3 text-[length:var(--text-size-caption)] text-[var(--text-tertiary)]">
          {shortcut}
        </span>
      )}
    </>
  );
}

interface MenuItemProps {
  onSelect?: () => void;
  /** Navigate instead of running `onSelect`. Rendered as a link. */
  href?: string;
  icon?: React.ReactNode;
  /** A keyboard hint, e.g. "⌘K". Decorative: the action must not depend on it. */
  shortcut?: string;
  /** A destructive action. It still opens a confirmation; this only colours the entry. */
  danger?: boolean;
  disabled?: boolean;
  /** Defaults to `true`. */
  closeOnSelect?: boolean;
  /** Text used for type-ahead when the children are not plain text. */
  textValue?: string;
  className?: string;
  children: React.ReactNode;
}

export function MenuItem({
  onSelect,
  href,
  icon,
  shortcut,
  danger,
  disabled,
  closeOnSelect = true,
  textValue,
  className,
  children,
}: MenuItemProps) {
  const close = useMenuClose();
  const classes = cn(
    itemClass,
    danger && "text-[var(--status-danger-text)] hover:bg-[var(--status-danger-bg)] focus:bg-[var(--status-danger-bg)]",
    className,
  );
  const content = (
    <ItemContent danger={danger} icon={icon} shortcut={shortcut}>
      {children}
    </ItemContent>
  );

  if (href && !disabled) {
    return (
      <Link
        className={classes}
        data-label={textValue}
        href={href}
        onClick={() => {
          onSelect?.();
          close(false);
        }}
        onPointerMove={followPointer}
        role="menuitem"
        tabIndex={-1}
      >
        {content}
      </Link>
    );
  }

  return (
    <button
      className={classes}
      data-label={textValue}
      disabled={disabled}
      onClick={() => {
        if (closeOnSelect) close(true);
        onSelect?.();
      }}
      onPointerMove={followPointer}
      role="menuitem"
      tabIndex={-1}
      type="button"
    >
      {content}
    </button>
  );
}

interface MenuCheckItemProps {
  checked: boolean;
  icon?: React.ReactNode;
  disabled?: boolean;
  textValue?: string;
  className?: string;
  children: React.ReactNode;
}

function CheckableItem({
  role,
  checked,
  icon,
  disabled,
  textValue,
  className,
  closeOnSelect,
  onActivate,
  children,
}: MenuCheckItemProps & {
  role: "menuitemcheckbox" | "menuitemradio";
  closeOnSelect: boolean;
  onActivate: () => void;
}) {
  const close = useMenuClose();
  return (
    <button
      aria-checked={checked}
      className={cn(itemClass, className)}
      data-label={textValue}
      disabled={disabled}
      onClick={() => {
        if (closeOnSelect) close(true);
        onActivate();
      }}
      onPointerMove={followPointer}
      role={role}
      tabIndex={-1}
      type="button"
    >
      <ItemContent icon={icon}>{children}</ItemContent>
      <Check
        aria-hidden="true"
        className={cn("ml-auto h-4 w-4 shrink-0 text-[var(--accent-primary)]", !checked && "invisible")}
      />
    </button>
  );
}

/** A toggle inside a menu (multi-select filter). Stays open by default so several can be ticked. */
export function MenuCheckboxItem({
  onCheckedChange,
  closeOnSelect = false,
  ...props
}: MenuCheckItemProps & { onCheckedChange?: (checked: boolean) => void; closeOnSelect?: boolean }) {
  return (
    <CheckableItem
      {...props}
      closeOnSelect={closeOnSelect}
      onActivate={() => onCheckedChange?.(!props.checked)}
      role="menuitemcheckbox"
    />
  );
}

/** One choice of a set (single-select filter, sort order). Closes by default. */
export function MenuRadioItem({
  onSelect,
  closeOnSelect = true,
  ...props
}: MenuCheckItemProps & { onSelect?: () => void; closeOnSelect?: boolean }) {
  return (
    <CheckableItem
      {...props}
      closeOnSelect={closeOnSelect}
      onActivate={() => onSelect?.()}
      role="menuitemradio"
    />
  );
}

/** A non-interactive section heading inside a menu. */
export function MenuLabel({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "px-2.5 pb-1 pt-2 text-[length:var(--text-size-caption)] font-semibold tracking-[0.02em] text-[var(--text-tertiary)]",
        className,
      )}
      role="presentation"
    >
      {children}
    </div>
  );
}

export function MenuSeparator() {
  return <div className="mx-1 my-[5px] h-px bg-[var(--border-subtle)]" role="separator" />;
}
