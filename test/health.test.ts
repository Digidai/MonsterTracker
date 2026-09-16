import { afterEach, describe, expect, it, vi } from "vitest";
import type { MonitorConfig, ProbeResult, RegionConfig } from "../src/domain";
import { isRegionResultStale, regionalFreshnessMs } from "../src/health";
import { buildSchedulePlan } from "../src/scheduler";
import { expireStaleIncidents, saveProbeResults } from "../src/storage";
import { databaseHarness } from "./d1-harness";

afterEach(() => { vi.useRealTimers(); });

const monitor: MonitorConfig = {
  id: "m0", name: "Monitor", url: "https://example.com/", method: "HEAD",
  expectedStatusMin: 200, expectedStatusMax: 399, bodyMatch: null, timeoutMs: 1000,
  dailyBudget: 100, enabled: true, configVersion: 1, tags: [],
  createdAt: "2026-01-01", updatedAt: "2026-01-01"
};

function region(id: string, weight: number): RegionConfig {
  return { id, weight, label: id, area: "Area", provider: "aws", providerRegion: "us-east-1",
    placementRegion: "aws:us-east-1", workerName: id, workerUrl: null, tier: "core", enabled: true,
    lastSeenColo: null, lastSeenCountry: null, lastSeenPlacement: null, lastSeenAt: null,
    createdAt: "2026-01-01", updatedAt: "2026-01-01" };
}

function scheduledGaps(regions: RegionConfig[], config = monitor) {
  const last = new Map<string, number>();
  const gaps: { regionId: string; previous: number; next: number; crossesMidnight: boolean }[] = [];
  const start = Date.parse("2026-09-14T00:00:00.000Z");
  for (let minute = 0; minute < 7 * 1440; minute++) {
    const now = start + minute * 60_000;
    for (const job of buildSchedulePlan([config], regions, new Date(now)).jobs) {
      const previous = last.get(job.region.id);
      if (previous !== undefined) gaps.push({ regionId: job.region.id, previous, next: now,
        crossesMidnight: Math.floor(previous / 86_400_000) !== Math.floor(now / 86_400_000) });
      last.set(job.region.id, now);
    }
  }
  return gaps;
}

describe("freshness follows the weighted scheduler", () => {
  it.each([
    [region("r0", 10), region("r1", 10)],
    Array.from({ length: 20 }, (_, i) => region(`r${i}`, i === 0 ? 10 : 1))
  ])("does not expire healthy evidence during consecutive weighted slots", (...regions) => {
    const gaps = scheduledGaps(regions);
    expect(gaps.some((gap) => !gap.crossesMidnight && gap.next - gap.previous > 120 * 60_000)).toBe(true);
    for (const gap of gaps) {
      expect(isRegionResultStale({ regionId: gap.regionId, checkedAt: new Date(gap.previous).toISOString() },
        monitor, regions, gap.next - 1)).toBe(false);
    }
  });

  it("allows three maximum-gap intervals including a changed seed at UTC midnight", () => {
    const regions = [region("r0", 10), region("r1", 10)];
    const gaps = scheduledGaps(regions);
    const midnight = gaps.filter((gap) => gap.crossesMidnight);
    const withinDayMaximum = Math.max(...gaps.filter((gap) => !gap.crossesMidnight).map((gap) => gap.next - gap.previous));
    expect(Math.max(...midnight.map((gap) => gap.next - gap.previous))).toBeGreaterThan(withinDayMaximum);
    for (const gap of midnight) {
      const freshness = regionalFreshnessMs(100, 20, 10);
      expect(freshness).toBeGreaterThanOrEqual(3 * (gap.next - gap.previous));
      const result = { regionId: gap.regionId, checkedAt: new Date(gap.previous).toISOString() };
      expect(isRegionResultStale(result, monitor, regions, gap.previous + freshness)).toBe(false);
      expect(isRegionResultStale(result, monitor, regions, gap.previous + freshness + 1)).toBe(true);
    }
  });

  it("retains the seven-day ceiling when a day can skip a region entirely", () => {
    expect(regionalFreshnessMs(1, 24, 1)).toBe(7 * 86_400_000);
    expect(regionalFreshnessMs(0, 24, 1)).toBe(7 * 86_400_000);
  });

  it("keeps SQL incidents open across natural gaps, then expires them with the shared policy", async () => {
    const db = databaseHarness();
    const regions = Array.from({ length: 20 }, (_, i) => region(`r${i}`, i === 0 ? 10 : 1));
    const gap = scheduledGaps(regions).find((item) => item.regionId === "r0" && item.next - item.previous >= 288 * 60_000);
    expect(gap).toBeDefined();
    if (!gap) throw new Error("Expected a weighted scheduling gap");
    try {
      db.sqlite.exec(`INSERT INTO monitors(id,name,url,daily_budget,created_at,updated_at)
        VALUES ('m0','Monitor','https://example.com/',100,'2026-01-01','2026-01-01')`);
      for (const item of regions) db.sqlite.prepare(`INSERT INTO regions(id,label,area,provider,provider_region,placement_region,worker_name,weight,created_at,updated_at)
        VALUES (?,?,'Area','aws','us-east-1','aws:us-east-1',?,?,'2026-01-01','2026-01-01')`)
        .run(item.id, item.id, item.id, item.weight);
      vi.useFakeTimers(); vi.setSystemTime(gap.previous);
      const failure: ProbeResult = { id: "failure", runId: "test", monitorId: "m0", monitorConfigVersion: 1,
        regionId: "r0", targetUrl: monitor.url, checkedAt: new Date().toISOString(), ok: false, resultType: "target",
        status: 503, latencyMs: 20, error: null, method: "HEAD", entryColo: null, entryCountry: null,
        entryCity: null, entryAsn: null, entryAsOrganization: null, placement: null, responseBytes: 0 };
      await saveProbeResults(db.env, [failure]);
      vi.setSystemTime(gap.next - 1);
      await expireStaleIncidents(db.env);
      expect(db.sqlite.prepare("SELECT status FROM incidents").get()?.status).toBe("open");
      const expires = Date.parse(String(db.sqlite.prepare("SELECT expires_at FROM incidents").get()?.expires_at));
      expect(expires).toBe(gap.previous + regionalFreshnessMs(100, 29, 10));
      vi.setSystemTime(expires + 1);
      await expireStaleIncidents(db.env);
      expect(db.sqlite.prepare("SELECT status,closed_at FROM incidents").get()).toMatchObject({ status: "unknown", closed_at: null });
    } finally { db.sqlite.close(); }
  });
});
