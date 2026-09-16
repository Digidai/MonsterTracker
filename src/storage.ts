import type {
  Incident,
  LatestResult,
  MonitorConfig,
  MonitorMethod,
  ProbeJob,
  ProbeResult,
  RegionConfig,
  RuntimeSettings,
  RuntimeEnv,
  RunStatus,
  SchedulerRun,
  Summary,
  UsageSummary
} from "./domain";
import {
  RESULT_BATCH_LIMIT,
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
import { normalizeTargetUrl, normalizeWorkerUrl } from "./validation";

import { applyGlobalDailyCap } from "./budget";
import { regionalFreshnessMs } from "./health";

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

export interface RecordSchedulerRunInput {
  id: string;
  startedAt: string;
  finishedAt?: string | null;
  plannedJobs: number;
  dispatchedJobs: number;
  skippedJobs: number;
  error?: string | null;
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
  const url = normalizeTargetUrl(input.url, { allowPrivateTargets: env.ALLOW_PRIVATE_TARGETS === "true" });
  const now = nowIso();
  const id = createId("mon");
  const method = input.method === "GET" ? "GET" : "HEAD";
  const name = normalizeMonitorName(input.name, new URL(url).hostname);
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
  const tags = normalizeTags(input.tags ?? []);
  const bodyMatch = normalizeBodyMatch(input.bodyMatch);
  validateBodyMatchMethod(method, bodyMatch);

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
    configVersion: 1,
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
  const url =
    patch.url !== undefined
      ? normalizeTargetUrl(patch.url, { allowPrivateTargets: env.ALLOW_PRIVATE_TARGETS === "true" })
      : current.url;
  const method = patch.method === "GET" ? "GET" : patch.method === "HEAD" ? "HEAD" : current.method;
  const name =
    patch.name !== undefined ? normalizeMonitorName(patch.name, new URL(url).hostname) : current.name;
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
  validateBodyMatchMethod(method, bodyMatch);
  const enabled = patch.enabled !== undefined ? patch.enabled : current.enabled;
  const updatedAt = nowIso();
  const probeShapeChanged =
    url !== current.url ||
    method !== current.method ||
    expectedStatusMin !== current.expectedStatusMin ||
    expectedStatusMax !== current.expectedStatusMax ||
    bodyMatch !== current.bodyMatch ||
    timeoutMs !== current.timeoutMs ||
    enabled !== current.enabled;
  const configVersion = current.configVersion + 1;
  const mutationId = createId("mut");

  const updateStatement = env.DB.prepare(
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
      config_version = ?,
      last_mutation_id = ?,
      updated_at = ?
    WHERE id = ? AND config_version = ?`
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
      configVersion,
      mutationId,
      updatedAt,
      id,
      current.configVersion
    );
  const outcomes = probeShapeChanged
    ? await env.DB.batch([
        updateStatement,
        env.DB.prepare(
          `DELETE FROM monitor_latest
           WHERE monitor_id = ?
             AND EXISTS (SELECT 1 FROM monitors WHERE id = ? AND last_mutation_id = ?)`
        ).bind(id, id, mutationId),
        env.DB.prepare(
          `UPDATE incidents SET
            status = 'resolved',
            closed_at = ?,
            summary = ?
           WHERE monitor_id = ? AND status IN ('open', 'unknown')
             AND EXISTS (SELECT 1 FROM monitors WHERE id = ? AND last_mutation_id = ?)`
        ).bind(
          updatedAt,
          `Resolved after ${enabled ? "config changed" : "monitor disabled"}`,
          id,
          id,
          mutationId
        )
      ])
    : await env.DB.batch([updateStatement]);
  if ((outcomes[0]?.meta.changes ?? 0) === 0) {
    throw new Error("Monitor changed concurrently. Refresh and retry.");
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
    configVersion,
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
  if (patch.workerUrl && env.ALLOW_LOCAL_PROBES !== "true" && !env.PROBE_WORKER_HOST_SUFFIX) {
    throw new Error("PROBE_WORKER_HOST_SUFFIX is required before configuring Worker routes.");
  }
  const workerUrl =
    patch.workerUrl !== undefined
      ? normalizeWorkerUrl(patch.workerUrl, {
          allowLocalHttp: env.ALLOW_LOCAL_PROBES === "true",
          allowPrivateTargets: env.ALLOW_LOCAL_PROBES === "true",
          ...(env.PROBE_WORKER_HOST_SUFFIX
            ? { allowedHostnameSuffix: env.PROBE_WORKER_HOST_SUFFIX }
            : {})
        })
      : current.workerUrl;
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
  if (enabled !== current.enabled) {
    await reconcileIncidentsAfterRegionChange(env);
  }

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
    "SELECT * FROM monitor_latest ORDER BY checked_at DESC"
  ).all<DbRow>();
  return (result.results ?? []).map(mapLatest);
}

export async function listIncidents(env: RuntimeEnv, limit = 100): Promise<Incident[]> {
  const safeLimit = normalizeLimit(limit, 100, 500);
  const result = await env.DB.prepare(
    "SELECT * FROM incidents ORDER BY (status IN ('open', 'unknown')) DESC, opened_at DESC LIMIT ?"
  )
    .bind(safeLimit)
    .all<DbRow>();
  return (result.results ?? []).map(mapIncident);
}

export async function listProbeResults(env: RuntimeEnv, monitorId: string, limit = 100): Promise<ProbeResult[]> {
  const safeLimit = normalizeLimit(limit, 100, 500);
  const monitor = await env.DB.prepare("SELECT id FROM monitors WHERE id = ?").bind(monitorId).first<{ id: string }>();
  if (!monitor) throw new Error("Monitor not found.");
  const result = await env.DB.prepare(
    `SELECT * FROM probe_results
     WHERE monitor_id = ?
     ORDER BY checked_at DESC
     LIMIT ?`
  )
    .bind(monitorId, safeLimit)
    .all<DbRow>();
  return (result.results ?? []).map(mapProbeResult);
}

export async function listSchedulerRuns(env: RuntimeEnv, limit = 25): Promise<SchedulerRun[]> {
  const safeLimit = normalizeLimit(limit, 25, 100);
  const result = await env.DB.prepare(
    `SELECT * FROM scheduler_runs
     ORDER BY started_at DESC
     LIMIT ?`
  )
    .bind(safeLimit)
    .all<DbRow>();
  return (result.results ?? []).map(mapSchedulerRun);
}

export async function getRunStatus(env: RuntimeEnv, id: string): Promise<RunStatus | null> {
  const runRow = await env.DB.prepare("SELECT * FROM scheduler_runs WHERE id = ?").bind(id).first<DbRow>();
  if (!runRow) return null;
  const counts = await env.DB.prepare(
    `SELECT
       COUNT(*) AS stored_results,
       SUM(CASE WHEN ok = 1 THEN 1 ELSE 0 END) AS successful_results,
       SUM(CASE WHEN ok = 0 AND result_type = 'target' THEN 1 ELSE 0 END) AS failed_results,
       SUM(CASE WHEN result_type = 'infrastructure' THEN 1 ELSE 0 END) AS unknown_results
     FROM probe_results
     WHERE run_id = ?`
  )
    .bind(id)
    .first<DbRow>();
  const run = mapSchedulerRun(runRow);
  const storedResults = numberField(counts ?? {}, "stored_results");
  return {
    ...run,
    storedResults,
    successfulResults: numberField(counts ?? {}, "successful_results"),
    failedResults: numberField(counts ?? {}, "failed_results"),
    unknownResults: numberField(counts ?? {}, "unknown_results"),
    pendingResults: run.error && run.finishedAt ? 0 : Math.max(0, run.plannedJobs - storedResults)
  };
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
      d1Writes: 0,
      reservedProbes: 0
    };
  }
  return mapUsage(row);
}

export async function getSummary(env: RuntimeEnv): Promise<Summary> {
  await bootstrapDefaults(env);
  const [monitors, regions, latest, incidents, runs, usage] = await Promise.all([
    listMonitors(env),
    listRegions(env),
    listLatest(env),
    listIncidents(env),
    listSchedulerRuns(env),
    getUsageSummary(env)
  ]);
  return {
    generatedAt: nowIso(),
    monitors,
    regions,
    latest,
    incidents,
    runs,
    usage,
    runtime: getRuntimeSettings(env)
  };
}

export function getRuntimeSettings(env: RuntimeEnv): RuntimeSettings {
  return {
    defaultDailyProbeBudget: parsePositiveInt(env.DEFAULT_DAILY_PROBE_BUDGET, 100),
    maxDailyProbes: parsePositiveInt(env.MAX_DAILY_PROBES, 10_000),
    maxMonitorDailyBudget: parsePositiveInt(env.MAX_MONITOR_DAILY_BUDGET, 10_000),
    retentionDays: parsePositiveInt(env.DEFAULT_RETENTION_DAYS, 30),
    probeBatchSize: Math.min(5, parsePositiveInt(env.PROBE_BATCH_SIZE, 5)),
    resultQueueBatchSize: Math.min(RESULT_BATCH_LIMIT, parsePositiveInt(env.RESULT_QUEUE_BATCH_SIZE, RESULT_BATCH_LIMIT)),
    probeConcurrency: Math.min(6, parsePositiveInt(env.PROBE_CONCURRENCY, 6)),
    dispatchConcurrency: Math.min(6, parsePositiveInt(env.DISPATCH_CONCURRENCY, 6)),
    probeWorkerHostSuffix: env.PROBE_WORKER_HOST_SUFFIX || ".workers.dev"
  };
}

export async function recordSchedulerRun(env: RuntimeEnv, input: RecordSchedulerRunInput): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO scheduler_runs (
      id, started_at, finished_at, planned_jobs, dispatched_jobs, skipped_jobs, error
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      started_at = excluded.started_at,
      finished_at = excluded.finished_at,
      planned_jobs = excluded.planned_jobs,
      dispatched_jobs = excluded.dispatched_jobs,
      skipped_jobs = excluded.skipped_jobs,
      error = excluded.error,
      lease_expires_at = CASE WHEN excluded.finished_at IS NOT NULL THEN NULL ELSE scheduler_runs.lease_expires_at END`
  )
    .bind(
      input.id,
      input.startedAt,
      input.finishedAt ?? null,
      input.plannedJobs,
      input.dispatchedJobs,
      input.skippedJobs,
      input.error ?? null
    )
    .run();
}

export async function retryScheduledRun(env: RuntimeEnv, id: string, error: string): Promise<void> {
  const now = nowIso();
  await env.DB.prepare(`UPDATE scheduler_runs SET error = ?,
    finished_at = CASE WHEN attempt_count >= 3 THEN ? ELSE NULL END,
    lease_expires_at = CASE WHEN attempt_count >= 3 THEN NULL ELSE ? END
    WHERE id = ? AND finished_at IS NULL`).bind(error.slice(0, 512), now, new Date(Date.now() + 60_000).toISOString(), id).run();
}

export async function claimScheduledRunAndReserve(
  env: RuntimeEnv,
  input: Pick<RecordSchedulerRunInput, "id" | "startedAt" | "plannedJobs">,
  jobs: ProbeJob[],
  maximum: number,
  budgetDate: string
): Promise<{ claimed: boolean; reserved: boolean }> {
  const cap = Math.max(0, Math.floor(maximum));
  const now = nowIso();
  const leaseExpiresAt = new Date(Date.now() + 16 * 60_000).toISOString();
  const claimToken = createId("claim");
  const outcomes = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO daily_usage (
        date, probe_results, worker_invocations, queue_messages, d1_writes, reserved_probes, updated_at
      ) VALUES (?, 0, 0, 0, 0, 0, ?)
      ON CONFLICT(date) DO NOTHING`
    ).bind(budgetDate, now),
    env.DB.prepare(
      `INSERT INTO scheduler_runs (
        id, started_at, finished_at, planned_jobs, dispatched_jobs, skipped_jobs, error,
        jobs_json, lease_expires_at, attempt_count, claim_token
      ) VALUES (?, ?, NULL, ?, 0, 0, NULL, ?, ?, 1, ?)
      ON CONFLICT(id) DO NOTHING`
    ).bind(input.id, input.startedAt, input.plannedJobs, JSON.stringify(jobs), leaseExpiresAt, claimToken),
    env.DB.prepare(
      `UPDATE daily_usage
       SET reserved_probes = reserved_probes + ?, updated_at = ?
       WHERE date = ? AND changes() = 1 AND reserved_probes + ? <= ?`
    ).bind(input.plannedJobs, now, budgetDate, input.plannedJobs, cap),
    env.DB.prepare(
      `UPDATE scheduler_runs
       SET
         finished_at = ?,
         skipped_jobs = planned_jobs,
         error = 'daily_probe_budget_exhausted',
         jobs_json = NULL,
         lease_expires_at = NULL
       WHERE id = ? AND claim_token = ? AND changes() = 0`
    ).bind(now, input.id, claimToken)
  ]);
  return {
    claimed: (outcomes[1]?.meta.changes ?? 0) > 0,
    reserved: (outcomes[2]?.meta.changes ?? 0) > 0
  };
}

export async function claimRecoverableSchedulerRun(
  env: RuntimeEnv,
  beforeClaim?: (jobs: ProbeJob[]) => void
): Promise<{ id: string; startedAt: string; jobs: ProbeJob[] } | null> {
  const now = nowIso();
  const leaseExpiresAt = new Date(Date.now() + 16 * 60_000).toISOString();
  // A killed invocation never reaches retryScheduledRun. Retire its third
  // expired lease here so crash recovery cannot dispatch a fourth attempt.
  await env.DB.prepare(`UPDATE scheduler_runs
    SET finished_at = ?, lease_expires_at = NULL, error = 'scheduler_retry_limit_exhausted'
    WHERE finished_at IS NULL AND attempt_count >= 3 AND lease_expires_at <= ?`
  ).bind(now, now).run();
  const row = await env.DB.prepare(
    `SELECT id, started_at, jobs_json
       FROM scheduler_runs
       WHERE finished_at IS NULL
         AND attempt_count < 3
         AND jobs_json IS NOT NULL
         AND lease_expires_at IS NOT NULL
         AND lease_expires_at <= ?
       ORDER BY started_at ASC
       LIMIT 1`
  )
    .bind(now)
    .first<{ id: string; started_at: string; jobs_json: string }>();
  if (!row) return null;
  let jobs: unknown;
  try {
    jobs = JSON.parse(row.jobs_json);
  } catch {
    jobs = null;
  }
  if (!Array.isArray(jobs)) {
    await recordSchedulerRun(env, {
      id: row.id,
      startedAt: row.started_at,
      finishedAt: nowIso(),
      plannedJobs: 0,
      dispatchedJobs: 0,
      skippedJobs: 0,
      error: "stored_scheduler_jobs_invalid"
    });
    return null;
  }
  beforeClaim?.(jobs as ProbeJob[]);
  // Recheck the lease atomically: another invocation may have claimed the row
  // after the read/preflight above.
  const claim = await env.DB.prepare(`UPDATE scheduler_runs
    SET lease_expires_at = ?, attempt_count = attempt_count + 1
    WHERE id = ? AND finished_at IS NULL AND attempt_count < 3 AND lease_expires_at <= ?`
  ).bind(leaseExpiresAt, row.id, now).run();
  if ((claim.meta.changes ?? 0) === 0) return null;
  return { id: row.id, startedAt: row.started_at, jobs: jobs as ProbeJob[] };
}

export async function reserveProbeBudget(
  env: RuntimeEnv,
  requested: number,
  maximum: number,
  budgetDate = new Date().toISOString().slice(0, 10)
): Promise<boolean> {
  const count = Math.max(0, Math.floor(requested));
  if (count === 0) return true;
  const cap = Math.max(0, Math.floor(maximum));
  const now = nowIso();
  await env.DB.prepare(
    `INSERT INTO daily_usage (
      date, probe_results, worker_invocations, queue_messages, d1_writes, reserved_probes, updated_at
    ) VALUES (?, 0, 0, 0, 0, 0, ?)
    ON CONFLICT(date) DO NOTHING`
  )
    .bind(budgetDate, now)
    .run();
  const outcome = await env.DB.prepare(
    `UPDATE daily_usage
     SET reserved_probes = reserved_probes + ?, updated_at = ?
     WHERE date = ? AND reserved_probes + ? <= ?`
  )
    .bind(count, now, budgetDate, count, cap)
    .run();
  return (outcome.meta.changes ?? 0) > 0;
}

export async function saveProbeResults(env: RuntimeEnv, results: ProbeResult[]): Promise<ProbeResult[]> {
  if (results.length === 0) return [];
  if (results.length > RESULT_BATCH_LIMIT) throw new Error("Result persistence batch exceeds the 10-result D1 safety limit.");
  const insertedResults = await saveProbeResultChunk(env, results);
  await applyResultUsage(env, results);
  await writePendingAnalytics(env, results.map((result) => result.id));
  await updateIncidents(env, [...new Set(results.map((result) => result.monitorId))]);
  return insertedResults;
}

async function saveProbeResultChunk(env: RuntimeEnv, results: ProbeResult[]): Promise<ProbeResult[]> {
  const statements: D1PreparedStatement[] = [];
  for (const result of results) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO probe_results (
          id, run_id, monitor_id, monitor_config_version, region_id, target_url, checked_at, ok, status, latency_ms,
          error, method, entry_colo, entry_country, entry_city, entry_asn, entry_as_organization,
          placement, response_bytes, result_type, usage_applied, analytics_applied
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)
        ON CONFLICT(id) DO NOTHING`
      ).bind(
        result.id,
        result.runId,
        result.monitorId,
        result.monitorConfigVersion,
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
        result.responseBytes,
        result.resultType ?? (!result.ok && result.status === null && result.latencyMs === null
          ? "infrastructure" : "target")
      )
    );
    statements.push(
      env.DB.prepare(
        `INSERT INTO monitor_latest (
          monitor_id, region_id, result_id, checked_at, ok, status, latency_ms,
          error, entry_colo, placement, result_type
        )
        SELECT result.monitor_id, result.region_id, result.id, result.checked_at, result.ok,
          result.status, result.latency_ms, result.error, result.entry_colo, result.placement, result.result_type
        FROM probe_results AS result JOIN monitors AS monitor ON monitor.id = result.monitor_id
        WHERE result.id = ? AND monitor.enabled = 1 AND monitor.config_version = result.monitor_config_version
        ON CONFLICT(monitor_id, region_id) DO UPDATE SET
          result_id = excluded.result_id,
          checked_at = excluded.checked_at,
          ok = excluded.ok,
          status = excluded.status,
          latency_ms = excluded.latency_ms,
          error = excluded.error,
          entry_colo = excluded.entry_colo,
          placement = excluded.placement,
          result_type = excluded.result_type
        WHERE excluded.checked_at > monitor_latest.checked_at
           OR (excluded.checked_at = monitor_latest.checked_at AND excluded.result_id > monitor_latest.result_id)`
      ).bind(result.id)
    );
    statements.push(
      env.DB.prepare(
        `UPDATE regions SET
          last_seen_colo = ?,
          last_seen_country = ?,
          last_seen_placement = ?,
          last_seen_at = ?,
          updated_at = ?
        WHERE id = ?
          AND (last_seen_at IS NULL OR last_seen_at < ?)
          AND (? IS NOT NULL OR ? IS NOT NULL)
          AND EXISTS (
            SELECT 1 FROM monitors
            WHERE id = ? AND enabled = 1 AND config_version = ?
          )`
      ).bind(
        result.entryColo,
        result.entryCountry,
        result.placement,
        result.checkedAt,
        result.checkedAt,
        result.regionId,
        result.checkedAt,
        result.entryColo,
        result.placement,
        result.monitorId,
        result.monitorConfigVersion
      )
    );
  }
  const outcomes = await env.DB.batch(statements);
  return results.filter((_, index) => (outcomes[index * 3]?.meta.changes ?? 0) > 0);
}

async function applyResultUsage(env: RuntimeEnv, results: ProbeResult[]): Promise<void> {
  const ids = [...new Set(results.map((result) => result.id))].slice(0, RESULT_BATCH_LIMIT);
  if (ids.length === 0) return;
  const placeholders = ids.map(() => "?").join(", ");
  const now = nowIso();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO daily_usage (
        date, probe_results, worker_invocations, queue_messages, d1_writes, reserved_probes, updated_at
      ) SELECT substr(checked_at, 1, 10), COUNT(*), 0, 0, COUNT(*) * 3, 0, ?
        FROM probe_results WHERE id IN (${placeholders}) AND usage_applied = 0
        GROUP BY substr(checked_at, 1, 10)
      ON CONFLICT(date) DO UPDATE SET
        probe_results = probe_results + excluded.probe_results,
        d1_writes = d1_writes + excluded.d1_writes,
        updated_at = excluded.updated_at`
    ).bind(now, ...ids),
    env.DB.prepare(
      `UPDATE probe_results SET usage_applied = 1
       WHERE id IN (${placeholders}) AND usage_applied = 0`
    ).bind(...ids)
  ]);
}

async function writePendingAnalytics(env: RuntimeEnv, resultIds: string[]): Promise<void> {
  const ids = [...new Set(resultIds)].slice(0, RESULT_BATCH_LIMIT);
  if (ids.length === 0) return;
  const placeholders = ids.map(() => "?").join(", ");
  const pending = await env.DB.prepare(
    `SELECT * FROM probe_results
     WHERE id IN (${placeholders}) AND analytics_applied = 0`
  )
    .bind(...ids)
    .all<DbRow>();
  const results = (pending.results ?? []).map(mapProbeResult);
  writeAnalytics(env, results);
  if (results.length > 0) {
    await env.DB.prepare(`UPDATE probe_results SET analytics_applied = 1 WHERE id IN (${placeholders}) AND analytics_applied = 0`).bind(...ids).run();
  }
}

export async function archiveProbeResults(env: RuntimeEnv, results: ProbeResult[]): Promise<void> {
  if (!env.ARCHIVE || env.ARCHIVE_RAW_RESULTS === "false" || results.length === 0) return;
  const archiveTime = new Date(
    [...results]
      .map((result) => Date.parse(result.checkedAt))
      .filter(Number.isFinite)
      .sort((left, right) => left - right)[0] ?? Date.now()
  );
  const date = archiveTime.toISOString().slice(0, 10);
  const hour = archiveTime.toISOString().slice(11, 13);
  const identity = [...new Set(results.map((result) => `${result.id}:${result.checkedAt}`))].sort().join("\n");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(identity));
  const hash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const key = `probe-results/date=${date}/hour=${hour}/${hash}.json`;
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

export async function recordRuntimeUsage(
  env: RuntimeEnv,
  patch: Pick<Partial<UsageSummary>, "workerInvocations" | "queueMessages">
): Promise<void> {
  await bumpDailyUsage(env, patch);
}

export async function cleanupRetention(env: RuntimeEnv): Promise<void> {
  const days = parsePositiveInt(env.DEFAULT_RETENTION_DAYS, 30);
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM probe_results WHERE id IN (SELECT id FROM probe_results WHERE checked_at < ? LIMIT 1000)").bind(cutoff),
    env.DB.prepare("DELETE FROM scheduler_runs WHERE started_at < ?").bind(cutoff),
    env.DB.prepare("DELETE FROM incidents WHERE status = 'resolved' AND opened_at < ?").bind(cutoff),
    env.DB.prepare("DELETE FROM daily_usage WHERE date < ?").bind(cutoff.slice(0, 10))
  ]);
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
  if (!monitorIds.length) return;
  const [monitors, regions] = await Promise.all([listMonitors(env), listRegions(env)]);
  const effective = applyGlobalDailyCap(monitors, parsePositiveInt(env.MAX_DAILY_PROBES, 10_000));
  const active = regions.filter((region) => region.enabled);
  const totalWeight = active.reduce((sum, region) => sum + region.weight, 0);
  const now = nowIso();
  const ids = JSON.stringify([...new Set(monitorIds)]);
  const policies = JSON.stringify(effective.filter((monitor) => monitor.enabled && monitorIds.includes(monitor.id)).flatMap((monitor) =>
    active.map((region) => {
      const freshnessMs = regionalFreshnessMs(monitor.dailyBudget, totalWeight, region.weight);
      return { monitorId: monitor.id, regionId: region.id, freshnessMs,
        cutoff: new Date(Date.parse(now) - freshnessMs).toISOString() };
    })
  ));
  // Re-evaluate latest evidence inside each statement of one transaction. This
  // prevents two consumers from applying stale read/modify/write incident state.
  const evidence = `WITH policies AS (
    SELECT json_extract(value, '$.monitorId') AS monitor_id,
      json_extract(value, '$.regionId') AS region_id,
      json_extract(value, '$.cutoff') AS cutoff,
      json_extract(value, '$.freshnessMs') AS freshness_ms FROM json_each(?)
  ), evidence AS (
    SELECT requested.value AS monitor_id, COUNT(policy.region_id) AS expected,
      SUM(CASE WHEN latest.result_type = 'target' AND latest.ok = 0 AND latest.checked_at >= policy.cutoff THEN 1 ELSE 0 END) AS failures,
      SUM(CASE WHEN latest.result_type = 'target' AND latest.ok = 1 AND latest.checked_at >= policy.cutoff THEN 1 ELSE 0 END) AS passes,
      MIN(CASE WHEN latest.result_type = 'target' AND latest.ok = 0 AND latest.checked_at >= policy.cutoff
        THEN strftime('%Y-%m-%dT%H:%M:%fZ', julianday(latest.checked_at) + policy.freshness_ms / 86400000.0) END) AS expiry
    FROM json_each(?) AS requested
    LEFT JOIN policies AS policy ON policy.monitor_id = requested.value
    LEFT JOIN monitor_latest AS latest ON latest.monitor_id = policy.monitor_id AND latest.region_id = policy.region_id
    GROUP BY requested.value
  )`;
  await env.DB.batch([
    env.DB.prepare(evidence + `
      INSERT INTO incidents (id, monitor_id, opened_at, severity, status, failing_regions, summary, expires_at)
      SELECT 'inc_' || lower(hex(randomblob(16))), monitor_id, ?,
        CASE WHEN failures = expected THEN 'outage' ELSE 'degraded' END,
        'open', failures, failures || ' region(s) failing', expiry FROM evidence WHERE failures > 0
      ON CONFLICT(monitor_id) WHERE status IN ('open', 'unknown') DO UPDATE SET
        status = 'open', closed_at = NULL, failing_regions = excluded.failing_regions,
        severity = excluded.severity, summary = excluded.summary, expires_at = excluded.expires_at
    `).bind(policies, ids, now),
    env.DB.prepare(evidence + `
      UPDATE incidents SET status = 'resolved', closed_at = ?, failing_regions = 0,
        summary = 'Recovery confirmed by fresh successful checks in all enabled regions', expires_at = NULL
      WHERE status IN ('open', 'unknown') AND monitor_id IN (
        SELECT monitor_id FROM evidence WHERE expected > 0 AND passes = expected
      )
    `).bind(policies, ids, now),
    env.DB.prepare(evidence + `
      UPDATE incidents SET status = 'unknown', closed_at = NULL, failing_regions = 0,
        summary = 'Recovery unconfirmed: regional evidence is missing, stale, or unavailable', expires_at = NULL
      WHERE status IN ('open', 'unknown') AND monitor_id IN (
        SELECT monitor_id FROM evidence WHERE failures = 0 AND (expected = 0 OR passes < expected)
      )
    `).bind(policies, ids)
  ]);
}

export async function expireStaleIncidents(env: RuntimeEnv): Promise<void> {
  const expired = await env.DB.prepare(
    "SELECT monitor_id FROM incidents WHERE status = 'open' AND expires_at <= ?"
  ).bind(nowIso()).all<{ monitor_id: string }>();
  await updateIncidents(env, (expired.results ?? []).map((row) => row.monitor_id));
}

async function reconcileIncidentsAfterRegionChange(env: RuntimeEnv): Promise<void> {
  const incidents = await env.DB.prepare("SELECT monitor_id FROM incidents WHERE status IN ('open', 'unknown')")
    .all<{ monitor_id: string }>();
  await updateIncidents(env, (incidents.results ?? []).map((row) => row.monitor_id));
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
      doubles: [result.latencyMs ?? -1, result.status ?? 0, result.resultType === "infrastructure" ? -1 : result.ok ? 1 : 0, result.responseBytes],
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
    configVersion: numberField(row, "config_version", 1),
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
    resultType: row.result_type === "infrastructure" ? "infrastructure" : "target",
    status: nullableNumber(row.status),
    latencyMs: nullableNumber(row.latency_ms),
    error: nullableTextField(row, "error"),
    entryColo: nullableTextField(row, "entry_colo"),
    placement: nullableTextField(row, "placement")
  };
}

function mapProbeResult(row: DbRow): ProbeResult {
  return {
    id: textField(row, "id"),
    runId: textField(row, "run_id"),
    monitorId: textField(row, "monitor_id"),
    monitorConfigVersion: numberField(row, "monitor_config_version", 1),
    regionId: textField(row, "region_id"),
    targetUrl: textField(row, "target_url"),
    checkedAt: textField(row, "checked_at"),
    ok: boolFromDb(row.ok),
    resultType: row.result_type === "infrastructure" ? "infrastructure" : "target",
    status: nullableNumber(row.status),
    latencyMs: nullableNumber(row.latency_ms),
    error: nullableTextField(row, "error"),
    method: textField(row, "method", "HEAD") === "GET" ? "GET" : "HEAD",
    entryColo: nullableTextField(row, "entry_colo"),
    entryCountry: nullableTextField(row, "entry_country"),
    entryCity: nullableTextField(row, "entry_city"),
    entryAsn: nullableNumber(row.entry_asn),
    entryAsOrganization: nullableTextField(row, "entry_as_organization"),
    placement: nullableTextField(row, "placement"),
    responseBytes: numberField(row, "response_bytes")
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
    d1Writes: numberField(row, "d1_writes"),
    reservedProbes: numberField(row, "reserved_probes")
  };
}

function mapSchedulerRun(row: DbRow): SchedulerRun {
  const id = textField(row, "id");
  return {
    id,
    startedAt: textField(row, "started_at"),
    finishedAt: nullableTextField(row, "finished_at"),
    plannedJobs: numberField(row, "planned_jobs"),
    dispatchedJobs: numberField(row, "dispatched_jobs"),
    skippedJobs: numberField(row, "skipped_jobs"),
    error: nullableTextField(row, "error"),
    trigger: id.startsWith("manual_") ? "manual" : "scheduled"
  };
}

function nullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
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
  const normalized = tags.map((tag) => tag.trim()).filter(Boolean);
  if (normalized.some((tag) => tag.length > 64)) {
    throw new Error("Each tag must be 64 characters or fewer.");
  }
  const unique = [...new Set(normalized)];
  if (unique.length > 20) throw new Error("A monitor can have at most 20 tags.");
  return unique;
}

function normalizeMonitorName(value: string | undefined, fallback: string): string {
  const name = value?.trim() || fallback;
  if (name.length > 256) throw new Error("Monitor name must be 256 characters or fewer.");
  return name;
}

function normalizeStatus(value: number | undefined, fallback: number): number {
  return clampInt(value, 100, 599, fallback);
}

function validateStatusRange(min: number, max: number): void {
  if (min > max) throw new Error("expectedStatusMin must be less than or equal to expectedStatusMax.");
}

function validateBodyMatchMethod(method: MonitorMethod, bodyMatch: string | null): void {
  if (bodyMatch && method !== "GET") throw new Error("bodyMatch requires the GET method.");
}

function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  const int = Math.floor(value as number);
  return Math.max(min, Math.min(max, int));
}

function normalizeLimit(value: number, fallback: number, maximum: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.min(maximum, Math.floor(value))) : fallback;
}
