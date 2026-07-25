import type { MonitorMethod, ProbeJob, ProbeResult } from "./domain";
import { MAX_BODY_MATCH_BYTES, createId } from "./domain";
import { mapWithConcurrency } from "./concurrency";
import { normalizeTargetUrl } from "./validation";

export interface ProbeRequestPayload {
  jobs: ProbeJob[];
}

export interface ParseProbeJobsOptions {
  allowPrivateTargets: boolean;
  maxJobs: number;
}

export function parseProbeJobs(input: unknown, options: ParseProbeJobsOptions): ProbeJob[] {
  if (!isRecord(input) || !Array.isArray(input.jobs)) {
    throw new Error("Payload must include a jobs array.");
  }
  if (input.jobs.length > options.maxJobs) {
    throw new Error(`Probe batch exceeds the ${options.maxJobs} job limit.`);
  }
  return input.jobs.map((job, index) => parseProbeJob(job, index, options.allowPrivateTargets));
}

export async function runProbeJobs(request: Request, jobs: ProbeJob[], concurrency = 6): Promise<ProbeResult[]> {
  return mapWithConcurrency(jobs, concurrency, (job) => runSingleProbe(request, job));
}

async function runSingleProbe(request: Request, job: ProbeJob): Promise<ProbeResult> {
  const checkedAt = new Date().toISOString();
  const cf = request.cf;
  const placement = request.headers.get("cf-placement");
  const started = performance.now();
  let status: number | null = null;
  let latencyMs: number | null = null;
  let error: string | null = null;
  let ok = false;
  let responseBytes = 0;
  let method: MonitorMethod = job.monitor.method;

  try {
    let inspected = await fetchWithTimeout(
      job.monitor.url,
      method,
      job.monitor.timeoutMs,
      method === "GET" ? job.monitor.bodyMatch : null
    );
    if (method === "HEAD" && inspected.response.status === 405) {
      method = "GET";
      inspected = await fetchWithTimeout(job.monitor.url, method, job.monitor.timeoutMs, null);
    }

    const response = inspected.response;
    status = response.status;
    latencyMs = Math.round(performance.now() - started);
    ok =
      status >= job.monitor.expectedStatusMin &&
      status <= job.monitor.expectedStatusMax;

    if (job.monitor.bodyMatch) {
      const prefix = inspected.prefix ?? { text: "", bytes: 0 };
      responseBytes = prefix.bytes;
      ok = ok && prefix.text.includes(job.monitor.bodyMatch);
      if (!prefix.text.includes(job.monitor.bodyMatch)) {
        error = "body_match_failed";
      }
    }
  } catch (caught) {
    latencyMs = Math.round(performance.now() - started);
    error = caught instanceof Error ? caught.message : "unknown_probe_error";
  }

  return {
    id: createId("res"),
    runId: job.runId,
    monitorId: job.monitor.id,
    monitorConfigVersion: job.monitor.configVersion,
    regionId: job.region.id,
    targetUrl: job.monitor.url,
    checkedAt,
    ok,
    status,
    latencyMs,
    error,
    method,
    entryColo: typeof cf?.colo === "string" ? cf.colo : null,
    entryCountry: typeof cf?.country === "string" ? cf.country : null,
    entryCity: typeof cf?.city === "string" ? cf.city : null,
    entryAsn: typeof cf?.asn === "number" ? cf.asn : null,
    entryAsOrganization: typeof cf?.asOrganization === "string" ? cf.asOrganization : null,
    placement,
    responseBytes
  };
}

async function fetchWithTimeout(
  url: string,
  method: MonitorMethod,
  timeoutMs: number,
  bodyMatch: string | null
): Promise<{ response: Response; prefix: { text: string; bytes: number } | null }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("probe_timeout"), timeoutMs);
  try {
    const response = await fetch(url, {
      method,
      redirect: "manual",
      signal: controller.signal,
      headers: {
        "User-Agent": "MonsterTracker/0.1 Cloudflare Worker Probe",
        "Accept": method === "HEAD" ? "*/*" : "text/plain,text/html,application/json,*/*;q=0.1",
        "Cache-Control": "no-cache"
      }
    });
    const prefix = bodyMatch ? await readResponsePrefix(response, MAX_BODY_MATCH_BYTES) : null;
    if (!bodyMatch) await response.body?.cancel().catch(() => undefined);
    return { response, prefix };
  } finally {
    clearTimeout(timeout);
  }
}

async function readResponsePrefix(response: Response, maxBytes: number): Promise<{ text: string; bytes: number }> {
  if (!response.body) return { text: "", bytes: 0 };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (bytes < maxBytes) {
      const read = await reader.read();
      if (read.done) break;
      const value = read.value;
      if (!value) continue;
      const remaining = maxBytes - bytes;
      const chunk = value.byteLength > remaining ? value.slice(0, remaining) : value;
      chunks.push(chunk);
      bytes += chunk.byteLength;
      if (value.byteLength > remaining) break;
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
  return {
    text: new TextDecoder().decode(merged),
    bytes
  };
}

function parseProbeJob(input: unknown, index: number, allowPrivateTargets: boolean): ProbeJob {
  if (!isRecord(input) || !isRecord(input.monitor) || !isRecord(input.region)) {
    throw new Error(`jobs[${index}] must include monitor and region objects.`);
  }

  const runId = requiredText(input.runId, `jobs[${index}].runId`, 160);
  const scheduledAt = requiredIsoDate(input.scheduledAt, `jobs[${index}].scheduledAt`);
  const monitorId = requiredText(input.monitor.id, `jobs[${index}].monitor.id`, 160);
  const monitorName = requiredText(input.monitor.name, `jobs[${index}].monitor.name`, 256);
  const targetUrl = normalizeTargetUrl(requiredText(input.monitor.url, `jobs[${index}].monitor.url`, 16_384), {
    allowPrivateTargets
  });
  const method = input.monitor.method === "GET" ? "GET" : input.monitor.method === "HEAD" ? "HEAD" : null;
  if (!method) throw new Error(`jobs[${index}].monitor.method must be HEAD or GET.`);

  const expectedStatusMin = boundedInteger(
    input.monitor.expectedStatusMin,
    `jobs[${index}].monitor.expectedStatusMin`,
    100,
    599
  );
  const expectedStatusMax = boundedInteger(
    input.monitor.expectedStatusMax,
    `jobs[${index}].monitor.expectedStatusMax`,
    100,
    599
  );
  if (expectedStatusMin > expectedStatusMax) {
    throw new Error(`jobs[${index}] expected status range is invalid.`);
  }

  let bodyMatch: string | null = null;
  if (input.monitor.bodyMatch !== null && input.monitor.bodyMatch !== undefined) {
    if (typeof input.monitor.bodyMatch !== "string") {
      throw new Error(`jobs[${index}].monitor.bodyMatch must be a string or null.`);
    }
    if (new TextEncoder().encode(input.monitor.bodyMatch).length > MAX_BODY_MATCH_BYTES) {
      throw new Error(`jobs[${index}].monitor.bodyMatch is too large.`);
    }
    bodyMatch = input.monitor.bodyMatch;
  }

  const workerUrl =
    input.region.workerUrl === null || input.region.workerUrl === undefined
      ? null
      : requiredText(input.region.workerUrl, `jobs[${index}].region.workerUrl`, 16_384);

  return {
    runId,
    scheduledAt,
    monitor: {
      id: monitorId,
      name: monitorName,
      url: targetUrl,
      method,
      expectedStatusMin,
      expectedStatusMax,
      bodyMatch,
      timeoutMs: boundedInteger(input.monitor.timeoutMs, `jobs[${index}].monitor.timeoutMs`, 1_000, 60_000),
      configVersion:
        input.monitor.configVersion === undefined
          ? 1
          : boundedInteger(input.monitor.configVersion, `jobs[${index}].monitor.configVersion`, 1, 2_147_483_647)
    },
    region: {
      id: requiredText(input.region.id, `jobs[${index}].region.id`, 160),
      label: requiredText(input.region.label, `jobs[${index}].region.label`, 256),
      placementRegion: requiredText(input.region.placementRegion, `jobs[${index}].region.placementRegion`, 256),
      workerUrl
    }
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} is required.`);
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) throw new Error(`${label} is too long.`);
  return normalized;
}

function requiredIsoDate(value: unknown, label: string): string {
  const text = requiredText(value, label, 64);
  if (!Number.isFinite(Date.parse(text))) throw new Error(`${label} must be an ISO date.`);
  return new Date(text).toISOString();
}

function boundedInteger(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${label} must be an integer between ${min} and ${max}.`);
  }
  return value;
}
