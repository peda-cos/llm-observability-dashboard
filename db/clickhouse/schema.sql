-- Production trace store. ClickHouse >= 25.3 for the production-ready JSON type.
CREATE DATABASE IF NOT EXISTS observability;

CREATE TABLE IF NOT EXISTS observability.spans
(
  span_id String,
  trace_id String,
  parent_span_id String,
  name LowCardinality(String),
  kind LowCardinality(String),
  start_time_unix_micros Int64,
  end_time_unix_micros Int64,
  latency_ms Float64,
  status_code UInt8,
  status_message String,
  gen_ai_system LowCardinality(String),
  gen_ai_request_model LowCardinality(String),
  gen_ai_response_model LowCardinality(String),
  gen_ai_response_id String,
  gen_ai_operation LowCardinality(String),
  input_tokens UInt32,
  output_tokens UInt32,
  cost_usd Float64,
  prompt_hash String,
  app_id LowCardinality(String),
  user_id String,
  session_id String,
  environment LowCardinality(String),
  instrumentation_family LowCardinality(String),
  prompt_text String CODEC(ZSTD(3)),
  completion_text String CODEC(ZSTD(3)),
  retrieval_json String CODEC(ZSTD(3)),
  attributes JSON,
  pii_json String,
  pii_completion UInt8,
  sampled_reason LowCardinality(String),
  ingested_at_us Int64,
  is_eval UInt8,
  eval_name LowCardinality(String),
  eval_score Float64,
  eval_pass UInt8,
  eval_engine LowCardinality(String),
  INDEX idx_trace_id trace_id TYPE bloom_filter GRANULARITY 4,
  INDEX idx_user_id user_id TYPE bloom_filter GRANULARITY 4,
  INDEX idx_app_id app_id TYPE set(100) GRANULARITY 1,
  INDEX idx_prompt_hash prompt_hash TYPE bloom_filter GRANULARITY 4
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(toDateTime(intDiv(start_time_unix_micros, 1000000)))
ORDER BY (app_id, start_time_unix_micros, trace_id)
TTL toDateTime(intDiv(start_time_unix_micros, 1000000)) + INTERVAL 90 DAY;

CREATE TABLE IF NOT EXISTS observability.eval_runs
(
  id String,
  started_us Int64,
  finished_us Int64,
  window_start_us Int64,
  window_end_us Int64,
  sampled UInt32,
  evaluated UInt32,
  engine LowCardinality(String)
)
ENGINE = MergeTree
ORDER BY (started_us, id);

CREATE TABLE IF NOT EXISTS observability.drift_runs
(
  id String,
  computed_us Int64,
  app_id LowCardinality(String),
  window_start_us Int64,
  window_end_us Int64,
  psi Float64,
  kl Float64,
  n_current UInt32,
  n_baseline UInt32,
  threshold Float64,
  alert UInt8,
  status LowCardinality(String),
  detail_json String CODEC(ZSTD(3))
)
ENGINE = ReplacingMergeTree
ORDER BY (app_id, window_end_us);

CREATE TABLE IF NOT EXISTS observability.alerts
(
  id String,
  fingerprint String,
  rule LowCardinality(String),
  severity LowCardinality(String),
  app_id LowCardinality(String),
  summary String,
  description String,
  status LowCardinality(String),
  occurrences UInt32,
  created_us Int64,
  updated_us Int64,
  payload_json String CODEC(ZSTD(3))
)
ENGINE = ReplacingMergeTree(updated_us)
ORDER BY (fingerprint);

CREATE TABLE IF NOT EXISTS observability.triage_queue
(
  id String,
  span_id String,
  trace_id String,
  score Float64,
  reason String,
  excerpt String,
  status LowCardinality(String),
  created_us Int64,
  resolved_us Int64
)
ENGINE = ReplacingMergeTree(created_us)
ORDER BY (span_id);
