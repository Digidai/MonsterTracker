import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { ProbeJob, ProbeResult, RuntimeEnv } from "../src/domain";
import { buildSchedulePlan } from "../src/scheduler";
import { claimRecoverableSchedulerRun, claimScheduledRunAndReserve, getRuntimeSettings, listMonitors, listRegions } from "../src/storage";
import { databaseHarness } from "./d1-harness";

const databases: ReturnType<typeof databaseHarness>[] = [];
const background: Promise<unknown>[] = [];
const ctx = { waitUntil: (promise: Promise<unknown>) => { background.push(promise); } } as ExecutionContext;
const startedAt = "2026-09-16T12:01:00.000Z";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(startedAt);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    const { jobs } = JSON.parse(String(init.body)) as { jobs: ProbeJob[] };
    return Response.json({ results: jobs.map((job) => ({
      ...result(), runId: job.runId, monitorId: job.monitor.id, regionId: job.region.id,
      monitorConfigVersion: job.monitor.configVersion, targetUrl: job.monitor.url
    })) });
  }));
});
afterEach(async () => {
  await Promise.all(background.splice(0));
  for (const db of databases.splice(0)) db.sqlite.close();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function setup(monitors = 1) {
  const db = databaseHarness(50);
  databases.push(db);
  db.sqlite.exec(`INSERT INTO regions (id,label,area,provider,provider_region,placement_region,worker_name,created_at,updated_at)
    VALUES ('r','Region','Area','aws','us-east-1','aws:us-east-1','probe','2026-01-01','2026-01-01')`);
  for (let i = 0; i < monitors; i++) db.sqlite.prepare(`INSERT INTO monitors (id,name,url,daily_budget,created_at,updated_at)
    VALUES (?, 'Monitor', 'https://example.com/', 1440, '2026-01-01', '2026-01-01')`).run(`m${i}`);
  Object.assign(db.env, { ADMIN_TOKEN: "synthetic-test-only", ALLOW_LOCAL_PROBES: "true", MAX_DAILY_PROBES: "20000" });
  return db;
}

function request(mode: "due" | "sample") {
  return new Request("http://localhost:8787/api/run", {
    method: "POST", headers: { Authorization: "Bearer synthetic-test-only", "Content-Type": "application/json" },
    body: JSON.stringify({ mode })
  });
}

function scheduled(env: RuntimeEnv) {
  return worker.scheduled({ scheduledTime: Date.now() } as ScheduledEvent, env, ctx);
}

function result(patch: Partial<ProbeResult> = {}): ProbeResult {
  return { id: crypto.randomUUID(), runId: "test", monitorId: "m0", monitorConfigVersion: 1,
    regionId: "r", targetUrl: "https://example.com/", checkedAt: new Date().toISOString(), ok: true,
    resultType: "target", status: 200, latencyMs: 20, error: null, method: "HEAD", entryColo: "IAD",
    entryCountry: "US", entryCity: null, entryAsn: null, entryAsOrganization: null, placement: null, responseBytes: 0, ...patch };
}

async function leasedRun(db: ReturnType<typeof setup>, id = "cron_recover") {
  const jobs = buildSchedulePlan(await listMonitors(db.env), await listRegions(db.env), new Date(), id).jobs;
  await claimScheduledRunAndReserve(db.env, { id, startedAt, plannedJobs: jobs.length }, jobs, 20000, "2026-09-16");
  db.resetCount();
  return jobs;
}

function expireLease(db: ReturnType<typeof setup>) {
  db.sqlite.exec("UPDATE scheduler_runs SET lease_expires_at='2020-01-01T00:00:00.000Z' WHERE finished_at IS NULL");
  db.resetCount();
}

describe("manual due recovery", () => {
  it("retries a failed Queue send through cron without reserving the same minute twice", async () => {
    const db = setup();
    const send = vi.fn().mockRejectedValueOnce(new Error("queue_unavailable")).mockResolvedValue(undefined);
    db.env.RESULTS_QUEUE = { send } as unknown as Queue<ProbeResult[]>;
    expect((await worker.fetch(request("due"), db.env, ctx)).status).toBe(500);
    const run = db.sqlite.prepare("SELECT id,finished_at,lease_expires_at,attempt_count FROM scheduler_runs").get();
    expect(run).toMatchObject({ finished_at: null, attempt_count: 1 });
    expect(run?.lease_expires_at).toBe("2026-09-16T12:02:00.000Z");
    db.resetCount();
    expect((await worker.fetch(request("due"), db.env, ctx)).status).toBe(202);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(db.sqlite.prepare("SELECT reserved_probes FROM daily_usage").get()?.reserved_probes).toBe(1);
    vi.setSystemTime("2026-09-16T12:02:01.000Z");
    db.resetCount();
    await scheduled(db.env);
    expect(db.sqlite.prepare("SELECT finished_at,attempt_count,error FROM scheduler_runs WHERE id=?").get(String(run?.id)))
      .toMatchObject({ finished_at: new Date().toISOString(), attempt_count: 2, error: null });
    expect(send).toHaveBeenCalledTimes(3); // failed manual send, recovery, current minute
    expect(db.sqlite.prepare("SELECT reserved_probes FROM daily_usage").get()?.reserved_probes).toBe(2);
  });

  it("keeps failed manual samples terminal", async () => {
    const db = setup();
    db.env.RESULTS_QUEUE = { send: vi.fn().mockRejectedValue(new Error("queue_unavailable")) } as unknown as Queue<ProbeResult[]>;
    expect((await worker.fetch(request("sample"), db.env, ctx)).status).toBe(500);
    expect(db.sqlite.prepare("SELECT finished_at FROM scheduler_runs").get()?.finished_at).toBe(startedAt);
    expect(await claimRecoverableSchedulerRun(db.env)).toBeNull();
  });
});

describe("crash recovery leases", () => {
  it("retires a killed third attempt and continues to the next eligible run", async () => {
    const db = setup();
    await leasedRun(db);
    for (const attempt of [2, 3]) {
      expireLease(db);
      expect((await claimRecoverableSchedulerRun(db.env))?.id).toBe("cron_recover");
      expect(db.sqlite.prepare("SELECT attempt_count FROM scheduler_runs").get()?.attempt_count).toBe(attempt);
    }
    // A still-valid third lease must not be terminated by another trigger.
    expect(await claimRecoverableSchedulerRun(db.env)).toBeNull();
    expect(db.sqlite.prepare("SELECT finished_at FROM scheduler_runs").get()?.finished_at).toBeNull();
    await leasedRun(db, "cron_next");
    expireLease(db);
    expect((await claimRecoverableSchedulerRun(db.env))?.id).toBe("cron_next");
    expect(db.sqlite.prepare("SELECT attempt_count,finished_at,lease_expires_at,error FROM scheduler_runs WHERE id='cron_recover'").get())
      .toMatchObject({ attempt_count: 3, finished_at: startedAt, lease_expires_at: null, error: "scheduler_retry_limit_exhausted" });
    expect(db.sqlite.prepare("SELECT reserved_probes FROM daily_usage").get()?.reserved_probes).toBe(2);
  });

  it("does not claim a lease another invocation acquired during preflight", async () => {
    const db = setup(); await leasedRun(db); expireLease(db);
    const claimed = await claimRecoverableSchedulerRun(db.env, () => {
      db.sqlite.exec("UPDATE scheduler_runs SET attempt_count=2, lease_expires_at='2026-09-16T12:17:00.000Z'");
    });
    expect(claimed).toBeNull();
    expect(db.sqlite.prepare("SELECT attempt_count FROM scheduler_runs").get()?.attempt_count).toBe(2);
  });
});

describe("legacy Queue evidence", () => {
  it("classifies old dispatch failures without hiding genuine target timeouts", async () => {
    const db = setup();
    const writeDataPoint = vi.fn();
    db.env.ANALYTICS = { writeDataPoint } as unknown as AnalyticsEngineDataset;
    const { resultType: _type, ...legacy } = result({ ok: false, status: null, latencyMs: null, error: "probe_worker_503" });
    await worker.queue({ messages: [{ body: [legacy] }] } as unknown as MessageBatch<ProbeResult[]>, db.env, ctx);
    expect(db.sqlite.prepare("SELECT result_type FROM probe_results").get()?.result_type).toBe("infrastructure");
    expect(db.sqlite.prepare("SELECT count(*) n FROM incidents").get()?.n).toBe(0);
    expect(writeDataPoint.mock.calls[0]?.[0].doubles[2]).toBe(-1);
    db.resetCount(); vi.setSystemTime(Date.now() + 1000);
    const timeout = { ...legacy, id: "target_timeout", checkedAt: new Date().toISOString(), latencyMs: 10000, error: "probe_timeout" };
    await worker.queue({ messages: [{ body: [timeout] }] } as unknown as MessageBatch<ProbeResult[]>, db.env, ctx);
    expect(db.sqlite.prepare("SELECT result_type FROM probe_results WHERE id='target_timeout'").get()?.result_type).toBe("target");
    expect(db.sqlite.prepare("SELECT status FROM incidents").get()?.status).toBe("open");
    db.resetCount();
    await worker.queue({ messages: [{ body: [timeout] }] } as unknown as MessageBatch<ProbeResult[]>, db.env, ctx);
    expect(db.sqlite.prepare("SELECT probe_results FROM daily_usage").get()?.probe_results).toBe(2);
    expect(writeDataPoint).toHaveBeenCalledTimes(2);
  });
});

describe("no-Queue invocation preflight", () => {
  it.each(["sample", "due"] as const)("rejects eleven %s jobs before dispatch or budget reservation", async (mode) => {
    const db = setup(11);
    const response = await worker.fetch(request(mode), db.env, ctx);
    expect(response.status).toBe(503);
    expect((await response.json() as { error: string }).error).toContain("RESULTS_QUEUE is required");
    expect(fetch).not.toHaveBeenCalled();
    expect(db.sqlite.prepare("SELECT count(*) n FROM daily_usage").get()?.n).toBe(0);
    expect(db.sqlite.prepare("SELECT count(*) n FROM scheduler_runs").get()?.n).toBe(0);
    expect(db.count()).toBeLessThanOrEqual(50);
  });

  it("allows a ten-result manual invocation within the aggregate limit", async () => {
    const db = setup(10);
    expect((await worker.fetch(request("due"), db.env, ctx)).status).toBe(200);
    expect(db.sqlite.prepare("SELECT count(*) n FROM probe_results").get()?.n).toBe(10);
    expect(db.count()).toBe(48);
  });

  it("includes configured smaller chunks in the query estimate", async () => {
    const db = setup(4); Object.assign(db.env, { RESULT_QUEUE_BATCH_SIZE: "1" });
    expect((await worker.fetch(request("sample"), db.env, ctx)).status).toBe(503);
    expect(fetch).not.toHaveBeenCalled();
    expect(db.sqlite.prepare("SELECT count(*) n FROM daily_usage").get()?.n).toBe(0);
  });

  it("counts cold bootstrap statements before deciding whether samples fit", async () => {
    const db = setup(6);
    db.sqlite.exec("DELETE FROM regions");
    const response = await worker.fetch(request("sample"), db.env, ctx);
    expect(response.status).toBe(503);
    expect((await response.json() as { error: string }).error).toContain("RESULTS_QUEUE is required");
    expect(fetch).not.toHaveBeenCalled();
    expect(db.sqlite.prepare("SELECT count(*) n FROM daily_usage").get()?.n).toBe(0);
    expect(db.count()).toBeLessThanOrEqual(50);
  });

  it("includes scheduler housekeeping before accepting a direct run", async () => {
    const db = setup(10);
    await expect(scheduled(db.env)).rejects.toThrow("RESULTS_QUEUE is required");
    expect(fetch).not.toHaveBeenCalled();
    expect(db.sqlite.prepare("SELECT count(*) n FROM daily_usage").get()?.n).toBe(0);
    expect(db.sqlite.prepare("SELECT count(*) n FROM scheduler_runs").get()?.n).toBe(0);
    expect(db.count()).toBeLessThanOrEqual(50);
  });

  it("reserves room for hourly retention and finishes a safe scheduled run", async () => {
    const db = setup(8); vi.setSystemTime("2026-09-16T12:00:00.000Z");
    await scheduled(db.env);
    await Promise.all(background.splice(0));
    expect(db.sqlite.prepare("SELECT count(*) n FROM probe_results").get()?.n).toBe(8);
    expect(db.count()).toBe(49);
  });

  it("rejects aggregate recovery plus current work before claiming or dispatching either", async () => {
    const db = setup(3); await leasedRun(db); expireLease(db);
    await expect(scheduled(db.env)).rejects.toThrow("RESULTS_QUEUE is required");
    expect(fetch).not.toHaveBeenCalled();
    expect(db.sqlite.prepare("SELECT attempt_count,finished_at FROM scheduler_runs").get())
      .toMatchObject({ attempt_count: 1, finished_at: null });
    expect(db.sqlite.prepare("SELECT reserved_probes FROM daily_usage").get()?.reserved_probes).toBe(3);
    expect(db.sqlite.prepare("SELECT count(*) n FROM scheduler_runs").get()?.n).toBe(1);
  });

  it("allows safe recovery plus current work within one invocation", async () => {
    const db = setup(2); await leasedRun(db); expireLease(db);
    await scheduled(db.env);
    expect(db.sqlite.prepare("SELECT count(*) n FROM probe_results").get()?.n).toBe(4);
    expect(db.sqlite.prepare("SELECT reserved_probes FROM daily_usage").get()?.reserved_probes).toBe(4);
    expect(db.count()).toBe(46); // includes monitor visibility refresh after recovery
  });

  it("keeps ten-result Queue consumers at forty statements", async () => {
    const db = setup(10);
    const body = Array.from({ length: 10 }, (_, i) => result({ monitorId: `m${i}`, ok: false, status: 503 }));
    await worker.queue({ messages: [{ body }] } as unknown as MessageBatch<ProbeResult[]>, db.env, ctx);
    expect(db.count()).toBe(40);
    expect(db.sqlite.prepare("SELECT count(*) n FROM incidents WHERE status='open'").get()?.n).toBe(10);
  });
});

describe("cost API batch defaults", () => {
  it("matches runtime's ten-result default when the binding is absent", async () => {
    const db = setup();
    const response = await worker.fetch(new Request("http://localhost:8787/api/cost?urls=10&probesPerDay=10000"), db.env, ctx);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ queueOperationsPerDay: 3000 });
    expect(getRuntimeSettings(db.env).resultQueueBatchSize).toBe(10);
  });

  it("honors a configured smaller batch and caps the public override at ten", async () => {
    const db = setup(); Object.assign(db.env, { RESULT_QUEUE_BATCH_SIZE: "5" });
    const base = "http://localhost:8787/api/cost?urls=10&probesPerDay=10000";
    const configured = await worker.fetch(new Request(base), db.env, ctx);
    expect(await configured.json()).toMatchObject({ queueOperationsPerDay: 6000 });
    expect(getRuntimeSettings(db.env).resultQueueBatchSize).toBe(5);
    const overridden = await worker.fetch(new Request(`${base}&queueBatchSize=100`), db.env, ctx);
    expect(await overridden.json()).toMatchObject({ queueOperationsPerDay: 3000 });
  });
});
