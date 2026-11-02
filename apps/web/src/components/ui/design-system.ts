/**
 * Class recipes shared by every control.
 *
 * Colour, shape, size and motion resolve to the tokens in `src/app/tokens.css`
 * through the Tailwind utilities it exposes (`bg-surface-base`,
 * `text-text-tertiary`, `rounded-md`, `h-(--control-md)` …); nothing here
 * hard-codes a value. A component that needs a different look changes a
 * token, not a class string in one file.
 */

export type ControlSize = "sm" | "md" | "lg";

/** The one focus treatment: a 3px halo in the accent (`--shadow-focus`). */
const focus = "outline-none focus-visible:outline-none focus-visible:shadow-(--shadow-focus)";

const motion = "transition-[background-color,border-color,box-shadow,color] duration-(--duration-fast) ease-(--ease-standard)";

/**
 * Height, padding, type size and radius per control size. Heights follow the
 * density tokens, so `html[data-density="compact"]` tightens every control.
 */
const controlSize: Record<ControlSize, string> = {
  sm: "h-(--control-sm) rounded-sm px-2.5 text-[0.8125rem]",
  md: "h-(--control-md) rounded-md px-3 text-body",
  lg: "h-(--control-lg) rounded-md px-3.5 text-[0.9375rem]",
};

/**
 * A bordered field surface. Class names are written out in full (never
 * assembled) so Tailwind's scanner sees every one of them.
 */
const fieldBase = `w-full min-w-0 border border-border-default bg-surface-base text-text-primary outline-none placeholder:text-text-tertiary hover:border-border-strong ${motion}`;

/** input, select, textarea: state read from the element itself. */
const field = [
  fieldBase,
  "focus:border-border-focus focus:shadow-(--shadow-focus)",
  "disabled:cursor-not-allowed disabled:bg-surface-subtle disabled:text-text-tertiary disabled:hover:border-border-default",
  "aria-[invalid=true]:border-status-danger aria-[invalid=true]:focus:shadow-(--shadow-focus-danger)",
].join(" ");

/** The wrapper around an input with a prefix or suffix: state read from inside. */
const fieldWithin = [
  fieldBase,
  "flex items-stretch overflow-hidden",
  "focus-within:border-border-focus focus-within:shadow-(--shadow-focus)",
  "has-[:disabled]:cursor-not-allowed has-[:disabled]:bg-surface-subtle has-[:disabled]:text-text-tertiary has-[:disabled]:hover:border-border-default",
  "has-[[aria-invalid=true]]:border-status-danger has-[[aria-invalid=true]]:focus-within:shadow-(--shadow-focus-danger)",
].join(" ");

export const ui = {
  focus,
  motion,
  controlSize,

  /** Single-line control (input, select). Add `controlSize[size]`. */
  control: field,
  /** The bordered wrapper of an input with a prefix/suffix. Add `controlSize[size]` minus padding. */
  controlGroup: fieldWithin,
  /** Multi-line control. */
  textarea: `${field} min-h-22 resize-y rounded-md px-3 py-2 text-body`,

  label: "flex items-center gap-1.5 text-[0.84375rem] font-medium text-text-primary",
  /** "Optional" beside a label. */
  labelHint: "font-normal text-text-tertiary",
  helper: "text-meta text-text-tertiary",
  errorText: "flex items-start gap-1.5 text-meta text-status-danger",
  counter: "text-caption tabular-nums text-text-tertiary",

  sectionTitle: "text-section font-semibold text-text-primary",
  sectionDescription: "mt-1 text-body text-text-tertiary",

  metaLabel: "text-caption font-medium text-text-tertiary",
  metaValue: "text-body text-text-primary",

  /** A card: the sheet surface with one hairline. */
  card: "rounded-lg border border-border-subtle bg-surface-base",
  cardPadding: "px-(--card-px) py-(--card-py)",
  insetPanel: "rounded-lg bg-surface-inset",
  subtlePanel: "rounded-md bg-surface-subtle px-3 py-2",

  /** A bare icon-only control. Pair with an `aria-label`. */
  iconButton: `inline-flex shrink-0 items-center justify-center rounded-md text-text-tertiary ${motion} hover:bg-surface-hover hover:text-text-primary active:bg-surface-pressed disabled:pointer-events-none disabled:opacity-45 ${focus}`,

  page: "w-full space-y-4",
  pageNarrow: "mx-auto w-full max-w-(--page-max-narrow) space-y-4",
};
