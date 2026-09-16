import { afterEach, describe, expect, it, vi } from "vitest";
import { getDiagnostics, recordSchedulerHeartbeat } from "../src/diagnostics";
import type { DiagnosticsEnv, RunDiagnostics } from "../src/diagnostics";
import { getRunStatus, type SchedulerCancellation } from "../src/storage";
import { databaseHarness } from "./d1-harness";

const now = "2026-09-16T12:00:00.000Z";
const databases: ReturnType<typeof databaseHarness>[] = [];
const unknownMetrics = { backlogCount: null, backlogBytes: null, oldestMessageAt: null };

afterEach(() => {
  for (const db of databases.splice(0)) db.sqlite.close();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function setup(queryLimit?: number) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(now));
  const db = databaseHarness(queryLimit);
  databases.push(db);
  return db;
}

function queue(metrics: () => Promise<unknown>): Queue {
  return { metrics: vi.fn(metrics), send: vi.fn(), sendBatch: vi.fn() } as unknown as Queue;
}

function addRun(db: ReturnType<typeof setup>, patch: Partial<RunDiagnostics> = {}, cancelledIds: (string | SchedulerCancellation)[] = []) {
  const run = { id: "run", startedAt: now, finishedAt: now, plannedJobs: 2, error: null,
    attemptCount: 1, leaseExpiresAt: null, ...patch };
  db.sqlite.prepare(`INSERT INTO scheduler_runs
    (id, started_at, finished_at, planned_jobs, dispatched_jobs, error, attempt_count, lease_expires_at, cancelled_result_ids_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(run.id, run.startedAt, run.finishedAt, run.plannedJobs,
    run.plannedJobs, run.error, run.attemptCount, run.leaseExpiresAt, JSON.stringify(cancelledIds));
  return run.id;
}

function addResult(db: ReturnType<typeof setup>, id: string, runId = "run", ok = 1, type = "target") {
  db.sqlite.exec(`INSERT OR IGNORE INTO monitors (id,name,url,created_at,updated_at)
    VALUES ('m','Monitor','https://example.com/','${now}','${now}');
    INSERT OR IGNORE INTO regions (id,label,area,provider,provider_region,placement_region,worker_name,created_at,updated_at)
    VALUES ('r','Region','Area','aws','us-east-1','aws:us-east-1','probe','${now}','${now}')`);
  db.sqlite.prepare(`INSERT INTO probe_results
    (id,run_id,monitor_id,region_id,target_url,checked_at,ok,method,result_type)
    VALUES (?,?,'m','r','https://example.com/',?,?,'HEAD',?)`).run(id, runId, now, ok, type);
}

async function runReport(db: ReturnType<typeof setup>, id = "run") {
  db.resetCount();
  const report = await getDiagnostics(db.env);
  expect(db.count()).toBe(2);
  const run = report.runs.find((item) => item.id === id)!;
  const status = await getRunStatus(db.env, id);
  expect(run).toMatchObject({ storedResults: status?.storedResults, cancelledResults: status?.cancelledResults });
  expect(run.pendingResults).toBe(Math.max(0, run.plannedJobs - run.storedResults - run.cancelledResults));
  return run;
}

describe("scheduler tick diagnostics", () => {
  it("stays unobserved without a tick even when runs exist, using only two reads", async () => {
    const db = setup(2);
    addRun(db, { plannedJobs: 0 });
    const before = db.sqlite.prepare("SELECT total_changes() AS n").get()?.n;
    const report = await getDiagnostics(db.env);
    expect(report.generatedAt).toBe(now);
    expect(report.scheduler).toEqual({ lastTickAt: null, status: "unobserved" });
    expect(db.count()).toBe(2);
    expect(db.sqlite.prepare("SELECT total_changes() AS n").get()?.n).toBe(before);
  });

  it("writes once on fifth UTC minutes, skips other minutes, and never samples metrics", async () => {
    const db = setup();
    db.env.RESULTS_QUEUE = queue(async () => ({ backlogCount: 0, backlogBytes: 0 }));
    for (let minute = 0; minute < 60; minute++) {
      db.resetCount();
      await recordSchedulerHeartbeat(db.env, new Date(Date.parse(now) + minute * 60_000));
      expect(db.count()).toBe(minute % 5 === 0 ? 1 : 0);
    }
    expect(db.env.RESULTS_QUEUE.metrics).not.toHaveBeenCalled();
    db.resetCount();
    await recordSchedulerHeartbeat(db.env, new Date(NaN));
    expect(db.count()).toBe(0);
  });

  it("keeps the latest scheduled time across delayed, duplicate and out-of-order ticks", async () => {
    const db = setup(3);
    for (const tick of [now, "2026-09-16T11:55:00.000Z", now]) {
      await recordSchedulerHeartbeat(db.env, new Date(tick));
    }
    expect(db.count()).toBe(3);
    expect(db.sqlite.prepare("SELECT * FROM operational_signals").all())
      .toEqual([{ name: "scheduler", last_tick_at: now }]);
    expect(db.sqlite.prepare("SELECT total_changes() AS n").get()?.n).toBe(1);
  });

  it("marks a tick stale only after fifteen minutes, without claiming successful work", async () => {
    const db = setup();
    await recordSchedulerHeartbeat(db.env, new Date(now));
    expect((await getDiagnostics(db.env)).scheduler.status).toBe("recent");
    vi.setSystemTime(Date.parse(now) + 15 * 60_000);
    expect((await getDiagnostics(db.env)).scheduler.status).toBe("recent");
    vi.setSystemTime(Date.now() + 1);
    expect((await getDiagnostics(db.env)).scheduler).toEqual({ lastTickAt: now, status: "stale" });
    expect((await getDiagnostics(db.env)).runs).toEqual([]);
  });
});

describe("bounded run evidence", () => {
  it("waits for actual rows after dispatch finishes and completes on delayed delivery", async () => {
    const db = setup();
    addRun(db);
    expect(await runReport(db)).toMatchObject({ state: "waiting-results", storedResults: 0, pendingResults: 2 });
    addResult(db, "one", "run", 0); // A target failure is still delivered evidence.
    expect(await runReport(db)).toMatchObject({ state: "waiting-results", storedResults: 1, pendingResults: 1 });
    addResult(db, "two", "run", 0, "infrastructure");
    expect(await runReport(db)).toMatchObject({ state: "complete", storedResults: 2, pendingResults: 0 });
  });

  it("discounts cancellations when late evidence arrives, including partial delivery", async () => {
    const db = setup();
    addRun(db, {}, ["one"]);
    expect(await runReport(db)).toMatchObject({ state: "waiting-results", cancelledResults: 1, pendingResults: 1 });
    addResult(db, "two");
    expect(await runReport(db)).toMatchObject({ state: "cancelled", storedResults: 1, cancelledResults: 1, pendingResults: 0 });
    addResult(db, "one");
    expect(await runReport(db)).toMatchObject({ state: "complete", storedResults: 2, cancelledResults: 0, pendingResults: 0 });
  });

  it("reports cancellation-only runs as cancelled, not complete or indefinitely pending", async () => {
    const db = setup();
    addRun(db, {}, ["one", "two"]);
    expect(await runReport(db)).toMatchObject({ state: "cancelled", storedResults: 0, cancelledResults: 2, pendingResults: 0 });
    addResult(db, "one");
    expect(await runReport(db)).toMatchObject({ state: "cancelled", storedResults: 1, cancelledResults: 1, pendingResults: 0 });
  });

  it("supports structured cancellation reasons alongside legacy IDs without double-counting", async () => {
    const db = setup();
    addRun(db, {}, [{ resultId: "one", reason: "monitor_deleted" }, "two", "two"]);
    expect(await runReport(db)).toMatchObject({ state: "cancelled", cancelledResults: 2, pendingResults: 0 });
    addResult(db, "one");
    expect(await runReport(db)).toMatchObject({ state: "cancelled", storedResults: 1, cancelledResults: 1, pendingResults: 0 });
    addResult(db, "two");
    expect(await runReport(db)).toMatchObject({ state: "complete", storedResults: 2, cancelledResults: 0, pendingResults: 0 });
  });

  it("distinguishes running, retrying and terminal failure while exposing lease and attempt metadata", async () => {
    const db = setup();
    const leaseExpiresAt = "2026-09-16T12:16:00.000Z";
    addRun(db, { finishedAt: null, leaseExpiresAt });
    expect(await runReport(db)).toMatchObject({ state: "running", attemptCount: 1, leaseExpiresAt, pendingResults: 2 });
    db.sqlite.exec("UPDATE scheduler_runs SET error='queue_unavailable'");
    expect(await runReport(db)).toMatchObject({ state: "retrying", attemptCount: 1, pendingResults: 2 });
    db.sqlite.exec("UPDATE scheduler_runs SET error=NULL, attempt_count=2");
    expect(await runReport(db)).toMatchObject({ state: "retrying", attemptCount: 2, pendingResults: 2 });
    db.sqlite.prepare(`UPDATE scheduler_runs SET finished_at=?, error='scheduler_retry_limit_exhausted',
      lease_expires_at=NULL, attempt_count=3`).run(now);
    expect(await runReport(db)).toMatchObject({ state: "failed", storedResults: 0, pendingResults: 2,
      error: "scheduler_retry_limit_exhausted", attemptCount: 3, leaseExpiresAt: null });
    addResult(db, "one");
    expect(await runReport(db)).toMatchObject({ state: "failed", plannedJobs: 2, storedResults: 1, pendingResults: 1, attemptCount: 3 });
    addResult(db, "two");
    expect(await runReport(db)).toMatchObject({ state: "failed", plannedJobs: 2, storedResults: 2, pendingResults: 0, attemptCount: 3 });
  });

  it("does not infer attempts from reservations, dispatch counts or historical defaults", async () => {
    const db = setup();
    addRun(db, { id: "manual_legacy", plannedJobs: 7, attemptCount: 0 });
    expect(await runReport(db, "manual_legacy")).toMatchObject({ plannedJobs: 7, attemptCount: 0,
      storedResults: 0, pendingResults: 7, state: "waiting-results" });
  });

  it("counts cancellation IDs with the same received-evidence lookup as storage", async () => {
    const db = setup();
    addRun(db, {}, ["received", "missing"]);
    addResult(db, "received", "other_run");
    expect(await runReport(db)).toMatchObject({ cancelledResults: 1, storedResults: 0, pendingResults: 1 });
  });

  it("returns only the last twenty runs with deterministic ordering in a bounded query", async () => {
    const db = setup(2);
    for (let index = 0; index < 25; index++) {
      addRun(db, { id: `run_${String(index).padStart(2, "0")}`, plannedJobs: 0 });
    }
    // A malformed old row verifies cancellation expansion happens after the LIMIT.
    db.sqlite.exec("UPDATE scheduler_runs SET cancelled_result_ids_json='invalid' WHERE id='run_00'");
    const report = await getDiagnostics(db.env);
    expect(report.runs.map((run) => run.id)).toEqual(Array.from({ length: 20 }, (_, i) => `run_${String(24 - i).padStart(2, "0")}`));
    expect(report.runs.every((run) => run.state === "complete")).toBe(true);
    expect(db.count()).toBe(2);
  });
});

describe("on-demand queue metrics", () => {
  it("keeps absent bindings unknown and exposes configuration presence without secrets", async () => {
    const db = setup();
    let report = await getDiagnostics(db.env);
    expect(report.queues).toEqual({ results: { state: "not_configured", ...unknownMetrics },
      deadLetter: { state: "not_configured", ...unknownMetrics } });
    expect(report.configuration).toEqual({ queueConfigured: false, archiveConfigured: false,
      analyticsConfigured: false, probeSecretConfigured: false });
    Object.assign(db.env, { RESULTS_QUEUE: queue(async () => ({ backlogCount: 0, backlogBytes: 0 })),
      ARCHIVE: { secret: "archive-sentinel" }, ANALYTICS: { secret: "analytics-sentinel" },
      SHARED_SECRET: "probe-sentinel", ADMIN_TOKEN: "admin-sentinel" });
    report = await getDiagnostics(db.env);
    expect(report.configuration).toEqual({ queueConfigured: true, archiveConfigured: true,
      analyticsConfigured: true, probeSecretConfigured: true });
    expect(JSON.stringify(report)).not.toContain("sentinel");
    expect(report.queues.results).toEqual({ state: "available", backlogCount: 0, backlogBytes: 0, oldestMessageAt: null });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([new Date(now), Date.parse(now)])("normalizes Date and epoch-millisecond timestamps: %s", async (timestamp) => {
    const db = setup();
    const binding = queue(async () => ({ backlogCount: 7, backlogBytes: 4096, oldestMessageTimestamp: timestamp }));
    const env: DiagnosticsEnv = { ...db.env, RESULTS_QUEUE: binding, RESULTS_DLQ: binding };
    const report = await getDiagnostics(env);
    const expected = { state: "available", backlogCount: 7, backlogBytes: 4096, oldestMessageAt: now };
    expect(report.queues).toEqual({ results: expected, deadLetter: expected });
    expect(binding.metrics).toHaveBeenCalledTimes(2);
    expect(binding.send).not.toHaveBeenCalled();
    expect(binding.sendBatch).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([undefined, null, new Date(NaN), NaN, Infinity, 9e20, "invalid"])("preserves missing or invalid metrics as null: %s", async (timestamp) => {
    const db = setup();
    db.env.RESULTS_QUEUE = queue(async () => ({ backlogCount: NaN, backlogBytes: -1, oldestMessageTimestamp: timestamp }));
    expect((await getDiagnostics(db.env)).queues.results).toEqual({ state: "available", ...unknownMetrics });
  });

  it("does not convert omitted metrics fields into zero", async () => {
    const db = setup();
    db.env.RESULTS_QUEUE = queue(async () => ({}));
    expect((await getDiagnostics(db.env)).queues.results).toEqual({ state: "available", ...unknownMetrics });
  });

  it.each(["reject", "throw", "missing"])("isolates %s metrics failures from the other queue and cleans up timers", async (mode) => {
    const db = setup();
    const binding = mode === "missing" ? {} as Queue : queue(() => {
      if (mode === "throw") throw new Error("private-binding-details");
      return Promise.reject(new Error("private-binding-details"));
    });
    const env: DiagnosticsEnv = { ...db.env, RESULTS_QUEUE: binding,
      RESULTS_DLQ: queue(async () => ({ backlogCount: 2, backlogBytes: 512 })) };
    const report = await getDiagnostics(env);
    expect(report.queues.results).toEqual({ state: "unavailable", ...unknownMetrics });
    expect(report.queues.deadLetter).toEqual({ state: "available", backlogCount: 2, backlogBytes: 512, oldestMessageAt: null });
    expect(report.configuration.queueConfigured).toBe(true);
    expect(JSON.stringify(report)).not.toContain("private-binding-details");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("times out both queues in parallel after three seconds and handles a late rejection", async () => {
    const db = setup();
    let rejectLate!: (error: Error) => void;
    const env: DiagnosticsEnv = { ...db.env,
      RESULTS_QUEUE: queue(() => new Promise((_, reject) => { rejectLate = reject; })),
      RESULTS_DLQ: queue(() => new Promise(() => {})) };
    let settled = false;
    const pending = getDiagnostics(env).then((report) => { settled = true; return report; });
    await vi.advanceTimersByTimeAsync(2_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const report = await pending;
    expect(report.queues).toEqual({ results: { state: "unavailable", ...unknownMetrics },
      deadLetter: { state: "unavailable", ...unknownMetrics } });
    expect(vi.getTimerCount()).toBe(0);
    rejectLate(new Error("late metrics rejection"));
    await vi.advanceTimersByTimeAsync(0);
    expect(db.count()).toBe(2);
  });
});
