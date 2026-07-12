# Skill: instrument an LLM application for the observability plane

Use this when an LLM application needs cost, latency, eval, drift, and PII
visibility. The dashboard accepts OTLP/HTTP GenAI spans and derives every view
from the same canonical span row.

## 1. Point the SDK at the ingress

The local ingress listens on `http://127.0.0.1:4318/v1/traces` and accepts
gzip-compressed OTLP JSON. The standard environment variables work with
OpenLLMetry or a plain OpenTelemetry exporter:

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318
export OTEL_EXPORTER_OTLP_PROTOCOL=http/json
export OTEL_SERVICE_NAME=support-bot
opentelemetry-instrument python your_app.py
```

For a TypeScript app, keep the OpenTelemetry SDK's OTLP/HTTP exporter and set
the endpoint above. The dashboard does not require a vendor SDK.

## 2. Emit the canonical attributes

At minimum, a GenAI span should carry:

| Attribute | Why |
|---|---|
| `gen_ai.provider.name` (or legacy `gen_ai.system`) | provider grouping and cost lookup |
| `gen_ai.request.model` | model inventory and pricing |
| `gen_ai.operation.name` | `chat`, `generate_content`, `embeddings`, `retrieval` |
| `gen_ai.usage.input_tokens` / `output_tokens` | token and cost attribution |
| `gen_ai.response.id` | response linkage |
| `gen_ai.input.messages` / `gen_ai.output.messages` | eval content; legacy `gen_ai.prompt` / `gen_ai.completion` also accepted |
| `user.id` and `session.id` (resource or span) | per-user cost and session views |
| `retrieval.documents` and `retrieval.expected_ids` | RAGAS-style context metrics |

The normalizer accepts the current message format, legacy prompt/completion
attributes, and OpenLLMetry's `llm.*` aliases. Application identity comes from
`app.id`, falling back to `service.name`.

## 3. Let the worker run the loops

`npm run ingress` starts the collector and the worker:

- tails traces and keeps 100% of errors and PII-flagged traces plus 10% of
  clean traffic;
- eval jobs run every 60s over sampled traces in the last 15 minutes and write
  linked eval spans;
- the PII guard writes high-score responses into the triage queue;
- the drift job runs weekly and compares the current 7-day prompt distribution
  with the trailing 4-week baseline;
- alert rules evaluate every 2s and record local, Slack, and PagerDuty
  delivery attempts.

Change windows and thresholds in `config/policy.json`.

## 4. Read the five surfaces

| Page | Question it answers |
|---|---|
| `/` | Are cost, latency, errors, and PII moving? |
| `/traces` | Which app/user/model produced a span, and what did it say? |
| `/traces/[traceId]` | Waterfall plus linked eval spans for one trace |
| `/evals` | Metric trends, pass rates, and the PII triage queue |
| `/drift` | Per-app PSI, KL, and cluster-proportion shifts |
| `/alerts` | Open/acked alerts and delivery state |

## 5. Plug real services

- **ClickHouse:** set `CLICKHOUSE_URL`; the application exporter writes the
  `observability.spans` schema in `db/clickhouse/schema.sql`.
- **Postgres metadata:** use `db/postgres/schema.sql`; the local SQLite tables
  mirror the same columns.
- **S3 archive:** `FileArchive` writes raw OTLP payloads to `ARCHIVE_DIR`
  locally; `deploy/otel-collector.yaml` has the `awss3` exporter.
- **Prometheus/Alertmanager:** scrape `/metrics` with
  `deploy/prometheus/prometheus.yml`, load the rules, and route
  `deploy/alertmanager/alertmanager.yml`; the `/api/alertmanager` endpoint
  accepts v4 webhooks so the dashboard alert history stays in sync.
- **Guard LLM:** set `JUDGE_PROVIDER=openai`, `OPENAI_BASE_URL`,
  `OPENAI_API_KEY`, and `JUDGE_MODEL` to use any OpenAI-compatible chat
  endpoint. The default regex judge is deterministic and offline.

## 6. Known limits

The local eval engine is lexical, not DeepEval/RAGAS. The local embedder is a
128-dimensional feature hash, not sentence-transformers. The ingestion load
test measures SQLite, not ClickHouse. See `README.md` for measured numbers and
the exact plug points.
