export interface CostEstimateInput {
  urlCount: number;
  probesPerDay: number;
  queueBatchSize: number;
  daysPerMonth?: number;
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
  fitsD1FreeWrites: boolean;
  recommendedPlan: "free" | "workers-paid";
}

const WORKERS_FREE_REQUESTS_PER_DAY = 100_000;
const QUEUES_FREE_OPS_PER_DAY = 10_000;
const ANALYTICS_FREE_POINTS_PER_DAY = 100_000;
const D1_FREE_WRITES_PER_DAY = 100_000;

export function estimateCost(input: CostEstimateInput): CostEstimate {
  const probesPerDay = nonNegativeInteger(input.probesPerDay, 0);
  const urlCount = positiveInteger(input.urlCount, 1);
  const queueBatchSize = positiveInteger(input.queueBatchSize, 1);
  const days = positiveInteger(input.daysPerMonth ?? 30, 30);
  const activeMinutesPerDay = Math.min(1_440, probesPerDay);
  const queueMessagesPerDay =
    activeMinutesPerDay === 0
      ? 0
      : activeMinutesPerDay * Math.ceil(probesPerDay / activeMinutesPerDay / queueBatchSize);
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
  const fitsD1FreeWrites = d1RowsWrittenPerDay <= D1_FREE_WRITES_PER_DAY;

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
      fitsWorkersFree && fitsQueuesFree && fitsAnalyticsFree && fitsD1FreeWrites ? "free" : "workers-paid"
  };
}

function nonNegativeInteger(value: number, fallback: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : fallback;
}

function positiveInteger(value: number, fallback: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : fallback;
}
