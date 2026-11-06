import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import type { Monitor, Preset } from "../lib/types";
import PresetCard from "./PresetCard";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { ArrowLeftGlyph, ArrowRightGlyph } from "@/components/ui/icons";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Plus, Search, X } from "lucide-react";
import { consumeStagger } from "../lib/motion";
import { useI18n } from "../lib/i18n";
import {
  ALL_CATEGORIES,
  NO_CATEGORY,
  filterPresets,
  hasUncategorisedPresets,
  presetCategories,
} from "../lib/presetSearch";

interface Props {
  monitors: Monitor[];
  presets: Preset[];
  loading: boolean;
  onEdit: (preset: Preset) => void;
  onRefresh: () => void;
  onCreateNew: () => void;
  pins: Record<string, string>;
  onPinChange: () => void;
  onApply: (preset: Preset) => void;
  appliedMap: Record<string, string>;
  onPresetDuplicated?: (preset: Preset) => void;
  onPresetDeleted?: (id: string) => void;
  lastAddedId?: string | null;
}

/** Loading skeleton */
function SkeletonRow() {
  return (
    <div className="rounded-[8px] border border-border bg-surface p-2">
      <div className="flex h-[132px] flex-col gap-3 rounded-[8px] border border-border-hover bg-surface p-4">
        <Skeleton className="h-4 w-20" />
        <Skeleton className="h-8 w-2/3" />
        <Skeleton className="mt-auto h-6 w-full" />
      </div>
    </div>
  );
}

/** Full empty state */
function EmptyState({ onCreateNew }: { onCreateNew: () => void }) {
  const { t } = useI18n();
  return (
    <div className="empty-state-enter flex flex-col items-center justify-center gap-4 py-12 text-center">
      <div className="flex size-16 items-center justify-center rounded-[8px] border border-dashed border-border text-muted-foreground">
        <svg className="size-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 5v14M5 12h14" />
        </svg>
      </div>
      <div className="flex flex-col gap-2">
        <h3 className="font-display text-xl font-semibold tracking-[-0.48px] text-foreground">{t.noPresetsYet}</h3>
        <p className="max-w-xs font-mono text-[10px] leading-relaxed text-muted-foreground">
          {t.emptyStateDesc}
        </p>
      </div>
      <Button variant="secondary" size="sm" onClick={() => onCreateNew()}>
        <Plus className="size-3.5" />
        {t.createPreset}
      </Button>
    </div>
  );
}

export default function MonitorList({ monitors, presets, loading, onEdit, onRefresh, onCreateNew, pins, onPinChange, onApply, appliedMap, onPresetDuplicated, onPresetDeleted, lastAddedId }: Props) {
  const { t } = useI18n();
  const carouselRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);
  const [query, setQuery] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<string>(ALL_CATEGORIES);
  const transitionRef = useRef(false);

  /** Run a filter-state update inside a View Transition so the carousel
   *  crossfades between result sets instead of snapping. Falls back to a
   *  plain update when the API is unavailable, reduced motion is requested,
   *  or another transition is still in flight. */
  const applyFilters = useCallback((next: () => void) => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (
      reduced ||
      typeof document.startViewTransition !== "function" ||
      transitionRef.current
    ) {
      next();
      return;
    }
    const release = () => {
      transitionRef.current = false;
    };
    transitionRef.current = true;
    try {
      const transition = document.startViewTransition(() => {
        flushSync(next);
      });
      transition.finished.then(release, release);
    } catch {
      release();
      next();
    }
  }, []);

  // Presets already applied to a CONNECTED monitor leave the library: they now
  // live on that monitor's card until the monitor is reset or the apply is
  // undone. Scoping to connected displays means a preset applied to a monitor
  // that later disconnects returns here instead of being stranded.
  const connectedEdids = new Set(monitors.filter((m) => m.connected).map((m) => m.edid_id));
  const appliedPresetIds = new Set(
    Object.entries(appliedMap)
      .filter(([edid]) => connectedEdids.has(edid))
      .map(([, presetId]) => presetId),
  );
  const libraryPresets = presets.filter((preset) => !appliedPresetIds.has(preset.id));

  const categories = presetCategories(libraryPresets);
  const showUncategorised = hasUncategorisedPresets(libraryPresets);
  const filteredPresets = filterPresets(libraryPresets, query, categoryFilter);
  const isSearching = query.trim().length > 0 || categoryFilter !== ALL_CATEGORIES;

  // Drop a filter whose category no longer exists (e.g. its presets were deleted).
  useEffect(() => {
    if (categoryFilter === ALL_CATEGORIES || categoryFilter === NO_CATEGORY) return;
    if (!categories.includes(categoryFilter)) setCategoryFilter(ALL_CATEGORIES);
  }, [categories, categoryFilter]);

  const clearFilters = () => {
    applyFilters(() => {
      setQuery("");
      setCategoryFilter(ALL_CATEGORIES);
    });
    searchRef.current?.focus();
  };

  /** Recompute which arrows are actionable from the deck's live metrics. */
  const updateScrollState = useCallback(() => {
    const deck = carouselRef.current;
    if (!deck) {
      setCanScrollLeft(false);
      setCanScrollRight(false);
      return;
    }
    setCanScrollLeft(deck.scrollLeft > 1);
    setCanScrollRight(deck.scrollLeft < deck.scrollWidth - deck.clientWidth - 1);
  }, []);

  /** Scroll to the next/previous card's snap position. Measures each card's
   *  actual start, so mixed card widths step exactly one card at a time. */
  const scrollByCard = useCallback((dir: 1 | -1) => {
    const deck = carouselRef.current;
    if (!deck || deck.children.length === 0) return;
    const deckLeft = deck.getBoundingClientRect().left;
    const padLeft = parseFloat(getComputedStyle(deck).scrollPaddingLeft) || 0;
    const maxScroll = deck.scrollWidth - deck.clientWidth;
    const current = deck.scrollLeft;
    // Snap target for each card: where scrollLeft must be for it to sit at the padded start.
    const stops = Array.from(deck.children, (card) =>
      Math.min(maxScroll, Math.max(0, current + card.getBoundingClientRect().left - deckLeft - padLeft)),
    );
    const target =
      dir === 1
        ? stops.find((s) => s > current + 1) ?? maxScroll
        : [...stops].reverse().find((s) => s < current - 1) ?? 0;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    deck.scrollTo({ left: target, behavior: reduced ? "auto" : "smooth" });
  }, []);

  /** Arrow keys steer the deck only when focus sits on the deck or a card. */
  const shouldHandleArrowKeys = (target: EventTarget | null): boolean => {
    const el = target instanceof HTMLElement ? target : null;
    if (!el) return false;
    // Form fields, sliders, dialogs and buttons own their arrow-key behaviour.
    if (
      el.closest(
        'input, textarea, select, [role="slider"], [contenteditable="true"], [contenteditable=""], [role="dialog"], button, a',
      )
    ) {
      return false;
    }
    if (el === carouselRef.current) return true;
    const card = el.closest('[data-slot="card"]');
    return card !== null && carouselRef.current?.contains(card) === true;
  };

  // Keep the arrow disabled states in sync with real overflow (mount, resize,
  // card count changes) instead of reading the ref during render.
  useEffect(() => {
    const deck = carouselRef.current;
    updateScrollState();
    if (!deck || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(updateScrollState);
    ro.observe(deck);
    return () => ro.disconnect();
  }, [updateScrollState, filteredPresets.length, loading]);

  // A new query or category starts the result list from the first card.
  useEffect(() => {
    const deck = carouselRef.current;
    if (deck) deck.scrollLeft = 0;
    updateScrollState();
  }, [query, categoryFilter, updateScrollState]);

  // Pre-compute preset cards for the carousel (avoids IIFE inside JSX)
  const presetCards = filteredPresets.map((preset, i) => {
    const isStagger = !loading && filteredPresets.length > 0 && consumeStagger();
    return (
      <PresetCard
        key={preset.id}
        preset={preset}
        monitors={monitors}
        pins={pins}
        onEdit={onEdit}
        onRefreshParent={onRefresh}
        onPinChange={onPinChange}
        onApply={onApply}
        appliedMap={appliedMap}
        staggerEnter={isStagger}
        staggerMs={Math.min(i, 5) * 60}
        onDuplicated={onPresetDuplicated}
        onDeleted={onPresetDeleted}
        highlightEnter={!isStagger && lastAddedId === preset.id}
        className="min-w-[288px] shrink-0 snap-start"
      />
    );
  });

  // Pre-computed carousel content (avoids nested JSX expressions inside the ternary)
  const allPresetsApplied = presets.length > 0 && libraryPresets.length === 0;
  const emptyPresetsContent = (
    <div className="flex min-h-64 flex-1 flex-col items-center justify-center gap-3 rounded-[8px] border border-dashed border-border bg-transparent py-12 text-center">
      <p className="font-mono text-[10px] text-muted-foreground">
        {allPresetsApplied ? t.everyPresetApplied : t.noPresetsYet}
      </p>
      {allPresetsApplied && (
        <p className="max-w-xs font-mono text-[9px] leading-relaxed text-muted-foreground/80">
          {t.everyPresetAppliedHint}
        </p>
      )}
      <Button variant="secondary" size="sm" onClick={() => onCreateNew()}>
        <Plus className="size-3.5" />
        {t.createPreset}
      </Button>
    </div>
  );

  const noResultsContent = (
    <div className="empty-state-enter flex min-h-64 flex-1 flex-col items-center justify-center gap-3 rounded-[8px] border border-dashed border-border bg-transparent py-12 text-center">
      <p className="max-w-[420px] truncate font-mono text-[10px] text-muted-foreground">
        {t.noPresetsMatchFilter}
      </p>
      <Button variant="secondary" size="sm" onClick={clearFilters}>
        {t.clearFilters}
      </Button>
    </div>
  );

  const carouselContent = (
    <div className="relative flex h-full flex-col">
      <div
        ref={carouselRef}
        className="preset-deck carousel-scroll my-auto flex shrink-0 flex-row gap-4 overflow-x-auto px-12 scroll-px-12 snap-x snap-mandatory"
        onScroll={updateScrollState}
      >
        {presetCards}
      </div>
      <button
        type="button"
        data-carousel-arrow
        className="absolute left-2 top-1/2 z-50 inline-flex -translate-y-1/2 shrink-0 items-center justify-center rounded-[8px] border border-border bg-surface px-2.5 py-2 text-muted-foreground transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring disabled:cursor-default disabled:opacity-40 enabled:hover:bg-surface-hover enabled:hover:text-foreground"
        onClick={() => scrollByCard(-1)}
        disabled={!canScrollLeft}
        aria-label={t.scrollLeftAria}
      >
        <ArrowLeftGlyph className="size-4" />
      </button>
      <button
        type="button"
        data-carousel-arrow
        className="absolute right-2 top-1/2 z-50 inline-flex -translate-y-1/2 shrink-0 items-center justify-center rounded-[8px] border border-border bg-surface px-2.5 py-2 text-muted-foreground transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring disabled:cursor-default disabled:opacity-40 enabled:hover:bg-surface-hover enabled:hover:text-foreground"
        onClick={() => scrollByCard(1)}
        disabled={!canScrollRight}
        aria-label={t.scrollRightAria}
      >
        <ArrowRightGlyph className="size-4" />
      </button>
    </div>
  );

  // Early return when loading
  if (loading) {
    return (
      <section className="shell-enter flex min-h-0 min-w-0 flex-1 flex-col" style={{ ["--shell-delay" as string]: "120ms" }}>
        <div className="flex h-10 shrink-0 items-center border-b border-border pb-2">
          <Skeleton className="h-3 w-24" />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overflow-x-clip pt-4">
          <div className="flex flex-row gap-4 overflow-hidden">
            <div className="min-w-[288px] shrink-0">
              <SkeletonRow />
            </div>
            <div className="min-w-[288px] shrink-0">
              <SkeletonRow />
            </div>
            <div className="min-w-[288px] shrink-0">
              <SkeletonRow />
            </div>
          </div>
        </div>
      </section>
    );
  }

  // Full empty state
  if (monitors.length === 0 && libraryPresets.length === 0) {
    return (
      <section className="shell-enter flex min-h-0 min-w-0 flex-1 flex-col" style={{ ["--shell-delay" as string]: "120ms" }}>
        <div className="flex h-10 shrink-0 items-center justify-between border-b border-border pb-2">
          <span className="mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
            {t.presetsHeading(0)}
          </span>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => onCreateNew()}
          >
            <Plus className="size-3.5" />
            {t.createPreset}
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overflow-x-clip pt-4">
          <EmptyState onCreateNew={onCreateNew} />
        </div>
      </section>
    );
  }

  return (
    <section
      className="flex min-h-0 min-w-0 flex-1 flex-col"
      onKeyDown={(e) => {
        // "/" or Ctrl/Cmd+F jumps to the preset search from anywhere in the panel.
        const isFindShortcut =
          (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f";
        if (isFindShortcut || e.key === "/") {
          const target = e.target instanceof HTMLElement ? e.target : null;
          const typing = target?.closest(
            'input, textarea, select, [contenteditable="true"], [contenteditable=""]',
          );
          if (!typing || isFindShortcut) {
            e.preventDefault();
            searchRef.current?.focus();
            return;
          }
        }
        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
        if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
        if (!shouldHandleArrowKeys(e.target)) return;
        e.preventDefault();
        scrollByCard(e.key === "ArrowLeft" ? -1 : 1);
      }}
    >
      <LibraryScrollRoot
        header={
          <div className="flex h-10 shrink-0 items-center justify-between gap-4 border-b border-border pb-2">
            <span className="mono min-w-0 truncate text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
              {isSearching
                ? t.presetsFilteredHeading(filteredPresets.length, libraryPresets.length)
                : t.presetsHeading(libraryPresets.length)}
            </span>
            <div className="flex shrink-0 items-center gap-2">
              <Select
                value={categoryFilter}
                onValueChange={(value) => {
                  const next = (value as string | null) ?? ALL_CATEGORIES;
                  applyFilters(() => setCategoryFilter(next));
                }}
              >
                <SelectTrigger
                  size="sm"
                  aria-label={t.filterByCategoryAria}
                  className="w-[136px] font-mono text-[11px] focus-visible:ring-1 focus-visible:ring-primary-border"
                >
                  <SelectValue>{(value: string | null) => (value && value !== ALL_CATEGORIES ? (value === NO_CATEGORY ? t.noCategory : value) : t.allCategories)}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL_CATEGORIES}>{t.allCategories}</SelectItem>
                  {categories.map((category) => (
                    <SelectItem key={category} value={category}>
                      {category}
                    </SelectItem>
                  ))}
                  {showUncategorised && (
                    <SelectItem value={NO_CATEGORY}>{t.noCategory}</SelectItem>
                  )}
                </SelectContent>
              </Select>
              <div className="relative">
                <Search
                  className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
                  aria-hidden="true"
                />
                <Input
                  ref={searchRef}
                  type="search"
                  value={query}
                  onChange={(e) => {
                    // Capture now: the view-transition callback runs after the
                    // synthetic event has been released.
                    const value = (e.target as HTMLInputElement).value;
                    applyFilters(() => setQuery(value));
                  }}
                  onKeyDown={(e) => {
                    if (e.key !== "Escape") return;
                    e.preventDefault();
                    e.stopPropagation();
                    if (query) applyFilters(() => setQuery(""));
                    else (e.target as HTMLInputElement).blur();
                  }}
                  placeholder={t.searchPresetsPlaceholder}
                  aria-label={t.searchPresetsAria}
                  title={t.searchPresetsTitle}
                  className="h-8 w-[150px] rounded-[8px] py-1 pr-7 pl-8 font-mono text-[11px] md:text-[11px] min-[1100px]:w-[210px] [&::-webkit-search-cancel-button]:appearance-none"
                />
                {isSearching && (
                  <button
                    type="button"
                    aria-label={t.clearFilters}
                    title={t.clearFilters}
                    onClick={clearFilters}
                    className="absolute top-1/2 right-1 inline-flex size-6 -translate-y-1/2 items-center justify-center rounded-[6px] text-muted-foreground transition-colors hover:text-foreground focus-visible:text-foreground focus-visible:outline-none"
                  >
                    <X className="size-3" />
                  </button>
                )}
              </div>
              <Button variant="secondary" size="sm" onClick={() => onCreateNew()}>
                <Plus className="size-3.5" />
                {t.createPreset}
              </Button>
            </div>
          </div>
        }
      >
        {libraryPresets.length === 0
          ? emptyPresetsContent
          : filteredPresets.length === 0
          ? noResultsContent
          : carouselContent}
      </LibraryScrollRoot>
    </section>
  );
}

/** Plain scroll container. Edge fading is fully declarative now
 * (scroll-driven card animations in CSS); no scroll listeners, no
 * rAF, no dataset writes. The header lives outside the scrollport.
 *
 * When the runtime does NOT support CSS animation-timeline: view()
 * (suspected in older WebView2), an IntersectionObserver fallback
 * writes per-card --edge-o CSS variables and the .no-view-timeline
 * class activates companion CSS rules. Feature-detect runs once on
 * mount; on supporting runtimes the fallback installs nothing. */
function LibraryScrollRoot({ header, children }: { header: ReactNode; children: ReactNode }) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // IntersectionObserver fallback for unsupported runtimes
  useEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;

    // 1. Feature-detect CSS scroll-driven animations
    const supportsViewTimeline =
      typeof CSS !== "undefined" &&
      typeof CSS.supports === "function" &&
      CSS.supports("animation-timeline", "view()");
    if (supportsViewTimeline) return; // CSS handles it - install nothing

    // 2. Runtime guard: IntersectionObserver / MutationObserver present
    if (typeof IntersectionObserver === "undefined" || typeof MutationObserver === "undefined") return;

    // 3. Respect prefers-reduced-motion
    try {
      const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
      if (mq.matches) return; // reduced motion - cards stay fully opaque
    } catch {
      /* matchMedia unavailable - fall through */
    }

    // 4. Activate fallback CSS rules on the scroll container
    scroll.classList.add("no-view-timeline");

    // 5. Dense thresholds: 0 to 1 step 0.05
    const thresholds: number[] = [0, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 1];

    // 6. Create IntersectionObserver with scroll container as root
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const el = entry.target as HTMLElement;
          // Map ratio r -> min(1, r/0.35): fully opaque through the
          // middle ~65%, fade occupies the outer ~35% at each edge,
          // mirroring the 35/65 keyframe shoulders of card-edge-vanish.
          const opacity = Math.min(1, entry.intersectionRatio / 0.35);
          el.style.setProperty("--edge-o", String(opacity));
        }
      },
      {
        root: scroll,
        threshold: thresholds,
      },
    );

    // 7. Sync IO observations with .preset-deck children (initial + on changes)
    const syncCards = () => {
      const deck = scroll.querySelector(".preset-deck");
      if (!deck) return;
      io.disconnect();
      for (const child of deck.children) {
        io.observe(child);
      }
    };

    syncCards();

    // 8. Watch for grid changes (duplicate -> new card, delete -> removal)
    const mut = new MutationObserver(() => syncCards());
    mut.observe(scroll, { childList: true, subtree: true });

    // 9. Cleanup on unmount - no observer leaks
    return () => {
      io.disconnect();
      mut.disconnect();
      scroll.classList.remove("no-view-timeline");
    };
  }, []);

  return (
    <div
      className="shell-enter flex min-h-0 min-w-0 flex-1 flex-col"
      style={{ ["--shell-delay" as string]: "120ms" }}
    >
      {header}
      <div
        ref={scrollRef}
        data-drag-scroll="true"
        className="min-h-0 flex-1 overflow-y-auto overflow-x-clip pt-4"
      >
        {children}
      </div>
    </div>
  );
}
