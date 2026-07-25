import { describe, expect, it } from "vitest";

import { mapWithConcurrency } from "../src/concurrency";

describe("mapWithConcurrency", () => {
  it("preserves input order while enforcing the concurrency limit", async () => {
    let active = 0;
    let maximumActive = 0;
    const values = await mapWithConcurrency([30, 5, 20, 1, 10], 2, async (delay, index) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, delay));
      active -= 1;
      return index * 10;
    });

    expect(values).toEqual([0, 10, 20, 30, 40]);
    expect(maximumActive).toBe(2);
  });

  it("handles empty input without invoking the mapper", async () => {
    let calls = 0;
    const values = await mapWithConcurrency([], 6, async () => {
      calls += 1;
      return 1;
    });

    expect(values).toEqual([]);
    expect(calls).toBe(0);
  });
});
