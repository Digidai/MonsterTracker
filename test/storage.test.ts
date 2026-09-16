import { describe, expect, it, vi } from "vitest";

import type { ProbeResult, RuntimeEnv } from "../src/domain";
import { claimScheduledRunAndReserve, cleanupRetention, getRunStatus, getSchedulingSnapshot, listMonitors,
  listRegions, recordSchedulerRun, saveProbeResults } from "../src/storage";
import { databaseHarness } from "./d1-harness";

describe("result persistence guardrails", () => {
  it("rejects a batch that could exceed the D1 Free query budget", async () => {
    const result = {
      id: "result",
      runId: "run",
      monitorId: "monitor",
      monitorConfigVersion: 1,
      regionId: "region",
      targetUrl: "https://example.com/",
      checkedAt: "2026-07-26T00:00:00.000Z",
      ok: true,
      status: 200,
      latencyMs: 10,
      error: null,
      method: "HEAD",
      entryColo: "IAD",
      entryCountry: "US",
      entryCity: "Ashburn",
      entryAsn: 13335,
      entryAsOrganization: "Cloudflare",
      placement: "aws:us-east-1",
      responseBytes: 0
    } satisfies ProbeResult;

    await expect(
      saveProbeResults({} as RuntimeEnv, Array.from({ length: 11 }, (_, index) => ({ ...result, id: `result_${index}` })))
    ).rejects.toThrow("10-result D1 safety limit");
  });
});

describe("scheduled run claims", () => {
  it("keeps missing results visible after terminal failure and accounts for late evidence", async () => {
    const db = databaseHarness();
    try {
      const now = new Date().toISOString();
      await recordSchedulerRun(db.env, { id: "terminal", startedAt: now, finishedAt: now,
        plannedJobs: 3, dispatchedJobs: 2, skippedJobs: 1, error: "queue_unavailable",
        cancellations: [{ resultId: "res_cancelled", reason: "monitor_config_changed" }] });
      expect(await getRunStatus(db.env, "terminal")).toMatchObject({ error: "queue_unavailable", finishedAt: now,
        storedResults: 0, cancelledResults: 1, pendingResults: 2 });
      db.sqlite.exec(`INSERT INTO monitors (id,name,url,created_at,updated_at)
        VALUES ('m','Monitor','https://example.com/','2026-01-01','2026-01-01');
        INSERT INTO regions (id,label,area,provider,provider_region,placement_region,worker_name,created_at,updated_at)
        VALUES ('r','Region','Area','aws','us-east-1','aws:us-east-1','probe','2026-01-01','2026-01-01')`);
      for (const [index, id] of ["res_late", "res_cancelled", "res_other"].entries()) {
        db.sqlite.prepare(`INSERT INTO probe_results
          (id,run_id,monitor_id,region_id,target_url,checked_at,ok,status,method)
          VALUES (?,'terminal','m','r','https://example.com/',?,1,200,'HEAD')`).run(id, now);
        expect(await getRunStatus(db.env, "terminal")).toMatchObject({ storedResults: index + 1,
          cancelledResults: index === 0 ? 1 : 0, pendingResults: index === 2 ? 0 : 1 });
      }
    } finally { db.sqlite.close(); }
  });

  it("refreshes monitors and regions in one query, retaining the list ordering and empty-table behavior", async () => {
    const db = databaseHarness();
    try {
      expect(await getSchedulingSnapshot(db.env)).toEqual({ monitors: [], regions: [] });
      db.sqlite.exec(`INSERT INTO monitors (id,name,url,created_at,updated_at,deleted_at)
        VALUES ('older','Older','https://example.com/','2026-01-01','2026-01-01',NULL),
          ('newer','Newer','https://example.com/','2026-02-01','2026-02-01',NULL),
          ('deleted','Deleted','https://example.com/','2026-03-01','2026-03-01','2026-04-01');
        INSERT INTO regions (id,label,area,provider,provider_region,placement_region,worker_name,enabled,created_at,updated_at)
        VALUES ('disabled','A','A','aws','us-east-1','aws:us-east-1','probe',0,'2026-01-01','2026-01-01'),
          ('enabled','Z','Z','aws','us-east-1','aws:us-east-1','probe',1,'2026-01-01','2026-01-01')`);
      const expected = { monitors: await listMonitors(db.env), regions: await listRegions(db.env) };
      db.resetCount();
      expect(await getSchedulingSnapshot(db.env)).toEqual(expected);
      expect(db.count()).toBe(1);
    } finally { db.sqlite.close(); }
  });

  it("reads legacy cancellation IDs and newer cancellation reasons without extra queries", async () => {
    const db = databaseHarness();
    try {
      for (const [id, cancellation] of [
        ["legacy", { cancelledResultIds: ["res_old"] }],
        ["current", { cancellations: [{ resultId: "res_new", reason: "monitor_disabled" }] }]
      ] as const) {
        await recordSchedulerRun(db.env, { id, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
          plannedJobs: 1, dispatchedJobs: 0, skippedJobs: 1,
          ...("cancelledResultIds" in cancellation ? { cancelledResultIds: [...cancellation.cancelledResultIds] }
            : { cancellations: [...cancellation.cancellations] }) });
      }
      db.resetCount();
      expect(await getRunStatus(db.env, "legacy")).toMatchObject({ cancelledResults: 1, pendingResults: 0,
        cancellations: [{ resultId: "res_old", reason: "unspecified" }] });
      expect(db.count()).toBe(2);
      expect(await getRunStatus(db.env, "current")).toMatchObject({ cancelledResults: 1, pendingResults: 0,
        cancellations: [{ resultId: "res_new", reason: "monitor_disabled" }] });
    } finally { db.sqlite.close(); }
  });

  it("scopes budget-failure cleanup to the run inserted by the current claim", async () => {
    const statements: Array<{ sql: string; bindings: unknown[] }> = [];
    const db = {
      prepare(sql: string) {
        return {
          sql,
          bindings: [] as unknown[],
          bind(...bindings: unknown[]) {
            this.bindings = bindings;
            statements.push(this);
            return this;
          }
        };
      },
      async batch() {
        return [
          { meta: { changes: 0 } },
          { meta: { changes: 0 } },
          { meta: { changes: 0 } },
          { meta: { changes: 0 } }
        ];
      }
    };

    await claimScheduledRunAndReserve(
      { DB: db } as unknown as RuntimeEnv,
      { id: "cron_202607260000", startedAt: "2026-07-26T00:00:00.000Z", plannedJobs: 0 },
      [],
      10_000,
      "2026-07-26"
    );

    const insertClaimToken = statements[1]?.bindings.at(-1);
    expect(statements[1]?.sql).toContain("claim_token");
    expect(statements[3]?.sql).toContain("claim_token = ?");
    expect(statements[3]?.bindings.at(-1)).toBe(insertClaimToken);
  });
});

describe("incident retention", () => {
  it("retains recent closures and active incidents, with an opening-date fallback only for legacy null closures", async () => {
    vi.useFakeTimers(); vi.setSystemTime("2026-09-16T12:01:00.000Z");
    const db = databaseHarness();
    try {
      db.sqlite.exec(`INSERT INTO monitors (id,name,url,created_at,updated_at)
        VALUES ('m','Monitor','https://example.com/','2026-01-01','2026-01-01')`);
      const now = new Date().toISOString();
      const old = new Date(Date.now() - 40 * 86400000).toISOString();
      const cutoff = new Date(Date.now() - 30 * 86400000).toISOString();
      const cases = [
        ["recent_recovery", "resolved", old, now],
        ["expired_recovery", "resolved", old, old],
        ["exact_cutoff", "resolved", old, cutoff],
        ["legacy_old", "resolved", old, null],
        ["legacy_recent", "resolved", now, null],
        ["still_open", "open", old, null]
      ];
      for (const [id, status, opened, closed] of cases) db.sqlite.prepare(`INSERT INTO incidents
        (id,monitor_id,opened_at,closed_at,severity,status,summary) VALUES (?,'m',?,?,'degraded',?,'test')`)
        .run(id!, opened!, closed!, status!);
      await cleanupRetention(db.env);
      expect(db.sqlite.prepare("SELECT id FROM incidents ORDER BY id").all().map((row) => row.id))
        .toEqual(["exact_cutoff", "legacy_recent", "recent_recovery", "still_open"]);
    } finally { db.sqlite.close(); vi.useRealTimers(); }
  });
});
