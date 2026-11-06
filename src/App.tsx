import { useState, useEffect, useCallback, useRef } from "react";
import { flushSync } from "react-dom";
import "./App.css";
import "@fontsource/geist/400.css";
import "@fontsource/geist/600.css";
import "@fontsource/geist/700.css";
import "@fontsource/jetbrains-mono/500.css";
import "@fontsource/jetbrains-mono/700.css";
import { listMonitors, listPresets, listPins, listApplied, reapplyNow } from "./lib/tauri";
import { version as appVersion } from "../package.json";
import type { Monitor, Preset, EnforceEvent } from "./lib/types";
import { mergeMonitors } from "./lib/monitorMerge";
import { enable, disable, isEnabled } from "@tauri-apps/plugin-autostart";
import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { replayEntrance } from "./lib/motion";
import { useI18n } from "./lib/i18n";
import { Languages } from "lucide-react";
import logoMark from "./assets/chromadeck-icon.svg";
import MonitorList from "./components/MonitorList";
import MonitorSidebar from "./components/MonitorSidebar";
import ApplyDialog from "./components/ApplyDialog";
import PresetEditor from "./components/PresetEditor";
import { DragAndDropProvider } from "./components/DragAndDropContext";
import DragGhost from "./components/DragGhost";
import UndoToast from "./components/UndoToast";

function LanguageSwitcher() {
  const { locale, setLocale, t } = useI18n();
  return (
    <div
      role="group"
      aria-label="Language switcher"
      title={t.langToggleTooltip}
      className="inline-flex items-center rounded-[8px] border border-border bg-surface p-0.5"
    >
      <Languages className="mx-1.5 size-3.5 text-muted-foreground" strokeWidth={1.5} />
      <button
        type="button"
        data-slot="button"
        onClick={() => setLocale("zh")}
        aria-pressed={locale === "zh"}
        className={`rounded-[6px] px-2 py-0.5 font-mono text-[10px] font-medium transition-colors ${
          locale === "zh"
            ? "bg-primary text-primary-foreground"
            : "text-muted-foreground hover:text-foreground"
        }`}
      >
        中文
      </button>
      <button
        type="button"
        data-slot="button"
        onClick={() => setLocale("en")}
        aria-pressed={locale === "en"}
        className={`rounded-[6px] px-2 py-0.5 font-mono text-[10px] font-medium transition-colors ${
          locale === "en"
            ? "bg-primary text-primary-foreground"
            : "text-muted-foreground hover:text-foreground"
        }`}
      >
        EN
      </button>
    </div>
  );
}

function AutostartToggle() {
  const { t } = useI18n();
  const [on, setOn] = useState<boolean | null>(null);
  useEffect(() => {
    isEnabled().then(setOn).catch(() => setOn(false));
  }, []);
  const toggle = async () => {
    try {
      if (on) await disable();
      else await enable();
      setOn(!on);
    } catch {
      // keep current state on failure
    }
  };
  return (
    <label className="inline-flex cursor-pointer items-center gap-2">
      <input
        type="checkbox"
        checked={on ?? false}
        onChange={toggle}
        className="size-[14px] rounded-[4px] accent-[var(--color-primary)]"
      />
      <span className="mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
        {t.autostart}
      </span>
    </label>
  );
}

function App() {
  const { t } = useI18n();
  const [monitors, setMonitors] = useState<Monitor[]>([]);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editingPreset, setEditingPreset] = useState<Preset | null>(null);
  const [showEditor, setShowEditor] = useState(false);
  const [pins, setPins] = useState<Record<string, string>>({});
  const [reapplyMsg, setReapplyMsg] = useState<string | null>(null);
  const [lastReapply, setLastReapply] = useState<{ errors: number; total: number } | null>(null);
  // Bumped on every Reapply so the footer health light remounts and replays
  // its one-shot ring even when the derived health state is unchanged.
  const [healthTick, setHealthTick] = useState(0);
  const [applyingPreset, setApplyingPreset] = useState<Preset | null>(null);
  const [applyTargetEdid, setApplyTargetEdid] = useState<string | null>(null);
  const [appliedMap, setAppliedMap] = useState<Record<string, string>>({});
  const [lastAddedId, setLastAddedId] = useState<string | null>(null);
  const reapplyTimerRef = useRef<number | null>(null);

  // Reapply status is transient: replace any pending clear, and clean up on unmount.
  const showReapplyMsg = (message: string) => {
    if (reapplyTimerRef.current !== null) {
      window.clearTimeout(reapplyTimerRef.current);
    }
    setReapplyMsg(message);
    reapplyTimerRef.current = window.setTimeout(() => {
      reapplyTimerRef.current = null;
      setReapplyMsg(null);
    }, 5000);
  };

  useEffect(
    () => () => {
      if (reapplyTimerRef.current !== null) {
        window.clearTimeout(reapplyTimerRef.current);
      }
    },
    [],
  );

  // Optimistic batch-delete removal: drop the deleted cards locally so no
  // reload flash interrupts the explosion, then sync quietly in the
  // background (pins/applied/footer) without touching the loading flag.
  // The removal runs inside a View Transition (Chromium/WebView2) so the
  // surviving cards glide into the freed gaps instead of jumping.
  const handleBatchDeleted = (ids: string[]) => {
    if (ids.length > 0) {
      const remove = () =>
        setPresets((prev) => prev.filter((p) => !ids.includes(p.id)));
      const doc = document as Document & {
        startViewTransition?: (cb: () => void) => void;
      };
      if (typeof doc.startViewTransition === "function") {
        doc.startViewTransition(() => {
          flushSync(remove);
        });
      } else {
        remove();
      }
      setLastAddedId((cur) => (cur !== null && ids.includes(cur) ? null : cur));
    }
    void fetchData(true);
  };

  // Optimistic duplicate insert: append the created preset locally so the
  // new card fades in on its own instead of reloading the whole library.
  const handlePresetDuplicated = (created: Preset) => {
    setPresets((prev) =>
      prev.some((p) => p.id === created.id) ? prev : [...prev, created],
    );
    setLastAddedId(created.id);
    window.setTimeout(() => {
      setLastAddedId((cur) => (cur === created.id ? null : cur));
    }, 600);
  };

  const fetchData = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    setError(null);
    try {
      const [monitorsData, presetsData, pinsData, appliedData] = await Promise.all([
        listMonitors(),
        listPresets(),
        listPins(),
        listApplied(),
      ]);
      setMonitors(monitorsData);
      setPresets(presetsData);
      setPins(pinsData);
      setAppliedMap(appliedData);
    } catch (err) {
      setError(String(err));
    } finally {
      if (!quiet) setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // — Background poll: 5s interval + window focus refresh —————
  // Fetches monitors ONLY (never presets/pins). Merges against current
  // state so disconnected monitors persist as red offline cards rather
  // than disappearing. Silent on failure – keeps last-known state.

  useEffect(() => {
    let mounted = true;
    let inFlight = false;

    const tick = async () => {
      if (!mounted || inFlight) return;
      inFlight = true;
      try {
        const fresh = await listMonitors();
        if (mounted) {
          setMonitors((prev) => mergeMonitors(prev, fresh));
        }
      } catch {
        // silent: keep last-known state on failure
      } finally {
        inFlight = false;
      }
    };

    const POLL_MS = 5000;
    const intervalId = setInterval(tick, POLL_MS);
    window.addEventListener("focus", tick);

    return () => {
      mounted = false;
      clearInterval(intervalId);
      window.removeEventListener("focus", tick);
    };
  }, []);

  // — Entrance replay: the window hides (not unmounts) on close, so the
  // backend pings `window-shown` on every re-show (tray Show / tray click /
  // second launch). Replay the staged load animation in place.
  useEffect(() => {
    // `listen` needs Tauri IPC – skip it in the browser preview.
    if (!isTauri()) return;
    const unlistenPromise = listen("window-shown", replayEntrance);
    return () => {
      unlistenPromise.then((unlisten) => unlisten()).catch(() => {});
    };
  }, []);

  const handleEdit = (preset: Preset) => {
    setEditingPreset(preset);
    setShowEditor(true);
  };

  const handleCreateNew = () => {
    setEditingPreset(null);
    setShowEditor(true);
  };

  const handleEditorSaved = () => {
    // The editor closes itself and reports back through onClosed; only the
    // data needs refreshing here.
    fetchData();
  };

  /** Dialog close requests are recorded inside the dialog. The parent keeps
   *  the dialog mounted until `onClosed` reports the exit animation ended. */
  const handleDialogCloseRequest = () => {};

  const handleEditorClosed = () => {
    setShowEditor(false);
    setEditingPreset(null);
  };

  function LogoMark() {
    return (
      <img
        src={logoMark}
        className="logo-lockup"
        alt="ChromaDeck logo"
      />
    );
  }

  return (
    <DragAndDropProvider
      monitors={monitors}
      appliedMap={appliedMap}
      onApplied={(presetId, edids) => {
        // Optimistic: reflect the drop immediately, then re-sync quietly.
        setAppliedMap((prev) => {
          const next = { ...prev };
          for (const edid of edids) next[edid] = presetId;
          return next;
        });
        void fetchData(true);
      }}
      onRefresh={() => void fetchData(true)}
    >
      <main className="flex h-screen flex-col overflow-hidden bg-background text-foreground">
        {/* — Header: flat strip ———————————————————————————————— */}
        <header
          className="shell-enter flex h-12 shrink-0 items-center justify-between border-b border-border bg-background px-6"
          style={{ ["--shell-delay" as string]: "0ms" }}
        >
          <div className="flex min-w-0 items-center gap-3">
            <LogoMark />
            <h1 className="enter-reveal truncate text-[15px] font-semibold tracking-[-0.02em] text-foreground">
              <span className="enter-reveal-child">ChromaDeck</span>
            </h1>
            <span className="h-4 w-px shrink-0 bg-border" aria-hidden="true" />
            <span className="mono shrink-0 text-[10px] text-muted-foreground">
              v{appVersion}
            </span>
            <span className="hidden h-4 w-px shrink-0 bg-border sm:inline-block" aria-hidden="true" />
            <span className="mono hidden truncate text-[10px] text-muted-foreground sm:inline">
              {t.appSubtitle}
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <LanguageSwitcher />
          </div>
        </header>

        {/* — Error banner ———————————————————————————————— */}
        {error && (
          <div className="error-banner-enter mx-6 mt-4 flex items-center gap-2.5 rounded-[8px] border border-border bg-surface px-3 py-2">
            <svg className="size-4 shrink-0 text-destructive" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v4m0 4h.01M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
            </svg>
            <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-destructive">
              {t.failedToLoad(error)}
            </span>
            <button onClick={() => void fetchData()} data-slot="button" className="inline-flex shrink-0 items-center justify-center rounded-[8px] border border-border bg-transparent px-2.5 py-1 font-mono text-[10px] text-foreground transition-colors hover:border-border-hover hover:bg-surface-hover">
              <span className="btn-label">{t.retry}</span>
            </button>
          </div>
        )}

        {/* — Content: two stacked panels, monitors shorter at min height, presets absorb extra — */}
        <div className="flex min-h-0 flex-1 flex-col p-6">
          <div className="h-4 w-full" />
          <div
            className="flex-[0_0_auto] min-h-[200px] shrink-0"
            style={{ maxHeight: "min(500px, calc(100vh - 440px))" }}
          >
            <MonitorSidebar
              monitors={monitors}
              presets={presets}
              pins={pins}
              appliedMap={appliedMap}
              setAppliedMap={setAppliedMap}
              onRefresh={fetchData}
              onPinChange={fetchData}
            />
          </div>
          <div className="h-4 w-full" />
          <div className="flex min-h-0 flex-1">
            <MonitorList
              monitors={monitors}
              presets={presets}
              loading={loading}
              onEdit={handleEdit}
              onRefresh={fetchData}
              onCreateNew={handleCreateNew}
              pins={pins}
              onPinChange={fetchData}
              appliedMap={appliedMap}
              onPresetDuplicated={handlePresetDuplicated}
              onPresetDeleted={(id) => handleBatchDeleted([id])}
              lastAddedId={lastAddedId}
              onApply={(preset) => { setApplyTargetEdid(null); setApplyingPreset(preset); }}
            />
          </div>
          <div className="h-4 w-full" />
        </div>

        {/* — Footer / status bar: flat strip ———————————————————————————————— */}
        <footer
          className="shell-enter flex h-14 shrink-0 items-center justify-between border-t border-border bg-background pl-6 pr-4"
          style={{ ["--shell-delay" as string]: "180ms" }}
        >
          <div className="flex min-w-0 items-center gap-3">
            {(() => {
              const errors = lastReapply?.errors ?? 0;
              const healthKey: "loading" | "ok" | "error" | "empty" = loading
                ? "loading"
                : errors > 0
                ? "error"
                : monitors.some((m) => m.connected)
                ? "ok"
                : "empty";
              const health =
                healthKey === "error"
                  ? {
                      label: t.healthError(errors),
                      tone: "bg-destructive animate-pulse motion-reduce:animate-none",
                    }
                  : healthKey === "ok"
                  ? { label: t.healthOk, tone: "bg-primary" }
                  : healthKey === "loading"
                  ? { label: t.healthLoading, tone: "bg-subtle-fg" }
                  : { label: t.healthEmpty, tone: "bg-subtle-fg" };
              return (
                <span
                  // Remount on every health change (and every Reapply) so the
                  // .health-pulse ring animation replays once.
                  key={`${healthKey}-${healthTick}`}
                  role="img"
                  aria-label={health.label}
                  title={health.label}
                  className={`health-pulse relative inline-block size-1.5 shrink-0 rounded-full ${health.tone}`}
                />
              );
            })()}
            {(() => {
              const summaryText = loading
                ? t.loadingFooter
                : t.footerSummary(
                    presets.length,
                    monitors.filter((m) => m.connected).length,
                    Object.keys(pins).length,
                  );
              return (
                <span key={summaryText} className="value-swap mono truncate text-[10px] uppercase tracking-[0.12em] tabular-nums text-muted-foreground">
                  {summaryText}
                </span>
              );
            })()}
            {reapplyMsg && (
              <>
                <span className="h-4 w-px shrink-0 bg-border" aria-hidden="true" />
                <span className="transient-enter mono truncate text-[10px] text-muted-foreground">
                  {reapplyMsg}
                </span>
              </>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-4">
            <span className="h-4 w-px bg-border" aria-hidden="true" />
            <AutostartToggle />
            <button
              data-slot="button"
              onClick={async () => {
                try {
                  const events: EnforceEvent[] = await reapplyNow();
                  setLastReapply({
                    errors: events.filter((e) => e.error).length,
                    total: events.length,
                  });
                  setHealthTick((tick) => tick + 1);
                  const applied = events.filter((e) => e.applied).length;
                  const firstErr = events.find((e) => e.error)?.error;
                  showReapplyMsg(
                    firstErr
                      ? t.reapplyWithError(firstErr)
                      : t.reappliedCount(applied, events.length),
                  );
                } catch (err) {
                  showReapplyMsg(t.reapplyFailed(String(err)));
                }
                fetchData();
              }}
              className="inline-flex items-center justify-center rounded-[8px] border border-border bg-transparent px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-foreground transition-colors hover:border-border-hover hover:bg-surface-hover"
              title={t.reapplyTooltip}
            >
              <span className="btn-label">{t.reapply}</span>
            </button>
          </div>
        </footer>

        {/* — Apply dialog ———————————————————————————————— */}
        {applyingPreset && (
          <ApplyDialog
            preset={applyingPreset}
            monitors={monitors}
            pins={pins}
            initialEdid={applyTargetEdid}
            onClose={handleDialogCloseRequest}
            onClosed={() => {
              setApplyingPreset(null);
              setApplyTargetEdid(null);
            }}
            onApplied={(info) => {
              if (info) {
                setAppliedMap((prev) => ({ ...prev, [info.edid]: info.presetId }));
              }
              fetchData();
            }}
          />
        )}

        {/* — Editor dialog ———————————————————————————————— */}
        {showEditor && (
          <PresetEditor
            presets={presets}
            editPreset={editingPreset}
            onClose={handleDialogCloseRequest}
            onClosed={handleEditorClosed}
            onSaved={handleEditorSaved}
          />
        )}

        {/* — Drag overlay + undo toast (portals) ————————————————— */}
        <DragGhost />
        <UndoToast />
      </main>
    </DragAndDropProvider>
  );
}

export default App;
