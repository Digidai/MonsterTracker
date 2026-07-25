ALTER TABLE monitors ADD COLUMN config_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE probe_results ADD COLUMN monitor_config_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE daily_usage ADD COLUMN reserved_probes INTEGER NOT NULL DEFAULT 0;

UPDATE daily_usage SET reserved_probes = probe_results WHERE reserved_probes < probe_results;

UPDATE incidents
SET
  status = 'resolved',
  closed_at = COALESCE(closed_at, datetime('now')),
  summary = 'Resolved duplicate open incident during reliability migration'
WHERE status = 'open'
  AND rowid NOT IN (
    SELECT MAX(rowid)
    FROM incidents
    WHERE status = 'open'
    GROUP BY monitor_id
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_incidents_one_open_per_monitor
  ON incidents (monitor_id)
  WHERE status = 'open';
