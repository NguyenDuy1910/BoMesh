import { Check, Minus } from "lucide-react";

/**
 * Yes/no cell of a comparison table (preview `tick()`): a soft green check disc or a quiet dash — never an empty
 * cell — with the answer spoken to screen readers.
 */
export function Tick({ on, yes = "Allowed", no = "Not allowed" }: { on: boolean; yes?: string; no?: string }) {
  const Icon = on ? Check : Minus;
  return (
    <>
      <span className={on ? "tick tick--on" : "tick tick--off"} aria-hidden>
        <Icon className="i" />
      </span>
      <span className="sr-only">{on ? yes : no}</span>
    </>
  );
}
