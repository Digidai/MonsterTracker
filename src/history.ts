import type { ProbeResult, RuntimeEnv } from "./domain";
import { boolFromDb, nullableTextField, numberField, textField } from "./domain";

export type HistoryRange = "24h" | "7d" | "30d";
export type HistoryOutcome = "all" | "pass" | "fail" | "infrastructure";
export interface HistoryFilters {
  range: HistoryRange;
  outcome: HistoryOutcome;
  region: string | null;
}
export interface HistoryWindow { from: string; to: string }
export interface HistoryStats {
  total: number;
  passed: number;
  failed: number;
  infrastructure: number;
  /** Fraction in [0, 1], excluding infrastructure; null without target observations. */
  observedSuccessRate: number | null;
  /** Mean of non-null target latencies, including failed target observations. */
  averageLatencyMs: number | null;
}
export interface HistoryResponse extends HistoryFilters {
  monitorId: string;
  configVersion: number;
  limit: number;
  results: ProbeResult[];
  nextCursor: string | null;
  /** Inclusive UTC boundaries, frozen across pages. */
  window: HistoryWindow;
  stats: HistoryStats;
}

interface Cursor extends HistoryFilters {
  v: 1;
  monitorId: string;
  configVersion: number;
  rangeStart: string;
  rangeEnd: string;
  snapshotRowId: number;
  snapshotId: string;
  checkedAt: string;
  id: string;
}
type DbRow = Record<string, unknown>;
interface Snapshot extends DbRow {
  config_version: number;
  snapshot_rowid: number;
  snapshot_id: string | null;
}
const RANGE_MS = { "24h": 86_400_000, "7d": 7 * 86_400_000, "30d": 30 * 86_400_000 };
const OUTCOME_SQL = {
  all: "",
  pass: " AND result_type = 'target' AND ok = 1",
  fail: " AND result_type = 'target' AND ok = 0",
  infrastructure: " AND result_type = 'infrastructure'"
};
const PARAMETERS = new Set(["range", "outcome", "region", "limit", "cursor"]);
const CURSOR_KEYS = new Set(["v", "monitorId", "configVersion", "range", "outcome", "region",
  "rangeStart", "rangeEnd", "snapshotRowId", "snapshotId", "checkedAt", "id"]);
const errorResponse = (error: string, status = 400) => Response.json({ error }, { status });

/** Caller owns requireAdmin, routing, response headers and DB-error -> 503 handling. */
export async function handleMonitorHistory(
  request: Request, env: Pick<RuntimeEnv, "DB">, monitorId: string
): Promise<Response> {
  let query: ReturnType<typeof parseQuery>;
  try { query = parseQuery(new URL(request.url).searchParams, monitorId); }
  catch { return errorResponse("Invalid history parameters or cursor."); }
  const { filters, limit, cursor } = query;

  // MAX(rowid) is a single B-tree lookup. The ceiling also excludes delayed inserts
  // whose checked_at predates this request. Pin its identity to detect deletion/reuse.
  const snapshotStatement = (ceiling: number | null) => env.DB.prepare(`
    SELECT m.config_version, COALESCE(s.rowid, 0) AS snapshot_rowid, s.id AS snapshot_id
    FROM monitors AS m LEFT JOIN probe_results AS s
      ON s.rowid = ${ceiling === null ? "(SELECT MAX(rowid) FROM probe_results)" : "?"}
    WHERE m.id = ? AND m.deleted_at IS NULL
  `).bind(...(ceiling === null ? [monitorId] : [ceiling, monitorId]));
  const metadata = await snapshotStatement(cursor?.snapshotRowId ?? null).first<Snapshot>();
  if (!metadata) return errorResponse("Monitor not found.", 404);
  if (cursor && (cursor.configVersion !== metadata.config_version ||
      cursor.snapshotRowId !== metadata.snapshot_rowid || cursor.snapshotId !== metadata.snapshot_id)) {
    return errorResponse("History snapshot expired or monitor changed. Restart without a cursor.");
  }

  const to = cursor?.rangeEnd ?? new Date().toISOString();
  const from = cursor?.rangeStart ?? new Date(Date.parse(to) - RANGE_MS[filters.range]).toISOString();
  const scope = `monitor_id = ? AND monitor_config_version = ?
    AND checked_at >= ? AND checked_at <= ? AND rowid <= ?${filters.region === null ? "" : " AND region_id = ?"}`;
  const bindings = [monitorId, metadata.config_version, from, to, metadata.snapshot_rowid,
    ...(filters.region === null ? [] : [filters.region])];
  // Recheck visibility/configuration and the insertion anchor in the same transaction
  // as the results (four statements total). Stats precede outcome/keyset filters.
  const [current, aggregate, page] = await env.DB.batch<DbRow>([
    snapshotStatement(metadata.snapshot_rowid),
    env.DB.prepare(`SELECT COUNT(*) AS total,
      COALESCE(SUM(result_type = 'target' AND ok = 1), 0) AS passed,
      COALESCE(SUM(result_type = 'target' AND ok = 0), 0) AS failed,
      COALESCE(SUM(result_type = 'infrastructure'), 0) AS infrastructure,
      AVG(CASE WHEN result_type = 'target' THEN latency_ms END) AS average_latency_ms
      FROM probe_results WHERE ${scope}`).bind(...bindings),
    env.DB.prepare(`SELECT * FROM probe_results WHERE ${scope}${OUTCOME_SQL[filters.outcome]}
      ${cursor ? "AND (checked_at, id) < (?, ?)" : ""}
      ORDER BY checked_at DESC, id DESC LIMIT ?`)
      .bind(...bindings, ...(cursor ? [cursor.checkedAt, cursor.id] : []), limit + 1)
  ]);
  const active = current!.results[0];
  if (!active) return errorResponse("Monitor not found.", 404);
  if (active.config_version !== metadata.config_version || active.snapshot_rowid !== metadata.snapshot_rowid ||
      active.snapshot_id !== metadata.snapshot_id) {
    return errorResponse("History snapshot expired or monitor changed. Restart without a cursor.");
  }
  const row = aggregate!.results[0]!;
  const passed = numberField(row, "passed");
  const failed = numberField(row, "failed");
  const results = page!.results.slice(0, limit).map(mapResult);
  const last = results.at(-1);
  const nextCursor = page!.results.length > limit && last ? encodeCursor({
    v: 1, monitorId, configVersion: metadata.config_version, ...filters,
    rangeStart: from, rangeEnd: to, snapshotRowId: metadata.snapshot_rowid,
    snapshotId: metadata.snapshot_id!, checkedAt: last.checkedAt, id: last.id
  }) : null;
  return Response.json({
    monitorId, configVersion: metadata.config_version, ...filters, limit,
    results, nextCursor, window: { from, to },
    stats: { total: numberField(row, "total"), passed, failed,
      infrastructure: numberField(row, "infrastructure"),
      observedSuccessRate: passed + failed ? passed / (passed + failed) : null,
      averageLatencyMs: nullableNumber(row.average_latency_ms) }
  } satisfies HistoryResponse);
}

function parseQuery(params: URLSearchParams, monitorId: string) {
  for (const key of params.keys()) {
    if (!PARAMETERS.has(key) || params.getAll(key).length !== 1) throw new Error("Invalid parameter");
  }
  const range = params.get("range") ?? "24h";
  const outcome = params.get("outcome") ?? "all";
  const region = params.get("region");
  const limitText = params.get("limit") ?? "50";
  if (!Object.hasOwn(RANGE_MS, range) || !Object.hasOwn(OUTCOME_SQL, outcome) ||
      (region !== null && !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(region)) ||
      !/^(?:[1-9][0-9]?|100)$/.test(limitText)) throw new Error("Invalid filters");
  const filters: HistoryFilters = { range: range as HistoryRange, outcome: outcome as HistoryOutcome, region };
  const token = params.get("cursor");
  const cursor = token === null ? null : decodeCursor(token, monitorId, filters);
  return { filters, limit: Number(limitText), cursor };
}

function encodeCursor(cursor: Cursor): string {
  const bytes = new TextEncoder().encode(JSON.stringify(cursor));
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function decodeCursor(token: string, monitorId: string, filters: HistoryFilters): Cursor {
  if (token.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(token)) throw new Error("Invalid cursor");
  const bytes = Uint8Array.from(atob(token.replaceAll("-", "+").replaceAll("_", "/")), (ch) => ch.charCodeAt(0));
  const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid cursor");
  const c = value as Record<string, unknown>;
  if (Object.keys(c).length !== CURSOR_KEYS.size || Object.keys(c).some((key) => !CURSOR_KEYS.has(key)) ||
      c.v !== 1 || c.monitorId !== monitorId || c.range !== filters.range ||
      c.outcome !== filters.outcome || c.region !== filters.region ||
      !positiveInteger(c.configVersion) || !positiveInteger(c.snapshotRowId) ||
      !identifier(c.snapshotId) || !identifier(c.id) || !isoTimestamp(c.rangeStart) ||
      !isoTimestamp(c.rangeEnd) || !isoTimestamp(c.checkedAt) ||
      Date.parse(c.rangeEnd) - Date.parse(c.rangeStart) !== RANGE_MS[filters.range] ||
      Date.parse(c.rangeEnd) > Date.now() || c.checkedAt < c.rangeStart || c.checkedAt > c.rangeEnd) {
    throw new Error("Invalid cursor");
  }
  // This is an unsigned transport format, never an authorization mechanism.
  return c as unknown as Cursor;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function identifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f]/.test(value);
}
function isoTimestamp(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function nullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function mapResult(row: DbRow): ProbeResult {
  return {
    id: textField(row, "id"), runId: textField(row, "run_id"), monitorId: textField(row, "monitor_id"),
    monitorConfigVersion: numberField(row, "monitor_config_version", 1), regionId: textField(row, "region_id"),
    targetUrl: textField(row, "target_url"), checkedAt: textField(row, "checked_at"), ok: boolFromDb(row.ok),
    resultType: row.result_type === "infrastructure" ? "infrastructure" : "target",
    status: nullableNumber(row.status), latencyMs: nullableNumber(row.latency_ms), error: nullableTextField(row, "error"),
    method: row.method === "GET" ? "GET" : "HEAD", entryColo: nullableTextField(row, "entry_colo"),
    entryCountry: nullableTextField(row, "entry_country"), entryCity: nullableTextField(row, "entry_city"),
    entryAsn: nullableNumber(row.entry_asn), entryAsOrganization: nullableTextField(row, "entry_as_organization"),
    placement: nullableTextField(row, "placement"), responseBytes: numberField(row, "response_bytes")
  };
}
