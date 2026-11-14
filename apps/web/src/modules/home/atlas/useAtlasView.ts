"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

/**
 * Pan and zoom for the Knowledge Atlas (preview `features/home.js` › View). The view lives in a ref and is written straight
 * to the DOM (one transform, coalesced to one per frame), so panning and zooming never re-render React. React only hears
 * about the zoom *band* (far · normal · near) when it changes, for semantic zoom. The view is kept per workspace for the
 * session.
 */
export interface View {
  k: number;
  tx: number;
  ty: number;
}
export type ZoomBand = "far" | "normal" | "near";

export const ZOOM = { min: 0.2, max: 2, far: 0.55, near: 1.35 } as const;
const clampK = (k: number) => Math.min(ZOOM.max, Math.max(ZOOM.min, k));
export const bandOf = (k: number): ZoomBand => (k < ZOOM.far ? "far" : k >= ZOOM.near ? "near" : "normal");
const storeKey = (ws: string) => `bomesh.atlas.view.${ws}`;

function loadView(ws: string, narrow: boolean): View {
  try {
    const saved = JSON.parse(window.sessionStorage.getItem(storeKey(ws)) ?? "null") as View | null;
    if (saved && Number.isFinite(saved.k) && Number.isFinite(saved.tx) && Number.isFinite(saved.ty)) return saved;
  } catch {
    // An unreadable saved view starts fresh.
  }
  return { k: narrow ? 0.85 : 1, tx: 0, ty: 40 };
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface AtlasView {
  band: ZoomBand;
  /** Current view (read-only snapshot). */
  get: () => View;
  zoomBy: (factor: number, glide?: boolean) => void;
  zoomTo100: () => void;
  fit: (rect: Rect, maxK?: number) => void;
  /** Centre a world box a little above the middle at a readable zoom. */
  focus: (rect: Rect) => void;
  /** Move the view by screen pixels (keeps a box in place after the layout changed). */
  nudge: (dx: number, dy: number) => void;
  reset: () => void;
}

/** `mounted`: the canvas element exists (the atlas renders a skeleton until its data arrives). */
export function useAtlasView(
  ws: string,
  viewport: RefObject<HTMLDivElement | null>,
  world: RefObject<HTMLDivElement | null>,
  zoomLabel: RefObject<HTMLElement | null>,
  mounted: boolean,
): AtlasView {
  const view = useRef<View | null>(null);
  const [band, setBand] = useState<ZoomBand>("normal");
  const frame = useRef(0);
  const saveTimer = useRef(0);
  const kTimer = useRef(0);
  const reduced = useRef(false);

  const current = useCallback((): View => {
    if (!view.current) view.current = loadView(ws, typeof window !== "undefined" && window.innerWidth < 680);
    return view.current;
  }, [ws]);

  /** Writes the view to the DOM (next frame), the band to React when it changed, and the view to the session. */
  const apply = useCallback(
    (glide = false) => {
      cancelAnimationFrame(frame.current);
      frame.current = requestAnimationFrame(() => {
        const v = current();
        const w = world.current;
        const vp = viewport.current;
        if (!w || !vp) return;
        w.classList.toggle("is-gliding", glide && !reduced.current);
        w.style.transform = `translate3d(${v.tx}px, ${v.ty}px, 0) scale(${v.k})`;
        vp.style.backgroundSize = `${20 * v.k}px ${20 * v.k}px`;
        vp.style.backgroundPosition = `${v.tx}px ${v.ty}px`;
        // Far-zoom titles counter-scale with --k; changing an inherited custom property restyles every box (~70 ms at 2,000
        // elements), so it is written only in the far band and only once the gesture settles.
        window.clearTimeout(kTimer.current);
        if (bandOf(v.k) === "far") kTimer.current = window.setTimeout(() => vp.parentElement?.style.setProperty("--k", String(v.k)), 120);
        if (zoomLabel.current) zoomLabel.current.textContent = `${Math.round(v.k * 100)}%`;
        setBand(bandOf(v.k));
        if (glide) window.setTimeout(() => w.classList.remove("is-gliding"), 320);
        window.clearTimeout(saveTimer.current);
        saveTimer.current = window.setTimeout(() => window.sessionStorage.setItem(storeKey(ws), JSON.stringify(v)), 250);
      });
    },
    [current, viewport, world, zoomLabel, ws],
  );

  /** Zooms around a point in canvas pixels (the centre when omitted). Gestures pass the point, so they never read layout. */
  const zoomAt = useCallback(
    (factor: number, px?: number, py?: number) => {
      const v = current();
      let x = px;
      let y = py;
      if (x === undefined || y === undefined) {
        const r = viewport.current?.getBoundingClientRect();
        if (!r) return;
        x = r.width / 2;
        y = r.height / 2;
      }
      const k = clampK(v.k * factor);
      const s = k / v.k;
      v.tx = x - (x - v.tx) * s;
      v.ty = y - (y - v.ty) * s;
      v.k = k;
    },
    [current, viewport],
  );

  // Pointer (drag to pan, two fingers to pinch), wheel (pan; ⌘/Ctrl or trackpad pinch zooms) and keyboard on the canvas.
  useEffect(() => {
    const vp = viewport.current;
    if (!vp) return;
    reduced.current = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const pointers = new Map<number, { x: number; y: number }>();
    // The canvas's screen position, read once per gesture: a layout read per event forces a style and layout pass each frame.
    let edge = { left: 0, top: 0, at: -Infinity };
    const origin = (fresh: boolean) => {
      if (fresh) {
        const r = vp.getBoundingClientRect();
        edge = { left: r.left, top: r.top, at: 0 };
      }
      return edge;
    };
    let drag: {
      x: number;
      y: number;
      tx: number;
      ty: number;
      dist: number;
      mid: { x: number; y: number };
    } | null = null;
    const onDown = (e: PointerEvent) => {
      if (e.button > 0 || (e.target as Element).closest("button, a, input, .an--cluster, .an--doc")) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const v = current();
      drag = {
        x: e.clientX,
        y: e.clientY,
        tx: v.tx,
        ty: v.ty,
        dist: 0,
        mid: { x: 0, y: 0 },
      };
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const o = origin(true);
        drag.dist = Math.hypot(a.x - b.x, a.y - b.y);
        drag.mid = { x: (a.x + b.x) / 2 - o.left, y: (a.y + b.y) / 2 - o.top };
      }
      vp.setPointerCapture(e.pointerId);
      vp.classList.add("is-grabbing");
    };
    const onMove = (e: PointerEvent) => {
      if (!drag || !pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const v = current();
      if (pointers.size === 2 && drag.dist) {
        const [a, b] = [...pointers.values()];
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        zoomAt(dist / drag.dist, drag.mid.x, drag.mid.y);
        drag.dist = dist;
      } else {
        v.tx = drag.tx + e.clientX - drag.x;
        v.ty = drag.ty + e.clientY - drag.y;
      }
      apply();
    };
    const onUp = (e: PointerEvent) => {
      pointers.delete(e.pointerId);
      if (pointers.size) return;
      drag = null;
      vp.classList.remove("is-grabbing");
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const v = current();
      if (e.ctrlKey || e.metaKey) {
        const o = origin(e.timeStamp - edge.at > 200);
        edge.at = e.timeStamp;
        zoomAt(Math.exp(-e.deltaY * 0.01), e.clientX - o.left, e.clientY - o.top);
      } else {
        v.tx -= e.shiftKey ? e.deltaY : e.deltaX;
        v.ty -= e.shiftKey ? 0 : e.deltaY;
      }
      apply();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.target !== vp || e.metaKey || e.ctrlKey || e.altKey) return;
      const v = current();
      const step = e.shiftKey ? 240 : 80;
      const keys: Record<string, () => void> = {
        ArrowLeft: () => (v.tx += step),
        ArrowRight: () => (v.tx -= step),
        ArrowUp: () => (v.ty += step),
        ArrowDown: () => (v.ty -= step),
        "+": () => zoomAt(1.2),
        "=": () => zoomAt(1.2),
        "-": () => zoomAt(1 / 1.2),
        "0": () => zoomAt(1 / v.k),
      };
      if (!keys[e.key]) return;
      e.preventDefault();
      keys[e.key]();
      apply(e.key === "0");
    };
    vp.addEventListener("pointerdown", onDown);
    vp.addEventListener("pointermove", onMove);
    vp.addEventListener("pointerup", onUp);
    vp.addEventListener("pointercancel", onUp);
    vp.addEventListener("wheel", onWheel, { passive: false });
    vp.addEventListener("keydown", onKey);
    apply();
    return () => {
      vp.removeEventListener("pointerdown", onDown);
      vp.removeEventListener("pointermove", onMove);
      vp.removeEventListener("pointerup", onUp);
      vp.removeEventListener("pointercancel", onUp);
      vp.removeEventListener("wheel", onWheel);
      vp.removeEventListener("keydown", onKey);
      cancelAnimationFrame(frame.current);
    };
  }, [viewport, current, apply, zoomAt, mounted]);

  return {
    band,
    get: current,
    zoomBy: (factor, glide = true) => {
      zoomAt(factor);
      apply(glide);
    },
    zoomTo100: () => {
      zoomAt(1 / current().k);
      apply(true);
    },
    fit: (rect, maxK = 1) => {
      const r = viewport.current?.getBoundingClientRect();
      if (!r) return;
      const v = current();
      const m = 24;
      v.k = clampK(Math.min((r.width - 2 * m) / rect.w, (r.height - 2 * m - 48) / rect.h, maxK));
      v.tx = m + (r.width - 2 * m - rect.w * v.k) / 2 - rect.x * v.k;
      v.ty = m + 48 - rect.y * v.k;
      apply(true);
    },
    focus: (rect) => {
      const r = viewport.current?.getBoundingClientRect();
      if (!r) return;
      const v = current();
      v.k = clampK(Math.max(v.k, 0.9));
      v.tx = r.width / 2 - (rect.x + rect.w / 2) * v.k;
      v.ty = r.height * 0.42 - (rect.y + rect.h / 2) * v.k;
      apply(true);
    },
    nudge: (dx, dy) => {
      const v = current();
      v.tx += dx;
      v.ty += dy;
      apply();
    },
    reset: () => {
      view.current = { k: window.innerWidth < 680 ? 0.85 : 1, tx: 0, ty: 40 };
      apply(true);
    },
  };
}
