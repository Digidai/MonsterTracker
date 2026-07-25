import { describe, expect, it } from "vitest";

import { applyGlobalDailyCap } from "../src/index";

describe("applyGlobalDailyCap", () => {
  it("preserves proportional budgets and uses the full cap", () => {
    const monitors = [
      { id: "a", dailyBudget: 600, enabled: true },
      { id: "b", dailyBudget: 300, enabled: true },
      { id: "c", dailyBudget: 100, enabled: true }
    ];
    const capped = applyGlobalDailyCap(monitors, 100);

    expect(capped.map((monitor) => monitor.dailyBudget)).toEqual([60, 30, 10]);
    expect(capped.reduce((total, monitor) => total + monitor.dailyBudget, 0)).toBe(100);
  });

  it("leaves disabled monitors unchanged and handles a cap below monitor count", () => {
    const monitors = [
      { id: "a", dailyBudget: 10, enabled: true },
      { id: "b", dailyBudget: 10, enabled: true },
      { id: "c", dailyBudget: 10, enabled: true },
      { id: "disabled", dailyBudget: 50, enabled: false }
    ];
    const capped = applyGlobalDailyCap(monitors, 2);

    expect(capped.slice(0, 3).reduce((total, monitor) => total + monitor.dailyBudget, 0)).toBe(2);
    expect(capped[3]?.dailyBudget).toBe(50);
  });

  it("never raises an individual monitor budget while reducing the total", () => {
    const monitors = [
      { id: "a", dailyBudget: 1, enabled: true },
      { id: "b", dailyBudget: 1, enabled: true },
      { id: "c", dailyBudget: 998, enabled: true }
    ];
    const capped = applyGlobalDailyCap(monitors, 500);

    expect(capped.every((monitor, index) => monitor.dailyBudget <= (monitors[index]?.dailyBudget ?? 0))).toBe(true);
    expect(capped.reduce((total, monitor) => total + monitor.dailyBudget, 0)).toBe(500);
  });
});
