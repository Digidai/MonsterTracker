import type { MonitorMethod, ProbeJob, ProbeResult } from "./domain";
import { MAX_BODY_MATCH_BYTES, createId } from "./domain";

export interface ProbeRequestPayload {
  jobs: ProbeJob[];
}

export async function runProbeJobs(request: Request, jobs: ProbeJob[]): Promise<ProbeResult[]> {
  const results: ProbeResult[] = [];
  for (const job of jobs) {
    results.push(await runSingleProbe(request, job));
  }
  return results;
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
    let response = await fetchWithTimeout(job.monitor.url, method, job.monitor.timeoutMs);
    if (method === "HEAD" && response.status === 405) {
      method = "GET";
      response = await fetchWithTimeout(job.monitor.url, method, job.monitor.timeoutMs);
    }

    status = response.status;
    latencyMs = Math.round(performance.now() - started);
    ok =
      status >= job.monitor.expectedStatusMin &&
      status <= job.monitor.expectedStatusMax;

    if (job.monitor.bodyMatch) {
      const prefix = await readResponsePrefix(response, MAX_BODY_MATCH_BYTES);
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

async function fetchWithTimeout(url: string, method: MonitorMethod, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("probe_timeout"), timeoutMs);
  try {
    return await fetch(url, {
      method,
      redirect: "manual",
      signal: controller.signal,
      headers: {
        "User-Agent": "MonsterTracker/0.1 Cloudflare Worker Probe",
        "Accept": method === "HEAD" ? "*/*" : "text/plain,text/html,application/json,*/*;q=0.1",
        "Cache-Control": "no-cache"
      }
    });
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
