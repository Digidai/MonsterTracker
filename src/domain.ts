export type MonitorMethod = "HEAD" | "GET";

export interface MonitorConfig {
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

export interface RegionSeed {
  id: string;
  label: string;
  area: string;
  provider: string;
  providerRegion: string;
  placementRegion: string;
  tier: "core" | "extended" | "max";
}

export interface ProbeJob {
  runId: string;
  scheduledAt: string;
  monitor: Pick<
    MonitorConfig,
    | "id"
    | "name"
    | "url"
    | "method"
    | "expectedStatusMin"
    | "expectedStatusMax"
    | "bodyMatch"
    | "timeoutMs"
  >;
  region: Pick<RegionConfig, "id" | "label" | "placementRegion" | "workerUrl">;
}

export interface ProbeResult {
  id: string;
  runId: string;
  monitorId: string;
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

export interface Summary {
  generatedAt: string;
  monitors: MonitorConfig[];
  regions: RegionConfig[];
  latest: LatestResult[];
  incidents: Incident[];
  runs: SchedulerRun[];
  usage: UsageSummary;
}

export interface LatestResult {
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

export type RuntimeEnv = Omit<
  Env,
  "ROLE" | "REGION_PACK" | "DEFAULT_DAILY_PROBE_BUDGET" | "DEFAULT_RETENTION_DAYS" | "PROBE_BATCH_SIZE" | "ALLOW_LOCAL_PROBES"
> & {
  ASSETS?: { fetch: (request: Request) => Promise<Response> };
  ADMIN_TOKEN?: string;
  SHARED_SECRET?: string;
  PUBLIC_BASE_URL?: string;
  PROBE_URL_TEMPLATE?: string;
  ROLE?: "control" | "probe";
  REGION_ID?: string;
  REGION_LABEL?: string;
  REGION_HINT?: string;
  REGION_PACK?: "core" | "extended" | "max";
  DEFAULT_DAILY_PROBE_BUDGET?: string;
  DEFAULT_RETENTION_DAYS?: string;
  PROBE_BATCH_SIZE?: string;
  MAX_DAILY_PROBES?: string;
  MAX_MONITOR_DAILY_BUDGET?: string;
  ALLOW_PRIVATE_TARGETS?: string;
  ALLOW_LOCAL_PROBES?: string;
  ARCHIVE_RAW_RESULTS?: string;
};

export const DEFAULT_TIMEOUT_MS = 10_000;
export const DEFAULT_EXPECTED_STATUS_MIN = 200;
export const DEFAULT_EXPECTED_STATUS_MAX = 399;
export const MAX_BODY_MATCH_BYTES = 64 * 1024;

export function nowIso(): string {
  return new Date().toISOString();
}

export function boolFromDb(value: unknown): boolean {
  return value === 1 || value === true || value === "1";
}

export function textField(row: Record<string, unknown>, key: string, fallback = ""): string {
  const value = row[key];
  return typeof value === "string" ? value : fallback;
}

export function nullableTextField(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function numberField(row: Record<string, unknown>, key: string, fallback = 0): number {
  const value = row[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function parseTags(value: unknown): string[] {
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

export function createId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

export function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
