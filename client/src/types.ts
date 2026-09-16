export type MonitorMethod = "HEAD" | "GET";

export interface MonitorConfig {
  effectiveDailyBudget?: number;
  id: string;
  name: string;
  url: string;
  method: MonitorMethod;
  expectedStatusMin: number;
  expectedStatusMax: number;
  bodyMatch: string | null;
  timeoutMs: number;
  dailyBudget: number;
  enabled: boolean;
  configVersion: number;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface RegionConfig {
  id: string;
  label: string;
  area: string;
  provider: string;
  providerRegion: string;
  placementRegion: string;
  workerName: string;
  workerUrl: string | null;
  tier: "core" | "extended" | "max";
  enabled: boolean;
  weight: number;
  lastSeenColo: string | null;
  lastSeenCountry: string | null;
  lastSeenPlacement: string | null;
  lastSeenAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LatestResult {
  resultType?: "target" | "infrastructure";
  monitorId: string;
  regionId: string;
  resultId: string;
  checkedAt: string;
  ok: boolean;
  status: number | null;
  latencyMs: number | null;
  error: string | null;
  entryColo: string | null;
  placement: string | null;
}

export interface ProbeResult {
  resultType?: "target" | "infrastructure";
  id: string;
  runId: string;
  monitorId: string;
  monitorConfigVersion: number;
  regionId: string;
  targetUrl: string;
  checkedAt: string;
  ok: boolean;
  status: number | null;
  latencyMs: number | null;
  error: string | null;
  method: MonitorMethod;
  entryColo: string | null;
  entryCountry: string | null;
  entryCity: string | null;
  entryAsn: number | null;
  entryAsOrganization: string | null;
  placement: string | null;
  responseBytes: number;
}

export interface Incident {
  id: string;
  monitorId: string;
  openedAt: string;
  closedAt: string | null;
  severity: string;
  status: string;
  failingRegions: number;
  summary: string;
}

export interface UsageSummary {
  date: string;
  probeResults: number;
  workerInvocations: number;
  queueMessages: number;
  d1Writes: number;
  reservedProbes: number;
}

export interface SchedulerRun {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  plannedJobs: number;
  dispatchedJobs: number;
  skippedJobs: number;
  error: string | null;
  trigger: "scheduled" | "manual";
}

export interface RunStatus extends SchedulerRun {
  cancelledResults: number;
  unknownResults: number;
  storedResults: number;
  successfulResults: number;
  failedResults: number;
  pendingResults: number;
}

export interface Summary {
  generatedAt: string;
  monitors: MonitorConfig[];
  regions: RegionConfig[];
  latest: LatestResult[];
  incidents: Incident[];
  runs: SchedulerRun[];
  usage: UsageSummary;
  runtime: RuntimeSettings;
}

export interface RuntimeSettings {
  defaultDailyProbeBudget: number;
  maxDailyProbes: number;
  maxMonitorDailyBudget: number;
  retentionDays: number;
  probeBatchSize: number;
  resultQueueBatchSize: number;
  probeConcurrency: number;
  dispatchConcurrency: number;
  probeWorkerHostSuffix: string;
}

export type ViewKey = "overview" | "monitors" | "regions" | "incidents" | "usage" | "placement" | "tokens";
export type DetailTab = "overview" | "history" | "regions" | "alerts" | "settings";
export type { MonitorStatus } from "../../src/health";
import type { MonitorStatus } from "../../src/health";
export type StatusFilter = "all" | MonitorStatus;

export type MonitorConfigPatch = Partial<
  Pick<
    MonitorConfig,
    | "name"
    | "url"
    | "method"
    | "expectedStatusMin"
    | "expectedStatusMax"
    | "bodyMatch"
    | "timeoutMs"
    | "dailyBudget"
    | "enabled"
    | "tags"
  >
>;

export type RegionConfigPatch = Partial<Pick<RegionConfig, "workerUrl" | "enabled" | "weight">>;
