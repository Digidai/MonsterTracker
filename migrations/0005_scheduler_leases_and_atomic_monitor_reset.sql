ALTER TABLE monitors ADD COLUMN last_mutation_id TEXT;
ALTER TABLE scheduler_runs ADD COLUMN jobs_json TEXT;
ALTER TABLE scheduler_runs ADD COLUMN lease_expires_at TEXT;
ALTER TABLE scheduler_runs ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_scheduler_runs_recovery
  ON scheduler_runs (finished_at, lease_expires_at, started_at);
