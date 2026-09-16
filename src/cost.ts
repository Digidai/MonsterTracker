import { quotaForMinute } from "./scheduler";
import { RESULT_BATCH_LIMIT } from "./domain";

export interface CostEstimateInput {
  urlCount: number;
  probesPerDay: number;
  queueBatchSize: number;
  daysPerMonth?: number;
  monitorBudgets?: number[];
}

export interface CostEstimate {
  urlCount: number;
  probesPerDay: number;
  averageProbesPerUrlPerDay: number;
  probesPerMonth: number;
  controlCronInvocationsPerDay: number;
  queueConsumerInvocationsPerDay: number;
  probeWorkerInvocationsPerDayWorstCase: number;
  workerRequestsPerDayWorstCase: number;
  queueOperationsPerDay: number;
  analyticsPointsPerDay: number;
  d1RowsWrittenPerDay: number;
  fitsWorkersFree: boolean;
  fitsQueuesFree: boolean;
  fitsAnalyticsFree: boolean;
  fitsD1FreeWrites: null;
  recommendedPlan: "verify-d1" | "workers-paid";
  assumptions: string[];
}

const WORKERS_FREE_REQUESTS_PER_DAY = 100_000;
const QUEUES_FREE_OPS_PER_DAY = 10_000;
const ANALYTICS_FREE_POINTS_PER_DAY = 100_000;

export function estimateCost(input: CostEstimateInput): CostEstimate {
  const urlCount = Math.min(1000, positiveInteger(input.urlCount, 1));
  const requested = Math.min(10_000_000, nonNegativeInteger(input.probesPerDay, 0));
  const budgets = input.monitorBudgets?.slice(0, 1000).map((value) => Math.min(10_000_000, nonNegativeInteger(value, 0)))
    ?? Array.from({ length: urlCount }, (_, i) => Math.floor(requested / urlCount) + (i < requested % urlCount ? 1 : 0));
  const probesPerDay = budgets.reduce((sum, budget) => sum + budget, 0);
  const queueBatchSize = Math.min(RESULT_BATCH_LIMIT, positiveInteger(input.queueBatchSize, 1));
  const days = positiveInteger(input.daysPerMonth ?? 30, 30);
  const budgetCounts = new Map<number, number>();
  for (const budget of budgets) budgetCounts.set(budget, (budgetCounts.get(budget) ?? 0) + 1);
  let queueMessagesPerDay = 0;
  for (let minute = 0; minute < 1440; minute++) {
    let count = 0;
    for (const [budget, multiplicity] of budgetCounts) count += quotaForMinute(budget, minute) * multiplicity;
    queueMessagesPerDay += Math.ceil(count / queueBatchSize);
  }
  const queueOperationsPerDay = queueMessagesPerDay * 3;
  const controlCronInvocationsPerDay = 1_440;
  const queueConsumerInvocationsPerDay = queueMessagesPerDay;
  const probeWorkerInvocationsPerDayWorstCase = probesPerDay;
  const workerRequestsPerDayWorstCase =
    controlCronInvocationsPerDay + queueConsumerInvocationsPerDay + probeWorkerInvocationsPerDayWorstCase;

  const fitsWorkersFree = workerRequestsPerDayWorstCase <= WORKERS_FREE_REQUESTS_PER_DAY;
  const fitsQueuesFree = queueOperationsPerDay <= QUEUES_FREE_OPS_PER_DAY;
  const fitsAnalyticsFree = probesPerDay <= ANALYTICS_FREE_POINTS_PER_DAY;
  const d1RowsWrittenPerDay = probesPerDay * 3;
  const fitsD1FreeWrites = null;

  return {
    urlCount,
    probesPerDay,
    averageProbesPerUrlPerDay: Math.round(probesPerDay / urlCount),
    probesPerMonth: probesPerDay * days,
    controlCronInvocationsPerDay,
    queueConsumerInvocationsPerDay,
    probeWorkerInvocationsPerDayWorstCase,
    workerRequestsPerDayWorstCase,
    queueOperationsPerDay,
    analyticsPointsPerDay: probesPerDay,
    d1RowsWrittenPerDay,
    fitsWorkersFree,
    fitsQueuesFree,
    fitsAnalyticsFree,
    fitsD1FreeWrites,
    recommendedPlan:
      fitsWorkersFree && fitsQueuesFree && fitsAnalyticsFree ? "verify-d1" : "workers-paid",
    assumptions: [
      input.monitorBudgets ? "Configured effective monitor budgets." : "Budget split evenly across URLs.",
      "All UTC-minute triggers delivered; excludes manual runs, retries and DLQ traffic.",
      "Queue messages under 64 KB; larger messages use additional billing units.",
      "D1 value is a logical row baseline, excluding indexes, acknowledgements, incidents and scheduling. Verify metered writes in Cloudflare."
    ]
  };
}

function nonNegativeInteger(value: number, fallback: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : fallback;
}

function positiveInteger(value: number, fallback: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : fallback;
}
