import { createPortal } from "react-dom";
import { useDragGhost } from "./DragAndDropContext";
import { splitCategory } from "../lib/presetCard";
import { PresetTag } from "@/components/ui/preset-tag";

/**
 * Portal-rendered drag ghost — a miniature preset card that follows the
 * pointer. It lives on document.body so no overflow container can clip it,
 * and it is `pointer-events-none` so elementFromPoint hit-testing only ever
 * sees the real drop targets underneath.
 */
export default function DragGhost() {
  const ghost = useDragGhost();
  if (!ghost || typeof document === "undefined") return null;

  const { preset, x, y, width } = ghost;
  const { category, title } = splitCategory(preset.name);
  const tag = /^#[0-9a-fA-F]{6}$/.test(preset.color_tag ?? "")
    ? (preset.color_tag as string)
    : null;
  const summary = `γ ${preset.gamma.toFixed(2)} · B ${preset.brightness.toFixed(0)} · C ${preset.contrast.toFixed(0)} · V ${preset.vibrance.toFixed(0)} · S ${preset.saturation.toFixed(0)}`;

  return createPortal(
    <div
      aria-hidden="true"
      data-slot="drag-ghost"
      className="drag-ghost pointer-events-none fixed z-[100] select-none opacity-90"
      style={{ left: x + 14, top: y + 14, width }}
    >
      <div className="flex flex-col gap-2 rounded-[8px] border border-primary-border bg-surface-raised p-2 shadow-[0_16px_40px_rgba(0,0,0,0.55)]">
        <div className="flex flex-col gap-2 rounded-[8px] border border-border-hover bg-surface-raised px-3 py-2.5">
          {/* Row 1: colour tag + category */}
          <div className="flex items-center gap-2">
            <PresetTag color={tag ?? undefined} shape={preset.tag_shape} />
            {category && (
              <span className="min-w-0 truncate rounded-[8px] border border-border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[-0.1em] text-muted-foreground">
                {category}
              </span>
            )}
          </div>

          {/* Row 2: title */}
          <span className="truncate font-display text-[15px] font-semibold leading-none tracking-[-0.4px] text-foreground">
            {title}
          </span>

          {/* Row 3: mono summary */}
          <span className="truncate font-mono text-[9px] leading-[1.3] text-muted-foreground">
            {summary}
          </span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
