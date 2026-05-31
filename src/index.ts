import { requireAdmin, requireInternal } from "./auth";
import { estimateCost } from "./cost";
import type { ProbeJob, ProbeResult, RuntimeEnv } from "./domain";
import { createId, nowIso, parsePositiveInt } from "./domain";
import { type ProbeRequestPayload, runProbeJobs } from "./probe";
import { buildSchedulePlan } from "./scheduler";
import {
  archiveProbeResults,
  bootstrapDefaults,
  cleanupRetention,
  createMonitor,
  getSummary,
  listMonitors,
  listRegions,
  recordQueueMessages,
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
    const scheduledAt = event.scheduledTime ? new Date(event.scheduledTime) : new Date();
    const monitors = applyGlobalDailyCap(await listMonitors(env), parsePositiveInt(env.MAX_DAILY_PROBES, 10_000));
    const regions = await listRegions(env);
    const plan = buildSchedulePlan(monitors, regions, scheduledAt);
    const baseUrl = env.PUBLIC_BASE_URL || "http://localhost:8787";
    const results = await dispatchJobs(env, plan.jobs, baseUrl);
    await persistResults(env, ctx, results);
    ctx.waitUntil(cleanupRetention(env));
  },

  async queue(batch: MessageBatch<ProbeResult[]>, env: RuntimeEnv, ctx: ExecutionContext): Promise<void> {
    const results = batch.messages.flatMap((message) => message.body);
    await saveProbeResults(env, results);
    ctx.waitUntil(archiveProbeResults(env, results));
  }
};

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
    const queueBatchSize = Number.parseInt(url.searchParams.get("queueBatchSize") ?? "50", 10);
    return Response.json(estimateCost({ urlCount, probesPerDay, queueBatchSize }));
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
    const payload = await request.json().catch(() => ({}));
    const monitors = applyGlobalDailyCap(await listMonitors(env), parsePositiveInt(env.MAX_DAILY_PROBES, 10_000));
    const regions = await listRegions(env);
    const mode = typeof payload === "object" && payload && "mode" in payload ? String(payload.mode) : "sample";
    const scheduledAt = new Date();
    let jobs = buildSchedulePlan(monitors, regions, scheduledAt, createId("manual")).jobs;
    if (mode !== "due" || jobs.length === 0) {
      jobs = buildSampleJobs(monitors, regions, scheduledAt);
    }
    const results = await dispatchJobs(env, jobs, url.origin);
    await persistResults(env, ctx, results);
    return Response.json({
      plannedJobs: jobs.length,
      dispatchedJobs: results.length,
      queued: Boolean(env.RESULTS_QUEUE)
    });
  }

  if (request.method === "GET" && !url.pathname.startsWith("/api/")) {
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

  const payload = (await request.json().catch(() => null)) as ProbeRequestPayload | null;
  if (!payload || !Array.isArray(payload.jobs)) {
    return jsonError("Payload must include jobs array.", 400);
  }
  const results = await runProbeJobs(request, payload.jobs);
  return Response.json({ results });
}

async function dispatchJobs(env: RuntimeEnv, jobs: ProbeJob[], origin: string): Promise<ProbeResult[]> {
  const groups = new Map<string, ProbeJob[]>();
  const batchSize = parsePositiveInt(env.PROBE_BATCH_SIZE, 50);
  const results: ProbeResult[] = [];
  const localMode = env.ALLOW_LOCAL_PROBES === "true";
  if (!env.SHARED_SECRET && !localMode) {
    return jobs.map((job) => dispatchErrorResult(job, "shared_secret_missing"));
  }

  for (const job of jobs) {
    const probeUrl = resolveProbeUrl(env, job.region, origin);
    if (!probeUrl) {
      results.push(dispatchErrorResult(job, "region_worker_url_missing"));
      continue;
    }
    const list = groups.get(probeUrl) ?? [];
    list.push(job);
    groups.set(probeUrl, list);
  }

  for (const [probeUrl, groupJobs] of groups) {
    for (let index = 0; index < groupJobs.length; index += batchSize) {
      const chunk = groupJobs.slice(index, index + batchSize);
      try {
        const response = await fetch(probeUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-MonsterTracker-Secret": env.SHARED_SECRET || "local-dev-secret"
          },
          body: JSON.stringify({ jobs: chunk })
        });
        if (!response.ok) {
          const text = await response.text();
          for (const job of chunk) {
            results.push(dispatchErrorResult(job, `probe_worker_${response.status}:${text.slice(0, 120)}`));
          }
          continue;
        }
        const body = (await response.json()) as { results?: ProbeResult[] };
        if (Array.isArray(body.results)) {
          results.push(...body.results);
        }
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : "probe_dispatch_failed";
        for (const job of chunk) {
          results.push(dispatchErrorResult(job, message));
        }
      }
    }
  }

  return results;
}

async function persistResults(env: RuntimeEnv, ctx: ExecutionContext, results: ProbeResult[]): Promise<void> {
  if (results.length === 0) return;
  if (env.RESULTS_QUEUE) {
    const chunkSize = parsePositiveInt(env.PROBE_BATCH_SIZE, 50);
    let messages = 0;
    for (let index = 0; index < results.length; index += chunkSize) {
      await env.RESULTS_QUEUE.send(results.slice(index, index + chunkSize));
      messages += 1;
    }
    await recordQueueMessages(env, messages);
    return;
  }

  await saveProbeResults(env, results);
  ctx.waitUntil(archiveProbeResults(env, results));
}

function resolveProbeUrl(
  env: RuntimeEnv,
  region: Pick<ProbeJob["region"], "id" | "workerUrl">,
  origin: string
): string | null {
  if (region.workerUrl) {
    return withProbePath(region.workerUrl);
  }
  const template = env.PROBE_URL_TEMPLATE;
  if (template) {
    const worker = `monstertracker-probe-${region.id}`;
    return withProbePath(
      template
        .replaceAll("{id}", region.id)
        .replaceAll("{worker}", worker)
        .replaceAll("{region}", region.id)
    );
  }
  if (env.ALLOW_LOCAL_PROBES === "true") {
    return withProbePath(origin);
  }
  return null;
}

function withProbePath(base: string): string {
  const url = new URL(base);
  url.pathname = "/internal/probe";
  url.search = "";
  url.hash = "";
  return url.toString();
}

function buildSampleJobs(monitors: Awaited<ReturnType<typeof listMonitors>>, regions: Awaited<ReturnType<typeof listRegions>>, date: Date): ProbeJob[] {
  const enabledRegions = regions.filter((region) => region.enabled);
  if (enabledRegions.length === 0) return [];
  const runId = createId("manual");
  return monitors
    .filter((monitor) => monitor.enabled)
    .map((monitor, index) => {
      const region = enabledRegions[index % enabledRegions.length];
      if (!region) return null;
      return {
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
          timeoutMs: monitor.timeoutMs
        },
        region: {
          id: region.id,
          label: region.label,
          placementRegion: region.placementRegion,
          workerUrl: region.workerUrl
        }
      };
    })
    .filter((job): job is ProbeJob => job !== null);
}

function dispatchErrorResult(job: ProbeJob, error: string): ProbeResult {
  return {
    id: createId("res"),
    runId: job.runId,
    monitorId: job.monitor.id,
    regionId: job.region.id,
    targetUrl: job.monitor.url,
    checkedAt: nowIso(),
    ok: false,
    status: null,
    latencyMs: null,
    error,
    method: job.monitor.method,
    entryColo: null,
    entryCountry: null,
    entryCity: null,
    entryAsn: null,
    entryAsOrganization: null,
    placement: null,
    responseBytes: 0
  };
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

function applyGlobalDailyCap<T extends { dailyBudget: number; enabled?: boolean }>(monitors: T[], maxDailyProbes: number): T[] {
  const enabledMonitors = monitors.filter((monitor) => monitor.enabled !== false);
  const enabledBudget = enabledMonitors.reduce((total, monitor) => total + Math.max(0, monitor.dailyBudget), 0);
  if (enabledBudget <= maxDailyProbes) return monitors;
  let remaining = maxDailyProbes;
  let remainingEnabled = enabledMonitors.length;
  return monitors.map((monitor, index) => {
    if (monitor.enabled === false) return monitor;
    remainingEnabled -= 1;
    const scaled = Math.max(1, Math.floor((monitor.dailyBudget / enabledBudget) * maxDailyProbes));
    const capped = Math.min(scaled, Math.max(0, remaining - remainingEnabled));
    remaining -= capped;
    return { ...monitor, dailyBudget: capped };
  });
}

function jsonError(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
}
