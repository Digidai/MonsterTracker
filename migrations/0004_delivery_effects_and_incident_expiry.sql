ALTER TABLE probe_results ADD COLUMN usage_applied INTEGER NOT NULL DEFAULT 1;
ALTER TABLE probe_results ADD COLUMN analytics_applied INTEGER NOT NULL DEFAULT 1;
ALTER TABLE incidents ADD COLUMN expires_at TEXT;

UPDATE incidents
SET expires_at = datetime('now', '+7 days')
WHERE status = 'open' AND expires_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_incidents_status_expiry
  ON incidents (status, expires_at);
