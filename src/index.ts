import { requireAdmin, requireInternal } from "./auth";
import { estimateCost } from "./cost";
import { dispatchJobs } from "./dispatch";
import type { ProbeJob, ProbeResult, RuntimeEnv } from "./domain";
import { createId, nowIso, parsePositiveInt } from "./domain";
import { parseProbeJobs, runProbeJobs } from "./probe";
import { buildSchedulePlan } from "./scheduler";
import {
  archiveProbeResults,
  bootstrapDefaults,
  claimRecoverableSchedulerRun,
  claimScheduledRunAndReserve,
  cleanupRetention,
  createMonitor,
  expireStaleIncidents,
  getRunStatus,
  getSummary,
  listMonitors,
  listProbeResults,
  listRegions,
  recordQueueMessages,
  recordRuntimeUsage,
  recordSchedulerRun,
  recordWorkerInvocation,
  reserveProbeBudget,
  saveProbeResults,
  updateMonitor,
  updateRegion
} from "./storage";

export default {
  async fetch(request: Request, env: RuntimeEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/internal/probe") {
      return handleInternalProbe(request, env);
    }

    if (env.ROLE === "probe") {
      return handleProbeRole(request, env);
    }

    return handleControlRequest(request, env, ctx, url);
  },

  async scheduled(event: ScheduledEvent, env: RuntimeEnv, ctx: ExecutionContext): Promise<void> {
    await bootstrapDefaults(env);
    await expireStaleIncidents(env);
    const baseUrl = env.PUBLIC_BASE_URL || "http://localhost:8787";
    const recovered = await claimRecoverableSchedulerRun(env);
    if (recovered) {
      await executeScheduledJobs(env, ctx, recovered, baseUrl);
    }

    const scheduledAt = event.scheduledTime ? new Date(event.scheduledTime) : new Date();
    const monitors = applyGlobalDailyCap(await listMonitors(env), parsePositiveInt(env.MAX_DAILY_PROBES, 10_000));
    const regions = await listRegions(env);
    const runId = scheduledRunId(scheduledAt);
    const plan = buildSchedulePlan(monitors, regions, scheduledAt, runId);
    const startedAt = scheduledAt.toISOString();
    const claim = await claimScheduledRunAndReserve(
      env,
      { id: runId, startedAt, plannedJobs: plan.jobs.length },
      plan.jobs,
      parsePositiveInt(env.MAX_DAILY_PROBES, 10_000),
      scheduledAt.toISOString().slice(0, 10)
    );
    if (!claim.claimed) return;
    if (!claim.reserved) return;
    await executeScheduledJobs(env, ctx, { id: runId, startedAt, jobs: plan.jobs }, baseUrl);
    ctx.waitUntil(cleanupRetention(env).catch((caught) => logBackgroundFailure("retention_cleanup_failed", caught)));
  },

  async queue(batch: MessageBatch<ProbeResult[]>, env: RuntimeEnv, ctx: ExecutionContext): Promise<void> {
    const incoming = batch.messages.flatMap((message) => message.body);
    const batchSize = Math.min(5, parsePositiveInt(env.RESULT_QUEUE_BATCH_SIZE, 5));
    const results = incoming.slice(0, batchSize);
    const remainder = incoming.slice(batchSize);
    await archiveProbeResults(env, results);
    await saveProbeResults(env, results);

    let requeuedMessages = 0;
    if (remainder.length > 0) {
      if (!env.RESULTS_QUEUE) throw new Error("Results queue binding is required to split an oversized message.");
      for (let index = 0; index < remainder.length; index += batchSize) {
        await env.RESULTS_QUEUE.send(remainder.slice(index, index + batchSize));
        requeuedMessages += 1;
      }
    }
    await recordRuntimeUsage(env, { workerInvocations: 1, queueMessages: requeuedMessages });
  }
};

async function executeScheduledJobs(
  env: RuntimeEnv,
  ctx: ExecutionContext,
  run: { id: string; startedAt: string; jobs: ProbeJob[] },
  baseUrl: string
): Promise<void> {
  try {
    const outcome = await dispatchJobs(env, run.jobs, baseUrl);
    await persistResults(env, ctx, outcome.results);
    await recordSchedulerRunSafely(env, {
      id: run.id,
      startedAt: run.startedAt,
      finishedAt: nowIso(),
      plannedJobs: run.jobs.length,
      dispatchedJobs: outcome.dispatchedJobs,
      skippedJobs: Math.max(0, run.jobs.length - outcome.dispatchedJobs)
    });
    await recordWorkerInvocationSafely(env, 1 + outcome.probeInvocations);
  } catch (caught) {
    await recordSchedulerRunSafely(env, {
      id: run.id,
      startedAt: run.startedAt,
      finishedAt: nowIso(),
      plannedJobs: run.jobs.length,
      dispatchedJobs: 0,
      skippedJobs: run.jobs.length,
      error: caught instanceof Error ? caught.message : "scheduled_run_failed"
    });
    console.error("scheduled_run_failed", run.id, caught instanceof Error ? caught.message : caught);
  }
}

async function handleControlRequest(
  request: Request,
  env: RuntimeEnv,
  ctx: ExecutionContext,
  url: URL
): Promise<Response> {
  if (request.method === "GET" && url.pathname === "/health") {
    return Response.json({ ok: true, role: env.ROLE ?? "control", time: nowIso() });
  }

  if (request.method === "GET" && url.pathname === "/api/summary") {
    const unauthorized = requireAdmin(request, env);
    if (unauthorized) return unauthorized;
    return Response.json(await getSummary(env));
  }

  if (request.method === "GET" && url.pathname === "/api/cost") {
    const urlCount = Number.parseInt(url.searchParams.get("urls") ?? "1", 10);
    const probesPerDay = Number.parseInt(url.searchParams.get("probesPerDay") ?? "100", 10);
    const queueBatchSize = Number.parseInt(
      url.searchParams.get("queueBatchSize") ?? env.RESULT_QUEUE_BATCH_SIZE ?? "5",
      10
    );
    return Response.json(estimateCost({ urlCount, probesPerDay, queueBatchSize }));
  }

  const runMatch = /^\/api\/runs\/([^/]+)$/.exec(url.pathname);
  if (request.method === "GET" && runMatch?.[1]) {
    const unauthorized = requireAdmin(request, env);
    if (unauthorized) return unauthorized;
    const run = await getRunStatus(env, decodeURIComponent(runMatch[1]));
    return run ? Response.json({ run }) : jsonError("Run not found.", 404);
  }

  if (request.method === "POST" && url.pathname === "/api/monitors") {
    const unauthorized = requireAdmin(request, env);
    if (unauthorized) return unauthorized;
    try {
      const input = await request.json();
      const monitor = await createMonitor(env, parseCreateMonitorInput(input));
      return Response.json({ monitor }, { status: 201 });
    } catch (caught) {
      return jsonError(caught instanceof Error ? caught.message : "Invalid monitor input", 400);
    }
  }

  const monitorMatch = /^\/api\/monitors\/([^/]+)$/.exec(url.pathname);
  if (request.method === "GET" && monitorMatch?.[1]) {
    const unauthorized = requireAdmin(request, env);
    if (unauthorized) return unauthorized;
    try {
      const limit = Number.parseInt(url.searchParams.get("limit") ?? "100", 10);
      const results = await listProbeResults(env, decodeURIComponent(monitorMatch[1]), limit);
      return Response.json({ results });
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Failed to load monitor results.";
      return jsonError(message, message === "Monitor not found." ? 404 : 400);
    }
  }

  if (request.method === "PATCH" && monitorMatch?.[1]) {
    const unauthorized = requireAdmin(request, env);
    if (unauthorized) return unauthorized;
    try {
      const input = await request.json();
      const monitor = await updateMonitor(env, decodeURIComponent(monitorMatch[1]), parseUpdateMonitorInput(input));
      return Response.json({ monitor });
    } catch (caught) {
      return jsonError(caught instanceof Error ? caught.message : "Invalid monitor update", 400);
    }
  }

  const regionMatch = /^\/api\/regions\/([^/]+)$/.exec(url.pathname);
  if (request.method === "PATCH" && regionMatch?.[1]) {
    const unauthorized = requireAdmin(request, env);
    if (unauthorized) return unauthorized;
    try {
      const input = await request.json();
      const region = await updateRegion(env, decodeURIComponent(regionMatch[1]), parseUpdateRegionInput(input));
      return Response.json({ region });
    } catch (caught) {
      return jsonError(caught instanceof Error ? caught.message : "Invalid region update", 400);
    }
  }

  if (request.method === "POST" && url.pathname === "/api/run") {
    const unauthorized = requireAdmin(request, env);
    if (unauthorized) return unauthorized;
    await bootstrapDefaults(env);
    const payload = parseRunRequestInput(await request.json().catch(() => ({})));
    let monitors = applyGlobalDailyCap(await listMonitors(env), parsePositiveInt(env.MAX_DAILY_PROBES, 10_000));
    if (payload.monitorId) {
      const selected = monitors.find((monitor) => monitor.id === payload.monitorId);
      if (!selected) return jsonError("Monitor not found.", 404);
      if (!selected.enabled) return jsonError("Monitor is disabled.", 409);
      monitors = [selected];
    }
    const regions = await listRegions(env);
    const scheduledAt = new Date();
    const runId = createId("manual");
    const startedAt = nowIso();
    const jobs =
      payload.mode === "due"
        ? buildSchedulePlan(monitors, regions, scheduledAt, runId).jobs
        : buildSampleJobs(monitors, regions, scheduledAt, runId, payload.monitorId ? "all-regions" : "one-per-monitor");
    const budgetReserved = await reserveProbeBudget(
      env,
      jobs.length,
      parsePositiveInt(env.MAX_DAILY_PROBES, 10_000)
    );
    if (!budgetReserved) {
      await recordSchedulerRunSafely(env, {
        id: runId,
        startedAt,
        finishedAt: nowIso(),
        plannedJobs: jobs.length,
        dispatchedJobs: 0,
        skippedJobs: jobs.length,
        error: "daily_probe_budget_exhausted"
      });
      return jsonError("Daily probe budget exhausted.", 429);
    }
    try {
      const outcome = await dispatchJobs(env, jobs, url.origin);
      await persistResults(env, ctx, outcome.results);
      await recordSchedulerRunSafely(env, {
        id: runId,
        startedAt,
        finishedAt: nowIso(),
        plannedJobs: jobs.length,
        dispatchedJobs: outcome.dispatchedJobs,
        skippedJobs: Math.max(0, jobs.length - outcome.dispatchedJobs)
      });
      await recordWorkerInvocationSafely(env, 1 + outcome.probeInvocations);
      return Response.json({
        runId,
        plannedJobs: jobs.length,
        dispatchedJobs: outcome.dispatchedJobs,
        successfulJobs: outcome.results.filter((result) => result.ok).length,
        failedJobs: outcome.results.filter((result) => !result.ok).length,
        queued: Boolean(env.RESULTS_QUEUE),
        mode: payload.mode,
        reason:
          jobs.length > 0
            ? null
            : regions.some((region) => region.enabled)
              ? "no_due_jobs"
              : "no_enabled_regions"
      });
    } catch (caught) {
      await recordSchedulerRunSafely(env, {
        id: runId,
        startedAt,
        finishedAt: nowIso(),
        plannedJobs: jobs.length,
        dispatchedJobs: 0,
        skippedJobs: jobs.length,
        error: caught instanceof Error ? caught.message : "manual_run_failed"
      });
      return jsonError(caught instanceof Error ? caught.message : "Run failed.", 500);
    }
  }

  if ((request.method === "GET" || request.method === "HEAD") && !url.pathname.startsWith("/api/")) {
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return jsonError("Dashboard assets are not configured.", 503);
  }

  return jsonError("Not found", 404);
}

async function handleProbeRole(request: Request, env: RuntimeEnv): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/health") {
    return Response.json({
      ok: true,
      role: "probe",
      regionId: env.REGION_ID ?? null,
      regionHint: env.REGION_HINT ?? null,
      time: nowIso()
    });
  }
  return jsonError("Probe worker only accepts /internal/probe and /health.", 404);
}

async function handleInternalProbe(request: Request, env: RuntimeEnv): Promise<Response> {
  if (request.method !== "POST") return jsonError("Method not allowed", 405);
  const allowLocal = env.ALLOW_LOCAL_PROBES === "true" && new URL(request.url).hostname === "localhost";
  if (!allowLocal) {
    const unauthorized = requireInternal(request, env);
    if (unauthorized) return unauthorized;
  }

  try {
    const jobs = parseProbeJobs(await request.json().catch(() => null), {
      allowPrivateTargets: env.ALLOW_PRIVATE_TARGETS === "true",
      maxJobs: Math.min(5, parsePositiveInt(env.PROBE_BATCH_SIZE, 5))
    });
    const concurrency = Math.min(6, parsePositiveInt(env.PROBE_CONCURRENCY, 6));
    const results = await runProbeJobs(request, jobs, concurrency);
    return Response.json({ results });
  } catch (caught) {
    return jsonError(caught instanceof Error ? caught.message : "Invalid probe payload.", 400);
  }
}

async function persistResults(env: RuntimeEnv, ctx: ExecutionContext, results: ProbeResult[]): Promise<void> {
  if (results.length === 0) return;
  if (env.RESULTS_QUEUE) {
    const chunkSize = Math.min(5, parsePositiveInt(env.RESULT_QUEUE_BATCH_SIZE, 5));
    let messages = 0;
    for (let index = 0; index < results.length; index += chunkSize) {
      await env.RESULTS_QUEUE.send(results.slice(index, index + chunkSize));
      messages += 1;
    }
    await recordQueueMessages(env, messages);
    return;
  }

  const chunkSize = Math.min(5, parsePositiveInt(env.RESULT_QUEUE_BATCH_SIZE, 5));
  for (let index = 0; index < results.length; index += chunkSize) {
    const chunk = results.slice(index, index + chunkSize);
    await archiveProbeResults(env, chunk);
    await saveProbeResults(env, chunk);
  }
}

function buildSampleJobs(
  monitors: Awaited<ReturnType<typeof listMonitors>>,
  regions: Awaited<ReturnType<typeof listRegions>>,
  date: Date,
  runId = createId("manual"),
  scope: "one-per-monitor" | "all-regions" = "one-per-monitor"
): ProbeJob[] {
  const enabledRegions = regions.filter((region) => region.enabled);
  if (enabledRegions.length === 0) return [];
  const jobs: ProbeJob[] = [];
  const enabledMonitors = monitors.filter((monitor) => monitor.enabled);
  for (const [monitorIndex, monitor] of enabledMonitors.entries()) {
    const sampleRegions = scope === "all-regions" ? enabledRegions : [enabledRegions[monitorIndex % enabledRegions.length]];
    for (const region of sampleRegions) {
      if (!region) continue;
      jobs.push({
        runId,
        scheduledAt: date.toISOString(),
        monitor: {
          id: monitor.id,
          name: monitor.name,
          url: monitor.url,
          method: monitor.method,
          expectedStatusMin: monitor.expectedStatusMin,
          expectedStatusMax: monitor.expectedStatusMax,
          bodyMatch: monitor.bodyMatch,
          timeoutMs: monitor.timeoutMs,
          configVersion: monitor.configVersion
        },
        region: {
          id: region.id,
          label: region.label,
          placementRegion: region.placementRegion,
          workerUrl: region.workerUrl
        }
      });
    }
  }
  return jobs;
}

function parseCreateMonitorInput(input: unknown) {
  if (!input || typeof input !== "object") throw new Error("JSON body is required.");
  const value = input as Record<string, unknown>;
  if (typeof value.url !== "string" || value.url.trim().length === 0) {
    throw new Error("url is required.");
  }
  const output: {
    url: string;
    name?: string;
    method?: "HEAD" | "GET";
    expectedStatusMin?: number;
    expectedStatusMax?: number;
    bodyMatch?: string | null;
    timeoutMs?: number;
    dailyBudget?: number;
    tags?: string[];
  } = {
    url: value.url,
    method: value.method === "GET" ? "GET" : "HEAD"
  };
  if (typeof value.name === "string") output.name = value.name;
  if (typeof value.expectedStatusMin === "number") output.expectedStatusMin = value.expectedStatusMin;
  if (typeof value.expectedStatusMax === "number") output.expectedStatusMax = value.expectedStatusMax;
  if (typeof value.bodyMatch === "string") output.bodyMatch = value.bodyMatch;
  if (typeof value.timeoutMs === "number") output.timeoutMs = value.timeoutMs;
  if (typeof value.dailyBudget === "number") output.dailyBudget = value.dailyBudget;
  if (Array.isArray(value.tags)) output.tags = value.tags.filter((tag): tag is string => typeof tag === "string");
  return output;
}

function parseUpdateMonitorInput(input: unknown) {
  if (!input || typeof input !== "object") throw new Error("JSON body is required.");
  const value = input as Record<string, unknown>;
  const output: {
    url?: string;
    name?: string;
    method?: "HEAD" | "GET";
    expectedStatusMin?: number;
    expectedStatusMax?: number;
    bodyMatch?: string | null;
    timeoutMs?: number;
    dailyBudget?: number;
    enabled?: boolean;
    tags?: string[];
  } = {};
  if (typeof value.url === "string") output.url = value.url;
  if (typeof value.name === "string") output.name = value.name;
  if (value.method === "GET" || value.method === "HEAD") output.method = value.method;
  if (typeof value.expectedStatusMin === "number") output.expectedStatusMin = value.expectedStatusMin;
  if (typeof value.expectedStatusMax === "number") output.expectedStatusMax = value.expectedStatusMax;
  if (typeof value.bodyMatch === "string" || value.bodyMatch === null) output.bodyMatch = value.bodyMatch;
  if (typeof value.timeoutMs === "number") output.timeoutMs = value.timeoutMs;
  if (typeof value.dailyBudget === "number") output.dailyBudget = value.dailyBudget;
  if (typeof value.enabled === "boolean") output.enabled = value.enabled;
  if (Array.isArray(value.tags)) output.tags = value.tags.filter((tag): tag is string => typeof tag === "string");
  return output;
}

function parseUpdateRegionInput(input: unknown) {
  if (!input || typeof input !== "object") throw new Error("JSON body is required.");
  const value = input as Record<string, unknown>;
  const output: {
    workerUrl?: string | null;
    enabled?: boolean;
    weight?: number;
  } = {};
  if (typeof value.workerUrl === "string" || value.workerUrl === null) output.workerUrl = value.workerUrl;
  if (typeof value.enabled === "boolean") output.enabled = value.enabled;
  if (typeof value.weight === "number") output.weight = value.weight;
  return output;
}

function parseRunRequestInput(input: unknown): { mode: "due" | "sample"; monitorId?: string } {
  if (!input || typeof input !== "object") return { mode: "due" };
  const value = input as Record<string, unknown>;
  const mode = value.mode === "sample" ? "sample" : "due";
  const monitorId = typeof value.monitorId === "string" && value.monitorId.trim() ? value.monitorId.trim() : undefined;
  return monitorId ? { mode, monitorId } : { mode };
}

function scheduledRunId(date: Date): string {
  return `cron_${date.toISOString().slice(0, 16).replace(/[-:T]/g, "")}`;
}

export function applyGlobalDailyCap<T extends { dailyBudget: number; enabled?: boolean; id?: string }>(
  monitors: T[],
  maxDailyProbes: number
): T[] {
  const cap = Math.max(0, Math.floor(maxDailyProbes));
  const enabled = monitors
    .map((monitor, index) => ({ index, monitor, budget: Math.max(0, Math.floor(monitor.dailyBudget)) }))
    .filter((item) => item.monitor.enabled !== false && item.budget > 0);
  const totalBudget = enabled.reduce((total, item) => total + item.budget, 0);
  if (totalBudget <= cap) return monitors;

  const allocations = enabled.map((item) => {
    const exact = totalBudget > 0 ? (item.budget / totalBudget) * cap : 0;
    return {
      ...item,
      allocation: Math.min(item.budget, Math.floor(exact)),
      remainder: exact - Math.floor(exact)
    };
  });
  let remaining = cap - allocations.reduce((total, item) => total + item.allocation, 0);
  const remainderOrder = [...allocations].sort(
    (left, right) =>
      right.remainder - left.remainder ||
      (left.monitor.id ?? String(left.index)).localeCompare(right.monitor.id ?? String(right.index))
  );
  for (const item of remainderOrder) {
    if (remaining <= 0) break;
    if (item.allocation >= item.budget) continue;
    item.allocation += 1;
    remaining -= 1;
  }

  const byIndex = new Map(allocations.map((item) => [item.index, item.allocation]));
  return monitors.map((monitor, index) =>
    byIndex.has(index) ? { ...monitor, dailyBudget: byIndex.get(index) ?? 0 } : monitor
  );
}

function jsonError(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
}

async function recordWorkerInvocationSafely(env: RuntimeEnv, count: number): Promise<void> {
  try {
    await recordWorkerInvocation(env, count);
  } catch (caught) {
    console.warn("worker_invocation_usage_record_failed", caught instanceof Error ? caught.message : caught);
  }
}

async function recordSchedulerRunSafely(
  env: RuntimeEnv,
  input: Parameters<typeof recordSchedulerRun>[1]
): Promise<void> {
  try {
    await recordSchedulerRun(env, input);
  } catch (caught) {
    console.warn("scheduler_run_record_failed", caught instanceof Error ? caught.message : caught);
  }
}

function logBackgroundFailure(code: string, caught: unknown): void {
  console.warn(code, caught instanceof Error ? caught.message : caught);
}
