import { mapWithConcurrency } from "./concurrency";
import type { MonitorMethod, ProbeJob, ProbeResult, RuntimeEnv } from "./domain";
import { createId, nowIso, parsePositiveInt } from "./domain";
import { normalizeWorkerUrl } from "./validation";

export interface DispatchOutcome {
  results: ProbeResult[];
  probeInvocations: number;
  dispatchedJobs: number;
}

interface DispatchBatch {
  probeUrl: string;
  jobs: ProbeJob[];
}

const MAX_OUTGOING_CONCURRENCY = 6;
const DEFAULT_MAX_RESPONSE_BYTES = 512_000;

export async function dispatchJobs(env: RuntimeEnv, jobs: ProbeJob[], origin: string): Promise<DispatchOutcome> {
  jobs = jobs.map((job, index) => ({ ...job, jobId: job.jobId ?? `${job.runId}:${index}` }));
  const groups = new Map<string, ProbeJob[]>();
  const batchSize = Math.min(5, parsePositiveInt(env.PROBE_BATCH_SIZE, 5));
  const immediateResults: ProbeResult[] = [];
  const localMode = env.ALLOW_LOCAL_PROBES === "true";
  if (!env.SHARED_SECRET && !localMode) {
    return {
      results: jobs.map((job) => dispatchErrorResult(job, "shared_secret_missing")),
      probeInvocations: 0,
      dispatchedJobs: 0
    };
  }
  if (!env.PROBE_WORKER_HOST_SUFFIX && !localMode) {
    return {
      results: jobs.map((job) => dispatchErrorResult(job, "probe_worker_host_suffix_missing")),
      probeInvocations: 0,
      dispatchedJobs: 0
    };
  }

  for (const job of jobs) {
    let probeUrl: string | null;
    try {
      probeUrl = resolveProbeUrl(env, job.region, origin);
    } catch {
      immediateResults.push(dispatchErrorResult(job, "region_worker_url_invalid"));
      continue;
    }
    if (!probeUrl) {
      immediateResults.push(dispatchErrorResult(job, "region_worker_url_missing"));
      continue;
    }
    const list = groups.get(probeUrl) ?? [];
    list.push(job);
    groups.set(probeUrl, list);
  }

  const batches: DispatchBatch[] = [];
  for (const [probeUrl, groupJobs] of groups) {
    for (let index = 0; index < groupJobs.length; index += batchSize) {
      batches.push({ probeUrl, jobs: groupJobs.slice(index, index + batchSize) });
    }
  }

  const concurrency = Math.min(
    MAX_OUTGOING_CONCURRENCY,
    parsePositiveInt(env.DISPATCH_CONCURRENCY, MAX_OUTGOING_CONCURRENCY)
  );
  const maxResponseBytes = Math.max(
    16_384,
    Math.min(2_000_000, parsePositiveInt(env.MAX_PROBE_RESPONSE_BYTES, DEFAULT_MAX_RESPONSE_BYTES))
  );
  const batchResults = await mapWithConcurrency(batches, concurrency, (batch) =>
    dispatchBatch(env, batch, maxResponseBytes)
  );

  return {
    results: immediateResults.concat(batchResults.flat()),
    probeInvocations: batches.length,
    dispatchedJobs: batches.reduce((total, batch) => total + batch.jobs.length, 0)
  };
}

export function reconcileProbeResults(jobs: ProbeJob[], candidates: unknown): ProbeResult[] {
  if (!Array.isArray(candidates)) {
    return jobs.map((job) => dispatchErrorResult(job, "probe_response_results_missing"));
  }

  const buckets = new Map<string, unknown[]>();
  for (const candidate of candidates) {
    if (!isRecord(candidate)) continue;
    const key = resultKey(candidate.runId, candidate.monitorId, candidate.regionId);
    if (!key) continue;
    const bucket = buckets.get(key) ?? [];
    bucket.push(candidate);
    buckets.set(key, bucket);
  }

  return jobs.map((job) => {
    const key = resultKey(job.runId, job.monitor.id, job.region.id);
    const candidate = key ? buckets.get(key)?.shift() : undefined;
    if (!candidate) return dispatchErrorResult(job, "probe_result_missing");
    return sanitizeProbeResult(job, candidate) ?? dispatchErrorResult(job, "probe_result_invalid");
  });
}

export function dispatchErrorResult(job: ProbeJob, error: string): ProbeResult {
  return {
    resultType: "infrastructure",
    id: job.jobId ? `res_${job.jobId}` : createId("res"),
    runId: job.runId,
    monitorId: job.monitor.id,
    monitorConfigVersion: job.monitor.configVersion,
    regionId: job.region.id,
    targetUrl: job.monitor.url,
    checkedAt: nowIso(),
    ok: false,
    status: null,
    latencyMs: null,
    error: error.slice(0, 512),
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

async function dispatchBatch(env: RuntimeEnv, batch: DispatchBatch, maxResponseBytes: number): Promise<ProbeResult[]> {
  const longestProbeTimeout = Math.max(...batch.jobs.map((job) => job.monitor.timeoutMs), 1_000);
  const dispatchTimeoutMs = Math.min(
    parsePositiveInt(env.MAX_DISPATCH_TIMEOUT_MS, 130_000),
    longestProbeTimeout * 2 + 10_000
  );
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("probe_dispatch_timeout"), dispatchTimeoutMs);
  try {
    const response = await fetch(batch.probeUrl, {
      method: "POST",
      redirect: "manual",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "X-MonsterTracker-Secret": env.SHARED_SECRET || "local-dev-secret"
      },
      body: JSON.stringify({ jobs: batch.jobs })
    });
    const responseText = await readResponseText(response, maxResponseBytes);
    if (!response.ok) {
      const error = `probe_worker_${response.status}:${responseText.slice(0, 120)}`;
      return batch.jobs.map((job) => dispatchErrorResult(job, error));
    }

    let body: unknown;
    try {
      body = JSON.parse(responseText);
    } catch {
      return batch.jobs.map((job) => dispatchErrorResult(job, "probe_response_invalid_json"));
    }
    return reconcileProbeResults(batch.jobs, isRecord(body) ? body.results : null);
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : "probe_dispatch_failed";
    return batch.jobs.map((job) => dispatchErrorResult(job, message));
  } finally {
    clearTimeout(timeout);
  }
}

async function readResponseText(response: Response, maxBytes: number): Promise<string> {
  const declaredLength = Number.parseInt(response.headers.get("Content-Length") ?? "0", 10);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("probe_response_too_large");
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const read = await reader.read();
      if (read.done) break;
      if (!read.value) continue;
      if (bytes + read.value.byteLength > maxBytes) {
        throw new Error("probe_response_too_large");
      }
      chunks.push(read.value);
      bytes += read.value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  const merged = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

function sanitizeProbeResult(job: ProbeJob, input: unknown): ProbeResult | null {
  if (!isRecord(input)) return null;
  const id = safeText(input.id, 160);
  const checkedAt = safeIsoDate(input.checkedAt);
  const method = input.method === "GET" ? "GET" : input.method === "HEAD" ? "HEAD" : null;
  if (!id || !checkedAt || !method || typeof input.ok !== "boolean") return null;
  const checkedAtMs = Date.parse(checkedAt);
  const scheduledAtMs = Date.parse(job.scheduledAt);
  const nowWithClockSkewMs = Date.now() + 5 * 60 * 1000;
  if (
    !Number.isFinite(scheduledAtMs) ||
    checkedAtMs < scheduledAtMs - 5 * 60 * 1000 ||
    checkedAtMs > nowWithClockSkewMs
  ) {
    return null;
  }
  if (
    input.runId !== job.runId ||
    input.monitorId !== job.monitor.id ||
    (input.monitorConfigVersion !== undefined && input.monitorConfigVersion !== job.monitor.configVersion) ||
    input.regionId !== job.region.id ||
    input.targetUrl !== job.monitor.url
  ) {
    return null;
  }

  const status = nullableInteger(input.status, 100, 599);
  const latencyMs = nullableInteger(input.latencyMs, 0, 300_000);
  const entryAsn = nullableInteger(input.entryAsn, 0, 4_294_967_295);
  const responseBytes = requiredInteger(input.responseBytes, 0, 10_000_000);
  if (
    status === undefined ||
    latencyMs === undefined ||
    entryAsn === undefined ||
    responseBytes === undefined
  ) {
    return null;
  }

  return {
    id: job.jobId ? `res_${job.jobId}` : id,
    resultType: "target",
    runId: job.runId,
    monitorId: job.monitor.id,
    monitorConfigVersion: job.monitor.configVersion,
    regionId: job.region.id,
    targetUrl: job.monitor.url,
    checkedAt,
    ok: input.ok,
    status,
    latencyMs,
    error: nullableText(input.error, 512),
    method: method as MonitorMethod,
    entryColo: nullableText(input.entryColo, 32),
    entryCountry: nullableText(input.entryCountry, 8),
    entryCity: nullableText(input.entryCity, 160),
    entryAsn,
    entryAsOrganization: nullableText(input.entryAsOrganization, 256),
    placement: nullableText(input.placement, 256),
    responseBytes
  };
}

function resolveProbeUrl(
  env: RuntimeEnv,
  region: Pick<ProbeJob["region"], "id" | "workerUrl">,
  origin: string
): string | null {
  const normalize = (value: string) =>
    withProbePath(
      normalizeWorkerUrl(value, {
        allowLocalHttp: env.ALLOW_LOCAL_PROBES === "true",
        allowPrivateTargets: env.ALLOW_LOCAL_PROBES === "true",
        ...(env.PROBE_WORKER_HOST_SUFFIX
          ? { allowedHostnameSuffix: env.PROBE_WORKER_HOST_SUFFIX }
          : {})
      }) as string
    );
  if (region.workerUrl) return normalize(region.workerUrl);
  if (env.PROBE_URL_TEMPLATE) {
    const worker = `monstertracker-probe-${region.id}`;
    return normalize(
      env.PROBE_URL_TEMPLATE
        .replaceAll("{id}", region.id)
        .replaceAll("{worker}", worker)
        .replaceAll("{region}", region.id)
    );
  }
  return env.ALLOW_LOCAL_PROBES === "true" ? normalize(origin) : null;
}

function withProbePath(base: string): string {
  const url = new URL(base);
  url.pathname = "/internal/probe";
  url.search = "";
  url.hash = "";
  return url.toString();
}

function resultKey(runId: unknown, monitorId: unknown, regionId: unknown): string | null {
  return typeof runId === "string" && typeof monitorId === "string" && typeof regionId === "string"
    ? `${runId}\u0000${monitorId}\u0000${regionId}`
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeText(value: unknown, maxLength: number): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength ? value : null;
}

function nullableText(value: unknown, maxLength: number): string | null {
  if (value === null || value === undefined || value === "") return null;
  return typeof value === "string" && value.length <= maxLength ? value : null;
}

function safeIsoDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || timestamp > Date.now() + 5 * 60_000) return null;
  return new Date(timestamp).toISOString();
}

function nullableInteger(value: unknown, min: number, max: number): number | null | undefined {
  if (value === null || value === undefined) return null;
  return requiredInteger(value, min, max);
}

function requiredInteger(value: unknown, min: number, max: number): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : undefined;
}
