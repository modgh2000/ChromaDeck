import { useState, useRef, useEffect } from "react";
import type { Monitor, Preset } from "../lib/types";
import { deletePreset, createPreset, unpinMonitor } from "../lib/tauri";
import { splitCategory } from "../lib/presetCard";
import { useI18n } from "../lib/i18n";
import { Copy, Pencil, PinOff, Trash2 } from "lucide-react";
import { ArrowRightGlyph } from "@/components/ui/icons";
import { PresetTag } from "@/components/ui/preset-tag";
import DeletePresetDialog from "./DeletePresetDialog";
import { useDragSource } from "./DragAndDropContext";
import { cn } from "cn";

/** Pointer travel (px) before a press becomes a drag rather than a click. */
const DRAG_THRESHOLD_PX = 6;
/** Window after a drop during which the trailing click is swallowed. */
const CLICK_SUPPRESS_MS = 400;

/** Tiny icon button in the card action strip. Muted, brightens on hover.
 *  The visible box stays 22px; `after:-inset-1` expands the pointer target
 *  to 30px without affecting layout. */
const iconStripButton =
  "relative inline-flex size-[22px] shrink-0 items-center justify-center rounded-[8px] text-muted-foreground transition-colors after:absolute after:-inset-1 after:content-[''] hover:bg-surface-hover hover:text-foreground focus-visible:bg-surface-hover focus-visible:text-foreground focus-visible:outline-none";

interface Props {
  preset: Preset;
  monitors: Monitor[];
  pins: Record<string, string>;
  onEdit: (preset: Preset) => void;
  onRefreshParent: () => void;
  onPinChange: () => void;
  onApply: (preset: Preset) => void;
  appliedMap: Record<string, string>;
  staggerEnter?: boolean;
  staggerMs?: number;
  onDuplicated?: (preset: Preset) => void;
  highlightEnter?: boolean;
  onDeleted?: (id: string) => void;
  className?: string;
}

export default function PresetCard({
  preset,
  monitors,
  pins,
  onEdit,
  onRefreshParent,
  onPinChange,
  onApply,
  appliedMap,
  staggerEnter,
  staggerMs,
  onDuplicated,
  highlightEnter,
  onDeleted,
  className,
}: Props) {
  const { t } = useI18n();
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [singleExploding, setSingleExploding] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const actionErrorTimer = useRef<number | null>(null);

  /** Show a transient card-level failure; replaces the summary row for 4s. */
  const showActionError = (message: string) => {
    if (actionErrorTimer.current !== null) {
      window.clearTimeout(actionErrorTimer.current);
    }
    setActionError(message);
    actionErrorTimer.current = window.setTimeout(() => {
      actionErrorTimer.current = null;
      setActionError(null);
    }, 4000);
  };

  useEffect(
    () => () => {
      if (actionErrorTimer.current !== null) {
        window.clearTimeout(actionErrorTimer.current);
      }
    },
    [],
  );

  // —— Pointer drag (HTML5 drag is swallowed by Tauri's file-drop handler) ——
  const { beginDrag, draggingPresetId } = useDragSource();
  const isDragSource = draggingPresetId === preset.id;
  const pendingDrag = useRef<{
    pointerId: number;
    x: number;
    y: number;
    rect: DOMRect;
  } | null>(null);
  const detachPending = useRef<(() => void) | null>(null);
  const draggedRecently = useRef(false);
  const prevDragSource = useRef(false);
  const clickSuppressTimer = useRef<number | null>(null);

  useEffect(
    () => () => {
      detachPending.current?.();
      if (clickSuppressTimer.current !== null) {
        window.clearTimeout(clickSuppressTimer.current);
      }
    },
    [],
  );

  // Swallow the click that lands immediately after the drag ends. The flag
  // must persist for the WHOLE drag (which can last seconds), so the timer
  // starts on drag end - not on drag start.
  useEffect(() => {
    if (isDragSource) {
      draggedRecently.current = true;
      prevDragSource.current = true;
    } else if (prevDragSource.current) {
      prevDragSource.current = false;
      if (clickSuppressTimer.current !== null) {
        window.clearTimeout(clickSuppressTimer.current);
      }
      clickSuppressTimer.current = window.setTimeout(() => {
        draggedRecently.current = false;
        clickSuppressTimer.current = null;
      }, CLICK_SUPPRESS_MS);
    }
  }, [isDragSource]);

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    // A card mid-delete is a dead target - no drag.
    if (singleExploding) return;
    if (e.button !== 0 || e.pointerType === "touch") return;
    // Interactive children (Apply, Edit, Duplicate, Delete, title) keep
    // their own pointer semantics - never hijack them into a drag.
    const origin = e.target as HTMLElement;
    if (origin.closest("button, a, input, [data-no-drag]")) return;

    detachPending.current?.();
    const start = {
      pointerId: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      rect: e.currentTarget.getBoundingClientRect(),
    };

    const cleanup = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      pendingDrag.current = null;
      detachPending.current = null;
    };

    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== start.pointerId || !pendingDrag.current) return;
      if (
        Math.hypot(ev.clientX - start.x, ev.clientY - start.y) <
        DRAG_THRESHOLD_PX
      ) {
        return;
      }
      const drag = pendingDrag.current;
      cleanup();
      if (!drag) return;
      // The drop's trailing click must not also open the apply dialog.
      // Cleared when the drag ends + a short grace window (see effect).
      draggedRecently.current = true;
      beginDrag(preset, drag.rect, { x: ev.clientX, y: ev.clientY });
    };

    const onUp = () => cleanup();

    pendingDrag.current = start;
    detachPending.current = cleanup;
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  const handleDuplicate = async () => {
    try {
      const created = await createPreset({
        name: `${preset.name} ${t.copySuffix}`,
        brightness: preset.brightness,
        contrast: preset.contrast,
        rgb_gains: preset.rgb_gains,
        gamma: preset.gamma,
        vibrance: preset.vibrance,
        saturation: preset.saturation,
        hue_deg: preset.hue_deg,
        color_tag: preset.color_tag,
        tag_shape: preset.tag_shape ?? undefined,
      });
      if (onDuplicated) onDuplicated(created);
      else onRefreshParent();
    } catch (err) {
      showActionError(t.duplicateFailed(String(err)));
    }
  };

  const handleDelete = async (): Promise<boolean> => {
    setDeleting(true);
    setDeleteError(null);
    setSingleExploding(true);
    try {
      await new Promise<void>((resolve) => {
        window.setTimeout(resolve, 300);
      });
      await deletePreset(preset.id);
      if (onDeleted) onDeleted(preset.id);
      else onRefreshParent();
      return true;
    } catch (err) {
      // Keep the dialog open and surface the failure; stop the explosion.
      setSingleExploding(false);
      setDeleteError(t.deleteFailed(String(err)));
      showActionError(t.deleteFailed(String(err)));
      return false;
    } finally {
      setDeleting(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    // Only the card shell itself applies; interactive children handle their own keys.
    if (e.target !== e.currentTarget) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onApply(preset);
    }
  };

  // Find ALL monitors that have this preset pinned
  const pinnedEdidList = Object.entries(pins)
    .filter(([, pid]) => pid === preset.id)
    .map(([edid]) => edid);
  const isPinned = pinnedEdidList.length > 0;
  const isConnected = (edid: string) =>
    monitors.find((m) => m.edid_id === edid)?.connected ?? false;
  const isActive =
    pinnedEdidList.some(isConnected) ||
    Object.entries(appliedMap).some(
      ([edid, pid]) => pid === preset.id && isConnected(edid),
    );
  const pinnedMonitorNames = pinnedEdidList.map((edid) => {
    const m = monitors.find((m) => m.edid_id === edid);
    return m?.alias || m?.model || edid.slice(0, 12);
  });

  // Flat color tag dot. Format-guarded: a hand-edited presets.json could hold
  // a non-hex string, which must never reach CSS.
  const tag = /^#[0-9a-fA-F]{6}$/.test(preset.color_tag ?? "")
    ? (preset.color_tag as string)
    : null;

  // Category split on first " - "
  const { category, title } = splitCategory(preset.name);

  // Title is a fixed 32px for every card; overflow is handled by
  // truncation + hover marquee + full-name tooltip, never by resizing.
  const titleSize = "32px";
  const titleTextClass = "text-foreground font-display font-semibold";
  const titleTextStyle = {
    fontSize: titleSize,
    lineHeight: "1",
    letterSpacing: "-1.28px",
  } as Record<string, string>;

  // Marquee only when the title actually overflows: measure full text
  // against the title row width (re-checked on resize + title change).
  const titleRef = useRef<HTMLSpanElement>(null);
  const titleMeasureRef = useRef<HTMLSpanElement>(null);
  const [titleOverflows, setTitleOverflows] = useState(false);

  useEffect(() => {
    const el = titleRef.current;
    const measure = titleMeasureRef.current;
    if (!el || !measure) {
      setTitleOverflows(false);
      return;
    }
    const check = () => setTitleOverflows(measure.scrollWidth > el.clientWidth + 1);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [title, titleSize]);

  const summary = `γ ${preset.gamma.toFixed(2)} · B ${preset.brightness.toFixed(0)} · C ${preset.contrast.toFixed(0)} · V ${preset.vibrance.toFixed(0)} · S ${preset.saturation.toFixed(0)}`;

  return (
    <div
      className={cn(
        staggerEnter ? "enter-stagger" : "",
        className,
      )}
      style={
        {
          ...(tag ? { "--tag": tag } : {}),
          ...(staggerEnter && staggerMs !== undefined
            ? { "--stagger-ms": `${staggerMs}ms` }
            : {}),
        } as Record<string, string>
      }
    >
      {/* —— Card shell: flat 8px surface, hairline outer + inner ———————— */}
      <div
        data-slot="card"
        className={cn(
          "card-ring",
          "group/card flex w-full flex-col h-full rounded-[8px] border border-border bg-surface p-2 outline-none",
          "focus-visible:ring-[3px] focus-visible:ring-ring",
          // Drag source placeholder: stays in place, dimmed and lifted, while
          // the portal ghost follows the pointer. `drag-placeholder` opts the
          // card out of the scroll-driven transform/opacity animation so the
          // placeholder state is not overridden by its fill-mode.
          isDragSource
            ? "drag-placeholder cursor-grabbing scale-[0.97] -translate-y-1 opacity-40 transition-[opacity,scale,translate] duration-[var(--motion-fast)]"
            : "cursor-pointer",
          isActive && !tag ? "border-primary" : "",
          highlightEnter ? "pop-in" : "",
          singleExploding ? "card-explode" : "",
        )}
        style={{
          viewTransitionName: `preset-card-${preset.id}`,
          ...(isActive && tag ? { borderColor: tag } : {}),
        }}
        role="group"
        aria-label={preset.name}
        tabIndex={0}
        onPointerDown={handlePointerDown}
        onDragStart={(e) => e.preventDefault()}
        onClick={() => {
          // A completed drag must not also fire the card's apply action.
          if (draggedRecently.current) {
            draggedRecently.current = false;
            return;
          }
          onApply(preset);
        }}
        onKeyDown={handleKeyDown}
      >
        <div className="flex min-h-0 flex-1 flex-col gap-3 rounded-[8px] border border-border-hover bg-surface p-4">
          {/* —— Row 1: Badges ———————————————————————————————————— */}
          <div className="flex h-6 items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2 overflow-hidden">
              <PresetTag color={tag ?? undefined} shape={preset.tag_shape} />
              {category && (
                <span className="min-w-0 truncate rounded-[8px] border border-border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.1em] text-muted-foreground">
                  {category}
                </span>
              )}
              {preset.icc_hash && (
                <span className="pop-in inline-flex shrink-0 items-center whitespace-nowrap rounded-[8px] border border-border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.1em] text-muted-foreground">
                  ICC
                </span>
              )}
            </div>
            {isActive && (
              <span
                className="pop-in inline-flex shrink-0 items-center whitespace-nowrap rounded-[8px] border border-primary bg-primary-subtle px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.1em] text-primary"
                title={t.inUseTooltip}
              >
                {t.inUseBadge}
              </span>
            )}
          </div>

          {/* —— Row 2: Title (non-interactive – the shell and Apply own the action) —— */}
          <span
            ref={titleRef}
            className="preset-title relative flex w-full items-center text-left transition-opacity hover:opacity-85"
          >
            {/* Invisible full-text measurer for overflow detection */}
            <span
              ref={titleMeasureRef}
              aria-hidden="true"
              className={`absolute invisible whitespace-nowrap ${titleTextClass}`}
              style={titleTextStyle}
            >
              {title}
            </span>
            {titleOverflows ? (
              <span className="block w-full overflow-hidden whitespace-nowrap" title={preset.name}>
                <span className="marquee-track">
                  <span className={`pr-10 ${titleTextClass}`} style={titleTextStyle}>
                    {title}
                  </span>
                  <span className={`pr-10 ${titleTextClass}`} style={titleTextStyle} aria-hidden="true">
                    {title}
                  </span>
                </span>
              </span>
            ) : (
              <span
                className={`truncate ${titleTextClass}`}
                style={titleTextStyle}
                title={preset.name}
              >
                {title}
              </span>
            )}
          </span>

          {/* —— Row 3: Mono summary – always visible; failures replace it —— */}
          {actionError ? (
            <div role="alert" className="flex h-3 items-center overflow-hidden">
              <span className="truncate font-mono text-[9px] leading-[1.3] text-destructive">
                {actionError}
              </span>
            </div>
          ) : (
            <div className="flex h-3 items-center justify-between gap-2 overflow-hidden">
              <span className="truncate font-mono text-[9px] leading-[1.3] text-muted-foreground">
                {summary}
              </span>
              {isPinned && pinnedMonitorNames.length > 0 && (
                <span
                  className="truncate font-mono text-[9px] leading-[1.3] text-muted-foreground"
                  title={t.pinnedToTooltip(pinnedMonitorNames.join(", "))}
                >
                  → {pinnedMonitorNames.join(", ")}
                </span>
              )}
            </div>
          )}

          {/* —— Row 4: Action strip – reduced emphasis until hover/focus —— */}
          <div className="mt-auto flex h-[22px] items-center justify-between gap-2">
            <button
              type="button"
              className="inline-flex h-[22px] items-center gap-1.5 rounded-[8px] border border-border bg-transparent px-2 font-mono text-[10px] text-foreground opacity-60 transition-opacity hover:bg-surface-hover focus-visible:opacity-100 group-hover/card:opacity-100 group-focus-within/card:opacity-100"
              onClick={(e) => {
                e.stopPropagation();
                onApply(preset);
              }}
              onKeyDown={(e) => e.stopPropagation()}
              title={t.applyPresetTitle(preset.name)}
              aria-label={t.applyPresetAria(preset.name)}
            >
              {t.applyButton}
              <ArrowRightGlyph className="size-3" />
            </button>

            <div className="flex shrink-0 items-center gap-1 opacity-60 transition-opacity focus-within:opacity-100 group-hover/card:opacity-100 group-focus-within/card:opacity-100">
              {isPinned && (
                <button
                  type="button"
                  className={cn(iconStripButton, "pop-in")}
                  onClick={(e) => {
                    e.stopPropagation();
                    void (async () => {
                      try {
                        for (const edid of pinnedEdidList) {
                          await unpinMonitor(edid);
                        }
                        onPinChange();
                      } catch (err) {
                        showActionError(t.unpinFailed(String(err)));
                      }
                    })();
                  }}
                  onKeyDown={(e) => e.stopPropagation()}
                  title={t.unpinAllTitle}
                  aria-label={t.unpinAllAria(preset.name)}
                >
                  <PinOff className="size-[13px] stroke-[1.5]" />
                </button>
              )}

              <button
                type="button"
                className={iconStripButton}
                onClick={(e) => {
                  e.stopPropagation();
                  onEdit(preset);
                }}
                onKeyDown={(e) => e.stopPropagation()}
                title={t.editTitle}
                aria-label={t.editPresetAria(preset.name)}
              >
                <Pencil className="size-[13px] stroke-[1.5]" />
              </button>

              <button
                type="button"
                className={iconStripButton}
                onClick={(e) => {
                  e.stopPropagation();
                  void handleDuplicate();
                }}
                onKeyDown={(e) => e.stopPropagation()}
                title={t.duplicateTitle}
                aria-label={t.duplicatePresetAria(preset.name)}
              >
                <Copy className="size-[13px] stroke-[1.5]" />
              </button>

              <button
                type="button"
                className={cn(iconStripButton, "hover:bg-destructive/10 hover:text-destructive")}
                onClick={(e) => {
                  e.stopPropagation();
                  setDeleteError(null);
                  setShowDeleteModal(true);
                }}
                onKeyDown={(e) => e.stopPropagation()}
                title={t.deleteTitle}
                aria-label={t.deletePresetAria(preset.name)}
              >
                <Trash2 className="size-[13px] stroke-[1.5]" />
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* —— Delete confirmation dialog ———————————————————————————— */}
      {showDeleteModal && (
        <DeletePresetDialog
          preset={preset}
          // Request intent only – the dialog animates out, then reports back
          // through onClosed so the parent can unmount it.
          onClose={() => {}}
          onClosed={() => setShowDeleteModal(false)}
          onConfirm={() => handleDelete()}
          pinnedTo={pinnedMonitorNames.join(", ") || undefined}
          inUse={isActive}
          deleting={deleting}
          error={deleteError ?? undefined}
        />
      )}
    </div>
  );
}
