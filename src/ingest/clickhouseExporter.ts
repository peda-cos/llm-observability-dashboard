import type { SpanRow } from "../types";

export interface ClickHouseConfig {
  url: string;
  database: string;
  username?: string;
  password?: string;
  fetchImpl?: typeof fetch;
}

function stringOrEmpty(value: string | null): string {
  return value ?? "";
}

function numberOrZero(value: number | null): number {
  return value ?? 0;
}

function rowForClickHouse(row: SpanRow): Record<string, unknown> {
  return {
    span_id: row.spanId,
    trace_id: row.traceId,
    parent_span_id: stringOrEmpty(row.parentSpanId),
    name: row.name,
    kind: row.kind,
    start_time_unix_micros: row.startUs,
    end_time_unix_micros: row.endUs,
    latency_ms: row.latencyMs,
    status_code: row.statusCode,
    status_message: stringOrEmpty(row.statusMessage),
    gen_ai_system: row.genAiSystem,
    gen_ai_request_model: stringOrEmpty(row.requestModel),
    gen_ai_response_model: stringOrEmpty(row.responseModel),
    gen_ai_response_id: stringOrEmpty(row.responseId),
    gen_ai_operation: stringOrEmpty(row.operation),
    input_tokens: row.inputTokens,
    output_tokens: row.outputTokens,
    cost_usd: row.costUsd,
    prompt_hash: stringOrEmpty(row.promptHash),
    app_id: row.appId,
    user_id: stringOrEmpty(row.userId),
    session_id: stringOrEmpty(row.sessionId),
    environment: stringOrEmpty(row.environment),
    instrumentation_family: stringOrEmpty(row.instrumentationFamily),
    prompt_text: stringOrEmpty(row.promptText),
    completion_text: stringOrEmpty(row.completionText),
    retrieval_json: row.retrieval ? JSON.stringify(row.retrieval) : "",
    attributes: row.attributes,
    pii_json: JSON.stringify(row.pii),
    pii_completion: row.piiCompletion ? 1 : 0,
    sampled_reason: row.sampledReason,
    ingested_at_us: row.ingestedAtUs,
    is_eval: row.isEval ? 1 : 0,
    eval_name: stringOrEmpty(row.evalName),
    eval_score: numberOrZero(row.evalScore),
    eval_pass: row.evalPass ? 1 : 0,
    eval_engine: stringOrEmpty(row.evalEngine),
  };
}

export class ClickHouseExporter {
  private readonly config: ClickHouseConfig;

  constructor(config: ClickHouseConfig) {
    this.config = config;
  }

  async insert(spans: SpanRow[]): Promise<void> {
    if (spans.length === 0) return;
    const query = encodeURIComponent("INSERT INTO spans FORMAT JSONEachRow");
    const endpoint = `${this.config.url.replace(/\/$/, "")}/?database=${encodeURIComponent(this.config.database)}&query=${query}`;
    const headers: Record<string, string> = { "content-type": "application/x-ndjson" };
    if (this.config.username) {
      headers.authorization = `Basic ${Buffer.from(`${this.config.username}:${this.config.password ?? ""}`).toString("base64")}`;
    }
    const body = `${spans.map((span) => JSON.stringify(rowForClickHouse(span))).join("\n")}\n`;
    const fetchImpl = this.config.fetchImpl ?? fetch;
    const response = await fetchImpl(endpoint, { method: "POST", headers, body });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`ClickHouse insert failed (${response.status}): ${text.slice(0, 300)}`);
    }
  }
}
