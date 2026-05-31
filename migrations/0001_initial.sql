CREATE TABLE IF NOT EXISTS monitors (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  method TEXT NOT NULL DEFAULT 'HEAD',
  expected_status_min INTEGER NOT NULL DEFAULT 200,
  expected_status_max INTEGER NOT NULL DEFAULT 399,
  body_match TEXT,
  timeout_ms INTEGER NOT NULL DEFAULT 10000,
  daily_budget INTEGER NOT NULL DEFAULT 100,
  enabled INTEGER NOT NULL DEFAULT 1,
  tags_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS regions (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  area TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_region TEXT NOT NULL,
  placement_region TEXT NOT NULL,
  worker_name TEXT NOT NULL,
  worker_url TEXT,
  tier TEXT NOT NULL DEFAULT 'core',
  enabled INTEGER NOT NULL DEFAULT 1,
  weight INTEGER NOT NULL DEFAULT 1,
  last_seen_colo TEXT,
  last_seen_country TEXT,
  last_seen_placement TEXT,
  last_seen_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS probe_results (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  monitor_id TEXT NOT NULL,
  region_id TEXT NOT NULL,
  target_url TEXT NOT NULL,
  checked_at TEXT NOT NULL,
  ok INTEGER NOT NULL,
  status INTEGER,
  latency_ms INTEGER,
  error TEXT,
  method TEXT NOT NULL,
  entry_colo TEXT,
  entry_country TEXT,
  entry_city TEXT,
  entry_asn INTEGER,
  entry_as_organization TEXT,
  placement TEXT,
  response_bytes INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (monitor_id) REFERENCES monitors(id) ON DELETE CASCADE,
  FOREIGN KEY (region_id) REFERENCES regions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_probe_results_monitor_time ON probe_results (monitor_id, checked_at DESC);
CREATE INDEX IF NOT EXISTS idx_probe_results_region_time ON probe_results (region_id, checked_at DESC);
CREATE INDEX IF NOT EXISTS idx_probe_results_run ON probe_results (run_id);

CREATE TABLE IF NOT EXISTS monitor_latest (
  monitor_id TEXT NOT NULL,
  region_id TEXT NOT NULL,
  result_id TEXT NOT NULL,
  checked_at TEXT NOT NULL,
  ok INTEGER NOT NULL,
  status INTEGER,
  latency_ms INTEGER,
  error TEXT,
  entry_colo TEXT,
  placement TEXT,
  PRIMARY KEY (monitor_id, region_id),
  FOREIGN KEY (monitor_id) REFERENCES monitors(id) ON DELETE CASCADE,
  FOREIGN KEY (region_id) REFERENCES regions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS incidents (
  id TEXT PRIMARY KEY,
  monitor_id TEXT NOT NULL,
  opened_at TEXT NOT NULL,
  closed_at TEXT,
  severity TEXT NOT NULL,
  status TEXT NOT NULL,
  failing_regions INTEGER NOT NULL DEFAULT 0,
  summary TEXT NOT NULL,
  FOREIGN KEY (monitor_id) REFERENCES monitors(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_incidents_monitor_status ON incidents (monitor_id, status, opened_at DESC);

CREATE TABLE IF NOT EXISTS scheduler_runs (
  id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  planned_jobs INTEGER NOT NULL DEFAULT 0,
  dispatched_jobs INTEGER NOT NULL DEFAULT 0,
  skipped_jobs INTEGER NOT NULL DEFAULT 0,
  error TEXT
);

CREATE TABLE IF NOT EXISTS daily_usage (
  date TEXT PRIMARY KEY,
  probe_results INTEGER NOT NULL DEFAULT 0,
  worker_invocations INTEGER NOT NULL DEFAULT 0,
  queue_messages INTEGER NOT NULL DEFAULT 0,
  d1_writes INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
