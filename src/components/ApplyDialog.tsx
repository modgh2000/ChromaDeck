import { useState, useEffect } from "react";
import type { Monitor, Preset, ApplyResult } from "../lib/types";
import { adjustmentLabel, summarizeApply } from "../lib/applyOutcomes";
import { connectedEdidSignature } from "../lib/connectedSignature";
import { applyPreset, getDisplayCapabilities } from "../lib/tauri";
import { useI18n } from "../lib/i18n";
import { Button } from "@/components/ui/button";
import { Checkbox, CheckboxIndicator } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogFooter, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { RadioGroup, RadioGroupIndicator, RadioGroupItem } from "@/components/ui/radio-group";
import { ArrowRightGlyph } from "@/components/ui/icons";
import { cn } from "cn";

interface Props {
  preset: Preset;
  monitors: Monitor[];
  pins: Record<string, string>;
  initialEdid?: string | null;
  onClose: () => void;
  /** Fired after the close animation finishes; the parent unmounts here. */
  onClosed?: () => void;
  onApplied: (info: { presetId: string; edid: string } | null) => void;
}

// In-session memory: reuse the last-selected target per preset
const lastTargetByPreset = new Map<string, string>();

type BackendState =
  | { status: "loading" }
  | { status: "ready"; label: string; unsupportedKeys: string[] }
  | { status: "error" };

export default function ApplyDialog({ preset, monitors, pins, initialEdid, onClose, onClosed, onApplied }: Props) {
  const { locale, t } = useI18n();
  // The dialog owns `open` so Base UI can run the data-closed exit animation
  // before the parent unmounts it (see onOpenChangeComplete below).
  const [open, setOpen] = useState(true);
  const [selectedEdid, setSelectedEdid] = useState<string>("");
  const [applyAll, setApplyAll] = useState(false);
  const [applying, setApplying] = useState(false);
  const [lastResult, setLastResult] = useState<ApplyResult | null>(null);
  const [backends, setBackends] = useState<Record<string, BackendState>>({});

  // Escape and backdrop dismissal must respect the same in-flight guard as the
  // disabled Cancel button; the success path passes `force` to close itself.
  const requestClose = (force = false) => {
    if (applying && !force) return;
    setOpen(false);
    onClose();
  };

  // Re-probe only when the connected set changes. The 5s monitor poll hands
  // us a new array on every tick (mergeMonitors), so depending on `monitors`
  // reset every badge to "loading" and re-ran every capability call. Keying
  // on a stable signature of connected EDIDs fixes the flicker.
  const connectedKey = connectedEdidSignature(monitors);

  // One capability call per connected display. Failures are contained per
  // row: the dialog still lists and applies to the display as before.
  useEffect(() => {
    let cancelled = false;
    const connected = monitors.filter((m) => m.connected);
    // Preserve already-resolved badges; only seed genuinely new ids.
    setBackends((prev) => {
      const next: Record<string, BackendState> = {};
      for (const m of connected) {
        next[m.edid_id] = prev[m.edid_id] ?? { status: "loading" };
      }
      return next;
    });
    for (const m of connected) {
      if (backends[m.edid_id]?.status === "ready") continue; // already resolved
      getDisplayCapabilities(m.edid_id)
        .then((caps) => {
          if (cancelled) return;
          const unsupportedKeys = caps.adjustments
            .filter((a) => a.status === "unsupported")
            .map((a) => a.adjustment);
          setBackends((prev) => ({
            ...prev,
            [m.edid_id]: { status: "ready", label: caps.backend_label, unsupportedKeys },
          }));
        })
        .catch(() => {
          if (cancelled) return;
          setBackends((prev) => ({ ...prev, [m.edid_id]: { status: "error" } }));
        });
    }
    return () => { cancelled = true; };
    // `monitors` is intentionally not a dependency: the poll replaces the
    // array every tick without changing the connected set.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectedKey]);

  // Initialise target: explicit sidebar choice -> in-session memory -> first connected
  useEffect(() => {
    if (selectedEdid) return;
    const explicitOk = initialEdid
      ? monitors.some((m) => m.edid_id === initialEdid && m.connected)
      : false;
    if (explicitOk && initialEdid) {
      setSelectedEdid(initialEdid);
      return;
    }
    const remembered = lastTargetByPreset.get(preset.id);
    const rememberedOk = remembered
      ? monitors.some((m) => m.edid_id === remembered && m.connected)
      : false;
    const fallback = monitors.find((m) => m.connected);
    const target = rememberedOk && remembered ? remembered : fallback?.edid_id;
    if (target) setSelectedEdid(target);
  }, [monitors, selectedEdid, preset.id, initialEdid]);

  const handleApply = async () => {
    if (applying) return;
    const targets = applyAll
      ? monitors.filter((m) => m.connected)
      : monitors.filter((m) => m.edid_id === selectedEdid && m.connected);
    if (targets.length === 0) return;

    setApplying(true);
    setLastResult(null);

    let firstFailure: ApplyResult | null = null;
    let succeeded = 0;

    for (const target of targets) {
      try {
        const result = await applyPreset(preset.id, target.edid_id);
        if (result.error) {
          if (!firstFailure) firstFailure = result;
        } else {
          succeeded += 1;
        }
      } catch (err) {
        if (!firstFailure) {
          firstFailure = {
            icc_applied: false,
            gamma_applied: false,
            vibrance_applied: false,
            error: String(err),
          };
        }
      }
    }

    setApplying(false);

    if (succeeded === targets.length && targets.length > 0) {
      // Success: remember the target, report, and close.
      lastTargetByPreset.set(preset.id, targets[0].edid_id);
      onApplied({ presetId: preset.id, edid: targets[0].edid_id });
      requestClose(true);
      return;
    }

    // Failure: keep the dialog open with diagnostics.
    setLastResult(firstFailure);
    onApplied(null);
  };

  const summary = lastResult ? summarizeApply(lastResult, locale) : null;
  const selectedBackend = backends[selectedEdid];
  const connectedCount = monitors.filter((m) => m.connected).length;
  const canApply = applyAll ? connectedCount > 0 : Boolean(selectedEdid);

  const statusClass: Record<string, string> = {
    applied: "text-foreground",
    skipped: "text-muted-foreground",
    failed: "text-destructive",
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) requestClose();
      }}
      onOpenChangeComplete={(next) => {
        if (!next) onClosed?.();
      }}
    >
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <span className="mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
            {t.applyPresetHeader}
          </span>
          <DialogTitle className="truncate font-display text-[24px] leading-tight tracking-[-0.48px] text-foreground">
            {preset.name}
          </DialogTitle>
          <DialogDescription className="font-mono text-[12px] leading-snug text-muted-foreground">
            {t.applyPresetDesc}
          </DialogDescription>
        </DialogHeader>

        {/* — Monitor list ———————————————————————————————— */}
        <RadioGroup
          value={selectedEdid}
          onValueChange={(v) => {
            setSelectedEdid(v);
            setLastResult(null);
          }}
          className="flex flex-col gap-2"
        >
          {monitors.length === 0 && (
            <p className="font-mono text-[10px] text-destructive">{t.noMonitorsDetectedPeriod}</p>
          )}
          {monitors.map((m) => {
            const isSelected = m.edid_id === selectedEdid;
            const isPinnedHere = pins[m.edid_id] === preset.id;
            const backend = backends[m.edid_id];
            const statusText = isPinnedHere
              ? t.statusPinned
              : m.connected
                ? t.statusReady
                : t.statusOffline;
            return (
              <label
                key={m.edid_id}
                className={cn(
                  "flex cursor-pointer items-center gap-3 rounded-[8px] border p-3 select-none transition-colors",
                  !m.connected
                    ? "border-border bg-surface text-muted-foreground opacity-60"
                    : isSelected
                    ? "border-primary bg-surface"
                    : "border-border bg-surface hover:bg-surface-hover",
                )}
              >
                <RadioGroupItem
                  value={m.edid_id}
                  disabled={!m.connected}
                  onClick={() => {
                    if (m.connected) setLastResult(null);
                  }}
                >
                  <RadioGroupIndicator />
                </RadioGroupItem>
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate font-mono text-[17px] leading-tight text-foreground">
                    {m.alias || m.model || m.device_name}
                  </span>
                  <span className="truncate font-mono text-[9px] leading-tight text-muted-foreground">
                    {m.serial || m.edid_id}
                  </span>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {m.connected && backend?.status === "ready" && (
                    <span className="mono hidden text-[9px] text-muted-foreground sm:inline" title={t.colourBackendTitle(backend.label)}>
                      {backend.label}
                    </span>
                  )}
                  <span
                    className={cn(
                      "inline-flex shrink-0 items-center rounded-[8px] border px-2 py-[3px] font-mono text-[9px] uppercase tracking-[0.1em]",
                      isPinnedHere
                        ? "border-primary bg-primary-subtle text-primary"
                        : "border-border text-muted-foreground",
                    )}
                  >
                    {statusText}
                  </span>
                </div>
              </label>
            );
          })}
        </RadioGroup>

        {/* Capability for the chosen target lives here, where the target is
            actually known — the preset editor is global and stays ungated. */}
        {selectedBackend?.status === "ready" && selectedBackend.unsupportedKeys.length > 0 && (
          <p className="mono text-[10px] leading-snug text-muted-foreground">
            {t.notSupportedOnDisplay(
              selectedBackend.unsupportedKeys
                .map((k) => adjustmentLabel(k, locale))
                .join(", "),
            )}
          </p>
        )}

        {/* — Apply to all ———————————————————————————————— */}
        <label className="flex cursor-pointer items-center gap-2.5">
          <Checkbox checked={applyAll} onCheckedChange={(v) => { setApplyAll(Boolean(v)); setLastResult(null); }}>
            <CheckboxIndicator />
          </Checkbox>
          <span className="mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
            {t.applyToAll}
          </span>
        </label>

        {/* — Failure feedback — persistent while the dialog stays open — */}
        {lastResult && summary && (
          <div aria-live="polite" className="feedback-enter rounded-[8px] border border-border bg-surface p-3">
            {lastResult.error && (
              <span className="validation-slide block font-mono text-[10px] text-destructive">
                {t.applyFailedWithErr(lastResult.error)}
              </span>
            )}
            {!lastResult.error && (
              <span className="mono feedback-enter block font-mono text-[10px] text-foreground">
                {summary.headline}
              </span>
            )}
            {summary.rows.length > 0 && (
              <ul className="mt-1.5 flex flex-col gap-0.5">
                {summary.rows.map((row) => (
                  <li
                    key={row.adjustment}
                    className="mono flex items-start gap-1.5 text-[10px] leading-tight"
                  >
                    <span className={cn("shrink-0 font-semibold", statusClass[row.status])}>
                      {t.outcomeStatus(row.status)}
                    </span>
                    <span className="shrink-0 font-semibold">{row.label}</span>
                    {row.reason && (
                      <span className="text-muted-foreground">{row.reason}</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {summary.verificationNote && (
              <span className="mt-1 block text-[10px] text-muted-foreground">
                {summary.verificationNote}
              </span>
            )}
          </div>
        )}

        {/* — Actions ———————————————————————————————— */}
        <DialogFooter>
          <Button variant="ghost" onClick={() => requestClose()} disabled={applying}>
            {t.cancel}
          </Button>
          <Button onClick={handleApply} disabled={!canApply || applying} trailingIcon={<ArrowRightGlyph />}>
            {applying ? t.applying : applyAll ? t.applyToAll : t.applyButton}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
