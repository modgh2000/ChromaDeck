import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { Monitor, Preset } from "../lib/types";
import { applyPreset, resetMonitor } from "../lib/tauri";
import { splitCategory } from "../lib/presetCard";

/* ==========================================================================
   Drag-and-drop — pointer-based, portal ghost.

   Tauri (Windows) routes HTML5 drag events through its own file-drop handler,
   so this is driven entirely by PointerEvents + elementFromPoint hit-testing.
   The ghost lives in a portal (see DragGhost) and never participates in
   layout or hit-testing; the source card stays put as a dimmed placeholder.
   ========================================================================== */

export type DropTargetKind = "monitor" | "all" | "panel";

export interface DropTarget {
  kind: DropTargetKind;
  edid?: string;
  /** False for offline monitors / a panel with no connected displays. */
  valid: boolean;
}

export interface DragGhostState {
  preset: Preset;
  x: number;
  y: number;
  width: number;
  height: number;
}

export type ApplyPhase = "applying" | "applied" | "error";

export interface ApplyStatus {
  phase: ApplyPhase;
  presetId: string;
  presetName: string;
  category?: string;
  error?: string;
}

export interface UndoState {
  presetId: string;
  presetName: string;
  targetLabel: string;
  count: number;
  edids: string[];
  /** Applied map snapshot before the drop, so undo can restore it. */
  previous: Record<string, string | undefined>;
}

export interface DragAndDropValue {
  isDragging: boolean;
  draggingPreset: Preset | null;
  target: DropTarget | null;
  applyStatus: Record<string, ApplyStatus>;
  undo: UndoState | null;
  undoNow: () => Promise<void>;
  dismissUndo: () => void;
}

export interface DragSourceValue {
  /** Begin a drag from a card; `rect` is the source card's bounding box. */
  beginDrag: (
    preset: Preset,
    rect: DOMRect,
    pointer: { x: number; y: number },
  ) => void;
  /** Id of the preset currently being dragged (stable per drag). */
  draggingPresetId: string | null;
}

interface Props {
  children: ReactNode;
  monitors: Monitor[];
  appliedMap: Record<string, string>;
  /** Called after a successful drop (per-monitor preset ids). */
  onApplied?: (presetId: string, edids: string[]) => void;
  /** Quiet re-sync after apply/undo. */
  onRefresh?: () => void;
}

const UNDO_TIMEOUT_MS = 5000;
const APPLIED_BADGE_MS = 2600;
const ERROR_CLEAR_MS = 10000;
const DRAG_EDGE_PX = 56;
const DRAG_SCROLL_STEP = 14;

const sleep = (ms: number) =>
  new Promise<void>((resolve) => window.setTimeout(resolve, ms));

const noop = () => {};
const noopAsync = async () => {};

/**
 * Three contexts, split so hot updates (pointer position) don't re-render
 * every preset card in the library:
 * - DndContext — drag identity, drop target, apply status, undo
 * - DragSourceContext — stable beginDrag + the source preset id
 * - DragGhostContext — high-frequency ghost position
 */
const DndContext = createContext<DragAndDropValue>({
  isDragging: false,
  draggingPreset: null,
  target: null,
  applyStatus: {},
  undo: null,
  undoNow: noopAsync,
  dismissUndo: noop,
});

const DragSourceContext = createContext<DragSourceValue>({
  beginDrag: noop,
  draggingPresetId: null,
});

const DragGhostContext = createContext<DragGhostState | null>(null);

export function useDragAndDrop(): DragAndDropValue {
  return useContext(DndContext);
}

export function useDragSource(): DragSourceValue {
  return useContext(DragSourceContext);
}

export function useDragGhost(): DragGhostState | null {
  return useContext(DragGhostContext);
}

const sameTarget = (a: DropTarget | null, b: DropTarget | null) =>
  a === b ||
  (a !== null &&
    b !== null &&
    a.kind === b.kind &&
    a.edid === b.edid &&
    a.valid === b.valid);

export function DragAndDropProvider({
  children,
  monitors,
  appliedMap,
  onApplied,
  onRefresh,
}: Props) {
  const [draggingPreset, setDraggingPreset] = useState<Preset | null>(null);
  const [ghostPos, setGhostPos] = useState<{ x: number; y: number } | null>(null);
  const [ghostSize, setGhostSize] = useState({ width: 280, height: 120 });
  const [target, setTarget] = useState<DropTarget | null>(null);
  const [applyStatus, setApplyStatus] = useState<Record<string, ApplyStatus>>({});
  const [undo, setUndo] = useState<UndoState | null>(null);

  // Latest props for handlers that outlive a render (drag effect, apply loop).
  const monitorsRef = useRef(monitors);
  monitorsRef.current = monitors;
  const appliedMapRef = useRef(appliedMap);
  appliedMapRef.current = appliedMap;
  const onAppliedRef = useRef(onApplied);
  onAppliedRef.current = onApplied;
  const onRefreshRef = useRef(onRefresh);
  onRefreshRef.current = onRefresh;

  const statusTimers = useRef<Map<string, number>>(new Map());
  const undoTimer = useRef<number | null>(null);

  /* — Hit-testing —————————————————————————————————————————— */

  const resolveTargetAt = useCallback((x: number, y: number): DropTarget | null => {
    if (typeof document === "undefined") return null;
    const el = document.elementFromPoint(x, y) as HTMLElement | null;
    if (!el) return null;

    const monitorEl = el.closest<HTMLElement>("[data-drop-monitor]");
    if (monitorEl) {
      const edid = monitorEl.dataset.dropMonitor;
      if (!edid) return null;
      return {
        kind: "monitor",
        edid,
        valid: monitorEl.dataset.dropEnabled !== "false",
      };
    }

    if (el.closest("[data-drop-all]")) {
      return {
        kind: "all",
        valid: monitorsRef.current.some((m) => m.connected),
      };
    }

    // Monitors panel background (and gaps between cards) -> apply to all.
    // The preset library carries no drop attribute, so a release there
    // resolves to null and cancels — no accidental applies.
    if (el.closest("[data-drop-panel]")) {
      return {
        kind: "panel",
        valid: monitorsRef.current.some((m) => m.connected),
      };
    }

    return null;
  }, []);

  const monitorLabel = useCallback((edid: string) => {
    const m = monitorsRef.current.find((x) => x.edid_id === edid);
    return m?.alias || m?.model || m?.device_name || edid.slice(0, 12);
  }, []);

  /* — Apply status helpers —————————————————————————————————— */

  const scheduleStatusClear = useCallback((edid: string, ms: number) => {
    const existing = statusTimers.current.get(edid);
    if (existing !== undefined) window.clearTimeout(existing);
    const id = window.setTimeout(() => {
      statusTimers.current.delete(edid);
      setApplyStatus((prev) => {
        if (!prev[edid]) return prev;
        const next = { ...prev };
        delete next[edid];
        return next;
      });
    }, ms);
    statusTimers.current.set(edid, id);
  }, []);

  const dismissUndo = useCallback(() => {
    if (undoTimer.current !== null) {
      window.clearTimeout(undoTimer.current);
      undoTimer.current = null;
    }
    setUndo(null);
  }, []);

  /* — Apply ———————————————————————————————————————————————— */

  const applyToEdids = useCallback(
    async (requested: string[], preset: Preset) => {
      // Only connected monitors are valid targets — never apply to a stale EDID.
      const edids = requested.filter((edid) =>
        monitorsRef.current.some((m) => m.edid_id === edid && m.connected),
      );
      if (edids.length === 0) return;

      const { category } = splitCategory(preset.name);

      // Snapshot what each target had before this drop (undo restore point).
      const previous: Record<string, string | undefined> = {};
      for (const edid of edids) previous[edid] = appliedMapRef.current[edid];

      setApplyStatus((prev) => {
        const next = { ...prev };
        for (const edid of edids) {
          next[edid] = {
            phase: "applying",
            presetId: preset.id,
            presetName: preset.name,
            category,
          };
        }
        return next;
      });

      // Staggered starts: 60ms steps, capped at 300ms total.
      const results = await Promise.all(
        edids.map(async (edid, index) => {
          const delay = Math.min(index * 60, 300);
          if (delay > 0) await sleep(delay);
          try {
            const result = await applyPreset(preset.id, edid);
            return { edid, error: result.error ?? null };
          } catch (err) {
            return { edid, error: String(err) };
          }
        }),
      );

      const outcomes: Record<string, ApplyStatus> = {};
      for (const r of results) {
        outcomes[r.edid] = r.error
          ? {
              phase: "error",
              presetId: preset.id,
              presetName: preset.name,
              category,
              error: r.error,
            }
          : {
              phase: "applied",
              presetId: preset.id,
              presetName: preset.name,
              category,
            };
      }
      setApplyStatus((prev) => ({ ...prev, ...outcomes }));

      const succeeded = results.filter((r) => !r.error).map((r) => r.edid);

      for (const r of results) {
        scheduleStatusClear(r.edid, r.error ? ERROR_CLEAR_MS : APPLIED_BADGE_MS);
      }

      if (succeeded.length === 0) return;

      onAppliedRef.current?.(preset.id, succeeded);

      // Undo toast — only for the monitors that actually took the preset.
      const previousSucceeded: Record<string, string | undefined> = {};
      for (const edid of succeeded) previousSucceeded[edid] = previous[edid];
      const targetLabel =
        succeeded.length === 1
          ? monitorLabel(succeeded[0])
          : `${succeeded.length} monitors`;

      const nextUndo: UndoState = {
        presetId: preset.id,
        presetName: preset.name,
        targetLabel,
        count: succeeded.length,
        edids: succeeded,
        previous: previousSucceeded,
      };

      if (undoTimer.current !== null) window.clearTimeout(undoTimer.current);
      setUndo(nextUndo);
      undoTimer.current = window.setTimeout(() => {
        undoTimer.current = null;
        setUndo(null);
      }, UNDO_TIMEOUT_MS);
    },
    [monitorLabel, scheduleStatusClear],
  );

  /* — Undo ———————————————————————————————————————————————— */

  const undoNow = useCallback(async () => {
    const current = undo;
    if (!current) return;

    dismissUndo();

    for (const edid of current.edids) {
      const previousPreset = current.previous[edid];
      try {
        if (previousPreset) {
          // Restore the prior apply; fall back to defaults if that fails.
          const result = await applyPreset(previousPreset, edid);
          if (result.error) await resetMonitor(edid);
        } else {
          // Nothing was applied before — unapply to identity.
          await resetMonitor(edid);
        }
      } catch {
        // best-effort: one monitor failing must not stop the rest
      }
    }

    setApplyStatus((prev) => {
      const next = { ...prev };
      for (const edid of current.edids) delete next[edid];
      return next;
    });
    onRefreshRef.current?.();
  }, [dismissUndo, undo]);

  /* — Drag lifecycle ————————————————————————————————————— */

  const beginDrag = useCallback<DragSourceValue["beginDrag"]>(
    (preset, rect, pointer) => {
      setDraggingPreset(preset);
      setGhostSize({
        width: Math.min(Math.max(rect.width, 200), 320),
        height: rect.height,
      });
      setGhostPos({ x: pointer.x, y: pointer.y });
      const next = resolveTargetAt(pointer.x, pointer.y);
      setTarget((prev) => (sameTarget(prev, next) ? prev : next));
    },
    [resolveTargetAt],
  );

  useEffect(() => {
    if (!draggingPreset) return;
    const preset = draggingPreset;

    const last = { x: ghostPos?.x ?? 0, y: ghostPos?.y ?? 0 };
    let raf = 0;
    let finished = false;

    const clearVisuals = () => {
      setDraggingPreset(null);
      setGhostPos(null);
      setTarget(null);
    };

    const stop = () => {
      if (finished) return;
      finished = true;
      if (raf) window.cancelAnimationFrame(raf);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("blur", onBlur);
      document.body.style.userSelect = previousUserSelect;
      document.body.style.cursor = previousCursor;
    };

    const cancel = () => {
      stop();
      clearVisuals();
    };

    const finish = (x: number, y: number) => {
      const resolved = resolveTargetAt(x, y);
      stop();
      clearVisuals();
      if (!resolved || !resolved.valid) return;
      if (resolved.kind === "monitor" && resolved.edid) {
        void applyToEdids([resolved.edid], preset);
      } else {
        const connected = monitorsRef.current
          .filter((m) => m.connected)
          .map((m) => m.edid_id);
        void applyToEdids(connected, preset);
      }
    };

    const onMove = (e: PointerEvent) => {
      // The button can be released outside the window (no pointerup reaches
      // us). Treat "no buttons held" as a cancel so a drag never sticks.
      if (e.buttons === 0) {
        cancel();
        return;
      }
      last.x = e.clientX;
      last.y = e.clientY;
      setGhostPos({ x: e.clientX, y: e.clientY });
      const next = resolveTargetAt(e.clientX, e.clientY);
      setTarget((prev) => (sameTarget(prev, next) ? prev : next));
    };

    const onUp = (e: PointerEvent) => finish(e.clientX, e.clientY);
    const onCancel = () => cancel();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        cancel();
      }
    };

    // Losing window focus (alt-tab, OS overlay) must not leave a stuck drag.
    const onBlur = () => cancel();

    // Auto-scroll any registered scrollport when the pointer nears its edge.
    const tick = () => {
      if (!finished) {
        document.querySelectorAll<HTMLElement>("[data-drag-scroll]").forEach((node) => {
          const r = node.getBoundingClientRect();
          if (last.x < r.left || last.x > r.right || last.y < r.top || last.y > r.bottom) {
            return;
          }
          if (last.y < r.top + DRAG_EDGE_PX) node.scrollTop -= DRAG_SCROLL_STEP;
          else if (last.y > r.bottom - DRAG_EDGE_PX) node.scrollTop += DRAG_SCROLL_STEP;
        });
        raf = window.requestAnimationFrame(tick);
      }
    };

    const previousUserSelect = document.body.style.userSelect;
    const previousCursor = document.body.style.cursor;
    document.body.style.userSelect = "none";
    document.body.style.cursor = "grabbing";

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("blur", onBlur);
    raf = window.requestAnimationFrame(tick);

    return stop;
    // The drag is identified by the preset; pointer position is live state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draggingPreset, resolveTargetAt, applyToEdids]);

  // Clear timers on unmount.
  useEffect(
    () => () => {
      statusTimers.current.forEach((id) => window.clearTimeout(id));
      statusTimers.current.clear();
      if (undoTimer.current !== null) window.clearTimeout(undoTimer.current);
    },
    [],
  );

  const ghost = useMemo<DragGhostState | null>(() => {
    if (!draggingPreset || !ghostPos) return null;
    return {
      preset: draggingPreset,
      x: ghostPos.x,
      y: ghostPos.y,
      width: ghostSize.width,
      height: ghostSize.height,
    };
  }, [draggingPreset, ghostPos, ghostSize]);

  const value = useMemo<DragAndDropValue>(
    () => ({
      isDragging: draggingPreset !== null,
      draggingPreset,
      target,
      applyStatus,
      undo,
      undoNow,
      dismissUndo,
    }),
    [
      draggingPreset,
      target,
      applyStatus,
      undo,
      undoNow,
      dismissUndo,
    ],
  );

  const sourceValue = useMemo<DragSourceValue>(
    () => ({
      beginDrag,
      draggingPresetId: draggingPreset?.id ?? null,
    }),
    [beginDrag, draggingPreset],
  );

  return (
    <DndContext.Provider value={value}>
      <DragSourceContext.Provider value={sourceValue}>
        <DragGhostContext.Provider value={ghost}>
          {children}
        </DragGhostContext.Provider>
      </DragSourceContext.Provider>
    </DndContext.Provider>
  );
}
