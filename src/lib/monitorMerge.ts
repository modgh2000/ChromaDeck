/// Monitor state merge for background polling.
///
/// Merges a fresh backend snapshot into previous state without wiping
/// monitors that briefly disappeared (disconnected cables, sleeping
/// displays, GPU driver re-enumeration gaps).
///
/// Merge rules (by edid_id):
/// 1. Present in fresh -> updated with fresh data & connected: true
/// 2. Known from prev, absent in fresh -> kept, connected: false
/// 3. Brand-new in fresh -> appended at end
/// 4. Fresh order wins for live entries; offline entries trail after
///
/// Always returns the same number of entries as or more than prev –
/// never fewer (unless prev itself was empty).

import type { Monitor } from "./types";

export function mergeMonitors(prev: Monitor[], fresh: Monitor[]): Monitor[] {
  const freshMap = new Map<string, Monitor>();
  for (const m of fresh) {
    freshMap.set(m.edid_id, m);
  }

  const seen = new Set<string>();
  const result: Monitor[] = [];

  // 1 & 3 – fresh entries (updates + new) in API order
  for (const m of fresh) {
    seen.add(m.edid_id);
    result.push(m);
  }

  // 2 – previously known entries now absent -> disconnected, appended
  for (const m of prev) {
    if (!seen.has(m.edid_id)) {
      seen.add(m.edid_id);
      result.push({ ...m, connected: false });
    }
  }

  return result;
}
