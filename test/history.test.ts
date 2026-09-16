import { afterEach, describe, expect, it, vi } from "vitest";
import { requireAdmin } from "../src/auth";
import type { ProbeResult } from "../src/domain";
import { handleMonitorHistory, type HistoryResponse } from "../src/history";
import { databaseHarness } from "./d1-harness";

const NOW = "2026-09-16T12:00:00.000Z";
const DAY = 86_400_000;
const databases: ReturnType<typeof databaseHarness>[] = [];
type Database = ReturnType<typeof databaseHarness>;
afterEach(() => {
  for (const db of databases.splice(0)) db.sqlite.close();
  vi.restoreAllMocks(); vi.useRealTimers();
});

function setup() {
  vi.useFakeTimers(); vi.setSystemTime(NOW);
  const db = databaseHarness(4); databases.push(db);
  db.sqlite.exec("PRAGMA foreign_keys = ON");
  for (const id of ["m", "other"]) db.sqlite.prepare(`INSERT INTO monitors
    (id, name, url, created_at, updated_at) VALUES (?, 'Monitor', 'https://example.com/', ?, ?)`)
    .run(id, NOW, NOW);
  for (const id of ["r", "r2"]) db.sqlite.prepare(`INSERT INTO regions
    (id, label, area, provider, provider_region, placement_region, worker_name, created_at, updated_at)
    VALUES (?, 'Region', 'Area', 'aws', 'us-east-1', 'aws:us-east-1', 'probe', ?, ?)`)
    .run(id, NOW, NOW);
  return db;
}

function insert(db: Database, patch: Partial<ProbeResult> = {}): ProbeResult {
  const result: ProbeResult = {
    id: crypto.randomUUID(), runId: "run", monitorId: "m", monitorConfigVersion: 1, regionId: "r",
    targetUrl: "https://example.com/", checkedAt: NOW, ok: true, resultType: "target", status: 200,
    latencyMs: 20, error: null, method: "HEAD", entryColo: "IAD", entryCountry: "US",
    entryCity: null, entryAsn: null, entryAsOrganization: null, placement: null, responseBytes: 0, ...patch
  };
  db.sqlite.prepare(`INSERT INTO probe_results (id, run_id, monitor_id, monitor_config_version,
    region_id, target_url, checked_at, ok, result_type, status, latency_ms, error, method,
    entry_colo, entry_country, entry_city, entry_asn, entry_as_organization, placement, response_bytes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(result.id, result.runId, result.monitorId, result.monitorConfigVersion, result.regionId,
      result.targetUrl, result.checkedAt, Number(result.ok), result.resultType!, result.status,
      result.latencyMs, result.error, result.method, result.entryColo, result.entryCountry,
      result.entryCity, result.entryAsn, result.entryAsOrganization, result.placement, result.responseBytes);
  return result;
}

function request(query = "", headers?: HeadersInit) {
  return new Request(`http://localhost/api/monitors/m/history?${query}`, { ...(headers ? { headers } : {}) });
}
async function response(db: Database, query = "", monitorId = "m") {
  db.resetCount();
  const result = await handleMonitorHistory(request(query), db.env, monitorId);
  expect(db.count()).toBeLessThanOrEqual(4);
  return result;
}
async function history(db: Database, query = "", monitorId = "m"): Promise<HistoryResponse> {
  const result = await response(db, query, monitorId);
  expect(result.status).toBe(200);
  expect(db.count()).toBe(4);
  return result.json();
}
function encode(value: unknown) { return Buffer.from(JSON.stringify(value)).toString("base64url"); }
function decode(token: string) { return JSON.parse(Buffer.from(token, "base64url").toString()) as Record<string, unknown>; }
async function cursorFixture(db: Database) {
  insert(db, { id: "a" }); insert(db, { id: "b" });
  return (await history(db, "limit=1")).nextCursor!;
}

describe("bounded monitor history with real SQLite", () => {
  it("defaults to 24h/all/50 and explicitly maps every ProbeResult field", async () => {
    const db = setup();
    const sample = insert(db, { id: "mapped", method: "GET", ok: false, status: 503, latencyMs: 0,
      error: "status_mismatch", entryCity: "Ashburn", entryAsn: 13335, entryAsOrganization: "Cloudflare",
      placement: "aws:us-east-1", responseBytes: 128 });
    expect(await history(db)).toEqual({ monitorId: "m", configVersion: 1, range: "24h", outcome: "all",
      region: null, limit: 50, results: [sample], nextCursor: null,
      window: { from: "2026-09-15T12:00:00.000Z", to: NOW },
      stats: { total: 1, passed: 0, failed: 1, infrastructure: 0, observedSuccessRate: 0, averageLatencyMs: 0 } });
  });

  it("paginates every timestamp tie once, freezing new, tied and backdated inserts", async () => {
    const db = setup();
    for (const id of ["a", "b", "c", "d", "e"]) insert(db, { id });
    insert(db, { id: "old", checkedAt: "2026-09-15T12:00:00.000Z" });
    const first = await history(db, "limit=2");
    expect(first.results.map((row) => row.id)).toEqual(["e", "d"]);
    vi.setSystemTime(Date.parse(NOW) + DAY);
    insert(db, { id: "new", checkedAt: new Date().toISOString() });
    insert(db, { id: "cc" }); // would fall on the next page without the row-ID ceiling
    insert(db, { id: "backdated", checkedAt: "2026-09-16T11:00:00.000Z", ok: false });
    const ids = first.results.map((row) => row.id);
    let cursor = first.nextCursor;
    let pages = 1;
    while (cursor && pages < 10) {
      const page = await history(db, `limit=2&cursor=${cursor}`);
      expect(page.window).toEqual(first.window);
      expect(page.stats).toEqual(first.stats);
      ids.push(...page.results.map((row) => row.id));
      cursor = page.nextCursor; pages++;
    }
    expect(cursor).toBeNull(); expect(pages).toBe(3);
    expect(ids).toEqual(["e", "d", "c", "b", "a", "old"]);
    expect((await history(db)).results.map((row) => row.id)).toContain("new");
  });

  it("bounds pages at default 50 and maximum 100, allowing a new page size", async () => {
    const db = setup();
    for (let i = 0; i < 102; i++) insert(db, { id: `p${String(i).padStart(3, "0")}` });
    expect((await history(db)).results).toHaveLength(50);
    const first = await history(db, "limit=100");
    expect(first.results).toHaveLength(100); expect(first.stats.total).toBe(102);
    const second = await history(db, `limit=1&cursor=${first.nextCursor}`);
    expect(second.results.map((row) => row.id)).toEqual(["p001"]);
    const third = await history(db, `limit=100&cursor=${second.nextCursor}`);
    expect(third.results.map((row) => row.id)).toEqual(["p000"]);
    expect(third.nextCursor).toBeNull();
  });

  it.each([["24h", 1], ["7d", 7], ["30d", 30]] as const)("uses inclusive %s boundaries", async (range, days) => {
    const db = setup(); const from = Date.parse(NOW) - days * DAY;
    insert(db, { id: "before", checkedAt: new Date(from - 1).toISOString() });
    insert(db, { id: "start", checkedAt: new Date(from).toISOString() });
    insert(db, { id: "end" });
    insert(db, { id: "future", checkedAt: new Date(Date.parse(NOW) + 1).toISOString() });
    const page = await history(db, `range=${range}`);
    expect(page.results.map((row) => row.id)).toEqual(["end", "start"]);
    expect(page.window).toEqual({ from: new Date(from).toISOString(), to: NOW });
    expect(page.stats.total).toBe(2);
  });

  it("applies strict outcome/region filters but computes statistics before outcome filtering", async () => {
    const db = setup();
    insert(db, { id: "pass", latencyMs: 10 });
    insert(db, { id: "pass-null", latencyMs: null });
    insert(db, { id: "fail", ok: false, status: null, latencyMs: 30 });
    insert(db, { id: "infra", ok: false, resultType: "infrastructure", status: null, latencyMs: 9000 });
    insert(db, { id: "infra-ok", ok: true, resultType: "infrastructure", status: null, latencyMs: null });
    insert(db, { id: "region2", regionId: "r2", ok: false, latencyMs: 900 });
    insert(db, { id: "other-monitor", monitorId: "other", ok: false });
    const expected = { total: 5, passed: 2, failed: 1, infrastructure: 2,
      observedSuccessRate: 2 / 3, averageLatencyMs: 20 };
    for (const [outcome, ids] of [
      ["all", ["pass-null", "pass", "infra-ok", "infra", "fail"]],
      ["pass", ["pass-null", "pass"]], ["fail", ["fail"]], ["infrastructure", ["infra-ok", "infra"]]
    ] as const) {
      const page = await history(db, `region=r&outcome=${outcome}`);
      expect(page.results.map((row) => row.id)).toEqual(ids);
      expect(page.stats).toEqual(expected);
    }
    const first = await history(db, "region=r&outcome=infrastructure&limit=1");
    const next = await history(db, `region=r&outcome=infrastructure&cursor=${first.nextCursor}`);
    expect(next.results.map((row) => row.id)).toEqual(["infra"]);
    expect(next.stats).toEqual(expected);
    expect((await history(db)).stats.total).toBe(6);
    expect((await history(db, "region=unobserved-region")).stats.total).toBe(0);
  });

  it("returns null rates and latency without target observations", async () => {
    const db = setup();
    const empty = await history(db);
    expect(empty.results).toEqual([]); expect(empty.nextCursor).toBeNull();
    expect(empty.stats).toEqual({ total: 0, passed: 0, failed: 0, infrastructure: 0,
      observedSuccessRate: null, averageLatencyMs: null });
    insert(db, { resultType: "infrastructure", ok: false, status: null, latencyMs: null });
    const infrastructure = await history(db, "outcome=pass");
    expect(infrastructure.results).toEqual([]); expect(infrastructure.nextCursor).toBeNull();
    expect(infrastructure.stats).toEqual({ ...empty.stats, total: 1, infrastructure: 1 });
  });

  it("isolates current config versions in both rows and stats and invalidates old cursors", async () => {
    const db = setup(); const cursor = await cursorFixture(db);
    insert(db, { monitorConfigVersion: 2, ok: false, latencyMs: 123 });
    expect((await history(db)).stats.total).toBe(2);
    db.sqlite.exec("UPDATE monitors SET config_version = 2 WHERE id = 'm'");
    const page = await history(db);
    expect(page.configVersion).toBe(2); expect(page.results).toHaveLength(1);
    expect(page.results[0]?.monitorConfigVersion).toBe(2);
    expect(page.stats).toMatchObject({ total: 1, passed: 0, failed: 1, observedSuccessRate: 0, averageLatencyMs: 123 });
    expect((await response(db, `cursor=${cursor}`)).status).toBe(400);
  });

  it("returns 404 for unknown/deleted monitors, including a continuation after deletion", async () => {
    const db = setup(); const cursor = await cursorFixture(db);
    expect((await response(db, "", "missing")).status).toBe(404); expect(db.count()).toBe(1);
    db.sqlite.exec("UPDATE monitors SET deleted_at = '2026-09-16', config_version = 2 WHERE id = 'm'");
    expect((await response(db)).status).toBe(404);
    expect((await response(db, `cursor=${cursor}`)).status).toBe(404);
    expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM probe_results").get()?.n).toBe(2);
  });

  it("keeps disabled but undeleted monitors visible", async () => {
    const db = setup(); insert(db);
    db.sqlite.exec("UPDATE monitors SET enabled = 0 WHERE id = 'm'");
    expect((await history(db)).stats.total).toBe(1);
  });

  it.each(["configuration", "deletion", "snapshot"] as const)(
    "rechecks concurrent %s changes in the result transaction", async (change) => {
      const db = setup(); insert(db, { id: "anchor" });
      const batch = db.env.DB.batch.bind(db.env.DB);
      vi.spyOn(db.env.DB, "batch").mockImplementation(async (statements) => {
        if (change === "configuration") db.sqlite.exec("UPDATE monitors SET config_version = 2 WHERE id = 'm'");
        if (change === "deletion") db.sqlite.exec("UPDATE monitors SET deleted_at = '2026-09-16' WHERE id = 'm'");
        if (change === "snapshot") {
          db.sqlite.exec("DELETE FROM probe_results WHERE id = 'anchor'"); insert(db, { id: "replacement" });
        }
        return batch(statements);
      });
      const result = await response(db);
      expect(result.status).toBe(change === "deletion" ? 404 : 400);
      expect(db.count()).toBe(4);
      expect(await result.json()).toEqual({ error: expect.any(String) });
    }
  );

  it.each([
    "range=", "range=1h", "range=24H", "range=toString", "range=__proto__", "range=7d&range=7d",
    "outcome=", "outcome=failed", "outcome=PASS", "outcome=all&outcome=fail", "outcome=constructor",
    "region=", "region=%20r", "region=r%20", "region=r&region=r2", "region=r%00", `region=${"r".repeat(129)}`,
    "region=%27%20OR%201%3D1--", "limit=", "limit=0", "limit=-1", "limit=101", "limit=1.5",
    "limit=1e2", "limit=1abc", "limit=%2B1", "limit=01", "limit=%2050", "limit=50&limit=50",
    "cursor=", "cursor=%%%", "cursor=abc&cursor=abc", "offset=1", "from=2020-01-01"
  ])("rejects invalid/ambiguous parameters without SQL: %s", async (query) => {
    const db = setup();
    expect((await response(db, query)).status).toBe(400); expect(db.count()).toBe(0);
  });

  it("rejects malformed, oversized and structurally invalid cursors", async () => {
    const db = setup(); const token = await cursorFixture(db); const valid = decode(token);
    const malformed = ["x".repeat(4097), "a", encode(null), encode([]), encode({}), encode("cursor"),
      ...[
        { v: 2 }, { configVersion: 0 }, { configVersion: "1" }, { snapshotRowId: 1.5 },
        { snapshotRowId: Number.MAX_SAFE_INTEGER + 1 }, { snapshotRowId: 0 }, { snapshotId: "" },
        { id: null }, { id: "" }, { id: "x".repeat(513) }, { id: "\u0000" }, { checkedAt: NOW.slice(0, -1) },
        { checkedAt: "2026-09-16T12:00:00.001Z" }, { checkedAt: "2026-09-15T11:59:59.999Z" },
        { rangeStart: "2026-08-15T12:00:00.000Z" }, { rangeEnd: "2026-09-16T12:00:01.000Z" },
        { rangeStart: "2026-02-30T12:00:00.000Z" }, { extra: true },
        { rangeStart: "2026-09-16T12:00:00.000Z", rangeEnd: "2026-09-17T12:00:00.000Z" }
      ].map((patch) => encode({ ...valid, ...patch }))];
    for (const cursor of malformed) {
      expect((await response(db, `cursor=${cursor}`)).status).toBe(400); expect(db.count()).toBe(0);
    }
  });

  it("binds cursors to monitor, range, outcome and region", async () => {
    const db = setup(); const token = await cursorFixture(db);
    for (const query of ["range=7d", "outcome=fail", "region=r"]) {
      expect((await response(db, `${query}&cursor=${token}`)).status).toBe(400); expect(db.count()).toBe(0);
    }
    expect((await response(db, `cursor=${token}`, "other")).status).toBe(400); expect(db.count()).toBe(0);
    const regional = (await history(db, "region=r&limit=1")).nextCursor!;
    expect((await response(db, `cursor=${regional}`)).status).toBe(400);
  });

  it("treats decoded values as bound data, never SQL or authorization", async () => {
    const db = setup(); const token = await cursorFixture(db);
    const forged = encode({ ...decode(token), id: "z') OR 1=1 --" });
    insert(db, { monitorId: "other", id: "secret-other-monitor" });
    const page = await history(db, `cursor=${forged}`);
    expect(page.results.map((row) => row.id)).toEqual(["b", "a"]);
    expect(page.stats.total).toBe(2);
    expect((await response(db, "", "m' OR 1=1 --")).status).toBe(404);
  });

  it("expires a cursor if its insertion ceiling was deleted and the row ID reused", async () => {
    const db = setup(); const token = await cursorFixture(db);
    db.sqlite.exec("DELETE FROM probe_results WHERE id = 'b'");
    insert(db, { id: "replacement" });
    expect((await response(db, `cursor=${token}`)).status).toBe(400);
  });

  it("leaves authentication, error-to-503 handling and custom headers to the parent", async () => {
    const db = setup(); insert(db); db.env.ADMIN_TOKEN = "synthetic-test-only";
    // Direct calls deliberately need no credentials. This wrapper models the parent contract.
    expect((await response(db)).status).toBe(200);
    async function parent(req: Request) {
      const unauthorized = requireAdmin(req, db.env);
      if (unauthorized) return unauthorized;
      try { return await handleMonitorHistory(req, db.env, "m"); }
      catch { return Response.json({ error: "Unavailable" }, { status: 503 }); }
    }
    db.resetCount();
    expect((await parent(request())).status).toBe(401); expect(db.count()).toBe(0);
    const authenticated = request("", { Authorization: "Bearer synthetic-test-only" });
    const result = await parent(authenticated);
    expect(result.status).toBe(200);
    expect([...result.headers.keys()]).toEqual(["content-type"]);
    const failure = new Error("synthetic_database_failure");
    vi.spyOn(db.env.DB, "batch").mockRejectedValue(failure);
    db.resetCount();
    await expect(handleMonitorHistory(request(), db.env, "m")).rejects.toBe(failure);
    db.resetCount(); expect((await parent(authenticated)).status).toBe(503);
    vi.spyOn(db.env.DB, "prepare").mockImplementation(() => { throw failure; });
    await expect(handleMonitorHistory(request(), db.env, "m")).rejects.toBe(failure);
  });

  it("uses the history index to avoid temporary sorting on both first and subsequent pages", async () => {
    const db = setup(); insert(db);
    const sql: string[] = [];
    const prepare = db.env.DB.prepare.bind(db.env.DB);
    vi.spyOn(db.env.DB, "prepare").mockImplementation((statement) => { sql.push(statement); return prepare(statement); });
    const token = await cursorFixture(db);
    await history(db, `cursor=${token}`);
    const queries = sql.filter((statement) => statement.includes("SELECT * FROM probe_results"));
    expect(queries).toHaveLength(2);
    for (const query of queries) {
      const bindings = ["m", 1, "2026-09-15T12:00:00.000Z", NOW, 3,
        ...(query.includes("AND (checked_at, id)") ? [NOW, "b"] : []), 51];
      const plan = db.sqlite.prepare(`EXPLAIN QUERY PLAN ${query}`).all(...bindings).map((row) => row.detail).join("\n");
      expect(plan).toContain("idx_probe_results_history_cursor"); expect(plan).not.toContain("TEMP B-TREE");
    }
  });
});
