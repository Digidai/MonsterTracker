import type { MonitorConfig, ProbeJob, RegionConfig } from "./domain";

export interface SchedulePlan {
  runId: string;
  scheduledAt: string;
  jobs: ProbeJob[];
}

export function quotaForMinute(dailyBudget: number, minuteOfDay: number): number {
  if (!Number.isInteger(dailyBudget) || dailyBudget <= 0) return 0;
  const safeMinute = Math.max(0, Math.min(1439, minuteOfDay));
  const before = Math.floor((safeMinute * dailyBudget) / 1440);
  const after = Math.floor(((safeMinute + 1) * dailyBudget) / 1440);
  return Math.max(0, after - before);
}

export function cumulativeQuotaBeforeMinute(dailyBudget: number, minuteOfDay: number): number {
  if (!Number.isInteger(dailyBudget) || dailyBudget <= 0) return 0;
  const safeMinute = Math.max(0, Math.min(1440, minuteOfDay));
  return Math.floor((safeMinute * dailyBudget) / 1440);
}

export function buildSchedulePlan(
  monitors: MonitorConfig[],
  regions: RegionConfig[],
  scheduledAt: Date,
  runId = `run_${scheduledAt.toISOString().replace(/\D/g, "")}`
): SchedulePlan {
  const enabledMonitors = monitors.filter((monitor) => monitor.enabled && monitor.dailyBudget > 0);
  const enabledRegions = expandWeightedRegions(regions);
  const minuteOfDay = scheduledAt.getUTCHours() * 60 + scheduledAt.getUTCMinutes();
  const dayKey = scheduledAt.toISOString().slice(0, 10);
  const jobs: ProbeJob[] = [];

  if (enabledRegions.length === 0) {
    return { runId, scheduledAt: scheduledAt.toISOString(), jobs };
  }

  for (const monitor of enabledMonitors) {
    const quota = quotaForMinute(monitor.dailyBudget, minuteOfDay);
    const previousQuota = cumulativeQuotaBeforeMinute(monitor.dailyBudget, minuteOfDay);
    const seed = stableHash(`${monitor.id}:${dayKey}`);
    for (let offset = 0; offset < quota; offset += 1) {
      const regionIndex = (seed + previousQuota + offset) % enabledRegions.length;
      const region = enabledRegions[regionIndex];
      if (!region) continue;
      jobs.push({
        runId,
        scheduledAt: scheduledAt.toISOString(),
        monitor: {
          id: monitor.id,
          name: monitor.name,
          url: monitor.url,
          method: monitor.method,
          expectedStatusMin: monitor.expectedStatusMin,
          expectedStatusMax: monitor.expectedStatusMax,
          bodyMatch: monitor.bodyMatch,
          timeoutMs: monitor.timeoutMs
        },
        region: {
          id: region.id,
          label: region.label,
          placementRegion: region.placementRegion,
          workerUrl: region.workerUrl
        }
      });
    }
  }

  return { runId, scheduledAt: scheduledAt.toISOString(), jobs };
}

export function expandWeightedRegions(regions: RegionConfig[]): RegionConfig[] {
  const slots: RegionConfig[] = [];
  for (const region of regions) {
    if (!region.enabled) continue;
    const weight = Number.isFinite(region.weight) ? Math.max(1, Math.min(100, Math.floor(region.weight))) : 1;
    for (let index = 0; index < weight; index += 1) {
      slots.push(region);
    }
  }
  return slots;
}

export function stableHash(input: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
