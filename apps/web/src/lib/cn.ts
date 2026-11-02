import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// tailwind-merge 2 predates Tailwind 4. Without this it reads the type scale
// from tokens.css (`text-body`, `text-meta` …) as text colours — so
// `text-text-primary text-body` silently lost its colour — and it cannot tell
// that `h-(--control-sm)` and `h-8` set the same property.
const isCssVariable = (value: string) => /^\((?:[a-z-]+:)?--[\w-]+\)$/.test(value);

const merge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [{ text: ["display", "title", "section", "body", "reading", "meta", "caption"] }],
      h: [{ h: [isCssVariable] }],
      "min-h": [{ "min-h": [isCssVariable] }],
      w: [{ w: [isCssVariable] }],
      "max-w": [{ "max-w": [isCssVariable] }],
      px: [{ px: [isCssVariable] }],
      py: [{ py: [isCssVariable] }],
      rounded: [{ rounded: [isCssVariable] }],
      shadow: [{ shadow: [isCssVariable] }],
      duration: [{ duration: [isCssVariable] }],
      ease: [{ ease: [isCssVariable] }],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return merge(clsx(inputs));
}
