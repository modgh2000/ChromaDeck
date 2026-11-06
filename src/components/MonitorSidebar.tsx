import { useEffect, useRef, useState } from "react";
import type { Monitor, Preset } from "../lib/types";
import { identifyMonitors, resetMonitor, setMonitorName, unpinMonitor, probeMonitor } from "../lib/tauri";
import { splitCategory } from "../lib/presetCard";
import { useI18n } from "../lib/i18n";
import { PresetTag } from "@/components/ui/preset-tag";
import { Input } from "@/components/ui/input";
import { IdentifyGlyph, MonitorGlyph, ProbeGlyph, ResetGlyph } from "@/components/ui/icons";
import { Check, ChevronDown, Pencil, PinOff } from "lucide-react";
import { useDragAndDrop, useDragSource } from "./DragAndDropContext";
import { cn } from "cn";

/** One utility action in a monitor card (Figma: icon 13 + mono 10 label). */
function UtilityButton({
  label,
  title,
  onClick,
  disabled,
  icon,
}: {
  label: string;
  title: string;
  onClick: () => void;
  disabled?: boolean;
  icon: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(
        "group/util-icon inline-flex shrink-0 items-center gap-[6px] rounded-[8px] px-1 py-0.5 text-muted-foreground transition-colors hover:text-foreground focus-visible:text-foreground focus-visible:outline-none disabled:pointer-events-none",
        disabled && "disabled:opacity-50 disabled:pointer-events-none",
      )}
    >
      <span className="shrink-0 transition-transform duration-[var(--motion-fast)] ease-[var(--ease-standard)] group-hover/util-icon:scale-[1.05]">{icon}</span>
      <span className="font-mono text-[10px] leading-[1.4] whitespace-nowrap">{label}</span>
    </button>
  );
}

/** Compact inline monitor rename – revealed on card hover so the default
 *  identity row matches Figma exactly while renaming stays available. */
function MonitorNameEditor({ monitor, onRefreshParent }: { monitor: Monitor; onRefreshParent: () => void }) {
  const { t } = useI18n();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(monitor.alias);
  const [saving, setSaving] = useState(false);
  const displayName = monitor.alias || monitor.model || monitor.device_name || monitor.edid_id.slice(0, 16);

  const save = async () => {
    setSaving(true);
    try {
      await setMonitorName(monitor.edid_id, draft);
      setEditing(false);
      onRefreshParent();
    } finally {
      setSaving(false);
    }
  };

  if (editing) {
    return (
      <span className="flex min-w-0 items-center gap-1.5">
        <Input
          type="text"
          value={draft}
          autoFocus
          maxLength={64}
          placeholder={monitor.model}
          aria-label={t.monitorNameAria}
          onChange={(e) => setDraft((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void save();
            else if (e.key === "Escape") setEditing(false);
          }}
          disabled={saving}
          className="h-6 min-w-0 flex-1 rounded-[4px] px-1.5 text-[13px]"
        />
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving}
          className="shrink-0 font-mono text-[10px] text-primary hover:opacity-80"
        >
          {saving ? "..." : t.save}
        </button>
        <button
          type="button"
          onClick={() => setEditing(false)}
          disabled={saving}
          className="shrink-0 font-mono text-[10px] text-muted-foreground hover:text-foreground"
        >
          {t.cancel}
        </button>
      </span>
    );
  }

  return (
    <span className="inline-flex min-w-0 items-center gap-1">
      <span
        className={cn(
          "truncate font-display text-[15px] leading-none",
          monitor.connected ? "text-foreground" : "text-muted-foreground",
        )}
      >
        {displayName}
      </span>
      <button
        type="button"
        onClick={() => {
          setDraft(monitor.alias);
          setEditing(true);
        }}
        title={t.renameMonitor}
        aria-label={t.renameMonitorAria(displayName)}
        className="shrink-0 rounded-[4px] p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover/pad:opacity-100"
      >
        <Pencil className="size-3" strokeWidth={1.5} />
      </button>
    </span>
  );
}

/** Monitor reset action: restore identity colours, then drop the pin. */
function MonitorResetButton({ edidId, onPinChange, setAppliedMap }: { edidId: string; onPinChange: () => void; setAppliedMap: React.Dispatch<React.SetStateAction<Record<string, string>>> }) {
  const { t } = useI18n();
  const [resetting, setResetting] = useState(false);
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null);

  const handleReset = async () => {
    setResetting(true);
    setMessage(null);
    try {
      try {
        const result = await resetMonitor(edidId);
        if (result.error) {
          // Keep the pin: a failed restore (e.g. Intel with no captured LUT)
          // must not silently drop the user's enforcement intent.
          setMessage({ text: t.resetFailed(result.error), ok: false });
          setTimeout(() => setMessage(null), 6000);
        } else {
          // Unpin only after the restore actually succeeded.
          try {
            await unpinMonitor(edidId);
          } catch {
            // best-effort: the reset itself already succeeded
          }
          // Clear the applied map entry so the UI no longer shows the preset as applied/in-use.
          setAppliedMap((prev) => {
            const next = { ...prev };
            delete next[edidId];
            return next;
          });
          setMessage({ text: t.resetToDefault, ok: true });
          setTimeout(() => setMessage(null), 3000);
        }
      } catch (err) {
        setMessage({ text: t.resetFailed(String(err)), ok: false });
        setTimeout(() => setMessage(null), 6000);
      }
    } finally {
      onPinChange();
      setResetting(false);
    }
  };

  return (
    <span className="inline-flex min-w-0 items-center gap-2">
      <UtilityButton
        label={resetting ? "..." : t.reset}
        title={t.resetTooltip}
        onClick={() => void handleReset()}
        disabled={resetting}
        icon={<ResetGlyph className="size-[13px]" />}
      />
      {message && (
        <span
          key={message.text}
          aria-live="polite"
          title={message.text}
          className={cn(
            "transient-enter max-w-[110px] truncate font-mono text-[9px]",
            message.ok ? "text-foreground" : "text-destructive",
          )}
        >
          {message.text}
        </span>
      )}
    </span>
  );
}

/** Monitor hardware probe: read live state, change nothing. */
function MonitorProbeButton({ edidId }: { edidId: string }) {
  const { t } = useI18n();
  const [probing, setProbing] = useState(false);
  const [report, setReport] = useState<string | null>(null);

  const handleProbe = async () => {
    setProbing(true);
    setReport(null);
    try {
      const p = await probeMonitor(edidId);
      const vib =
        p.vibrance_supported && p.vibrance !== null && p.vibrance !== undefined
          ? `vib ${p.vibrance} hue ${p.hue ?? "?"}`
          : "vib n/a";
      // Intel's colour lives in the pixtx LUT, not the OS ramp.
      const rampLabel = p.backend_id === "intel" ? "lut" : "ramp";
      const ramp =
        p.ramp_peak !== null && p.ramp_peak !== undefined
          ? `${rampLabel} ${p.ramp_peak.toFixed(2)}${p.ramp_identity ? "" : " !"}`
          : `${rampLabel} n/a`;
      setReport(`${p.backend_id ?? p.engine} · ${vib} · ${ramp}`);
      setTimeout(() => setReport(null), 8000);
    } catch (err) {
      setReport(t.probeFailed(String(err)));
      setTimeout(() => setReport(null), 6000);
    } finally {
      setProbing(false);
    }
  };

  return (
    <span className="inline-flex min-w-0 items-center gap-2">
      <UtilityButton
        label={probing ? "..." : t.probe}
        title={t.probeTooltip}
        onClick={() => void handleProbe()}
        disabled={probing}
        icon={<ProbeGlyph className="size-[13px]" />}
      />
      {report && (
        <span
          key={report}
          aria-live="polite"
          title={report}
          className="max-w-[120px] truncate font-mono text-[9px] text-muted-foreground"
        >
          {report}
        </span>
      )}
    </span>
  );
}

/** Monitor card – flat dark surface, 1px outer/inner hairlines. */
function MonitorCard({ monitor, pinnedPreset, appliedMap, setAppliedMap, pins, presets, onRefresh, onPinChange, index, compact }: {
  monitor: Monitor;
  pinnedPreset: Preset | null;
  appliedMap: Record<string, string>;
  setAppliedMap: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  pins: Record<string, string>;
  presets: Preset[];
  onRefresh: () => void;
  onPinChange: () => void;
  index: number;
  /** Denser treatment used when the sidebar holds many monitors. */
  compact?: boolean;
}) {
  const { t } = useI18n();
  const { target, isDragging, draggingPreset, applyStatus } = useDragAndDrop();
  // Applied presets leave the library, so the monitor slot doubles as a drag
  // source: drag a preset from one display to another to copy it.
  const { beginDrag, draggingPresetId } = useDragSource();
  const [dragOrigin, setDragOrigin] = useState(false);
  const pendingDrag = useRef<{ pointerId: number; x: number; y: number; rect: DOMRect } | null>(null);
  const detachPending = useRef<(() => void) | null>(null);

  useEffect(() => () => detachPending.current?.(), []);
  // Clear the dimmed source state once the drag lifecycle finishes.
  useEffect(() => {
    if (draggingPresetId === null) setDragOrigin(false);
  }, [draggingPresetId]);
  // Bumped on every transition into "applied" so the sweep span remounts and
  // replays its one-shot animation (the status object carries no timestamp).
  const [sweepKey, setSweepKey] = useState(0);

  const isPinned = !!pinnedPreset;
  const connected = monitor.connected;

  const appliedPresetId = appliedMap[monitor.edid_id];
  const appliedPreset = appliedPresetId
    ? presets.find((p) => p.id === appliedPresetId) ?? null
    : null;
  // A drop applies without pinning, so the assignment line reflects the
  // last applied preset and falls back to the pinned one.
  const slotPreset = appliedPreset ?? pinnedPreset;
  const status = applyStatus[monitor.edid_id];
  const statusPhase = status?.phase;

  // Each transition into "applied" replays the slot sweep.
  useEffect(() => {
    if (statusPhase === "applied") setSweepKey((key) => key + 1);
  }, [statusPhase]);

  const slotTitle = slotPreset
    ? splitCategory(slotPreset.name)
    : status
      ? splitCategory(status.presetName)
      : null;
  const tag = /^#[0-9a-fA-F]{6}$/.test(slotPreset?.color_tag ?? "")
    ? (slotPreset?.color_tag as string)
    : null;

  /* —— Drop states ————————————————————————————————————————————— */
  const isDropHover =
    target?.kind === "monitor" && target.edid === monitor.edid_id;
  const isOfflineHover = isDropHover && !connected;
  const samePresetApplied =
    isDragging &&
    draggingPreset !== null &&
    appliedMap[monitor.edid_id] === draggingPreset.id;
  const showValidDrop =
    isDropHover && connected && !samePresetApplied;

  /** Press-and-drag from the filled slot copies this display's preset to
   *  another monitor. Applied presets no longer exist in the library, so this
   *  is how they get reused without duplicating them first. */
  const handleSlotPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!slotPreset || !connected || isDragging) return;
    if (status?.phase === "applying") return;
    if (e.button !== 0 || e.pointerType === "touch") return;
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
      if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 6) return;
      cleanup();
      setDragOrigin(true);
      beginDrag(slotPreset, start.rect, { x: ev.clientX, y: ev.clientY });
    };

    const onUp = () => cleanup();

    pendingDrag.current = start;
    detachPending.current = cleanup;
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  // While a drag hovers this monitor the drop feedback adopts the dragged
  // preset's tag colour; otherwise the slot's own preset tag applies.
  const draggedTag = /^#[0-9a-fA-F]{6}$/.test(draggingPreset?.color_tag ?? "")
    ? (draggingPreset?.color_tag as string)
    : null;
  const dropTag = isDropHover && draggedTag ? draggedTag : tag;

  const showAppliedBadge =
    isPinned || (connected && appliedPreset !== null);

  // Single status chip replaces the old dot + APPLIED/DEFAULT/OFFLINE badge:
  // assigned monitors show the preset's category on a tag-tinted pill, so the
  // colour carries preset identity while the text keeps it colour-blind safe.
  const chipLabel = showAppliedBadge
    ? slotTitle?.category || slotTitle?.title || t.chipAssigned
    : connected
      ? t.chipDefault
      : t.chipOffline;

  return (
    <div
      data-drop-monitor={monitor.edid_id}
      data-drop-enabled={connected ? "true" : "false"}
      className={cn(
        "group/pad monitor-card-enter relative shrink-0 rounded-[8px] border bg-surface p-2 transition-[scale,border-color] duration-[var(--motion-fast)]",
        compact ? "h-[146px]" : "h-[160px]",
        isPinned && !tag ? "border-primary" : "border-border",
        // Standalone `scale` (not transform) so the entrance animation keeps
        // ownership of `transform`.
        showValidDrop && "monitor-drop-target scale-[1.01]",
        isDropHover && connected && samePresetApplied &&
          "cursor-default border-border-hover",
        isOfflineHover && "cursor-not-allowed border-destructive drop-shake",
      )}
      style={
        {
          "--stagger-ms": `${Math.min(index * 60, 180)}ms`,
          // Let .monitor-drop-target own the border while a drag is hovering.
          ...(isPinned && tag && !isDropHover ? { borderColor: tag } : {}),
          ...(dropTag ? { "--tag": dropTag } : {}),
        } as Record<string, string>
      }
    >
      <div
        className={cn(
          "flex h-full min-h-0 flex-col overflow-hidden rounded-[8px] border border-border-hover bg-surface hover:bg-surface-hover",
          compact ? "p-3" : "p-4",
        )}
      >
        {/* Identity */}
        <div className="flex min-w-0 items-center gap-2">
          <MonitorGlyph
            className={cn(
              "shrink-0",
              connected ? "text-primary" : "text-subtle-fg",
            )}
          />
          <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
            <MonitorNameEditor monitor={monitor} onRefreshParent={onRefresh} />
            <span className="truncate font-mono text-[9px] leading-[1.4] text-muted-foreground">
              {monitor.serial || monitor.edid_id}
            </span>
          </div>
          <span
            className={cn(
              "inline-flex w-fit max-w-[104px] shrink-0 items-center justify-center overflow-hidden rounded-full border px-2 py-[3px] font-mono text-[9px] leading-[1.4] uppercase tracking-normal whitespace-nowrap transition-colors",
              showAppliedBadge
                ? tag
                  ? ""
                  : "border-primary bg-primary-subtle text-primary"
                : "border-border bg-transparent text-muted-foreground",
              showAppliedBadge && !connected && "opacity-60",
            )}
            style={
              showAppliedBadge && tag
                ? {
                    backgroundColor: `color-mix(in srgb, ${tag} 18%, transparent)`,
                    borderColor: tag,
                    color: tag,
                  }
                : undefined
            }
            title={
              showAppliedBadge && slotPreset
                ? `${slotPreset.name}${connected ? "" : t.slotOfflineSuffix}`
                : connected
                  ? t.slotDefaultTooltip
                  : t.slotDisconnectedTooltip
            }
          >
            <span className="truncate">{chipLabel}</span>
          </span>
        </div>

        {/* Slot: apply-in-progress / applied summary / drop prompt.
            When filled it is also a drag source for copying to another display. */}
        <div
          className={cn(
            "flex min-h-0 flex-1 flex-col justify-center rounded-[8px] p-2 transition-colors relative overflow-hidden",
            compact ? "mt-2" : "mt-3",
            slotPreset
              ? "border border-border bg-surface"
              : "border border-dashed border-border bg-transparent",
            slotPreset && connected && "cursor-grab active:cursor-grabbing",
            dragOrigin && "opacity-40",
            showValidDrop && "monitor-drop-target",
            isOfflineHover && "border-destructive",
          )}
          style={
            slotPreset && tag
              ? { backgroundColor: `color-mix(in srgb, ${tag} 8%, var(--color-surface))` }
              : undefined
          }
          onPointerDown={slotPreset && connected ? handleSlotPointerDown : undefined}
          title={
            slotPreset && connected
              ? t.slotDragCopyTooltip(slotPreset.name)
              : undefined
          }
        >
          {status?.phase === "applying" ? (
            <span className="flex min-w-0 items-center gap-2">
              <span
                aria-hidden="true"
                className="inline-block size-3 shrink-0 animate-spin rounded-full border border-primary-border border-t-primary"
              />
              <span className="truncate font-mono text-[9px] leading-[1.3] text-primary">
                {t.slotApplying(status.presetName)}
              </span>
            </span>
          ) : status?.phase === "error" ? (
            <span className="flex min-w-0 flex-col gap-0.5" title={status.error}>
              <span className="validation-slide truncate font-mono text-[9px] leading-[1.3] text-destructive">
                {t.slotApplyFailed}
              </span>
              <span className="truncate font-mono text-[9px] leading-[1.3] text-destructive/80">
                {status.error}
              </span>
            </span>
          ) : slotTitle ? (
            <div className="flex min-w-0 items-center gap-2">
              <PresetTag color={tag ?? undefined} shape={slotPreset?.tag_shape} size="md" />
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate font-mono text-[10px] leading-[1.3] text-foreground">
                  {slotTitle.title}
                </span>
                {slotTitle.category && (
                  <span className="truncate font-mono text-[9px] leading-[1.3] text-muted-foreground">
                    {slotTitle.category}
                  </span>
                )}
              </div>
              {status?.phase === "applied" && (
                <span className="pop-in inline-flex shrink-0 items-center gap-1 rounded-full border border-primary bg-primary-subtle px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.1em] text-primary">
                  <Check className="size-2.5 stroke-[2]" />
                  {t.slotApplied}
                </span>
              )}
            </div>
          ) : (
            <span className="truncate font-mono text-[9px] text-muted-foreground">
              {isDragging && connected
                ? t.slotReleaseToApply
                : connected
                  ? t.slotDropPresetHere
                  : t.slotNotConnected}
            </span>
          )}

          {/* Success wash – remounts on every applied transition. */}
          {statusPhase === "applied" && (
            <span key={sweepKey} aria-hidden="true" className="apply-sweep absolute inset-0" />
          )}
        </div>

        {/* Actions */}
        <div className={cn("flex h-[22px] min-w-0 shrink-0 items-center gap-4", compact ? "mt-2" : "mt-3", !connected && "opacity-40 transition-opacity hover:opacity-100")}>
          <MonitorResetButton edidId={monitor.edid_id} onPinChange={onPinChange} setAppliedMap={setAppliedMap} />
          <MonitorProbeButton edidId={monitor.edid_id} />
          {pins[monitor.edid_id] && (
            <button
              type="button"
              title={t.unpinMonitorTooltip}
              aria-label={t.unpinMonitorAria(monitor.alias || monitor.model)}
              onClick={async () => {
                try {
                  await unpinMonitor(monitor.edid_id);
                  onPinChange();
                } catch { /* silent */ }
              }}
              className="inline-flex shrink-0 items-center justify-center rounded-[8px] p-1 text-muted-foreground transition-colors hover:text-foreground focus-visible:text-foreground focus-visible:outline-none"
            >
              <PinOff className="size-[13px] transition-transform duration-[var(--motion-fast)] ease-[var(--ease-standard)] hover:scale-110" strokeWidth={1.5} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export default function MonitorSidebar({ monitors, presets, pins, appliedMap, setAppliedMap, onRefresh, onPinChange }: {
  monitors: Monitor[];
  presets: Preset[];
  pins: Record<string, string>;
  appliedMap: Record<string, string>;
  setAppliedMap: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  onRefresh: () => void;
  onPinChange: () => void;
}) {
  const { t } = useI18n();
  const [identifying, setIdentifying] = useState(false);
  const { isDragging, target } = useDragAndDrop();

  const connectedCount = monitors.filter((m) => m.connected).length;
  // Many monitors: tighten card density instead of switching to a carousel.
  const compact = monitors.length > 4;
  const isAllHover = target?.kind === "all";
  const isPanelHover = target?.kind === "panel";

  const handleIdentify = async () => {
    setIdentifying(true);
    try {
      await identifyMonitors();
    } catch {
      // silent
    } finally {
      setIdentifying(false);
    }
  };

  return (
    <aside
      data-drop-panel="true"
      className="shell-enter relative flex min-h-0 min-w-0 flex-1 flex-col"
      style={{ ["--shell-delay" as string]: "60ms" }}
    >
      {/* Panel heading */}
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-border pb-2">
        <span className="mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
          {t.monitorsHeading(monitors.length)}
        </span>
        <button
          type="button"
          onClick={() => void handleIdentify()}
          disabled={identifying}
          title={t.identifyTooltip}
          className="inline-flex items-center gap-1.5 rounded-[8px] px-1.5 py-1 text-muted-foreground transition-colors hover:text-foreground focus-visible:text-foreground focus-visible:outline-none disabled:opacity-50"
        >
          <IdentifyGlyph className="size-3.5 transition-transform duration-[var(--motion-fast)] ease-[var(--ease-standard)] hover:scale-110" />
          <span className="font-mono text-[10px] leading-[1.4]">
            {identifying ? t.identifying : t.identify}
          </span>
        </button>
      </div>

      {/* —— "All monitors" target – overlays the top of the panel only
          while a drag is in flight, so it never shifts cards under the
          pointer mid-drag. ———————————————————————————————————————— */}
      <div className="relative min-h-0 flex-1">
        {isDragging && (
          <>
            {/* Empty panel space signals "drop here"; releasing applies to all. */}
            <div
              aria-hidden="true"
              className={cn(
                "pointer-events-none absolute inset-0 z-10 rounded-[8px] border border-dashed transition-colors",
                isPanelHover ? "border-primary-border" : "border-border",
              )}
            />
            <div className="pointer-events-none absolute inset-x-0 top-2 z-20 flex justify-center">
              <div
                data-drop-all="true"
                aria-hidden="true"
                className={cn(
                  "pop-in pointer-events-auto flex h-8 select-none items-center justify-center gap-2 rounded-full border px-3 font-mono text-[10px] uppercase tracking-[0.12em] shadow-[0_8px_24px_rgba(0,0,0,0.45)] transition-colors",
                  connectedCount === 0
                    ? "border-border bg-surface text-muted-foreground"
                    : isAllHover
                      ? "border-primary bg-primary-subtle text-primary shadow-[inset_0_0_0_1px_var(--color-primary-border)]"
                      : "border-primary-border bg-surface text-primary",
                )}
              >
                <ChevronDown className="size-3.5 stroke-[1.5]" />
                <span>{t.allMonitors}</span>
                <span className="text-[9px] normal-case tracking-normal text-muted-foreground">
                  {t.connectedCount(connectedCount)}
                </span>
              </div>
            </div>
          </>
        )}
        <div
          data-drag-scroll="true"
          className="h-full min-h-0 overflow-y-auto overflow-x-clip pt-4"
        >
          {monitors.length === 0 ? (
            <div className="rounded-[8px] border border-dashed border-border p-4">
              <span className="font-mono text-[10px] text-muted-foreground">{t.noMonitorsDetected}</span>
            </div>
          ) : (
            <div
              className={cn(
                "grid grid-cols-1 min-[760px]:grid-cols-2 min-[1000px]:grid-cols-3",
                compact ? "gap-3" : "gap-4",
              )}
            >
              {monitors.map((m, index) => {
                const pinnedId = pins[m.edid_id];
                const pinnedPreset = pinnedId ? presets.find((p) => p.id === pinnedId) ?? null : null;
                return (
                  <MonitorCard
                    key={m.edid_id}
                    monitor={m}
                    pinnedPreset={pinnedPreset}
                    appliedMap={appliedMap}
                    setAppliedMap={setAppliedMap}
                    pins={pins}
                    presets={presets}
                    onRefresh={onRefresh}
                    onPinChange={onPinChange}
                    index={index}
                    compact={compact}
                  />
                );
              })}
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}
