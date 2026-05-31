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

export interface Summary {
  generatedAt: string;
  monitors: MonitorConfig[];
  regions: RegionConfig[];
  latest: LatestResult[];
  incidents: Incident[];
  usage: UsageSummary;
}

export type ViewKey = "overview" | "monitors" | "regions" | "incidents" | "usage" | "placement" | "tokens";
export type DetailTab = "overview" | "regions" | "alerts" | "settings";
export type StatusFilter = "all" | "up" | "down" | "idle";

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
