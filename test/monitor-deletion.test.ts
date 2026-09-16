import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { ProbeJob, ProbeResult } from "../src/domain";
import { buildSchedulePlan } from "../src/scheduler";
import { claimScheduledRunAndReserve, deleteMonitor, getRunStatus, listIncidents, listLatest,
  listMonitors, listProbeResults, listRegions, saveProbeResults, updateMonitor } from "../src/storage";
import { databaseHarness } from "./d1-harness";

const databases: ReturnType<typeof databaseHarness>[] = [];
const background: Promise<unknown>[] = [];
const ctx = { waitUntil: (promise: Promise<unknown>) => { background.push(promise); } } as ExecutionContext;
afterEach(async () => {
  await Promise.all(background.splice(0));
  for (const db of databases.splice(0)) db.sqlite.close();
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});

function setup(count = 2) {
  const db = databaseHarness(); databases.push(db);
  db.sqlite.exec("PRAGMA foreign_keys = ON");
  db.sqlite.exec(`INSERT INTO regions (id,label,area,provider,provider_region,placement_region,worker_name,created_at,updated_at)
    VALUES ('r','Region','Area','aws','us-east-1','aws:us-east-1','probe','2026-01-01','2026-01-01')`);
  for (let index = 0; index < count; index++) db.sqlite.prepare(`INSERT INTO monitors (id,name,url,daily_budget,created_at,updated_at)
    VALUES (?, 'Monitor', 'https://example.com/', 1440, '2026-01-01', '2026-01-01')`).run(`m${index}`);
  Object.assign(db.env, { ADMIN_TOKEN: "synthetic-test-only", ALLOW_LOCAL_PROBES: "true" });
  return db;
}

function request(path = "/api/monitors/m0", method = "DELETE", authenticated = true, body?: unknown) {
  return new Request(`http://localhost:8787${path}`, { method,
    headers: { ...(authenticated ? { Authorization: "Bearer synthetic-test-only" } : {}), "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

function result(patch: Partial<ProbeResult> = {}): ProbeResult {
  return { id: crypto.randomUUID(), runId: "manual_test", monitorId: "m0", monitorConfigVersion: 1,
    regionId: "r", targetUrl: "https://example.com/", checkedAt: new Date().toISOString(), ok: false,
    resultType: "target", status: 503, latencyMs: 20, error: null, method: "HEAD", entryColo: "IAD",
    entryCountry: "US", entryCity: null, entryAsn: null, entryAsOrganization: null, placement: null, responseBytes: 0, ...patch };
}

describe("monitor deletion", () => {
  it("requires admin authorization and returns 404 for an unknown ID", async () => {
    const db = setup();
    expect((await worker.fetch(request(undefined, undefined, false), db.env, ctx)).status).toBe(401);
    expect((await listMonitors(db.env)).length).toBe(2);
    expect((await worker.fetch(request("/api/monitors/missing"), db.env, ctx)).status).toBe(404);
  });

  it("deletes atomically and idempotently while retaining history and usage", async () => {
    const db = setup();
    await saveProbeResults(db.env, [result()]);
    const usage = db.sqlite.prepare("SELECT * FROM daily_usage").get();
    const response = await worker.fetch(request(), db.env, ctx);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ deleted: true });
    const deleted = db.sqlite.prepare("SELECT * FROM monitors WHERE id='m0'").get();
    expect(deleted).toMatchObject({ enabled: 0, config_version: 2, deleted_at: expect.any(String) });
    expect((await listMonitors(db.env)).map((item) => item.id)).toEqual(["m1"]);
    expect(await listLatest(db.env)).toEqual([]);
    expect(await listIncidents(db.env)).toEqual([]);
    expect(db.sqlite.prepare("SELECT status, summary FROM incidents").get()).toMatchObject({
      status: "resolved", summary: expect.stringContaining("recovery was not verified")
    });
    expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM probe_results").get()?.n).toBe(1);
    expect(db.sqlite.prepare("SELECT * FROM daily_usage").get()).toEqual(usage);
    expect((await worker.fetch(request(), db.env, ctx)).status).toBe(200);
    expect(db.sqlite.prepare("SELECT * FROM monitors WHERE id='m0'").get()).toEqual(deleted);
  });

  it("rolls back all deletion changes if a write fails", async () => {
    const db = setup(); await saveProbeResults(db.env, [result()]);
    db.sqlite.exec(`CREATE TRIGGER fail_delete BEFORE DELETE ON monitor_latest BEGIN SELECT RAISE(ABORT, 'synthetic_failure'); END`);
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await worker.fetch(request(), db.env, ctx)).status).toBe(503);
    expect(db.sqlite.prepare("SELECT enabled,deleted_at,config_version FROM monitors WHERE id='m0'").get())
      .toMatchObject({ enabled: 1, deleted_at: null, config_version: 1 });
    expect((await listLatest(db.env)).length).toBe(1);
    expect((await listIncidents(db.env))[0]?.status).toBe("open");
  });

  it("rejects reads, edits, samples and scheduling for a deleted monitor", async () => {
    const db = setup(); await deleteMonitor(db.env, "m0");
    await expect(listProbeResults(db.env, "m0")).rejects.toThrow("Monitor not found");
    await expect(updateMonitor(db.env, "m0", { enabled: true })).rejects.toThrow("Monitor not found");
    expect((await worker.fetch(request(undefined, "GET"), db.env, ctx)).status).toBe(404);
    expect((await worker.fetch(request("/api/run", "POST", true, { mode: "sample", monitorId: "m0" }), db.env, ctx)).status).toBe(404);
    const jobs = buildSchedulePlan(await listMonitors(db.env), await listRegions(db.env), new Date()).jobs;
    expect(jobs.every((job) => job.monitor.id === "m1")).toBe(true);
  });

  it("cannot be resurrected by an edit that read the old configuration", async () => {
    const db = setup(); const originalBatch = db.env.DB.batch.bind(db.env.DB);
    let intercepted = false;
    vi.spyOn(db.env.DB, "batch").mockImplementation(async (statements) => {
      if (!intercepted) { intercepted = true; await deleteMonitor(db.env, "m0"); }
      return originalBatch(statements);
    });
    await expect(updateMonitor(db.env, "m0", { name: "Concurrent edit", enabled: true })).rejects.toThrow("changed concurrently");
    expect(db.sqlite.prepare("SELECT enabled,deleted_at FROM monitors WHERE id='m0'").get())
      .toMatchObject({ enabled: 0, deleted_at: expect.any(String) });
  });

  it("accepts delayed mixed Queue batches without restoring deleted state or affecting another monitor", async () => {
    const db = setup(); await saveProbeResults(db.env, [result()]);
    await deleteMonitor(db.env, "m0");
    const delayed = result(); const active = result({ monitorId: "m1" });
    await worker.queue({ messages: [{ body: [delayed, active] }] } as unknown as MessageBatch<ProbeResult[]>, db.env, ctx);
    await worker.queue({ messages: [{ body: [delayed, active] }] } as unknown as MessageBatch<ProbeResult[]>, db.env, ctx);
    expect((await listLatest(db.env)).map((item) => item.monitorId)).toEqual(["m1"]);
    expect((await listIncidents(db.env)).map((item) => item.monitorId)).toEqual(["m1"]);
    expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM probe_results").get()?.n).toBe(3);
    expect(db.sqlite.prepare("SELECT SUM(probe_results) AS n FROM daily_usage").get()?.n).toBe(3);
    expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM incidents WHERE monitor_id='m0' AND status IN ('open','unknown')").get()?.n).toBe(0);
  });

  it("prevents stale incident policies from reopening a deleted monitor", async () => {
    const db = setup(); const originalBatch = db.env.DB.batch.bind(db.env.DB);
    let calls = 0;
    vi.spyOn(db.env.DB, "batch").mockImplementation(async (statements) => {
      // Persistence then usage then incident batch: delete after policies were read.
      if (++calls === 3) await deleteMonitor(db.env, "m0");
      return originalBatch(statements);
    });
    await saveProbeResults(db.env, [result()]);
    expect(await listMonitors(db.env)).toHaveLength(1);
    expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM incidents WHERE monitor_id='m0' AND status IN ('open','unknown')").get()?.n).toBe(0);
  });

  it("skips deleted targets on recovery and preserves the surviving job's identity", async () => {
    vi.useFakeTimers(); vi.setSystemTime("2026-09-16T12:01:00Z");
    const db = setup();
    const jobs = buildSchedulePlan(await listMonitors(db.env), await listRegions(db.env), new Date(), "cron_recover").jobs;
    const removed = jobs[0]!.monitor.id; const remaining = jobs[1]!.monitor.id;
    await claimScheduledRunAndReserve(db.env, { id: "cron_recover", startedAt: new Date().toISOString(), plannedJobs: 2 }, jobs, 10000, "2026-09-16");
    await deleteMonitor(db.env, removed);
    db.sqlite.exec("UPDATE scheduler_runs SET lease_expires_at='2020-01-01T00:00:00.000Z'");
    const sent: ProbeJob[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const batch = JSON.parse(String(init.body)).jobs as ProbeJob[]; sent.push(...batch);
      return Response.json({ results: batch.map((job) => result({ runId: job.runId, monitorId: job.monitor.id,
        monitorConfigVersion: job.monitor.configVersion, targetUrl: job.monitor.url, ok: true, status: 200 })) });
    }));
    db.env.RESULTS_QUEUE = { send: async (batch: ProbeResult[]) => { await saveProbeResults(db.env, batch); } } as unknown as Queue<ProbeResult[]>;
    await worker.scheduled({ scheduledTime: Date.now() } as ScheduledEvent, db.env, ctx);
    expect(sent.every((job) => job.monitor.id === remaining)).toBe(true);
    expect(sent.find((job) => job.runId === "cron_recover")?.jobId).toBe("cron_recover:1");
    expect(db.sqlite.prepare("SELECT id FROM probe_results WHERE monitor_id=? AND run_id='cron_recover'").get(removed)).toBeUndefined();
    expect(await getRunStatus(db.env, "cron_recover"))
      .toMatchObject({ plannedJobs: 2, storedResults: 1, cancelledResults: 1, pendingResults: 0 });
    // A real result from the earlier attempt can arrive after cancellation.
    await saveProbeResults(db.env, [result({ id: "res_cron_recover:0", runId: "cron_recover", monitorId: removed, ok: true, status: 200 })]);
    expect(await getRunStatus(db.env, "cron_recover"))
      .toMatchObject({ storedResults: 2, successfulResults: 2, unknownResults: 0, cancelledResults: 0, pendingResults: 0 });
    expect((await listLatest(db.env)).map((item) => item.monitorId)).toEqual([remaining]);
  });

  it("does not reserve or start a new job deleted while recovery was in progress", async () => {
    vi.useFakeTimers(); vi.setSystemTime("2026-09-16T12:01:00Z");
    const db = setup();
    const monitors = await listMonitors(db.env);
    const jobs = buildSchedulePlan(monitors.filter((item) => item.id === "m1"), await listRegions(db.env), new Date(), "cron_recover").jobs;
    await claimScheduledRunAndReserve(db.env, { id: "cron_recover", startedAt: new Date().toISOString(), plannedJobs: 1 }, jobs, 10000, "2026-09-16");
    db.sqlite.exec("UPDATE scheduler_runs SET lease_expires_at='2020-01-01T00:00:00.000Z'");
    const sent: ProbeJob[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const batch = JSON.parse(String(init.body)).jobs as ProbeJob[]; sent.push(...batch);
      if (batch.some((job) => job.runId === "cron_recover")) await deleteMonitor(db.env, "m0");
      return Response.json({ results: batch.map((job) => result({ runId: job.runId, monitorId: job.monitor.id,
        monitorConfigVersion: job.monitor.configVersion, targetUrl: job.monitor.url, ok: true, status: 200 })) });
    }));
    db.env.RESULTS_QUEUE = { send: async (batch: ProbeResult[]) => { await saveProbeResults(db.env, batch); } } as unknown as Queue<ProbeResult[]>;
    await worker.scheduled({ scheduledTime: Date.now() } as ScheduledEvent, db.env, ctx);
    expect(sent).toHaveLength(2);
    expect(sent.every((job) => job.monitor.id === "m1")).toBe(true);
    expect(db.sqlite.prepare("SELECT reserved_probes FROM daily_usage").get()?.reserved_probes).toBe(2);
  });

  it("finishes an entirely cancelled recovery without probes, synthetic results or new budget", async () => {
    vi.useFakeTimers(); vi.setSystemTime("2026-09-16T12:01:00Z");
    const db = setup();
    const jobs = buildSchedulePlan(await listMonitors(db.env), await listRegions(db.env), new Date(), "cron_recover").jobs;
    await claimScheduledRunAndReserve(db.env, { id: "cron_recover", startedAt: new Date().toISOString(), plannedJobs: 2 }, jobs, 10000, "2026-09-16");
    await deleteMonitor(db.env, "m0"); await deleteMonitor(db.env, "m1");
    db.sqlite.exec("UPDATE scheduler_runs SET lease_expires_at='2020-01-01T00:00:00.000Z'");
    vi.stubGlobal("fetch", vi.fn());
    await worker.scheduled({ scheduledTime: Date.now() } as ScheduledEvent, db.env, ctx);
    expect(fetch).not.toHaveBeenCalled();
    expect(await getRunStatus(db.env, "cron_recover"))
      .toMatchObject({ plannedJobs: 2, storedResults: 0, cancelledResults: 2, pendingResults: 0 });
    expect(db.sqlite.prepare("SELECT probe_results,reserved_probes FROM daily_usage").get())
      .toMatchObject({ probe_results: 0, reserved_probes: 2 });
  });

  it("excludes cancelled jobs from the no-Queue persistence limit", async () => {
    vi.useFakeTimers(); vi.setSystemTime("2026-09-16T12:01:00Z");
    const db = setup(6);
    const jobs = buildSchedulePlan(await listMonitors(db.env), await listRegions(db.env), new Date(), "cron_recover").jobs;
    await claimScheduledRunAndReserve(db.env, { id: "cron_recover", startedAt: new Date().toISOString(), plannedJobs: 6 }, jobs, 10000, "2026-09-16");
    for (let i = 0; i < 5; i++) await deleteMonitor(db.env, `m${i}`);
    db.sqlite.exec("UPDATE scheduler_runs SET lease_expires_at='2020-01-01T00:00:00.000Z'");
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const batch = JSON.parse(String(init.body)).jobs as ProbeJob[];
      return Response.json({ results: batch.map((job) => result({ runId: job.runId, monitorId: job.monitor.id,
        monitorConfigVersion: job.monitor.configVersion, targetUrl: job.monitor.url, ok: true, status: 200 })) });
    }));
    db.resetCount();
    await worker.scheduled({ scheduledTime: Date.now() } as ScheduledEvent, db.env, ctx);
    expect(db.count()).toBe(40);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(await getRunStatus(db.env, "cron_recover"))
      .toMatchObject({ plannedJobs: 6, storedResults: 1, cancelledResults: 5, pendingResults: 0 });
  });
});
