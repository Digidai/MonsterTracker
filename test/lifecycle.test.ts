import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { ProbeJob, ProbeResult } from "../src/domain";
import { buildSchedulePlan } from "../src/scheduler";
import { claimScheduledRunAndReserve, getRunStatus, listMonitors, listRegions, retryScheduledRun, saveProbeResults,
  updateMonitor, updateRegion } from "../src/storage";
import { databaseHarness } from "./d1-harness";

const databases: ReturnType<typeof databaseHarness>[] = [];
const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;
const runId = "cron_lifecycle";
const time = "2026-09-16T12:01:00.000Z";

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(time); });
afterEach(() => {
  for (const db of databases.splice(0)) db.sqlite.close();
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

function setup(count = 2) {
  const db = databaseHarness(); databases.push(db);
  db.sqlite.exec("PRAGMA foreign_keys = ON");
  for (const id of ["r", "r2"]) db.sqlite.prepare(`INSERT INTO regions
    (id,label,area,provider,provider_region,placement_region,worker_name,created_at,updated_at)
    VALUES (?, 'Region', 'Area', 'aws', 'us-east-1', 'aws:us-east-1', 'probe', ?, ?)`).run(id, time, time);
  for (let i = 0; i < count; i++) db.sqlite.prepare(`INSERT INTO monitors
    (id,name,url,daily_budget,created_at,updated_at) VALUES (?, 'Monitor', 'https://example.com/',1440,?,?)`).run(`m${i}`, time, time);
  Object.assign(db.env, { ALLOW_LOCAL_PROBES: "true" });
  return db;
}

async function lease(db: ReturnType<typeof setup>) {
  const monitors = (await listMonitors(db.env)).sort((a, b) => a.id.localeCompare(b.id));
  const jobs = buildSchedulePlan(monitors, await listRegions(db.env), new Date(), runId).jobs;
  const regions = await listRegions(db.env);
  for (const [index, job] of jobs.entries()) {
    const region = regions.find((item) => item.id === (index === 0 ? "r" : "r2"))!;
    job.region = { id: region.id, label: region.label, placementRegion: region.placementRegion, workerUrl: region.workerUrl };
  }
  await claimScheduledRunAndReserve(db.env, { id: runId, startedAt: time, plannedJobs: jobs.length }, jobs, 10000, "2026-09-16");
  db.sqlite.exec("UPDATE scheduler_runs SET lease_expires_at='2020-01-01T00:00:00.000Z'");
  return jobs;
}

function result(job: ProbeJob): ProbeResult {
  return { id: crypto.randomUUID(), runId: job.runId, monitorId: job.monitor.id,
    monitorConfigVersion: job.monitor.configVersion, regionId: job.region.id, targetUrl: job.monitor.url,
    checkedAt: time, ok: true, status: 200, latencyMs: 10, error: null, method: "HEAD", resultType: "target",
    entryColo: "IAD", entryCountry: "US", entryCity: null, entryAsn: null, entryAsOrganization: null,
    placement: null, responseBytes: 0 };
}

function captureDispatch() {
  const sent: ProbeJob[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    const jobs = JSON.parse(String(init.body)).jobs as ProbeJob[]; sent.push(...jobs);
    return Response.json({ results: jobs.map(result) });
  }));
  return sent;
}

describe("recovered monitor lifecycle", () => {
  it.each([2, 3])("preserves cancellations when Queue persistence fails on recovery attempt %i", async (attempt) => {
    const db = setup(); const jobs = await lease(db);
    await updateMonitor(db.env, "m0", { enabled: false });
    db.sqlite.prepare("UPDATE scheduler_runs SET attempt_count=? WHERE id=?").run(attempt - 1, runId);
    const sent = captureDispatch();
    db.env.RESULTS_QUEUE = { send: vi.fn().mockRejectedValue(new Error("queue_unavailable")) } as unknown as Queue<ProbeResult[]>;
    vi.spyOn(console, "error").mockImplementation(() => {});
    db.resetCount();
    await worker.scheduled({ scheduledTime: Date.now() } as ScheduledEvent, db.env, ctx);
    // Recovery and current work each fail their send; each failure still needs
    // only the existing one-statement retry update, including cancellation data.
    expect(db.count()).toBe(14);
    expect(sent.filter((job) => job.runId === runId).map((job) => job.jobId)).toEqual([`${runId}:1`]);
    expect(await getRunStatus(db.env, runId)).toMatchObject({ plannedJobs: 2, storedResults: 0,
      finishedAt: attempt === 3 ? time : null, error: "queue_unavailable", cancelledResults: 1, pendingResults: 1,
      cancellations: [{ resultId: `res_${runId}:0`, reason: "monitor_disabled" }] });
    expect(db.sqlite.prepare("SELECT attempt_count,lease_expires_at FROM scheduler_runs WHERE id=?").get(runId))
      .toMatchObject({ attempt_count: attempt, lease_expires_at: attempt === 3 ? null : "2026-09-16T12:02:00.000Z" });
    const recorded = db.sqlite.prepare("SELECT cancelled_result_ids_json FROM scheduler_runs WHERE id=?").get(runId);
    db.resetCount();
    await retryScheduledRun(db.env, runId, "another_failure");
    expect(db.count()).toBe(1);
    expect(db.sqlite.prepare("SELECT cancelled_result_ids_json FROM scheduler_runs WHERE id=?").get(runId)).toEqual(recorded);
    // A delivery from an earlier attempt still replaces a recorded cancellation.
    await saveProbeResults(db.env, [{ ...result(jobs[0]!), id: `res_${runId}:0` }]);
    expect(await getRunStatus(db.env, runId)).toMatchObject({ storedResults: 1, cancelledResults: 0, pendingResults: 1, cancellations: [] });
  });

  it.each([
    ["pause", "monitor_disabled"],
    ["URL edit", "monitor_config_changed"],
    ["region disable", "region_disabled"]
  ])("cancels obsolete jobs after %s without renumbering survivors", async (change, reason) => {
    const db = setup(); const jobs = await lease(db);
    if (change === "pause") await updateMonitor(db.env, "m0", { enabled: false });
    if (change === "URL edit") await updateMonitor(db.env, "m0", { url: "https://new.example.com/" });
    if (change === "region disable") await updateRegion(db.env, "r", { enabled: false });
    const sent = captureDispatch();
    db.env.RESULTS_QUEUE = { send: async (batch: ProbeResult[]) => { await saveProbeResults(db.env, batch); } } as unknown as Queue<ProbeResult[]>;
    await worker.scheduled({ scheduledTime: Date.now() } as ScheduledEvent, db.env, ctx);
    expect(sent.filter((job) => job.runId === runId).map((job) => job.jobId)).toEqual([`${runId}:1`]);
    expect(await getRunStatus(db.env, runId)).toMatchObject({ plannedJobs: 2, storedResults: 1,
      cancelledResults: 1, pendingResults: 0, cancellations: [{ resultId: `res_${runId}:0`, reason }] });
    expect(db.sqlite.prepare("SELECT COUNT(*) n FROM probe_results WHERE id=?").get(`res_${runId}:0`)?.n).toBe(0);
    if (change === "URL edit") expect(sent.filter((job) => job.monitor.id === "m0")
      .every((job) => job.monitor.url === "https://new.example.com/" && job.monitor.configVersion === 2)).toBe(true);
    // Previously in-flight evidence still supersedes the recorded cancellation.
    await saveProbeResults(db.env, [{ ...result(jobs[0]!), id: `res_${runId}:0` }]);
    expect(await getRunStatus(db.env, runId)).toMatchObject({ storedResults: 2, cancelledResults: 0, pendingResults: 0, cancellations: [] });
  });

  it("keeps custom job identities and cancels pause/resume jobs from the old configuration", async () => {
    const db = setup(1); const jobs = await lease(db);
    jobs[0]!.jobId = "stable-custom-job";
    db.sqlite.prepare("UPDATE scheduler_runs SET jobs_json=? WHERE id=?").run(JSON.stringify(jobs), runId);
    await updateMonitor(db.env, "m0", { enabled: false });
    await updateMonitor(db.env, "m0", { enabled: true });
    const sent = captureDispatch();
    await worker.scheduled({ scheduledTime: Date.now() } as ScheduledEvent, db.env, ctx);
    expect(sent.some((job) => job.runId === runId)).toBe(false);
    expect(await getRunStatus(db.env, runId)).toMatchObject({ cancellations: [
      { resultId: "res_stable-custom-job", reason: "monitor_config_changed" }
    ], pendingResults: 0 });
  });

  it("excludes paused jobs from direct-persistence preflight and does not reserve them again", async () => {
    const db = setup(6); await lease(db);
    for (let i = 0; i < 5; i++) await updateMonitor(db.env, `m${i}`, { enabled: false });
    const sent = captureDispatch(); db.resetCount();
    await worker.scheduled({ scheduledTime: Date.now() } as ScheduledEvent, db.env, ctx);
    expect(db.count()).toBeLessThanOrEqual(50);
    expect(sent).toHaveLength(2);
    expect(sent.every((job) => job.monitor.id === "m5")).toBe(true);
    expect(db.sqlite.prepare("SELECT reserved_probes FROM daily_usage").get()?.reserved_probes).toBe(7);
    expect(await getRunStatus(db.env, runId)).toMatchObject({ cancelledResults: 5, storedResults: 1, pendingResults: 0 });
  });

  it("uses the current enabled region route when recovering a job", async () => {
    const db = setup(1); await lease(db);
    await updateRegion(db.env, "r", { workerUrl: "http://localhost:8790" });
    captureDispatch();
    await worker.scheduled({ scheduledTime: Date.now() } as ScheduledEvent, db.env, ctx);
    expect(fetch).toHaveBeenCalledWith("http://localhost:8790/internal/probe", expect.anything());
    expect(await getRunStatus(db.env, runId)).toMatchObject({ storedResults: 1, cancelledResults: 0 });
  });

  it.each(["disabled", "rerouted"])("rebuilds the new plan after regions are %s during recovery", async (change) => {
    const db = setup(1); await lease(db);
    const sent: ProbeJob[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const jobs = JSON.parse(String(init.body)).jobs as ProbeJob[]; sent.push(...jobs);
      if (jobs.some((job) => job.runId === runId)) {
        for (const id of ["r", "r2"]) await updateRegion(db.env, id, change === "disabled"
          ? { enabled: false } : { workerUrl: "http://localhost:8791" });
      }
      return Response.json({ results: jobs.map(result) });
    }));
    await worker.scheduled({ scheduledTime: Date.now() } as ScheduledEvent, db.env, ctx);
    const currentJobs = sent.filter((job) => job.runId !== runId);
    if (change === "disabled") {
      expect(currentJobs).toEqual([]);
      expect(db.sqlite.prepare("SELECT reserved_probes FROM daily_usage").get()?.reserved_probes).toBe(1);
      expect(db.sqlite.prepare("SELECT COUNT(*) n FROM scheduler_runs").get()?.n).toBe(1);
    } else {
      expect(currentJobs).toHaveLength(1);
      expect(currentJobs[0]?.region.workerUrl).toBe("http://localhost:8791/");
      expect(fetch).toHaveBeenLastCalledWith("http://localhost:8791/internal/probe", expect.anything());
    }
  });
});
