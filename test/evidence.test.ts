import { afterEach, describe, expect, it } from "vitest";
import { databaseHarness } from "./d1-harness";
import { saveProbeResults, expireStaleIncidents, claimScheduledRunAndReserve, retryScheduledRun, claimRecoverableSchedulerRun } from "../src/storage";
import { isRegionResultStale, monitorStatus } from "../src/health";
import type { ProbeResult } from "../src/domain";

const openDatabases: ReturnType<typeof databaseHarness>[] = [];
afterEach(() => { for (const db of openDatabases.splice(0)) db.sqlite.close(); });

function setup(count = 1) {
  const db = databaseHarness(); openDatabases.push(db);
  db.sqlite.exec(`INSERT INTO regions (id,label,area,provider,provider_region,placement_region,worker_name,created_at,updated_at)
    VALUES ('r','Region','Area','aws','us-east-1','aws:us-east-1','probe','2026-01-01','2026-01-01')`);
  for (let i = 0; i < count; i++) db.sqlite.prepare(`INSERT INTO monitors (id,name,url,daily_budget,created_at,updated_at)
    VALUES (?, 'Monitor', 'https://example.com/', 1000, '2026-01-01', '2026-01-01')`).run(`m${i}`);
  return db;
}

function result(patch: Partial<ProbeResult> = {}): ProbeResult {
  return { id: crypto.randomUUID(), runId: "manual_test", monitorId: "m0", monitorConfigVersion: 1,
    regionId: "r", targetUrl: "https://example.com/", checkedAt: new Date().toISOString(), ok: true,
    resultType: "target", status: 200, latencyMs: 20, error: null, method: "HEAD", entryColo: "IAD",
    entryCountry: "US", entryCity: null, entryAsn: null, entryAsOrganization: null, placement: null, responseBytes: 0, ...patch };
}

describe("evidence persistence with real SQL", () => {
  it("persists ten distinct monitors below 50 D1 queries, with idempotent counters", async () => {
    const db = setup(10);
    const batch = Array.from({length: 10}, (_, i) => result({monitorId: `m${i}`}));
    await saveProbeResults(db.env, batch);
    expect(db.count()).toBe(39); // consumer adds one usage statement: 40 < 50
    expect(db.sqlite.prepare("SELECT count(*) AS n FROM monitor_latest").get()?.n).toBe(10);
    await saveProbeResults(db.env, batch);
    expect(db.sqlite.prepare("SELECT SUM(probe_results) AS n FROM daily_usage").get()?.n).toBe(10);
  });

  it("never creates an outage for an unreachable probe", async () => {
    const db = setup();
    await saveProbeResults(db.env, [result({ok:false,status:null,latencyMs:null,resultType:"infrastructure",error:"probe_worker_503"})]);
    expect(db.sqlite.prepare("SELECT count(*) AS n FROM incidents").get()?.n).toBe(0);
    expect(db.sqlite.prepare("SELECT result_type FROM monitor_latest").get()?.result_type).toBe("infrastructure");
  });

  it("keeps an outage unconfirmed after infrastructure failure and resolves only on success", async () => {
    const db = setup(); const now = Date.now();
    await saveProbeResults(db.env, [result({ok:false,status:503,checkedAt:new Date(now-2000).toISOString()})]);
    expect(db.sqlite.prepare("SELECT status FROM incidents").get()?.status).toBe("open");
    await saveProbeResults(db.env, [result({ok:false,status:null,latencyMs:null,resultType:"infrastructure",checkedAt:new Date(now-1000).toISOString()})]);
    expect(db.sqlite.prepare("SELECT status,closed_at FROM incidents").get()).toMatchObject({status:"unknown",closed_at:null});
    await saveProbeResults(db.env, [result({checkedAt:new Date(now).toISOString()})]);
    expect(db.sqlite.prepare("SELECT status FROM incidents").get()?.status).toBe("resolved");
  });

  it("expires stale evidence to unknown, not recovered", async () => {
    const db = setup();
    await saveProbeResults(db.env, [result({ok:false,status:500})]);
    db.sqlite.exec("UPDATE monitor_latest SET checked_at='2020-01-01T00:00:00.000Z'; UPDATE incidents SET expires_at='2020-01-01T00:00:00.000Z'");
    await expireStaleIncidents(db.env);
    expect(db.sqlite.prepare("SELECT status,closed_at FROM incidents").get()).toMatchObject({status:"unknown",closed_at:null});
  });

  it("does not let delayed results or an older configuration replace current evidence", async () => {
    const db = setup(); const latest = result();
    await saveProbeResults(db.env, [latest]);
    await saveProbeResults(db.env, [result({ok:false,status:500,checkedAt:'2020-01-01T00:00:00.000Z'})]);
    await saveProbeResults(db.env, [result({ok:false,status:500,monitorConfigVersion:0})]);
    expect(db.sqlite.prepare("SELECT result_id FROM monitor_latest").get()?.result_id).toBe(latest.id);
    expect(db.sqlite.prepare("SELECT count(*) AS n FROM incidents").get()?.n).toBe(0);
  });

  it("attributes results across UTC midnight to their own day", async () => {
    const db = setup();
    await saveProbeResults(db.env, [result({checkedAt:'2026-09-15T23:59:59.000Z'}),result({checkedAt:'2026-09-16T00:00:01.000Z'})]);
    expect(db.sqlite.prepare("SELECT date,probe_results FROM daily_usage ORDER BY date").all()).toEqual([
      {date:'2026-09-15',probe_results:1},{date:'2026-09-16',probe_results:1}
    ]);
  });

  it("keeps the first stored observation when a recovered job has the same result id", async () => {
    const db = setup(); const original = result({ checkedAt:new Date(Date.now()-1000).toISOString() });
    await saveProbeResults(db.env, [original]);
    await saveProbeResults(db.env, [{...original,checkedAt:new Date().toISOString(),ok:false,status:500}]);
    expect(db.sqlite.prepare("SELECT ok,checked_at FROM monitor_latest").get()).toMatchObject({ok:1,checked_at:original.checkedAt});
    expect(db.sqlite.prepare("SELECT SUM(probe_results) AS n FROM daily_usage").get()?.n).toBe(1);
  });

  it("claims a minute once and recovers a retry without reserving twice", async () => {
    const db = setup();
    const input={id:'cron_test',startedAt:new Date().toISOString(),plannedJobs:10};
    expect(await claimScheduledRunAndReserve(db.env,input,[],10000,'2026-09-16')).toEqual({claimed:true,reserved:true});
    expect(await claimScheduledRunAndReserve(db.env,input,[],10000,'2026-09-16')).toEqual({claimed:false,reserved:false});
    await retryScheduledRun(db.env,input.id,'queue_unavailable');
    db.sqlite.exec("UPDATE scheduler_runs SET lease_expires_at = '2020-01-01T00:00:00.000Z'");
    expect((await claimRecoverableSchedulerRun(db.env))?.id).toBe(input.id);
    expect(db.sqlite.prepare("SELECT reserved_probes FROM daily_usage").get()?.reserved_probes).toBe(10);
  });
});

describe("shared health semantics", () => {
  const regions = [{id:"r",enabled:true,weight:1},{id:"r2",enabled:true,weight:3}];
  const monitor = {enabled:true,dailyBudget:100};
  const latest = () => ({...result(),resultId:"latest"});
  it("separates incomplete coverage, unknown probes and degraded targets", () => {
    expect(monitorStatus([latest()],monitor,regions)).toBe("incomplete");
    expect(monitorStatus([{...latest(),resultType:"infrastructure",ok:false}],monitor,regions)).toBe("unknown");
    expect(monitorStatus([{...latest(),ok:false}],monitor,regions)).toBe("partial");
    expect(monitorStatus([latest()],monitor,[])).toBe("unknown");
  });
  it("uses weights, effective budget and the same seven-day freshness ceiling", () => {
    const checkedAt=new Date(Date.now()-2.5*3600_000).toISOString();
    expect(isRegionResultStale({...latest(),checkedAt},monitor,regions)).toBe(false);
    expect(isRegionResultStale({...latest(),regionId:"r2",checkedAt},monitor,regions)).toBe(true);
    expect(isRegionResultStale({...latest(),checkedAt}, {...monitor,effectiveDailyBudget:10},regions)).toBe(false);
  });
});
