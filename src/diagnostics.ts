import type { RuntimeEnv } from "./domain";
import { nowIso, nullableTextField, numberField, textField } from "./domain";

export type DiagnosticsEnv = RuntimeEnv & { RESULTS_DLQ?: Queue };

export interface SchedulerDiagnostics {
  /** Observed scheduled event time, not successful dispatch or persistence. */
  lastTickAt: string | null;
  status: "recent" | "stale" | "unobserved";
}

export interface QueueDiagnostics {
  state: "available" | "unavailable" | "not_configured";
  backlogCount: number | null;
  backlogBytes: number | null;
  oldestMessageAt: string | null;
}

export interface RunDiagnostics {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  /** Persisted job plan; retries retain this count regardless of dispatch progress. */
  plannedJobs: number;
  storedResults: number;
  cancelledResults: number;
  /** Missing evidence, including on terminal failure. */
  pendingResults: number;
  error: string | null;
  /** Persisted scheduler claims, not dispatched jobs or Queue delivery attempts. */
  attemptCount: number;
  leaseExpiresAt: string | null;
  /** Complete means all results arrived; cancelled means settled with cancellations. */
  state: "complete" | "running" | "waiting-results" | "retrying" | "failed" | "cancelled";
}

export interface DiagnosticsConfiguration {
  queueConfigured: boolean;
  archiveConfigured: boolean;
  analyticsConfigured: boolean;
  probeSecretConfigured: boolean;
}

export interface DiagnosticsReport {
  generatedAt: string;
  scheduler: SchedulerDiagnostics;
  queues: { results: QueueDiagnostics; deadLetter: QueueDiagnostics };
  runs: RunDiagnostics[];
  /** Binding/secret presence only; these checks do not establish operational health. */
  configuration: DiagnosticsConfiguration;
}

/** Call at scheduler entry. One monotonic write every fifth UTC minute; no metrics work. */
export async function recordSchedulerHeartbeat(env: RuntimeEnv, scheduledAt: Date): Promise<void> {
  if (!Number.isFinite(scheduledAt.getTime()) || scheduledAt.getUTCMinutes() % 5 !== 0) return;
  await env.DB.prepare(
    `INSERT INTO operational_signals (name, last_tick_at) VALUES ('scheduler', ?)
     ON CONFLICT(name) DO UPDATE SET last_tick_at = excluded.last_tick_at
     WHERE excluded.last_tick_at > operational_signals.last_tick_at`
  ).bind(scheduledAt.toISOString()).run();
}

/** On-demand, read-only diagnostics: two D1 statements and at most two metrics calls. */
export async function getDiagnostics(env: DiagnosticsEnv): Promise<DiagnosticsReport> {
  const [heartbeat, runs, results, deadLetter] = await Promise.all([
    env.DB.prepare("SELECT last_tick_at FROM operational_signals WHERE name = 'scheduler'")
      .first<Record<string, unknown>>(),
    env.DB.prepare(
      `SELECT r.*,
         (SELECT COUNT(*) FROM probe_results WHERE run_id = r.id) AS stored_results,
         (SELECT COUNT(DISTINCT cancelled.result_id) FROM (
            SELECT CASE WHEN type = 'text' THEN value ELSE json_extract(value, '$.resultId') END AS result_id
            FROM json_each(COALESCE(NULLIF(r.cancelled_result_ids_json, ''), '[]'))
          ) AS cancelled
          WHERE NOT EXISTS (SELECT 1 FROM probe_results AS received WHERE received.id = cancelled.result_id)) AS cancelled_results
       FROM (
         SELECT id, started_at, finished_at, planned_jobs, error, attempt_count,
                lease_expires_at, cancelled_result_ids_json
         FROM scheduler_runs ORDER BY started_at DESC, id DESC LIMIT 20
       ) AS r
       ORDER BY r.started_at DESC, r.id DESC`
    ).all<Record<string, unknown>>(),
    queueDiagnostics(env.RESULTS_QUEUE),
    queueDiagnostics(env.RESULTS_DLQ)
  ]);
  const generatedAt = nowIso();
  const lastTickAt = nullableTextField(heartbeat ?? {}, "last_tick_at");
  return {
    generatedAt,
    scheduler: {
      lastTickAt,
      status: lastTickAt === null ? "unobserved"
        : Date.parse(generatedAt) - Date.parse(lastTickAt) > 15 * 60_000 ? "stale" : "recent"
    },
    queues: { results, deadLetter },
    runs: (runs.results ?? []).map(mapRun),
    configuration: {
      queueConfigured: Boolean(env.RESULTS_QUEUE),
      archiveConfigured: Boolean(env.ARCHIVE),
      analyticsConfigured: Boolean(env.ANALYTICS),
      probeSecretConfigured: Boolean(env.SHARED_SECRET)
    }
  };
}

function mapRun(row: Record<string, unknown>): RunDiagnostics {
  const finishedAt = nullableTextField(row, "finished_at");
  const error = nullableTextField(row, "error");
  const plannedJobs = numberField(row, "planned_jobs");
  const storedResults = numberField(row, "stored_results");
  const cancelledResults = numberField(row, "cancelled_results");
  // Failure is a lifecycle state; it does not establish delivery of missing evidence.
  const pendingResults = Math.max(0, plannedJobs - storedResults - cancelledResults);
  const attemptCount = numberField(row, "attempt_count");
  let state: RunDiagnostics["state"];
  if (!finishedAt) state = error || attemptCount > 1 ? "retrying" : "running";
  else if (error) state = "failed";
  else if (pendingResults > 0) state = "waiting-results";
  else state = cancelledResults > 0 ? "cancelled" : "complete";
  return {
    id: textField(row, "id"),
    startedAt: textField(row, "started_at"),
    finishedAt,
    plannedJobs,
    storedResults,
    cancelledResults,
    pendingResults,
    error,
    attemptCount,
    leaseExpiresAt: nullableTextField(row, "lease_expires_at"),
    state
  };
}

async function queueDiagnostics(queue: Queue | undefined): Promise<QueueDiagnostics> {
  const unknown: QueueDiagnostics = {
    state: queue ? "unavailable" : "not_configured",
    backlogCount: null, backlogBytes: null, oldestMessageAt: null
  };
  if (!queue) return unknown;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const metrics = await Promise.race([
      queue.metrics(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Queue metrics timed out")), 3_000);
      })
    ]);
    return {
      state: "available",
      backlogCount: nonnegativeNumber(metrics.backlogCount),
      backlogBytes: nonnegativeNumber(metrics.backlogBytes),
      oldestMessageAt: queueTimestamp(metrics.oldestMessageTimestamp)
    };
  } catch {
    return unknown;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function nonnegativeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function queueTimestamp(value: unknown): string | null {
  // Worker types use Date | undefined; the public API docs also specify epoch milliseconds.
  const date = value instanceof Date ? value : typeof value === "number" ? new Date(value) : null;
  return date && Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
