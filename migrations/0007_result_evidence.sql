ALTER TABLE probe_results ADD COLUMN result_type TEXT NOT NULL DEFAULT 'target';
ALTER TABLE monitor_latest ADD COLUMN result_type TEXT NOT NULL DEFAULT 'target';

-- Old dispatch errors have neither a target status nor target latency.
-- Actual probe execution always records latency, even on timeout.
UPDATE probe_results SET result_type = 'infrastructure'
WHERE ok = 0 AND status IS NULL AND latency_ms IS NULL;
UPDATE monitor_latest SET result_type = 'infrastructure'
WHERE ok = 0 AND status IS NULL AND latency_ms IS NULL;

-- Keep existing incidents unconfirmed until new evidence establishes recovery.
UPDATE incidents SET status = 'unknown', closed_at = NULL,
  summary = 'Awaiting fresh target evidence after monitoring upgrade'
WHERE status = 'open';
DROP INDEX idx_incidents_one_open_per_monitor;
CREATE UNIQUE INDEX idx_incidents_one_active_per_monitor
ON incidents(monitor_id) WHERE status IN ('open', 'unknown');
