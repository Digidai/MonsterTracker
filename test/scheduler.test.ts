import { describe, expect, it } from "vitest";
import { cumulativeQuotaBeforeMinute, quotaForMinute, stableHash } from "../src/scheduler";

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
});
