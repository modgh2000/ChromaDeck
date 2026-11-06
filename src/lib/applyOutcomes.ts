/**
 * Pure presentation logic for an apply response.
 *
 * The backend reports one outcome per adjustment (applied / skipped / failed)
 * plus an honest `verified` flag (apply paths confirm writes, not panel
 * read-back). This module turns that into a compact, ordered summary the
 * Apply dialog can render without inventing success. Legacy responses without
 * `adjustments` fall back to the previous boolean copy.
 */

import type { AdjustmentOutcome, AdjustmentStatus, ApplyResult } from "./types";
import { ADJUSTMENT_LABELS, TRANSLATIONS, getCurrentLocale, type Locale } from "./i18n";

export interface OutcomeRow {
  adjustment: string;
  label: string;
  status: AdjustmentStatus;
  verified: boolean;
  reason?: string;
}

export interface ApplySummary {
  rows: OutcomeRow[];
  /** One-line result used next to the existing confirmation copy. */
  headline: string;
  appliedCount: number;
  skippedCount: number;
  failedCount: number;
  /** A global error or any per-adjustment failure. */
  hasFailures: boolean;
  /** Applied rows exist but none were read-back verified. */
  unverifiedApplied: boolean;
  /** Footnote explaining the verification limit, or null. */
  verificationNote: string | null;
}

/** Readable label for a backend adjustment key (unknown keys degrade safely). */
export function adjustmentLabel(adjustment: string, locale: Locale = getCurrentLocale()): string {
  const dict = ADJUSTMENT_LABELS[locale] ?? ADJUSTMENT_LABELS.en;
  return dict[adjustment] ?? adjustment.replace(/_/g, " ");
}

function legacyHeadline(result: ApplyResult, locale: Locale): string {
  const t = TRANSLATIONS[locale];
  if (locale === "zh") {
    const applied = [
      result.icc_applied && "ICC 已应用",
      result.gamma_applied && "Gamma 已应用",
      result.vibrance_applied && "数字振动已应用",
    ].filter(Boolean);
    if (result.error) return t.headlineApplyFailed;
    return applied.join(" + ") || t.headlineApplied;
  }
  const applied = [
    result.icc_applied && "ICC applied",
    result.gamma_applied && "gamma applied",
    result.vibrance_applied && "vibrance applied",
  ].filter(Boolean);

  if (result.error) return "Apply failed";
  return applied.join(" + ") || "Applied";
}

/**
 * Summarize an apply response.
 *
 * - Per-adjustment rows are kept in backend order.
 * - Headline counts skips/failures instead of hiding them.
 * - Neutral adjustments are already omitted by the backend (nothing was
 *   requested), so a skipped row means a non-neutral value was not delivered.
 * - Without `adjustments` (legacy response) the old boolean copy is preserved.
 */
export function summarizeApply(
  result: ApplyResult,
  locale: Locale = getCurrentLocale(),
): ApplySummary {
  const t = TRANSLATIONS[locale];
  const rows: OutcomeRow[] = (result.adjustments ?? []).map((outcome: AdjustmentOutcome) => ({
    adjustment: outcome.adjustment,
    label: adjustmentLabel(outcome.adjustment, locale),
    status: outcome.status,
    verified: outcome.verified,
    reason: outcome.reason,
  }));

  const applied = rows.filter((row) => row.status === "applied");
  const skipped = rows.filter((row) => row.status === "skipped");
  const failed = rows.filter((row) => row.status === "failed");

  let headline: string;
  if (rows.length === 0) {
    headline = legacyHeadline(result, locale);
  } else if (result.error && applied.length === 0) {
    headline = t.headlineApplyFailed;
  } else if (failed.length > 0) {
    headline = t.headlineAppliedWithFailed(failed.length);
  } else if (skipped.length > 0) {
    headline = t.headlineAppliedWithSkipped(skipped.length);
  } else if (applied.length > 0) {
    headline = t.headlineAppliedList(applied.map((row) => row.label).join(", "));
  } else {
    headline = t.headlineApplied;
  }

  const unverifiedApplied = applied.some((row) => !row.verified);

  return {
    rows,
    headline,
    appliedCount: applied.length,
    skippedCount: skipped.length,
    failedCount: failed.length,
    hasFailures: Boolean(result.error) || failed.length > 0,
    unverifiedApplied,
    verificationNote: unverifiedApplied ? t.verificationNote : null,
  };
}
