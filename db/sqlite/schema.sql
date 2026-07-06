CREATE TABLE IF NOT EXISTS spans (
  span_id TEXT PRIMARY KEY,
  trace_id TEXT NOT NULL,
  parent_span_id TEXT,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  start_us INTEGER NOT NULL,
  end_us INTEGER NOT NULL,
  latency_ms REAL NOT NULL,
  status_code INTEGER NOT NULL DEFAULT 0,
  status_message TEXT,
  gen_ai_system TEXT NOT NULL DEFAULT 'unknown',
  gen_ai_request_model TEXT,
  gen_ai_response_model TEXT,
  gen_ai_response_id TEXT,
  gen_ai_operation TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  prompt_hash TEXT,
  app_id TEXT NOT NULL,
  user_id TEXT,
  session_id TEXT,
  environment TEXT,
  instrumentation_family TEXT,
  prompt_text TEXT,
  completion_text TEXT,
  retrieval_json TEXT,
  attributes_json TEXT NOT NULL,
  pii_json TEXT NOT NULL DEFAULT '[]',
  pii_completion INTEGER NOT NULL DEFAULT 0,
  sampled_reason TEXT,
  ingested_at_us INTEGER NOT NULL,
  is_eval INTEGER NOT NULL DEFAULT 0,
  eval_name TEXT,
  eval_score REAL,
  eval_pass INTEGER,
  eval_engine TEXT
);

CREATE INDEX IF NOT EXISTS idx_spans_app_time ON spans(app_id, start_us DESC);
CREATE INDEX IF NOT EXISTS idx_spans_user_time ON spans(user_id, start_us DESC);
CREATE INDEX IF NOT EXISTS idx_spans_trace ON spans(trace_id, start_us);
CREATE INDEX IF NOT EXISTS idx_spans_model ON spans(gen_ai_request_model, start_us DESC);
CREATE INDEX IF NOT EXISTS idx_spans_prompt_hash ON spans(prompt_hash);
CREATE INDEX IF NOT EXISTS idx_spans_eval ON spans(is_eval, eval_name, start_us DESC);
CREATE INDEX IF NOT EXISTS idx_spans_parent ON spans(parent_span_id);
CREATE INDEX IF NOT EXISTS idx_spans_pii ON spans(start_us DESC) WHERE pii_completion = 1;

CREATE TABLE IF NOT EXISTS eval_runs (
  id TEXT PRIMARY KEY,
  started_us INTEGER NOT NULL,
  finished_us INTEGER NOT NULL,
  window_start_us INTEGER NOT NULL,
  window_end_us INTEGER NOT NULL,
  sampled INTEGER NOT NULL,
  evaluated INTEGER NOT NULL,
  engine TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS drift_runs (
  id TEXT PRIMARY KEY,
  computed_us INTEGER NOT NULL,
  app_id TEXT NOT NULL,
  window_start_us INTEGER NOT NULL,
  window_end_us INTEGER NOT NULL,
  psi REAL NOT NULL,
  kl REAL NOT NULL,
  n_current INTEGER NOT NULL,
  n_baseline INTEGER NOT NULL,
  threshold REAL NOT NULL,
  alert INTEGER NOT NULL,
  status TEXT NOT NULL,
  detail_json TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_drift_window ON drift_runs(app_id, window_end_us);
CREATE INDEX IF NOT EXISTS idx_drift_app_time ON drift_runs(app_id, window_end_us DESC);

CREATE TABLE IF NOT EXISTS alerts (
  id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL UNIQUE,
  rule TEXT NOT NULL,
  severity TEXT NOT NULL,
  app_id TEXT NOT NULL,
  summary TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  occurrences INTEGER NOT NULL DEFAULT 1,
  created_us INTEGER NOT NULL,
  updated_us INTEGER NOT NULL,
  payload_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS alert_deliveries (
  alert_id TEXT NOT NULL,
  sink TEXT NOT NULL,
  status TEXT NOT NULL,
  detail TEXT,
  attempted_us INTEGER NOT NULL,
  PRIMARY KEY (alert_id, sink)
);

CREATE TABLE IF NOT EXISTS triage_queue (
  id TEXT PRIMARY KEY,
  span_id TEXT NOT NULL,
  trace_id TEXT NOT NULL,
  score REAL NOT NULL,
  reason TEXT NOT NULL,
  excerpt TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  created_us INTEGER NOT NULL,
  resolved_us INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_triage_span ON triage_queue(span_id);
CREATE INDEX IF NOT EXISTS idx_triage_status ON triage_queue(status, created_us DESC);

CREATE TABLE IF NOT EXISTS apps (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  team TEXT,
  created_us INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  tier TEXT NOT NULL,
  created_us INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  app_id TEXT,
  started_us INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_app ON sessions(app_id);
