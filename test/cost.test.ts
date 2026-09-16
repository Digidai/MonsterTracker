import { describe, expect, it } from "vitest";
import { estimateCost } from "../src/cost";

describe("cost estimate", () => {
  it("simulates per-monitor minute quotas and does not promise free D1 writes", () => {
    const estimate = estimateCost({ urlCount: 10, probesPerDay: 10_000, queueBatchSize: 10 });
    expect(estimate.probesPerMonth).toBe(300_000);
    expect(estimate.averageProbesPerUrlPerDay).toBe(1_000);
    expect(estimate.queueOperationsPerDay).toBe(3_000);
    expect(estimate.workerRequestsPerDayWorstCase).toBe(12_440);
    expect(estimate.d1RowsWrittenPerDay).toBe(30_000);
    expect(estimate.recommendedPlan).toBe("verify-d1");
    expect(estimate.fitsD1FreeWrites).toBeNull();
    expect(estimateCost({urlCount:10, probesPerDay:10000, queueBatchSize:5}).queueOperationsPerDay).toBe(6000);
  });

  it("recommends paid when worst-case worker requests exceed the free daily quota", () => {
    const estimate = estimateCost({ urlCount: 10, probesPerDay: 100_001, queueBatchSize: 100 });
    expect(estimate.fitsWorkersFree).toBe(false);
    expect(estimate.recommendedPlan).toBe("workers-paid");
  });

  it("normalizes non-finite and non-positive public input", () => {
    const estimate = estimateCost({
      urlCount: Number.NaN,
      probesPerDay: Number.NaN,
      queueBatchSize: 0,
      daysPerMonth: Number.POSITIVE_INFINITY
    });
    expect(estimate.urlCount).toBe(1);
    expect(estimate.probesPerDay).toBe(0);
    expect(estimate.probesPerMonth).toBe(0);
    expect(estimate.queueOperationsPerDay).toBe(0);
  });
});
