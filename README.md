# LLM Observability & Eval Dashboard

A self-hosted observability plane for LLM applications: OTLP/HTTP ingest of
GenAI-semconv spans, tail sampling, eval spans linked to their parent traces,
PII triage, per-app prompt drift, alert delivery, and a Next.js 15 dashboard over
cost, latency, traces, evals, drift, and alerts.

The project is built for deterministic local execution. It runs with no cloud
account, no API key, no model download, and no GPU. Production-shaped adapters
for ClickHouse, Postgres, S3, OpenTelemetry Collector, Prometheus, and
Alertmanager are included and documented below.

## What it demonstrates

- **Six SDK dialects in, one canonical span schema out.** OpenAI,
  Anthropic, Google GenAI, LangChain, LlamaIndex, and vLLM payloads are
  normalized into the same row (`gen_ai_system`, model, tokens, latency,
  prompt hash, trace/parent IDs, JSON attributes).
- **Tail sampling with error and PII overrides.** A trace is kept after it
  completes if any span errored or carried PII; clean traces use deterministic
  trace-ID sampling. The default success rate is 10%.
- **Eval spans linked to their source.** Faithfulness, toxicity, answer
  relevance, context precision, context recall, and a PII-leak judge write child
  spans into the same trace.
- **Drift as a distribution test.** Per-app PSI and KL divergence between the
  current 7-day prompt distribution and the trailing 4-week baseline, using
  baseline k-means clusters and hash embeddings.
- **An alert chain with evidence.** Local rules dedupe by rule + app, record
  every Slack/PagerDuty delivery attempt, expose Prometheus metrics, accept
  Alertmanager v4 webhooks, and feed five dashboard surfaces.
- **Measured detection and load.** The regression probe detects an injected 1%
  SSN leak in **2.248 s** locally; the ingest loop sustained **1,099.6
  spans/s** for 20 s with no stored-span loss.

## Architecture

```text
 LLM apps / SDKs
 OpenAI · Anthropic · Google · LangChain · LlamaIndex · vLLM
        |
        | OTLP/HTTP (JSON, optional gzip)
        v
 src/ingest/server.ts            /v1/traces · /healthz · /metrics · /api/alertmanager
        |
        v
 Collector                        decode -> normalize GenAI semconv -> archive raw payload
        |
        +--> TailSampler           keep errors + PII, sample successes at 10%
        |
        v
 SQLite (local default)           spans, eval_runs, drift_runs, alerts, triage, metadata
  or ClickHouse (optional)        same canonical columns via CLICKHOUSE_URL
        |
        +--> Eval worker           15-min window, sampled traces, linked eval spans
        +--> PII judge             regex guard locally, OpenAI-compatible guard optionally
        +--> Drift job             weekly per-app PSI/KL over prompt embeddings
        +--> Alert engine          PII, eval, latency, error, drift rules
        |
        +--> Prometheus /metrics   eval aggregates, p95, error ratio, PII ratio, PSI
        +--> Alertmanager webhook  Slack (warning) / PagerDuty (critical)
        |
        v
 Next.js 15 App Router
 / (overview) · /traces · /traces/[traceId] · /evals · /drift · /alerts
```

The local store keeps the production table shapes: `db/clickhouse/schema.sql`
defines `observability.spans` with user/app skip indexes and a JSON attributes
column; `db/postgres/schema.sql` defines apps, users, and sessions;
`db/sqlite/schema.sql` is the executable local equivalent. Raw OTLP payloads go
to `data/archive/` locally and to S3 in the collector config.

### Build-it coverage

| Spec step | Implementation | Where |
|---|---|---|
| 1. Collector config | OTLP HTTP receiver, 100%-error/10%-success tail sampling, ClickHouse + S3 exporters in the collector YAML; the TypeScript ingress is the offline equivalent and adds PII retention | `deploy/otel-collector.yaml`, `src/ingest/` |
| 2. ClickHouse schema | `spans` mirrors GenAI semconv with JSON attributes and user/app indexes | `db/clickhouse/schema.sql` |
| 3. SDK coverage | Six family payload builders; an integration test posts all six through OTLP HTTP and asserts canonical rows | `src/sdk/families.ts`, `tests/collector.test.ts`, `tests/semconv.test.ts` |
| 4. Eval jobs | Windowed, sampled trace eval that writes linked eval spans; faithfulness, toxicity, relevance, retrieval metrics | `src/eval/runner.ts`, `src/eval/metrics.ts` |
| 5. Custom PII judge | Local regex judge by default; optional OpenAI-compatible guard LLM; high scores enter the triage queue | `src/eval/judge.ts`, `app/evals/page.tsx` |
| 6. Drift detection | Weekly PSI + KL, per app and globally, baseline-cluster proportions stored with every run | `src/drift/` |
| 7. Dashboard | Overview, trace search, waterfall with eval spans, eval trends/triage, drift trails, alerts | `app/` |
| 8. Alerting chain | Local rule engine + delivery ledger, Prometheus exporter, scrape/rules/Alertmanager configs, v4 webhook | `src/alerts/`, `deploy/prometheus/`, `deploy/alertmanager/` |
| 9. Regression probe | Synthetic traffic goes from clean to 1% SSN leakage; MTTD is measured from the first leaking batch to the mock Slack delivery | `src/cli/demo-regression.ts` |

## Quickstart

Prerequisites: Node.js 24+ (tested on Node 26), npm, and a POSIX shell.

```bash
# from the project root
./verify.sh          # npm ci, typecheck, 40 tests, production Next.js build
npm run seed         # deterministic 34-day synthetic dataset + evals + drift + alerts
npm run dev          # ingress :4318 + dashboard :3000
```

Open <http://localhost:3000>. If you prefer separate terminals:

```bash
npm run ingress      # collector + eval/drift/alert worker on :4318
npm run dashboard    # Next.js dev server on :3000
```

`npm run seed` resets the demo tables first. Use
`npm run seed -- --no-reset` to append instead. Data lives in `./data/` by
default and is ignored by git.

### Send a live trace

With the ingress running:

```bash
for family in openai anthropic google langchain llamaindex vllm; do
  npm run emit -- --family "$family"
done

curl -s localhost:4318/metrics | grep -E 'llm_(spans|pii|eval)'
```

Clean traces are sampled at 10% by default, so a single emit may not be stored.
Repeat the loop or set `sampling.successRate` to `1` in `config/policy.json`.
The dashboard's trace search covers the full retention window, not only the
last 24 hours.

### Useful commands

```bash
npm test                    # 40 node:test cases, no external network
npm run typecheck           # tsc --noEmit
npm run build               # Next.js production build
npm run eval-report         # score the hand-labeled fixture and write results/eval-quality.json
npm run demo                # inject the PII regression and write results/mttd.json
npm run loadtest -- --rate 1100  # 20-second ingest test; writes results/loadtest.json
npm run drift               # run the weekly drift detector now
```

## Ingest contract

`POST /v1/traces` accepts OTLP JSON (`resourceSpans`) and gzip when
`content-encoding: gzip` is set. Malformed IDs, timestamps, and payloads are
rejected without failing the rest of the batch. The normalizer prefers current
semconv names and accepts legacy aliases:

| Canonical field | Accepted attributes (first match wins) |
|---|---|
| provider | `gen_ai.provider.name`, `gen_ai.system`, `llm.system` |
| model | `gen_ai.request.model`, `llm.request.model`, `gen_ai.response.model` |
| tokens | `gen_ai.usage.input_tokens` / `output_tokens`, `gen_ai.usage.prompt_tokens` / `completion_tokens`, `llm.usage.*` |
| prompt | `gen_ai.input.messages`, `gen_ai.prompt`, `llm.prompts`, prompt events |
| completion | `gen_ai.output.messages`, `gen_ai.completion`, `llm.completions`, completion events |
| response id | `gen_ai.response.id`, `llm.response.id` |
| app | resource `app.id`, resource `service.name`, else `unknown` |
| user / session | `user.id`, `enduser.id`, `llm.user`, `gen_ai.request.user`; `session.id`, `gen_ai.conversation.id` |
| retrieval | `retrieval.documents` (id/text or content), `retrieval.expected_ids` |

Every stored span records `prompt_hash`, cost from `config/pricing.json`,
latency, status, raw attributes, PII findings, and the sampling reason. Unknown
models are stored with `cost.unknown: true` instead of silently costing zero.
`CAPTURE_CONTENT=0` removes prompt/completion/retrieval content and the PII
hash input at ingest; evals then have nothing to score by design.

## Evals, PII, and drift

**Eval jobs.** The worker selects non-eval traces from the last 15 minutes,
samples at 25% by default, caps a batch at 100, and skips spans already scored
for that metric. Results are written as eval spans with `parent_span_id` set to
the parent LLM span, so the trace waterfall shows the link. The local engine is
deterministic: token-overlap faithfulness, cosine answer relevance, a toxicity
lexicon, retrieval precision/recall when context is present, and a PII guard.
`tests/fixtures/eval-labels.json` contains six hand-authored cases covering
grounded, unsupported, toxic, leaking, and ranked-retrieval answers; the report
compares 27 metric values and threshold verdicts.

**PII judge.** `LocalPiiJudge` scans completions for SSNs (with area/group/serial
validation), Luhn-valid credit cards, email addresses, and phone numbers.
High scores are inserted once into `triage_queue` with a redacted excerpt.
For a real guard model:

```bash
export JUDGE_PROVIDER=openai
export OPENAI_BASE_URL=http://127.0.0.1:8000/v1
export OPENAI_API_KEY=sk_test_only
export JUDGE_MODEL=guard-model
npm run ingress
```

The judge uses the OpenAI-compatible `/chat/completions` shape and falls back to
the local detector if the request or JSON parse fails.

**Drift.** The detector embeds prompts with a deterministic 128-dimensional
feature hash (unigrams + bigrams, FNV-1a signed buckets), fits k-means on the
baseline window, assigns both windows to those clusters, and computes PSI and
KL. The threshold is 0.2, following standard PSI guidance that 0.1 is moderate
and 0.2 is severe. Runs are stored per app and for `__all__`, with
`insufficient_data` when the minimum sample sizes are not met. The dashboard
shows the per-cluster baseline/current proportions behind each PSI value.

## Dashboard

| Route | Contents |
|---|---|
| `/` | Spans/sec, cost, p95, error rate, PII-positive evals, open alerts, traffic and latency charts, cost-per-user bars, model table |
| `/traces` | Server-rendered search by app, user, model, status, PII flag, or content, with pagination |
| `/traces/[traceId]` | Waterfall with eval spans plus prompt/completion/retrieval panels and attribute JSON |
| `/evals` | Metric cards, 15-minute score trend, pass-rate table, recent eval spans, open PII triage |
| `/drift` | Per-app PSI trails, latest runs, cluster-proportion shift |
| `/alerts` | Severity/status counts, deduped alert history, delivery status, ack and triage server actions |

All pages are server components reading SQLite through a process-global store;
charts are client components using Recharts. Server actions validate the target
ID and revalidate the affected route. There is no authentication; the UI is
intended for local/self-hosted use behind your own proxy.

## Measured locally

These numbers were produced on the development workstation with the commands
shown. They are local pipeline measurements, not production benchmarks.

| Measurement | Result | How it was measured |
|---|---|---|
| Automated tests | **40 passing**, 0 failing | `./verify.sh` (Node's test runner) |
| Typecheck + build | pass | `tsc --noEmit`, `next build` |
| Ingest throughput | **1,099.6 spans/s** for 20.0 s, 22,000 spans stored, 1.0 kept ratio | `npm run loadtest -- --rate 1100` on loopback, success rate 1.0, no ClickHouse export |
| Ingest POST latency | **p95 8.3 ms**, 220 requests | same run |
| Process RSS | **168 MB** | same run |
| Tail-sampler backlog | max **100 pending traces**, no stored-span loss | same run |
| Injected PII regression MTTD | **2,248 ms** from first leaking batch to Slack delivery | `npm run demo`; eval and alert intervals shortened to 300 ms for the probe |
| Baseline PII false alerts | **0** over 500 clean spans | same run |
| Eval agreement | **MAE 0.0022** over 27 metric values; **1.0 pass agreement** over 6 authored cases | `npm run eval-report` |
| Seeded dataset | 11,265 spans, 2,481 eval spans, 4 apps, 12 users | `npm run seed` |

The committed artifacts are `results/mttd.json`, `results/loadtest.json`,
`results/eval-quality.json`, and `results/seed-summary.json`. Re-run the
commands above to refresh them; seed counts vary slightly because eval sampling
is trace-ID based.

## Test strategy

Tests are deterministic and use no external network. HTTP tests bind ephemeral
loopback ports; Slack, PagerDuty, the guard LLM, and ClickHouse are mock servers
or injected fetch implementations. Each store test gets a fresh temporary SQLite
database.

| Area | Coverage |
|---|---|
| Ingest | Six families through OTLP HTTP, gzip, malformed payloads, archive, ClickHouse JSONEachRow, counters |
| Sampling | Error/PII retention at 0% success, deterministic success rate, one decision per trace, deadline flush |
| Normalization | Current and legacy attributes, retrieval, event-carried content, content-capture off, bad IDs |
| Evals | Hand-labeled metric agreement, missing retrieval context, guard LLM request/parse, judge fallback, idempotent linked eval spans, zero sample rate |
| PII | SSN validation, Luhn cards, email/phone, redaction |
| Drift | Deterministic embeddings, k-means separation, PSI edge cases, per-app isolation, insufficient data |
| Alerts | Severity routing, skipped-delivery ledger, Prometheus families, Alertmanager v4 create/resolve |
| Regression | End-to-end PII probe under the five-minute bound |
| Storage | Idempotent inserts, filters, trace lookup, top-model aggregates, eval candidates, metadata, alert stats |

## Offline vs real services

**Offline by default**

- The six SDK families are OTLP fixtures modeled on their instrumentation
  dialects, not live SDK calls. This keeps `verify.sh` deterministic and
  credential-free.
- DeepEval/RAGAS are not installed. The local engine implements the same
  concepts (faithfulness, relevance, toxicity, context precision/recall) with
  transparent heuristics, and `LocalEvalEngine` is injected into the runner
  through the `EvalEngine` interface.
- The PII guard is a local regex detector unless `JUDGE_PROVIDER=openai` is set.
- Prompt embeddings are local feature hashes, not sentence-transformers.
  `DriftDetector` accepts any `embedder` callback, so a sentence-transformers
  sidecar can be wired at the service boundary without changing PSI/k-means.
- Storage is SQLite with WAL; raw events go to the local filesystem. The
  ClickHouse exporter is exercised against a mock HTTP endpoint, not a live
  ClickHouse server. Alerts record `skipped` deliveries when no webhook is set.

**Optional real components**

| Component | How to plug it in |
|---|---|
| ClickHouse | Set `CLICKHOUSE_URL=http://host:8123`, `CLICKHOUSE_DATABASE`, and credentials; run `db/clickhouse/schema.sql` first. The exporter writes `INSERT INTO spans FORMAT JSONEachRow`. |
| Postgres metadata | Load `db/postgres/schema.sql` and replace the local metadata tables; the column shapes match. |
| S3 archive | Use `deploy/otel-collector.yaml` (`awss3` exporter) or point `ARCHIVE_DIR` at durable storage; local raw payloads are JSON. |
| Collector-contrib | Run `deploy/otel-collector.yaml` with the contrib image, replacing `${env:...}` values. Its ClickHouse exporter uses its own `otel_traces` schema; the canonical `spans` schema is written by the application exporter. |
| Prometheus / Alertmanager | Scrape `/metrics` with `deploy/prometheus/prometheus.yml`, load `llm-observability-rules.yml`, and route `deploy/alertmanager/alertmanager.yml` to your Slack/PagerDuty endpoints. |
| Guard LLM | Set the four `JUDGE_*` / `OPENAI_*` variables shown above. |
| Real SDKs | Point OpenLLMetry/OpenTelemetry at `OTEL_EXPORTER_OTLP_ENDPOINT=http://host:4318`; see `outputs/skill-llm-observability.md`. |

No GPU path is required or included. The local embedding and eval paths are CPU
only and deterministic.

## Limitations and risks

- **Not production-hardened.** Single-process SQLite, no authentication, no TLS,
  no tenant isolation, no quota enforcement, and unbounded local archive growth
  are deliberate local-demo tradeoffs. Put auth, TLS, retention, and a real
  ClickHouse/Postgres deployment in front before exposing it.
- **Content capture is sensitive.** The default local mode stores prompts and
  completions so evals can run. Use `CAPTURE_CONTENT=0` or a redacting proxy in
  any real deployment; the archive contains raw payloads.
- **Local metrics are heuristics.** Faithfulness/relevance are lexical and can
  disagree with a calibrated judge or DeepEval/RAGAS. The authored fixture is a
  regression check, not an independent quality benchmark.
- **Hash embeddings are not semantic.** Drift detects lexical distribution
  shifts; paraphrase-level drift needs a real embedding model.
- **PII coverage is finite.** SSN, card, email, and phone patterns do not cover
  names, addresses, API keys, or provider-specific formats.
- **Sampling costs accuracy.** Success traces are sampled at 10% by default;
  dashboards that read stored spans see the sampled population, while tail
  sampling keeps errors and PII at 100%.
- **MTTD is local.** The 2.248 s result uses 300 ms eval and alert intervals and
  a mock Slack sink. Production MTTD depends on sampling, eval cadence, rule
  windows, and alert routing. The probe's bound is five minutes, and the test
  fails above that bound.
- **ClickHouse/S3 were not run live.** The schemas and exporters are real and
  the HTTP exporter is integration-tested, but throughput was measured on
  SQLite. Do not cite the load number as ClickHouse capacity.
- **The collector, Prometheus, and Alertmanager configs were not booted as live
  daemons.** Their YAML parses; the exporter and webhook contracts are covered
  by tests. Validate them against your pinned collector/Alertmanager versions
  before production rollout.

## Project layout

```text
app/                    Next.js 15 App Router pages, charts, server actions
config/                 policy thresholds and pricing
db/clickhouse/          canonical MergeTree schema + indexes
db/postgres/            metadata schema
db/sqlite/              local executable schema
deploy/                 collector, Prometheus rules, Alertmanager routes
src/alerts/             rule engine, Prometheus renderer, dispatcher, webhook
src/drift/              hash embeddings, k-means, PSI/KL, per-app runs
src/eval/               metrics, local engine, PII/guard judge, runner
src/ingest/             OTLP HTTP server, collector, tail sampler, archive, ClickHouse
src/otlp/               OTLP types, decoder, semconv normalizer
src/sdk/                six family payload builders used by tests/emit/demo
src/storage/            SQLite connection and store queries
src/cli/                seed, dev, ingress, emit, drift, eval report, demo, load test
tests/                  node:test suites + hand-labeled eval fixture
results/                committed measured artifacts
outputs/                skill-style operator guide
verify.sh               install, typecheck, test, build
```

## References

- [OpenTelemetry GenAI semantic conventions](https://github.com/open-telemetry/semantic-conventions-genai) — canonical span names, `gen_ai.provider.name`, tokens, messages, and response fields used by the normalizer.
- [OpenTelemetry sampling concepts](https://opentelemetry.io/docs/concepts/sampling/) — head vs tail sampling and the error/PII retention rationale.
- [ClickHouse MergeTree documentation](https://clickhouse.com/docs/engines/table-engines/mergetree-family/mergetree) — sorting keys, partitions, skip indexes, and TTL choices in `db/clickhouse/schema.sql`.
- [Minitab: details about the Population Stability Index](https://support.minitab.com/en-us/model-ops/monitor-deployed-models/details-about-the-population-stability-index-psi) — PSI definition and the 0.1/0.2 interpretation used for the drift threshold.
- [Next.js: Server and Client Components](https://nextjs.org/docs/app/getting-started/server-and-client-components) — server-rendered data pages and the client chart boundary.

Source specification: [LLM Observability & Eval Dashboard capstone](https://aiengineeringfromscratch.com/learn/capstone-projects/llm-observability-dashboard).
