import { describe, expect, it } from "vitest";
import type { MonitorConfig, RegionConfig } from "../src/domain";
import { buildSchedulePlan, cumulativeQuotaBeforeMinute, quotaForMinute, stableHash } from "../src/scheduler";

describe("scheduler budget distribution", () => {
  it("distributes exactly the daily budget across a UTC day", () => {
    const budget = 10_000;
    let total = 0;
    for (let minute = 0; minute < 1440; minute += 1) {
      total += quotaForMinute(budget, minute);
    }
    expect(total).toBe(budget);
  });

  it("keeps low budgets sparse without losing probes", () => {
    const budget = 100;
    let activeMinutes = 0;
    let total = 0;
    for (let minute = 0; minute < 1440; minute += 1) {
      const quota = quotaForMinute(budget, minute);
      if (quota > 0) activeMinutes += 1;
      total += quota;
    }
    expect(total).toBe(100);
    expect(activeMinutes).toBe(100);
  });

  it("reports cumulative budget before a minute boundary", () => {
    expect(cumulativeQuotaBeforeMinute(1440, 0)).toBe(0);
    expect(cumulativeQuotaBeforeMinute(1440, 720)).toBe(720);
    expect(cumulativeQuotaBeforeMinute(1440, 1440)).toBe(1440);
  });

  it("uses a stable unsigned hash", () => {
    expect(stableHash("monitor:2026-05-31")).toBe(stableHash("monitor:2026-05-31"));
    expect(stableHash("monitor:2026-05-31")).toBeGreaterThanOrEqual(0);
  });

  it("uses region weights without changing the daily monitor budget", () => {
    const counts = new Map<string, number>();
    let total = 0;
    for (let minute = 0; minute < 1440; minute += 1) {
      const at = new Date(Date.UTC(2026, 5, 1, 0, minute));
      const plan = buildSchedulePlan(
        [makeMonitor(1440)],
        [makeRegion("primary", 3), makeRegion("secondary", 1)],
        at
      );
      for (const job of plan.jobs) {
        counts.set(job.region.id, (counts.get(job.region.id) ?? 0) + 1);
        total += 1;
      }
    }

    expect(total).toBe(1440);
    expect(counts.get("primary")).toBe(1080);
    expect(counts.get("secondary")).toBe(360);
  });

  it("skips disabled regions regardless of weight", () => {
    const counts = new Map<string, number>();
    for (let minute = 0; minute < 1440; minute += 1) {
      const at = new Date(Date.UTC(2026, 5, 1, 0, minute));
      const plan = buildSchedulePlan(
        [makeMonitor(1440)],
        [makeRegion("paused", 100, false), makeRegion("active", 1)],
        at
      );
      for (const job of plan.jobs) {
        counts.set(job.region.id, (counts.get(job.region.id) ?? 0) + 1);
      }
    }

    expect(counts.get("paused")).toBeUndefined();
    expect(counts.get("active")).toBe(1440);
  });
});

function makeMonitor(dailyBudget: number): MonitorConfig {
  return {
    id: "mon_test",
    name: "Test monitor",
    url: "https://example.com",
    method: "HEAD",
    expectedStatusMin: 200,
    expectedStatusMax: 399,
    bodyMatch: null,
    timeoutMs: 10000,
    dailyBudget,
    enabled: true,
    tags: [],
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z"
  };
}

function makeRegion(id: string, weight: number, enabled = true): RegionConfig {
  return {
    id,
    label: id,
    area: "test",
    provider: "aws",
    providerRegion: "us-east-1",
    placementRegion: "aws:us-east-1",
    workerName: `monstertracker-probe-${id}`,
    workerUrl: `https://${id}.example.workers.dev`,
    tier: "core",
    enabled,
    weight,
    lastSeenColo: null,
    lastSeenCountry: null,
    lastSeenPlacement: null,
    lastSeenAt: null,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z"
  };
}
