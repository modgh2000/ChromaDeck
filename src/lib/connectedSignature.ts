import type { Monitor } from "./types";

/**
 * Stable key for the set of connected displays, independent of poll order.
 *
 * The 5s monitor poll hands back a fresh array on every tick (mergeMonitors),
 * so a component that depends on `monitors` directly would reset and re-probe
 * on every tick even when the connected set is unchanged. Keying capability
 * probes on this signature keeps equal-but-reordered monitor lists stable.
 */
export function connectedEdidSignature(
  monitors: Pick<Monitor, "edid_id" | "connected">[],
): string {
  return monitors
    .filter((m) => m.connected)
    .map((m) => m.edid_id)
    .sort()
    .join("\u0000");
}
