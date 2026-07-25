import { afterEach, describe, expect, it, vi } from "vitest";

import { dispatchJobs, reconcileProbeResults } from "../src/dispatch";
import type { ProbeJob, ProbeResult, RuntimeEnv } from "../src/domain";
import { parseProbeJobs, runProbeJobs } from "../src/probe";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function makeJob(overrides: Partial<ProbeJob> = {}): ProbeJob {
  return {
    runId: "run_test",
    scheduledAt: "2026-07-25T10:00:00.000Z",
    monitor: {
      id: "mon_test",
      name: "Example",
      url: "https://example.com/",
      method: "HEAD",
      expectedStatusMin: 200,
      expectedStatusMax: 399,
      bodyMatch: null,
      timeoutMs: 10_000,
      configVersion: 1
    },
    region: {
      id: "use1",
      label: "US East",
      placementRegion: "aws:us-east-1",
      workerUrl: "https://probe.example.workers.dev/"
    },
    ...overrides
  };
}

function makeResult(job: ProbeJob, id: string): ProbeResult {
  return {
    id,
    runId: job.runId,
    monitorId: job.monitor.id,
    monitorConfigVersion: job.monitor.configVersion,
    regionId: job.region.id,
    targetUrl: job.monitor.url,
    checkedAt: "2026-07-25T10:00:01.000Z",
    ok: true,
    status: 204,
    latencyMs: 120,
    error: null,
    method: "HEAD",
    entryColo: "IAD",
    entryCountry: "US",
    entryCity: "Ashburn",
    entryAsn: 13335,
    entryAsOrganization: "Cloudflare",
    placement: "aws:us-east-1",
    responseBytes: 0
  };
}

describe("parseProbeJobs", () => {
  it("normalizes a valid payload", () => {
    const job = makeJob();
    const jobs = parseProbeJobs({ jobs: [job] }, { allowPrivateTargets: false, maxJobs: 50 });

    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.monitor.url).toBe("https://example.com/");
  });

  it("rejects oversized and private-target payloads", () => {
    const job = makeJob();
    expect(() =>
      parseProbeJobs({ jobs: [job, job] }, { allowPrivateTargets: false, maxJobs: 1 })
    ).toThrow("job limit");

    const privateJob = makeJob({
      monitor: { ...job.monitor, url: "http://127.0.0.1/admin" }
    });
    expect(() =>
      parseProbeJobs({ jobs: [privateJob] }, { allowPrivateTargets: false, maxJobs: 50 })
    ).toThrow("blocked");
  });
});

describe("runProbeJobs", () => {
  it("keeps the timeout active while reading a body match response", async () => {
    vi.useFakeTimers();
    const job = makeJob({
      monitor: {
        ...makeJob().monitor,
        method: "GET",
        bodyMatch: "ready",
        timeoutMs: 1_000
      }
    });
    vi.stubGlobal("fetch", (_url: string, init?: RequestInit) => {
      const signal = init?.signal;
      const body = new ReadableStream({
        start(controller) {
          signal?.addEventListener("abort", () => controller.error(new Error("body_read_aborted")));
        }
      });
      return Promise.resolve(new Response(body, { status: 200 }));
    });

    const pending = runProbeJobs(new Request("https://probe.example/"), [job], 1);
    await vi.advanceTimersByTimeAsync(1_001);
    const results = await pending;

    expect(results[0]?.ok).toBe(false);
    expect(results[0]?.error).toContain("body_read_aborted");
  });
});

describe("reconcileProbeResults", () => {
  it("matches repeated monitor-region jobs one-for-one", () => {
    const job = makeJob();
    const results = reconcileProbeResults([job, job], [makeResult(job, "res_1"), makeResult(job, "res_2")]);

    expect(results.map((result) => result.id)).toEqual(["res_1", "res_2"]);
    expect(results.every((result) => result.ok)).toBe(true);
  });

  it("creates explicit errors for missing or malformed results", () => {
    const job = makeJob();
    const missing = reconcileProbeResults([job], []);
    const malformed = reconcileProbeResults([job], [{ ...makeResult(job, "res_bad"), targetUrl: "https://evil.example/" }]);

    expect(missing[0]?.error).toBe("probe_result_missing");
    expect(malformed[0]?.error).toBe("probe_result_invalid");
  });

  it("accepts legacy probe results during a probe-first rolling upgrade", () => {
    const job = makeJob();
    const legacy = { ...makeResult(job, "res_legacy") } as Record<string, unknown>;
    delete legacy.monitorConfigVersion;

    expect(reconcileProbeResults([job], [legacy])[0]?.id).toBe("res_legacy");
  });

  it("rejects results outside the scheduled clock-skew window", () => {
    const job = makeJob();
    const tooOld = { ...makeResult(job, "res_old"), checkedAt: "2026-07-25T09:54:59.000Z" };
    const tooFarInFuture = {
      ...makeResult(job, "res_future"),
      checkedAt: new Date(Date.now() + 6 * 60 * 1000).toISOString()
    };

    expect(reconcileProbeResults([job], [tooOld])[0]?.error).toBe("probe_result_invalid");
    expect(reconcileProbeResults([job], [tooFarInFuture])[0]?.error).toBe("probe_result_invalid");
  });
});

describe("dispatchJobs", () => {
  it("isolates an invalid legacy worker URL instead of failing the run", async () => {
    const job = makeJob({
      region: { ...makeJob().region, workerUrl: "not a URL" }
    });
    const env = {
      SHARED_SECRET: "test-secret",
      PROBE_WORKER_HOST_SUFFIX: ".example.workers.dev"
    } as RuntimeEnv;

    const outcome = await dispatchJobs(env, [job], "https://control.example/");

    expect(outcome.probeInvocations).toBe(0);
    expect(outcome.results[0]?.error).toBe("region_worker_url_invalid");
  });

  it("bounds a control-to-probe request with a dispatch timeout", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("dispatch_aborted")));
      })
    );
    const job = makeJob();
    const env = {
      SHARED_SECRET: "test-secret",
      PROBE_WORKER_HOST_SUFFIX: ".example.workers.dev",
      MAX_DISPATCH_TIMEOUT_MS: "1000"
    } as RuntimeEnv;

    const pending = dispatchJobs(env, [job], "https://control.example/");
    await vi.advanceTimersByTimeAsync(1_001);
    const outcome = await pending;

    expect(outcome.dispatchedJobs).toBe(1);
    expect(outcome.results[0]?.error).toContain("dispatch_aborted");
  });
});
