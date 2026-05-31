import type {
  Incident,
  LatestResult,
  MonitorConfig,
  MonitorMethod,
  ProbeResult,
  RegionConfig,
  RuntimeEnv,
  Summary,
  UsageSummary
} from "./domain";
import {
  DEFAULT_EXPECTED_STATUS_MAX,
  DEFAULT_EXPECTED_STATUS_MIN,
  MAX_BODY_MATCH_BYTES,
  DEFAULT_TIMEOUT_MS,
  boolFromDb,
  createId,
  nowIso,
  nullableTextField,
  numberField,
  parsePositiveInt,
  parseTags,
  textField
} from "./domain";
import { getRegionSeeds, probeWorkerName } from "./regions";

type DbRow = Record<string, unknown>;

export interface CreateMonitorInput {
  name?: string;
  url: string;
  method?: MonitorMethod;
  expectedStatusMin?: number;
  expectedStatusMax?: number;
  bodyMatch?: string | null;
  timeoutMs?: number;
  dailyBudget?: number;
  tags?: string[];
}

export interface UpdateMonitorInput {
  name?: string;
  url?: string;
  method?: MonitorMethod;
  expectedStatusMin?: number;
  expectedStatusMax?: number;
  bodyMatch?: string | null;
  timeoutMs?: number;
  dailyBudget?: number;
  enabled?: boolean;
  tags?: string[];
}

export interface UpdateRegionInput {
  workerUrl?: string | null;
  enabled?: boolean;
  weight?: number;
}

export async function bootstrapDefaults(env: RuntimeEnv): Promise<void> {
  const existing = await env.DB.prepare("SELECT COUNT(*) AS count FROM regions").first<{ count: number }>();
  if ((existing?.count ?? 0) > 0) return;

  const now = nowIso();
  const seeds = getRegionSeeds(env.REGION_PACK ?? "core");
  const statements = seeds.map((seed) =>
    env.DB.prepare(
      `INSERT INTO regions (
        id, label, area, provider, provider_region, placement_region, worker_name,
        worker_url, tier, enabled, weight, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, 1, 1, ?, ?)`
    ).bind(
      seed.id,
      seed.label,
      seed.area,
      seed.provider,
      seed.providerRegion,
      seed.placementRegion,
      probeWorkerName(seed.id),
      seed.tier,
      now,
      now
    )
  );
  if (statements.length > 0) {
    await env.DB.batch(statements);
  }
}

export async function createMonitor(env: RuntimeEnv, input: CreateMonitorInput): Promise<MonitorConfig> {
  const url = normalizeHttpUrl(input.url, env);
  const now = nowIso();
  const id = createId("mon");
  const method = input.method === "GET" ? "GET" : "HEAD";
  const name = input.name?.trim() || new URL(url).hostname;
  const expectedStatusMin = normalizeStatus(input.expectedStatusMin, DEFAULT_EXPECTED_STATUS_MIN);
  const expectedStatusMax = normalizeStatus(input.expectedStatusMax, DEFAULT_EXPECTED_STATUS_MAX);
  validateStatusRange(expectedStatusMin, expectedStatusMax);
  const timeoutMs = clampInt(input.timeoutMs, 1000, 60_000, DEFAULT_TIMEOUT_MS);
  const dailyBudget = clampInt(
    input.dailyBudget,
    1,
    parsePositiveInt(env.MAX_MONITOR_DAILY_BUDGET, 10_000),
    parsePositiveInt(env.DEFAULT_DAILY_PROBE_BUDGET, 100)
  );
  const tags = input.tags?.filter((tag) => tag.trim().length > 0).map((tag) => tag.trim()) ?? [];
  const bodyMatch = normalizeBodyMatch(input.bodyMatch);

  await env.DB.prepare(
    `INSERT INTO monitors (
      id, name, url, method, expected_status_min, expected_status_max,
      body_match, timeout_ms, daily_budget, enabled, tags_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`
  )
    .bind(
      id,
      name,
      url,
      method,
      expectedStatusMin,
      expectedStatusMax,
      bodyMatch,
      timeoutMs,
      dailyBudget,
      JSON.stringify(tags),
      now,
      now
    )
    .run();

  return {
    id,
    name,
    url,
    method,
    expectedStatusMin,
    expectedStatusMax,
    bodyMatch,
    timeoutMs,
    dailyBudget,
    enabled: true,
    tags,
    createdAt: now,
    updatedAt: now
  };
}

export async function updateMonitor(
  env: RuntimeEnv,
  id: string,
  patch: UpdateMonitorInput
): Promise<MonitorConfig> {
  const existing = await env.DB.prepare("SELECT * FROM monitors WHERE id = ?").bind(id).first<DbRow>();
  if (!existing) throw new Error("Monitor not found.");
  const current = mapMonitor(existing);
  const url = patch.url !== undefined ? normalizeHttpUrl(patch.url, env) : current.url;
  const method = patch.method === "GET" ? "GET" : patch.method === "HEAD" ? "HEAD" : current.method;
  const name = patch.name !== undefined ? patch.name.trim() || new URL(url).hostname : current.name;
  const expectedStatusMin = normalizeStatus(patch.expectedStatusMin, current.expectedStatusMin);
  const expectedStatusMax = normalizeStatus(patch.expectedStatusMax, current.expectedStatusMax);
  validateStatusRange(expectedStatusMin, expectedStatusMax);
  const timeoutMs = clampInt(patch.timeoutMs, 1000, 60_000, current.timeoutMs);
  const dailyBudget = clampInt(
    patch.dailyBudget,
    1,
    parsePositiveInt(env.MAX_MONITOR_DAILY_BUDGET, 10_000),
    current.dailyBudget
  );
  const tags = patch.tags !== undefined ? normalizeTags(patch.tags) : current.tags;
  const bodyMatch = patch.bodyMatch !== undefined ? normalizeBodyMatch(patch.bodyMatch) : current.bodyMatch;
  const enabled = patch.enabled !== undefined ? patch.enabled : current.enabled;
  const updatedAt = nowIso();

  await env.DB.prepare(
    `UPDATE monitors SET
      name = ?,
      url = ?,
      method = ?,
      expected_status_min = ?,
      expected_status_max = ?,
      body_match = ?,
      timeout_ms = ?,
      daily_budget = ?,
      enabled = ?,
      tags_json = ?,
      updated_at = ?
    WHERE id = ?`
  )
    .bind(
      name,
      url,
      method,
      expectedStatusMin,
      expectedStatusMax,
      bodyMatch,
      timeoutMs,
      dailyBudget,
      enabled ? 1 : 0,
      JSON.stringify(tags),
      updatedAt,
      id
    )
    .run();

  const probeShapeChanged =
    url !== current.url ||
    method !== current.method ||
    expectedStatusMin !== current.expectedStatusMin ||
    expectedStatusMax !== current.expectedStatusMax ||
    bodyMatch !== current.bodyMatch ||
    enabled !== current.enabled;
  if (probeShapeChanged) {
    await resetMonitorRuntimeState(env, id, enabled ? "config_changed" : "monitor_disabled");
  }

  return {
    id,
    name,
    url,
    method,
    expectedStatusMin,
    expectedStatusMax,
    bodyMatch,
    timeoutMs,
    dailyBudget,
    enabled,
    tags,
    createdAt: current.createdAt,
    updatedAt
  };
}

export async function updateRegion(
  env: RuntimeEnv,
  id: string,
  patch: UpdateRegionInput
): Promise<RegionConfig> {
  const existing = await env.DB.prepare("SELECT * FROM regions WHERE id = ?").bind(id).first<DbRow>();
  if (!existing) throw new Error("Region not found.");
  const current = mapRegion(existing);
  const workerUrl = patch.workerUrl !== undefined ? normalizeWorkerUrl(patch.workerUrl) : current.workerUrl;
  const enabled = patch.enabled !== undefined ? patch.enabled : current.enabled;
  const weight = clampInt(patch.weight, 1, 100, current.weight);
  const updatedAt = nowIso();

  await env.DB.prepare(
    `UPDATE regions SET
      worker_url = ?,
      enabled = ?,
      weight = ?,
      updated_at = ?
    WHERE id = ?`
  )
    .bind(workerUrl, enabled ? 1 : 0, weight, updatedAt, id)
    .run();

  return {
    ...current,
    workerUrl,
    enabled,
    weight,
    updatedAt
  };
}

export async function listMonitors(env: RuntimeEnv): Promise<MonitorConfig[]> {
  const result = await env.DB.prepare("SELECT * FROM monitors ORDER BY created_at DESC").all<DbRow>();
  return (result.results ?? []).map(mapMonitor);
}

export async function listRegions(env: RuntimeEnv): Promise<RegionConfig[]> {
  const result = await env.DB.prepare(
    "SELECT * FROM regions ORDER BY enabled DESC, area ASC, label ASC"
  ).all<DbRow>();
  return (result.results ?? []).map(mapRegion);
}

export async function listLatest(env: RuntimeEnv): Promise<LatestResult[]> {
  const result = await env.DB.prepare(
    "SELECT * FROM monitor_latest ORDER BY checked_at DESC LIMIT 1000"
  ).all<DbRow>();
  return (result.results ?? []).map(mapLatest);
}

export async function listOpenIncidents(env: RuntimeEnv): Promise<Incident[]> {
  const result = await env.DB.prepare(
    "SELECT * FROM incidents WHERE status = 'open' ORDER BY opened_at DESC LIMIT 100"
  ).all<DbRow>();
  return (result.results ?? []).map(mapIncident);
}

export async function getUsageSummary(env: RuntimeEnv): Promise<UsageSummary> {
  const today = new Date().toISOString().slice(0, 10);
  const row = await env.DB.prepare("SELECT * FROM daily_usage WHERE date = ?").bind(today).first<DbRow>();
  if (!row) {
    return {
      date: today,
      probeResults: 0,
      workerInvocations: 0,
      queueMessages: 0,
      d1Writes: 0
    };
  }
  return mapUsage(row);
}

export async function getSummary(env: RuntimeEnv): Promise<Summary> {
  await bootstrapDefaults(env);
  const [monitors, regions, latest, incidents, usage] = await Promise.all([
    listMonitors(env),
    listRegions(env),
    listLatest(env),
    listOpenIncidents(env),
    getUsageSummary(env)
  ]);
  return {
    generatedAt: nowIso(),
    monitors,
    regions,
    latest,
    incidents,
    usage
  };
}

export async function saveProbeResults(env: RuntimeEnv, results: ProbeResult[]): Promise<void> {
  if (results.length === 0) return;
  let d1Writes = 0;
  for (let index = 0; index < results.length; index += 25) {
    d1Writes += await saveProbeResultChunk(env, results.slice(index, index + 25));
  }
  await bumpDailyUsage(env, { probeResults: results.length, d1Writes });
  writeAnalytics(env, results);
  await updateIncidents(env, [...new Set(results.map((result) => result.monitorId))]);
}

async function saveProbeResultChunk(env: RuntimeEnv, results: ProbeResult[]): Promise<number> {
  const statements: D1PreparedStatement[] = [];
  for (const result of results) {
    statements.push(
      env.DB.prepare(
        `INSERT OR REPLACE INTO probe_results (
          id, run_id, monitor_id, region_id, target_url, checked_at, ok, status, latency_ms,
          error, method, entry_colo, entry_country, entry_city, entry_asn, entry_as_organization,
          placement, response_bytes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        result.id,
        result.runId,
        result.monitorId,
        result.regionId,
        result.targetUrl,
        result.checkedAt,
        result.ok ? 1 : 0,
        result.status,
        result.latencyMs,
        result.error,
        result.method,
        result.entryColo,
        result.entryCountry,
        result.entryCity,
        result.entryAsn,
        result.entryAsOrganization,
        result.placement,
        result.responseBytes
      )
    );
    statements.push(
      env.DB.prepare(
        `INSERT INTO monitor_latest (
          monitor_id, region_id, result_id, checked_at, ok, status, latency_ms,
          error, entry_colo, placement
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(monitor_id, region_id) DO UPDATE SET
          result_id = excluded.result_id,
          checked_at = excluded.checked_at,
          ok = excluded.ok,
          status = excluded.status,
          latency_ms = excluded.latency_ms,
          error = excluded.error,
          entry_colo = excluded.entry_colo,
          placement = excluded.placement`
      ).bind(
        result.monitorId,
        result.regionId,
        result.id,
        result.checkedAt,
        result.ok ? 1 : 0,
        result.status,
        result.latencyMs,
        result.error,
        result.entryColo,
        result.placement
      )
    );
    statements.push(
      env.DB.prepare(
        `UPDATE regions SET
          last_seen_colo = ?,
          last_seen_country = ?,
          last_seen_placement = ?,
          last_seen_at = ?,
          updated_at = ?
        WHERE id = ?`
      ).bind(
        result.entryColo,
        result.entryCountry,
        result.placement,
        result.checkedAt,
        result.checkedAt,
        result.regionId
      )
    );
  }
  await env.DB.batch(statements);
  return statements.length;
}

export async function archiveProbeResults(env: RuntimeEnv, results: ProbeResult[]): Promise<void> {
  if (!env.ARCHIVE || env.ARCHIVE_RAW_RESULTS === "false" || results.length === 0) return;
  const date = new Date().toISOString().slice(0, 10);
  const hour = new Date().toISOString().slice(11, 13);
  const key = `probe-results/date=${date}/hour=${hour}/${crypto.randomUUID()}.json`;
  await env.ARCHIVE.put(key, JSON.stringify(results), {
    httpMetadata: { contentType: "application/json" }
  });
}

export async function recordQueueMessages(env: RuntimeEnv, count: number): Promise<void> {
  await bumpDailyUsage(env, { queueMessages: count });
}

export async function recordWorkerInvocation(env: RuntimeEnv, count = 1): Promise<void> {
  await bumpDailyUsage(env, { workerInvocations: count });
}

export async function cleanupRetention(env: RuntimeEnv): Promise<void> {
  const days = parsePositiveInt(env.DEFAULT_RETENTION_DAYS, 30);
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  await env.DB.prepare("DELETE FROM probe_results WHERE checked_at < ?").bind(cutoff).run();
}

async function bumpDailyUsage(
  env: RuntimeEnv,
  patch: Partial<Omit<UsageSummary, "date">>
): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  const now = nowIso();
  await env.DB.prepare(
    `INSERT INTO daily_usage (
      date, probe_results, worker_invocations, queue_messages, d1_writes, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(date) DO UPDATE SET
      probe_results = probe_results + excluded.probe_results,
      worker_invocations = worker_invocations + excluded.worker_invocations,
      queue_messages = queue_messages + excluded.queue_messages,
      d1_writes = d1_writes + excluded.d1_writes,
      updated_at = excluded.updated_at`
  )
    .bind(
      today,
      patch.probeResults ?? 0,
      patch.workerInvocations ?? 0,
      patch.queueMessages ?? 0,
      patch.d1Writes ?? 0,
      now
    )
    .run();
}

async function updateIncidents(env: RuntimeEnv, monitorIds: string[]): Promise<void> {
  for (const monitorId of monitorIds) {
    const failing = await env.DB.prepare(
      `SELECT COUNT(*) AS count
       FROM monitor_latest
       WHERE monitor_id = ? AND ok = 0`
    )
      .bind(monitorId)
      .first<{ count: number }>();
    const failingRegions = failing?.count ?? 0;
    const openIncident = await env.DB.prepare(
      "SELECT * FROM incidents WHERE monitor_id = ? AND status = 'open' ORDER BY opened_at DESC LIMIT 1"
    )
      .bind(monitorId)
      .first<DbRow>();

    if (failingRegions > 0 && !openIncident) {
      await env.DB.prepare(
        `INSERT INTO incidents (
          id, monitor_id, opened_at, severity, status, failing_regions, summary
        ) VALUES (?, ?, ?, ?, 'open', ?, ?)`
      )
        .bind(
          createId("inc"),
          monitorId,
          nowIso(),
          failingRegions >= 3 ? "outage" : "degraded",
          failingRegions,
          `${failingRegions} region${failingRegions === 1 ? "" : "s"} failing`
        )
        .run();
    } else if (failingRegions === 0 && openIncident) {
      await env.DB.prepare(
        "UPDATE incidents SET status = 'resolved', closed_at = ? WHERE id = ?"
      )
        .bind(nowIso(), textField(openIncident, "id"))
        .run();
    } else if (failingRegions > 0 && openIncident) {
      await env.DB.prepare(
        `UPDATE incidents SET
          failing_regions = ?,
          severity = ?,
          summary = ?
        WHERE id = ?`
      )
        .bind(
          failingRegions,
          failingRegions >= 3 ? "outage" : "degraded",
          `${failingRegions} region${failingRegions === 1 ? "" : "s"} failing`,
          textField(openIncident, "id")
        )
        .run();
    }
  }
}

async function resetMonitorRuntimeState(env: RuntimeEnv, monitorId: string, reason: string): Promise<void> {
  const now = nowIso();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM monitor_latest WHERE monitor_id = ?").bind(monitorId),
    env.DB.prepare(
      `UPDATE incidents SET
        status = 'resolved',
        closed_at = ?,
        summary = ?
      WHERE monitor_id = ? AND status = 'open'`
    ).bind(now, `Resolved after ${reason.replaceAll("_", " ")}`, monitorId)
  ]);
}

function writeAnalytics(env: RuntimeEnv, results: ProbeResult[]): void {
  if (!env.ANALYTICS) return;
  for (const result of results) {
    env.ANALYTICS.writeDataPoint({
      blobs: [
        result.monitorId,
        result.regionId,
        result.targetUrl,
        result.error ?? "",
        result.entryColo ?? "",
        result.placement ?? ""
      ],
      doubles: [result.latencyMs ?? -1, result.status ?? 0, result.ok ? 1 : 0, result.responseBytes],
      indexes: [result.monitorId]
    });
  }
}

function mapMonitor(row: DbRow): MonitorConfig {
  return {
    id: textField(row, "id"),
    name: textField(row, "name"),
    url: textField(row, "url"),
    method: textField(row, "method", "HEAD") === "GET" ? "GET" : "HEAD",
    expectedStatusMin: numberField(row, "expected_status_min", DEFAULT_EXPECTED_STATUS_MIN),
    expectedStatusMax: numberField(row, "expected_status_max", DEFAULT_EXPECTED_STATUS_MAX),
    bodyMatch: nullableTextField(row, "body_match"),
    timeoutMs: numberField(row, "timeout_ms", DEFAULT_TIMEOUT_MS),
    dailyBudget: numberField(row, "daily_budget", 100),
    enabled: boolFromDb(row.enabled),
    tags: parseTags(row.tags_json),
    createdAt: textField(row, "created_at"),
    updatedAt: textField(row, "updated_at")
  };
}

function mapRegion(row: DbRow): RegionConfig {
  const tier = textField(row, "tier", "core");
  return {
    id: textField(row, "id"),
    label: textField(row, "label"),
    area: textField(row, "area"),
    provider: textField(row, "provider"),
    providerRegion: textField(row, "provider_region"),
    placementRegion: textField(row, "placement_region"),
    workerName: textField(row, "worker_name"),
    workerUrl: nullableTextField(row, "worker_url"),
    tier: tier === "max" || tier === "extended" ? tier : "core",
    enabled: boolFromDb(row.enabled),
    weight: numberField(row, "weight", 1),
    lastSeenColo: nullableTextField(row, "last_seen_colo"),
    lastSeenCountry: nullableTextField(row, "last_seen_country"),
    lastSeenPlacement: nullableTextField(row, "last_seen_placement"),
    lastSeenAt: nullableTextField(row, "last_seen_at"),
    createdAt: textField(row, "created_at"),
    updatedAt: textField(row, "updated_at")
  };
}

function mapLatest(row: DbRow): LatestResult {
  return {
    monitorId: textField(row, "monitor_id"),
    regionId: textField(row, "region_id"),
    resultId: textField(row, "result_id"),
    checkedAt: textField(row, "checked_at"),
    ok: boolFromDb(row.ok),
    status: nullableNumber(row.status),
    latencyMs: nullableNumber(row.latency_ms),
    error: nullableTextField(row, "error"),
    entryColo: nullableTextField(row, "entry_colo"),
    placement: nullableTextField(row, "placement")
  };
}

function mapIncident(row: DbRow): Incident {
  return {
    id: textField(row, "id"),
    monitorId: textField(row, "monitor_id"),
    openedAt: textField(row, "opened_at"),
    closedAt: nullableTextField(row, "closed_at"),
    severity: textField(row, "severity"),
    status: textField(row, "status"),
    failingRegions: numberField(row, "failing_regions"),
    summary: textField(row, "summary")
  };
}

function mapUsage(row: DbRow): UsageSummary {
  return {
    date: textField(row, "date"),
    probeResults: numberField(row, "probe_results"),
    workerInvocations: numberField(row, "worker_invocations"),
    queueMessages: numberField(row, "queue_messages"),
    d1Writes: numberField(row, "d1_writes")
  };
}

function nullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeHttpUrl(input: string, env: RuntimeEnv): string {
  const url = new URL(input);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only http and https URLs are supported.");
  }
  if (url.username || url.password) {
    throw new Error("Target URLs must not include embedded credentials.");
  }
  if (env.ALLOW_PRIVATE_TARGETS !== "true" && isBlockedTargetHostname(url.hostname)) {
    throw new Error("Private, local, reserved, and IP-literal targets are blocked by default.");
  }
  url.hash = "";
  return url.toString();
}

function normalizeWorkerUrl(input: string | null): string | null {
  const trimmed = input?.trim();
  if (!trimmed) return null;
  const url = new URL(trimmed);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Worker URL must use http or https.");
  }
  if (url.username || url.password) {
    throw new Error("Worker URL must not include embedded credentials.");
  }
  url.hash = "";
  return url.toString();
}

function normalizeBodyMatch(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  if (new TextEncoder().encode(trimmed).length > MAX_BODY_MATCH_BYTES) {
    throw new Error("bodyMatch is too large.");
  }
  return trimmed;
}

function normalizeTags(tags: string[]): string[] {
  return [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))].slice(0, 20);
}

function isBlockedTargetHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  if (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local") ||
    normalized.endsWith(".internal") ||
    normalized.endsWith(".home.arpa")
  ) {
    return true;
  }
  if (isIpv4Literal(normalized)) {
    return isBlockedIpv4(normalized);
  }
  if (normalized.includes(":")) {
    return true;
  }
  return false;
}

function isIpv4Literal(hostname: string): boolean {
  const parts = hostname.split(".");
  return parts.length === 4 && parts.every((part) => /^\d+$/.test(part) && Number(part) >= 0 && Number(part) <= 255);
}

function isBlockedIpv4(hostname: string): boolean {
  const [a = 0, b = 0] = hostname.split(".").map((part) => Number(part));
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 0 && hostname.startsWith("192.0.2.")) ||
    (a === 198 && (b === 18 || b === 19 || b === 51)) ||
    (a === 203 && b === 0) ||
    a >= 224
  );
}

function normalizeStatus(value: number | undefined, fallback: number): number {
  return clampInt(value, 100, 599, fallback);
}

function validateStatusRange(min: number, max: number): void {
  if (min > max) throw new Error("expectedStatusMin must be less than or equal to expectedStatusMax.");
}

function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  const int = Math.floor(value as number);
  return Math.max(min, Math.min(max, int));
}
