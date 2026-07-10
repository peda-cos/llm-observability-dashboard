import { DatabaseSync, type StatementSync } from "node:sqlite";
import { sampleTrace } from "../ids";
import type {
  AlertDeliveryRow,
  AlertRow,
  AppAlertStats,
  CostByUserRow,
  DriftRunRow,
  EvalRunRow,
  EvalTrendPoint,
  JsonValue,
  OverviewStats,
  PiiFinding,
  RetrievalDoc,
  SpanRow,
  SpanSearchFilter,
  TimeSeriesPoint,
  TriageRow,
} from "../types";

const SPAN_COLUMNS = [
  "span_id",
  "trace_id",
  "parent_span_id",
  "name",
  "kind",
  "start_us",
  "end_us",
  "latency_ms",
  "status_code",
  "status_message",
  "gen_ai_system",
  "gen_ai_request_model",
  "gen_ai_response_model",
  "gen_ai_response_id",
  "gen_ai_operation",
  "input_tokens",
  "output_tokens",
  "cost_usd",
  "prompt_hash",
  "app_id",
  "user_id",
  "session_id",
  "environment",
  "instrumentation_family",
  "prompt_text",
  "completion_text",
  "retrieval_json",
  "attributes_json",
  "pii_json",
  "pii_completion",
  "sampled_reason",
  "ingested_at_us",
  "is_eval",
  "eval_name",
  "eval_score",
  "eval_pass",
  "eval_engine",
] as const;

type RawRow = Record<string, unknown>;

function asNumber(value: unknown, fallback = 0): number {
  const number = typeof value === "bigint" ? Number(value) : Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function asNullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || value.length === 0) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function percentile95(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * 0.95))];
}

function mapSpan(row: RawRow): SpanRow {
  return {
    spanId: String(row.span_id),
    traceId: String(row.trace_id),
    parentSpanId: asNullableString(row.parent_span_id),
    name: String(row.name),
    kind: String(row.kind),
    startUs: asNumber(row.start_us),
    endUs: asNumber(row.end_us),
    latencyMs: asNumber(row.latency_ms),
    statusCode: (asNumber(row.status_code) as 0 | 1 | 2) ?? 0,
    statusMessage: asNullableString(row.status_message),
    genAiSystem: String(row.gen_ai_system ?? "unknown"),
    requestModel: asNullableString(row.gen_ai_request_model),
    responseModel: asNullableString(row.gen_ai_response_model),
    responseId: asNullableString(row.gen_ai_response_id),
    operation: asNullableString(row.gen_ai_operation),
    inputTokens: asNumber(row.input_tokens),
    outputTokens: asNumber(row.output_tokens),
    costUsd: asNumber(row.cost_usd),
    promptHash: asNullableString(row.prompt_hash),
    appId: String(row.app_id ?? "unknown"),
    userId: asNullableString(row.user_id),
    sessionId: asNullableString(row.session_id),
    environment: asNullableString(row.environment),
    instrumentationFamily: asNullableString(row.instrumentation_family),
    promptText: asNullableString(row.prompt_text),
    completionText: asNullableString(row.completion_text),
    retrieval: parseJson<RetrievalDoc[] | null>(
      row.retrieval_json,
      null as RetrievalDoc[] | null,
    ),
    attributes: parseJson<Record<string, JsonValue>>(row.attributes_json, {}),
    pii: parseJson<PiiFinding[]>(row.pii_json, []),
    piiCompletion: asNumber(row.pii_completion) === 1,
    sampledReason: String(row.sampled_reason ?? ""),
    ingestedAtUs: asNumber(row.ingested_at_us),
    isEval: asNumber(row.is_eval) === 1,
    evalName: asNullableString(row.eval_name),
    evalScore: row.eval_score === null || row.eval_score === undefined ? null : asNumber(row.eval_score),
    evalPass:
      row.eval_pass === null || row.eval_pass === undefined ? null : asNumber(row.eval_pass) === 1,
    evalEngine: asNullableString(row.eval_engine),
  };
}

function mapDrift(row: RawRow): DriftRunRow {
  return {
    id: String(row.id),
    computedUs: asNumber(row.computed_us),
    appId: String(row.app_id),
    windowStartUs: asNumber(row.window_start_us),
    windowEndUs: asNumber(row.window_end_us),
    psi: asNumber(row.psi),
    kl: asNumber(row.kl),
    nCurrent: asNumber(row.n_current),
    nBaseline: asNumber(row.n_baseline),
    threshold: asNumber(row.threshold),
    alert: asNumber(row.alert) === 1,
    status: String(row.status),
    detailJson: String(row.detail_json ?? "{}"),
  };
}

function mapAlert(row: RawRow): AlertRow {
  return {
    id: String(row.id),
    fingerprint: String(row.fingerprint),
    rule: String(row.rule),
    severity: String(row.severity) === "critical" ? "critical" : "warning",
    appId: String(row.app_id),
    summary: String(row.summary),
    description: String(row.description),
    status: String(row.status) === "acked" ? "acked" : "open",
    occurrences: asNumber(row.occurrences, 1),
    createdUs: asNumber(row.created_us),
    updatedUs: asNumber(row.updated_us),
    payloadJson: String(row.payload_json ?? "{}"),
  };
}

function mapTriage(row: RawRow): TriageRow {
  return {
    id: String(row.id),
    spanId: String(row.span_id),
    traceId: String(row.trace_id),
    score: asNumber(row.score),
    reason: String(row.reason),
    excerpt: String(row.excerpt),
    status: String(row.status) === "resolved" ? "resolved" : "open",
    createdUs: asNumber(row.created_us),
    resolvedUs:
      row.resolved_us === null || row.resolved_us === undefined ? null : asNumber(row.resolved_us),
  };
}

interface EvalAccumulator {
  sum: number;
  n: number;
  pass: number;
}

interface StatsAccumulator {
  appId: string;
  latencies: number[];
  spans: number;
  errors: number;
  piiEvalCount: number;
  piiEvalTotal: number;
  evals: Map<string, EvalAccumulator>;
  driftPsi: number | null;
  openAlerts: number;
  costUsd: number;
}

export interface InsertAlertResult {
  created: boolean;
  alert: AlertRow;
}

export class SQLiteStore {
  private readonly db: DatabaseSync;
  private readonly insertSpanStmt: StatementSync;
  private readonly evalSalt: string;

  constructor(db: DatabaseSync, options: { evalSalt?: string } = {}) {
    this.db = db;
    this.evalSalt = options.evalSalt ?? "eval";
    this.insertSpanStmt = this.db.prepare(
      `INSERT OR REPLACE INTO spans (${SPAN_COLUMNS.join(", ")}) VALUES (${SPAN_COLUMNS.map(() => "?").join(", ")})`,
    );
  }

  close(): void {
    this.db.close();
  }

  insertSpans(rows: SpanRow[]): void {
    if (rows.length === 0) return;
    this.db.exec("BEGIN");
    try {
      for (const row of rows) {
        this.insertSpanStmt.run(
          row.spanId,
          row.traceId,
          row.parentSpanId,
          row.name,
          row.kind,
          row.startUs,
          row.endUs,
          row.latencyMs,
          row.statusCode,
          row.statusMessage,
          row.genAiSystem,
          row.requestModel,
          row.responseModel,
          row.responseId,
          row.operation,
          row.inputTokens,
          row.outputTokens,
          row.costUsd,
          row.promptHash,
          row.appId,
          row.userId,
          row.sessionId,
          row.environment,
          row.instrumentationFamily,
          row.promptText,
          row.completionText,
          row.retrieval ? JSON.stringify(row.retrieval) : null,
          JSON.stringify(row.attributes),
          JSON.stringify(row.pii),
          row.piiCompletion ? 1 : 0,
          row.sampledReason,
          row.ingestedAtUs,
          row.isEval ? 1 : 0,
          row.evalName,
          row.evalScore,
          row.evalPass === null ? null : row.evalPass ? 1 : 0,
          row.evalEngine,
        );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  countSpans(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM spans").get() as RawRow;
    return asNumber(row.n);
  }

  countEvalSpans(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM spans WHERE is_eval = 1").get() as RawRow;
    return asNumber(row.n);
  }

  overview(nowUs: number, windowUs = 86_400_000_000): OverviewStats {
    const since = nowUs - windowUs;
    const aggregate = this.db
      .prepare(
        `SELECT COUNT(*) AS spans,
                COALESCE(SUM(cost_usd), 0) AS cost_usd,
                COALESCE(SUM(CASE WHEN status_code = 2 THEN 1 ELSE 0 END), 0) AS errors
         FROM spans WHERE is_eval = 0 AND start_us >= ?`,
      )
      .get(since) as RawRow;
    const spans = asNumber(aggregate.spans);
    const errors = asNumber(aggregate.errors);
    const lastMinute = this.db
      .prepare("SELECT COUNT(*) AS n FROM spans WHERE is_eval = 0 AND start_us >= ?")
      .get(nowUs - 60_000_000) as RawRow;
    const pii = this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM spans WHERE is_eval = 1 AND eval_name = 'pii_leak' AND eval_pass = 0 AND start_us >= ?",
      )
      .get(since) as RawRow;
    const open = this.db
      .prepare("SELECT COUNT(*) AS n FROM alerts WHERE status = 'open'")
      .get() as RawRow;
    const p95 = this.p95Latency(since);
    return {
      spans,
      spansPerSec: asNumber(lastMinute.n) / 60,
      costUsd: asNumber(aggregate.cost_usd),
      p95LatencyMs: p95,
      errorRate: spans > 0 ? errors / spans : 0,
      piiPositives: asNumber(pii.n),
      openAlerts: asNumber(open.n),
    };
  }

  private p95Latency(sinceUs: number): number {
    const countRow = this.db
      .prepare("SELECT COUNT(*) AS n FROM spans WHERE is_eval = 0 AND start_us >= ?")
      .get(sinceUs) as RawRow;
    const count = asNumber(countRow.n);
    if (count === 0) return 0;
    const offset = Math.min(count - 1, Math.floor((count - 1) * 0.95));
    const row = this.db
      .prepare(
        "SELECT latency_ms FROM spans WHERE is_eval = 0 AND start_us >= ? ORDER BY latency_ms ASC LIMIT 1 OFFSET ?",
      )
      .get(sinceUs, offset) as RawRow | undefined;
    return row ? asNumber(row.latency_ms) : 0;
  }

  timeseries(nowUs: number, windowUs = 86_400_000_000, bucketUs = 300_000_000): TimeSeriesPoint[] {
    const since = nowUs - windowUs;
    const firstBucket = Math.floor(since / bucketUs) * bucketUs;
    const buckets = new Map<number, { spans: number; errors: number; costUsd: number; latencies: number[] }>();
    for (let bucket = firstBucket; bucket <= nowUs; bucket += bucketUs) {
      buckets.set(bucket, { spans: 0, errors: 0, costUsd: 0, latencies: [] });
    }
    const rows = this.db
      .prepare(
        "SELECT start_us, latency_ms, status_code, cost_usd FROM spans WHERE is_eval = 0 AND start_us >= ? AND start_us < ?",
      )
      .all(since, nowUs) as RawRow[];
    for (const row of rows) {
      const bucket = Math.floor(asNumber(row.start_us) / bucketUs) * bucketUs;
      const entry = buckets.get(bucket);
      if (!entry) continue;
      entry.spans += 1;
      entry.costUsd += asNumber(row.cost_usd);
      entry.latencies.push(asNumber(row.latency_ms));
      if (asNumber(row.status_code) === 2) entry.errors += 1;
    }
    return [...buckets.entries()]
      .sort(([a], [b]) => a - b)
      .map(([bucketUs, entry]) => ({
        bucketUs,
        spans: entry.spans,
        errors: entry.errors,
        costUsd: Math.round(entry.costUsd * 1e8) / 1e8,
        p95LatencyMs: percentile95(entry.latencies),
      }));
  }

  costByUser(nowUs: number, windowUs = 86_400_000_000, limit = 8): CostByUserRow[] {
    const rows = this.db
      .prepare(
        `SELECT COALESCE(user_id, 'anonymous') AS user_id,
                SUM(cost_usd) AS cost_usd,
                COUNT(*) AS spans,
                SUM(CASE WHEN status_code = 2 THEN 1 ELSE 0 END) AS errors
         FROM spans
         WHERE is_eval = 0 AND start_us >= ?
         GROUP BY COALESCE(user_id, 'anonymous')
         ORDER BY cost_usd DESC, user_id ASC
         LIMIT ?`,
      )
      .all(nowUs - windowUs, Math.max(1, Math.min(100, limit))) as RawRow[];
    return rows.map((row) => {
      const spans = asNumber(row.spans);
      return {
        userId: String(row.user_id),
        costUsd: asNumber(row.cost_usd),
        spans,
        failureRate: spans > 0 ? asNumber(row.errors) / spans : 0,
      };
    });
  }

  search(filter: SpanSearchFilter = {}): { rows: SpanRow[]; total: number } {
    const where: string[] = ["is_eval = 0"];
    const params: (string | number)[] = [];
    if (filter.appId) {
      where.push("app_id = ?");
      params.push(filter.appId);
    }
    if (filter.userId) {
      where.push("user_id = ?");
      params.push(filter.userId);
    }
    if (filter.model) {
      where.push("gen_ai_request_model = ?");
      params.push(filter.model);
    }
    if (filter.status) {
      const code = filter.status === "ok" ? 1 : filter.status === "error" ? 2 : 0;
      where.push("status_code = ?");
      params.push(code);
    }
    if (filter.piiOnly) where.push("pii_json <> '[]'");
    if (filter.q) {
      where.push("(prompt_text LIKE ? OR completion_text LIKE ? OR trace_id LIKE ?)");
      const like = `%${filter.q}%`;
      params.push(like, like, like);
    }
    if (filter.sinceUs !== undefined) {
      where.push("start_us >= ?");
      params.push(filter.sinceUs);
    }
    if (filter.untilUs !== undefined) {
      where.push("start_us < ?");
      params.push(filter.untilUs);
    }
    const limit = Math.max(1, Math.min(200, filter.limit ?? 50));
    const offset = Math.max(0, filter.offset ?? 0);
    const totalRow = this.db
      .prepare(`SELECT COUNT(*) AS n FROM spans WHERE ${where.join(" AND ")}`)
      .get(...params) as RawRow;
    const rows = this.db
      .prepare(
        `SELECT * FROM spans WHERE ${where.join(" AND ")} ORDER BY start_us DESC, span_id ASC LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as RawRow[];
    return { rows: rows.map(mapSpan), total: asNumber(totalRow.n) };
  }

  getTrace(traceId: string): SpanRow[] {
    const rows = this.db
      .prepare("SELECT * FROM spans WHERE trace_id = ? ORDER BY start_us ASC, span_id ASC")
      .all(traceId) as RawRow[];
    return rows.map(mapSpan);
  }

  evalTrend(nowUs: number, windowUs = 86_400_000_000, bucketUs = 900_000_000): EvalTrendPoint[] {
    const since = nowUs - windowUs;
    const rows = this.db
      .prepare(
        "SELECT start_us, eval_name, eval_score, eval_pass FROM spans WHERE is_eval = 1 AND start_us >= ? AND start_us < ? ORDER BY start_us ASC",
      )
      .all(since, nowUs) as RawRow[];
    const buckets = new Map<string, { bucketUs: number; metric: string; sum: number; n: number; pass: number }>();
    for (const row of rows) {
      const metric = asNullableString(row.eval_name);
      if (!metric) continue;
      const bucket = Math.floor(asNumber(row.start_us) / bucketUs) * bucketUs;
      const key = `${bucket}:${metric}`;
      const entry = buckets.get(key) ?? { bucketUs: bucket, metric, sum: 0, n: 0, pass: 0 };
      entry.sum += asNumber(row.eval_score);
      entry.n += 1;
      if (asNumber(row.eval_pass) === 1) entry.pass += 1;
      buckets.set(key, entry);
    }
    return [...buckets.values()]
      .sort((a, b) => a.bucketUs - b.bucketUs || a.metric.localeCompare(b.metric))
      .map((entry) => ({
        bucketUs: entry.bucketUs,
        metric: entry.metric,
        avgScore: entry.n > 0 ? entry.sum / entry.n : 0,
        passRate: entry.n > 0 ? entry.pass / entry.n : 0,
        n: entry.n,
      }));
  }

  recentEvals(limit = 20): SpanRow[] {
    const rows = this.db
      .prepare("SELECT * FROM spans WHERE is_eval = 1 ORDER BY start_us DESC, span_id ASC LIMIT ?")
      .all(Math.max(1, Math.min(200, limit))) as RawRow[];
    return rows.map(mapSpan);
  }

  evalCandidates(
    nowUs: number,
    windowUs: number,
    sampleRate: number,
    limit: number,
  ): SpanRow[] {
    return this.evalCandidatesBetween(nowUs - windowUs, nowUs, sampleRate, limit);
  }

  evalCandidatesBetween(
    fromUs: number,
    toUs: number,
    sampleRate: number,
    limit: number,
  ): SpanRow[] {
    if (sampleRate <= 0 || limit <= 0) return [];
    const rows = this.db
      .prepare(
        `SELECT s.* FROM spans s
         WHERE s.is_eval = 0
           AND s.completion_text IS NOT NULL
           AND length(s.completion_text) > 0
           AND s.start_us >= ? AND s.start_us < ?
           AND NOT EXISTS (
             SELECT 1 FROM spans e WHERE e.is_eval = 1 AND e.parent_span_id = s.span_id
           )
         ORDER BY s.start_us ASC, s.span_id ASC
         LIMIT ?`,
      )
      .all(fromUs, toUs, Math.max(limit * 4, limit)) as RawRow[];
    return rows
      .map(mapSpan)
      .filter((row) => sampleTrace(row.traceId, this.evalSalt, sampleRate))
      .slice(0, limit);
  }

  insertEvalRun(run: EvalRunRow): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO eval_runs
         (id, started_us, finished_us, window_start_us, window_end_us, sampled, evaluated, engine)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        run.id,
        run.startedUs,
        run.finishedUs,
        run.windowStartUs,
        run.windowEndUs,
        run.sampled,
        run.evaluated,
        run.engine,
      );
  }

  alertStats(nowUs: number): AppAlertStats[] {
    const fiveMinutesAgo = nowUs - 300_000_000;
    const fifteenMinutesAgo = nowUs - 900_000_000;
    const accumulators = new Map<string, StatsAccumulator>();
    const ensure = (appId: string): StatsAccumulator => {
      let accumulator = accumulators.get(appId);
      if (!accumulator) {
        accumulator = {
          appId,
          latencies: [],
          spans: 0,
          errors: 0,
          piiEvalCount: 0,
          piiEvalTotal: 0,
          evals: new Map(),
          driftPsi: null,
          openAlerts: 0,
          costUsd: 0,
        };
        accumulators.set(appId, accumulator);
      }
      return accumulator;
    };

    const spanRows = this.db
      .prepare(
        "SELECT app_id, status_code, latency_ms, cost_usd FROM spans WHERE is_eval = 0 AND start_us >= ? AND start_us <= ?",
      )
      .all(fiveMinutesAgo, nowUs) as RawRow[];
    for (const row of spanRows) {
      const appId = String(row.app_id ?? "unknown");
      const latency = asNumber(row.latency_ms);
      const error = asNumber(row.status_code) === 2 ? 1 : 0;
      for (const target of [appId, "__all__"]) {
        const accumulator = ensure(target);
        accumulator.spans += 1;
        accumulator.errors += error;
        accumulator.latencies.push(latency);
        accumulator.costUsd += asNumber(row.cost_usd);
      }
    }

    const evalRows = this.db
      .prepare(
        "SELECT app_id, eval_name, eval_score, eval_pass, start_us FROM spans WHERE is_eval = 1 AND start_us >= ? AND start_us <= ?",
      )
      .all(fifteenMinutesAgo, nowUs) as RawRow[];
    for (const row of evalRows) {
      const appId = String(row.app_id ?? "unknown");
      const metric = asNullableString(row.eval_name);
      if (!metric) continue;
      const isRecentPii = metric === "pii_leak" && asNumber(row.start_us) >= fiveMinutesAgo;
      for (const target of [appId, "__all__"]) {
        const accumulator = ensure(target);
        const entry = accumulator.evals.get(metric) ?? { sum: 0, n: 0, pass: 0 };
        entry.sum += asNumber(row.eval_score);
        entry.n += 1;
        if (asNumber(row.eval_pass) === 1) entry.pass += 1;
        accumulator.evals.set(metric, entry);
        if (isRecentPii) {
          accumulator.piiEvalTotal += 1;
          if (asNumber(row.eval_pass) === 0) accumulator.piiEvalCount += 1;
        }
      }
    }

    const driftRows = this.db
      .prepare(
        "SELECT app_id, psi, window_end_us FROM drift_runs WHERE window_end_us >= ? AND window_end_us <= ? ORDER BY window_end_us ASC",
      )
      .all(nowUs - 7 * 86_400_000_000, nowUs) as RawRow[];
    const latestDrift = new Map<string, number>();
    for (const row of driftRows) {
      const appId = String(row.app_id);
      if (appId !== "__all__") latestDrift.set(appId, asNumber(row.psi));
    }
    let maxDrift = 0;
    for (const [appId, psi] of latestDrift.entries()) {
      ensure(appId).driftPsi = psi;
      maxDrift = Math.max(maxDrift, psi);
    }
    ensure("__all__").driftPsi = latestDrift.size > 0 ? maxDrift : null;

    const groupedAlerts = this.db
      .prepare("SELECT app_id, COUNT(*) AS n FROM alerts WHERE status = 'open' GROUP BY app_id")
      .all() as RawRow[];
    let totalAlerts = 0;
    for (const row of groupedAlerts) {
      const count = asNumber(row.n);
      totalAlerts += count;
      ensure(String(row.app_id)).openAlerts = count;
    }
    ensure("__all__").openAlerts = totalAlerts;

    return [...accumulators.values()]
      .map((accumulator) => {
        const evalAvg: Record<string, number> = {};
        const evalN: Record<string, number> = {};
        const evalPassRate: Record<string, number> = {};
        for (const [metric, entry] of accumulator.evals.entries()) {
          evalAvg[metric] = entry.n > 0 ? entry.sum / entry.n : 0;
          evalN[metric] = entry.n;
          evalPassRate[metric] = entry.n > 0 ? entry.pass / entry.n : 0;
        }
        return {
          appId: accumulator.appId,
          spans: accumulator.spans,
          errors: accumulator.errors,
          errorRate: accumulator.spans > 0 ? accumulator.errors / accumulator.spans : 0,
          latencyP95Ms: percentile95(accumulator.latencies),
          piiEvalCount: accumulator.piiEvalCount,
          piiEvalTotal: accumulator.piiEvalTotal,
          piiEvalRate:
            accumulator.piiEvalTotal > 0 ? accumulator.piiEvalCount / accumulator.piiEvalTotal : 0,
          evalAvg,
          evalN,
          evalPassRate,
          driftPsi: accumulator.driftPsi,
          openAlerts: accumulator.openAlerts,
          costUsd: accumulator.costUsd,
        };
      })
      .sort((a, b) => (a.appId === "__all__" ? -1 : b.appId === "__all__" ? 1 : a.appId.localeCompare(b.appId)));
  }

  promptSamples(
    fromUs: number,
    toUs: number,
    appId?: string,
  ): { appId: string; text: string; startUs: number }[] {
    const params: (string | number)[] = [fromUs, toUs];
    let sql =
      "SELECT app_id, prompt_text, start_us FROM spans WHERE is_eval = 0 AND prompt_text IS NOT NULL AND length(prompt_text) > 0 AND start_us >= ? AND start_us < ?";
    if (appId) {
      sql += " AND app_id = ?";
      params.push(appId);
    }
    sql += " ORDER BY start_us ASC LIMIT 5000";
    const rows = this.db.prepare(sql).all(...params) as RawRow[];
    return rows.map((row) => ({
      appId: String(row.app_id ?? "unknown"),
      text: String(row.prompt_text),
      startUs: asNumber(row.start_us),
    }));
  }

  insertDriftRun(run: DriftRunRow): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO drift_runs
         (id, computed_us, app_id, window_start_us, window_end_us, psi, kl, n_current, n_baseline, threshold, alert, status, detail_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        run.id,
        run.computedUs,
        run.appId,
        run.windowStartUs,
        run.windowEndUs,
        run.psi,
        run.kl,
        run.nCurrent,
        run.nBaseline,
        run.threshold,
        run.alert ? 1 : 0,
        run.status,
        run.detailJson,
      );
  }

  latestDriftRuns(limit = 50, appId?: string): DriftRunRow[] {
    const params: (string | number)[] = [];
    let sql = "SELECT * FROM drift_runs";
    if (appId) {
      sql += " WHERE app_id = ?";
      params.push(appId);
    }
    sql += " ORDER BY window_end_us DESC, computed_us DESC LIMIT ?";
    params.push(Math.max(1, Math.min(500, limit)));
    const rows = this.db.prepare(sql).all(...params) as RawRow[];
    return rows.map(mapDrift);
  }

  latestDriftByApp(): DriftRunRow[] {
    const rows = this.latestDriftRuns(300);
    const seen = new Set<string>();
    const result: DriftRunRow[] = [];
    for (const row of rows) {
      if (seen.has(row.appId)) continue;
      seen.add(row.appId);
      result.push(row);
    }
    return result;
  }

  driftTrend(nowUs: number, days = 35): DriftRunRow[] {
    const rows = this.db
      .prepare("SELECT * FROM drift_runs WHERE computed_us >= ? ORDER BY window_end_us ASC")
      .all(nowUs - days * 86_400_000_000) as RawRow[];
    return rows.map(mapDrift);
  }

  insertAlert(alert: AlertRow): InsertAlertResult {
    const existing = this.db
      .prepare("SELECT occurrences FROM alerts WHERE fingerprint = ?")
      .get(alert.fingerprint) as RawRow | undefined;
    if (existing) {
      const occurrences = asNumber(existing.occurrences, 1) + 1;
      this.db
        .prepare(
          "UPDATE alerts SET updated_us = ?, occurrences = ?, payload_json = ?, description = ? WHERE fingerprint = ?",
        )
        .run(alert.updatedUs, occurrences, alert.payloadJson, alert.description, alert.fingerprint);
      return { created: false, alert: { ...alert, occurrences } };
    }
    this.db
      .prepare(
        `INSERT INTO alerts
         (id, fingerprint, rule, severity, app_id, summary, description, status, occurrences, created_us, updated_us, payload_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        alert.id,
        alert.fingerprint,
        alert.rule,
        alert.severity,
        alert.appId,
        alert.summary,
        alert.description,
        alert.status,
        alert.occurrences,
        alert.createdUs,
        alert.updatedUs,
        alert.payloadJson,
      );
    return { created: true, alert };
  }

  listAlerts(limit = 100): AlertRow[] {
    const rows = this.db
      .prepare("SELECT * FROM alerts ORDER BY created_us DESC, id ASC LIMIT ?")
      .all(Math.max(1, Math.min(500, limit))) as RawRow[];
    return rows.map(mapAlert);
  }

  getAlert(id: string): AlertRow | null {
    const row = this.db.prepare("SELECT * FROM alerts WHERE id = ?").get(id) as RawRow | undefined;
    return row ? mapAlert(row) : null;
  }

  ackAlert(id: string, nowUs: number): boolean {
    const result = this.db
      .prepare("UPDATE alerts SET status = 'acked', updated_us = ? WHERE id = ? AND status = 'open'")
      .run(nowUs, id);
    return Number(result.changes) > 0;
  }

  ackAlertByFingerprint(fingerprint: string, nowUs: number): boolean {
    const result = this.db
      .prepare(
        "UPDATE alerts SET status = 'acked', updated_us = ? WHERE fingerprint = ? AND status = 'open'",
      )
      .run(nowUs, fingerprint);
    return Number(result.changes) > 0;
  }

  insertDelivery(row: AlertDeliveryRow): void {
    this.db
      .prepare(
        "INSERT OR REPLACE INTO alert_deliveries (alert_id, sink, status, detail, attempted_us) VALUES (?, ?, ?, ?, ?)",
      )
      .run(row.alertId, row.sink, row.status, row.detail, row.attemptedUs);
  }

  getDeliveries(alertId: string): AlertDeliveryRow[] {
    const rows = this.db
      .prepare("SELECT * FROM alert_deliveries WHERE alert_id = ? ORDER BY sink ASC")
      .all(alertId) as RawRow[];
    return rows.map((row) => ({
      alertId: String(row.alert_id),
      sink: String(row.sink),
      status: String(row.status),
      detail: asNullableString(row.detail),
      attemptedUs: asNumber(row.attempted_us),
    }));
  }

  insertTriage(row: TriageRow): boolean {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO triage_queue
         (id, span_id, trace_id, score, reason, excerpt, status, created_us, resolved_us)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.spanId,
        row.traceId,
        row.score,
        row.reason,
        row.excerpt,
        row.status,
        row.createdUs,
        row.resolvedUs,
      );
    return Number(result.changes) > 0;
  }

  triage(status: "open" | "resolved" = "open", limit = 100): TriageRow[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM triage_queue WHERE status = ? ORDER BY created_us DESC, id ASC LIMIT ?",
      )
      .all(status, Math.max(1, Math.min(500, limit))) as RawRow[];
    return rows.map(mapTriage);
  }

  resolveTriage(id: string, nowUs: number): boolean {
    const result = this.db
      .prepare(
        "UPDATE triage_queue SET status = 'resolved', resolved_us = ? WHERE id = ? AND status = 'open'",
      )
      .run(nowUs, id);
    return Number(result.changes) > 0;
  }

  upsertApps(rows: { id: string; name: string; team: string | null; createdUs: number }[]): void {
    const statement = this.db.prepare(
      "INSERT OR REPLACE INTO apps (id, name, team, created_us) VALUES (?, ?, ?, ?)",
    );
    for (const row of rows) statement.run(row.id, row.name, row.team, row.createdUs);
  }

  upsertUsers(rows: { id: string; displayName: string; tier: string; createdUs: number }[]): void {
    const statement = this.db.prepare(
      "INSERT OR REPLACE INTO users (id, display_name, tier, created_us) VALUES (?, ?, ?, ?)",
    );
    for (const row of rows) statement.run(row.id, row.displayName, row.tier, row.createdUs);
  }

  insertSessions(rows: { id: string; userId: string; appId: string; startedUs: number }[]): void {
    const statement = this.db.prepare(
      "INSERT OR REPLACE INTO sessions (id, user_id, app_id, started_us) VALUES (?, ?, ?, ?)",
    );
    for (const row of rows) statement.run(row.id, row.userId, row.appId, row.startedUs);
  }

  getMeta(): {
    apps: { id: string; name: string; team: string | null }[];
    users: { id: string; displayName: string; tier: string }[];
  } {
    const apps = this.db.prepare("SELECT * FROM apps ORDER BY id ASC").all() as RawRow[];
    const users = this.db.prepare("SELECT * FROM users ORDER BY id ASC").all() as RawRow[];
    return {
      apps: apps.map((row) => ({
        id: String(row.id),
        name: String(row.name),
        team: asNullableString(row.team),
      })),
      users: users.map((row) => ({
        id: String(row.id),
        displayName: String(row.display_name),
        tier: String(row.tier),
      })),
    };
  }
}
