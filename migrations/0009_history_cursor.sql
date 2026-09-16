-- Scope by current configuration and satisfy the full keyset order without
-- SQLite's temporary B-tree sort for timestamp ties.
CREATE INDEX idx_probe_results_history_cursor
  ON probe_results (monitor_id, monitor_config_version, checked_at DESC, id DESC);
