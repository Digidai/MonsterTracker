import type { LatestResult, MonitorConfig, RegionConfig } from "./domain";

export type MonitorStatus = "up" | "down" | "partial" | "unknown" | "incomplete" | "stale" | "paused" | "idle";

// Shared by the UI and incident engine. The supplied monitor budget is the
// effective allocation after the global cap, not the unbounded requested budget.
export function regionalFreshnessMs(dailyBudget: number, totalWeight: number, weight = 1): number {
  const ceiling = 7 * 86_400_000;
  const otherSlots = Math.max(0, totalWeight - weight);
  // buildSchedulePlan visits contiguous weighted slots, then reseeds at UTC
  // midnight. The trailing and leading runs of other regions can each occupy
  // otherSlots checks, so the boundary gap can span 2 * otherSlots + 1 checks.
  // If a whole day's budget fits outside this region, reseeding can skip it for
  // multiple days; keep the explicit seven-day evidence ceiling in that case.
  if (dailyBudget <= otherSlots || dailyBudget <= 0) return ceiling;
  const maximumGapMs = Math.ceil((2 * otherSlots + 1) * 1440 / dailyBudget) * 60_000;
  return Math.min(ceiling, Math.max(2 * 60 * 60_000, maximumGapMs * 3));
}

export function isRegionResultStale(
  result: Pick<LatestResult, "checkedAt" | "regionId">,
  monitor: Pick<MonitorConfig, "dailyBudget"> & { effectiveDailyBudget?: number },
  regions: Pick<RegionConfig, "id" | "enabled" | "weight">[],
  now = Date.now()
): boolean {
  const active = regions.filter((region) => region.enabled);
  const totalWeight = active.reduce((sum, region) => sum + region.weight, 0);
  const weight = active.find((region) => region.id === result.regionId)?.weight ?? 1;
  const checked = Date.parse(result.checkedAt);
  return !Number.isFinite(checked) || checked > now + 300_000 || now - checked > regionalFreshnessMs(monitor.effectiveDailyBudget ?? monitor.dailyBudget, totalWeight, weight);
}

export function monitorStatus(
  latest: LatestResult[],
  monitor: (Pick<MonitorConfig, "dailyBudget" | "enabled"> & { effectiveDailyBudget?: number }) | null,
  regions: Pick<RegionConfig, "id" | "enabled" | "weight">[],
  now = Date.now()
): MonitorStatus {
  if (monitor && !monitor.enabled) return "paused";
  const active = regions.filter((region) => region.enabled);
  if (!active.length) return "unknown";
  const ids = new Set(active.map((region) => region.id));
  const relevant = latest.filter((item) => ids.has(item.regionId));
  if (!relevant.length) return "idle";
  const fresh = monitor ? relevant.filter((item) => !isRegionResultStale(item, monitor, active, now)) : relevant;
  if (!fresh.length) return "stale";
  const targets = fresh.filter((item) => item.resultType !== "infrastructure");
  const failures = targets.filter((item) => !item.ok).length;
  if (failures > 0) return failures === active.length ? "down" : "partial";
  if (fresh.some((item) => item.resultType === "infrastructure")) return "unknown";
  return targets.length === active.length ? "up" : "incomplete";
}
