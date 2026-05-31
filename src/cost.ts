export interface CostEstimateInput {
  urlCount: number;
  probesPerDay: number;
  queueBatchSize: number;
  daysPerMonth?: number;
}

export interface CostEstimate {
  probesPerDay: number;
  probesPerMonth: number;
  workerRequestsPerDayWorstCase: number;
  queueOperationsPerDay: number;
  analyticsPointsPerDay: number;
  d1RowsWrittenPerDay: number;
  fitsWorkersFree: boolean;
  fitsQueuesFree: boolean;
  fitsAnalyticsFree: boolean;
  fitsD1FreeWrites: boolean;
  recommendedPlan: "free" | "workers-paid";
}

const WORKERS_FREE_REQUESTS_PER_DAY = 100_000;
const QUEUES_FREE_OPS_PER_DAY = 10_000;
const ANALYTICS_FREE_POINTS_PER_DAY = 100_000;
const D1_FREE_WRITES_PER_DAY = 100_000;

export function estimateCost(input: CostEstimateInput): CostEstimate {
  const probesPerDay = Math.max(0, Math.floor(input.probesPerDay));
  const queueBatchSize = Math.max(1, Math.floor(input.queueBatchSize));
  const days = input.daysPerMonth ?? 30;
  const queueMessagesPerDay = Math.ceil(probesPerDay / queueBatchSize);
  const queueOperationsPerDay = queueMessagesPerDay * 3;
  const workerRequestsPerDayWorstCase = probesPerDay;

  const fitsWorkersFree = workerRequestsPerDayWorstCase <= WORKERS_FREE_REQUESTS_PER_DAY;
  const fitsQueuesFree = queueOperationsPerDay <= QUEUES_FREE_OPS_PER_DAY;
  const fitsAnalyticsFree = probesPerDay <= ANALYTICS_FREE_POINTS_PER_DAY;
  const d1RowsWrittenPerDay = probesPerDay * 3;
  const fitsD1FreeWrites = d1RowsWrittenPerDay <= D1_FREE_WRITES_PER_DAY;

  return {
    probesPerDay,
    probesPerMonth: probesPerDay * days,
    workerRequestsPerDayWorstCase,
    queueOperationsPerDay,
    analyticsPointsPerDay: probesPerDay,
    d1RowsWrittenPerDay,
    fitsWorkersFree,
    fitsQueuesFree,
    fitsAnalyticsFree,
    fitsD1FreeWrites,
    recommendedPlan:
      fitsWorkersFree && fitsQueuesFree && fitsAnalyticsFree && fitsD1FreeWrites ? "free" : "workers-paid"
  };
}
