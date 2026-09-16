-- This records observed scheduler ticks, not successful dispatch or result delivery.
-- Do not seed a timestamp: no recorded tick must remain unobserved.
CREATE TABLE IF NOT EXISTS operational_signals (
  name TEXT PRIMARY KEY,
  last_tick_at TEXT NOT NULL
);

-- Bound the diagnostics run selection before counting per-run result evidence.
CREATE INDEX IF NOT EXISTS idx_scheduler_runs_started
  ON scheduler_runs (started_at DESC, id DESC);
