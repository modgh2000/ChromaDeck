import { createPortal } from "react-dom";
import { Undo2, X } from "lucide-react";
import { useDragAndDrop } from "./DragAndDropContext";
import { useI18n } from "../lib/i18n";

/**
 * Undo toast — shown after a drag-apply (single or all monitors). Dismisses
 * on click anywhere in the toast, via the close button, or after 5s (the
 * provider owns the timeout). Undo restores the previous apply.
 */
export default function UndoToast() {
  const { t } = useI18n();
  const { undo, undoNow, dismissUndo } = useDragAndDrop();
  if (!undo || typeof document === "undefined") return null;

  const targetDisplay =
    undo.count > 1 ? t.undoMonitorsCount(undo.count) : undo.targetLabel;

  return createPortal(
    <div
      role="status"
      aria-live="polite"
      data-slot="undo-toast"
      onClick={dismissUndo}
      className="undo-toast-enter fixed bottom-[72px] left-1/2 z-[90] flex -translate-x-1/2 cursor-pointer items-center gap-3 rounded-[8px] border border-border bg-surface-raised px-3 py-2 shadow-[0_12px_32px_rgba(0,0,0,0.5)]"
    >
      <span className="mono max-w-[320px] truncate text-[10px] text-foreground">
        {t.undoAppliedTo(undo.presetName, targetDisplay)}
      </span>
      <span className="h-4 w-px shrink-0 bg-border" aria-hidden="true" />
      <button
        type="button"
        data-slot="button"
        onClick={(e) => {
          e.stopPropagation();
          void undoNow();
        }}
        className="inline-flex shrink-0 items-center gap-1.5 rounded-[8px] border border-primary-border bg-primary-subtle px-2 py-1 font-mono text-[10px] text-primary transition-colors hover:border-primary"
      >
        <Undo2 className="size-3 stroke-[1.5]" />
        <span>{t.undoButton}</span>
      </button>
      <button
        type="button"
        aria-label={t.dismissUndoAria}
        onClick={(e) => {
          e.stopPropagation();
          dismissUndo();
        }}
        className="inline-flex size-[20px] shrink-0 items-center justify-center rounded-[8px] text-muted-foreground transition-colors hover:bg-surface-hover hover:text-foreground"
      >
        <X className="size-3 stroke-[1.5]" />
      </button>
    </div>,
    document.body,
  );
}
