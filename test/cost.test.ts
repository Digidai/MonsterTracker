import { describe, expect, it } from "vitest";
import { estimateCost } from "../src/cost";

describe("cost estimate", () => {
  it("keeps 10 URLs / 10,000 total probes per day in free quotas when batched", () => {
    const estimate = estimateCost({ urlCount: 10, probesPerDay: 10_000, queueBatchSize: 50 });
    expect(estimate.probesPerMonth).toBe(300_000);
    expect(estimate.queueOperationsPerDay).toBe(600);
    expect(estimate.d1RowsWrittenPerDay).toBe(30_000);
    expect(estimate.recommendedPlan).toBe("free");
  });

  it("recommends paid when worst-case worker requests exceed the free daily quota", () => {
    const estimate = estimateCost({ urlCount: 10, probesPerDay: 100_001, queueBatchSize: 100 });
    expect(estimate.fitsWorkersFree).toBe(false);
    expect(estimate.recommendedPlan).toBe("workers-paid");
  });
});
