-- Keep a tombstone so delayed Queue deliveries retain a valid foreign key.
-- Deletion stops scheduling and removes the monitor from the control plane;
-- historical evidence continues to follow the existing retention policies.
ALTER TABLE monitors ADD COLUMN deleted_at TEXT;
ALTER TABLE scheduler_runs ADD COLUMN cancelled_result_ids_json TEXT;

CREATE INDEX idx_monitors_visible_created
  ON monitors (created_at DESC) WHERE deleted_at IS NULL;
