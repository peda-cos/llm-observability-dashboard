export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type PiiType = "ssn" | "credit_card" | "email" | "phone";

export interface PiiFinding {
  type: PiiType;
  confidence: number;
  field: "prompt" | "completion";
}

export interface RetrievalDoc {
  id: string;
  text: string;
  score?: number;
}

export interface SpanRecord {
  spanId: string;
  traceId: string;
  parentSpanId: string | null;
  name: string;
  kind: string;
  startNs: bigint;
  endNs: bigint;
  startUs: number;
  endUs: number;
  latencyMs: number;
  statusCode: 0 | 1 | 2;
  statusMessage: string | null;
  genAiSystem: string;
  requestModel: string | null;
  responseModel: string | null;
  responseId: string | null;
  operation: string | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  promptHash: string | null;
  appId: string;
  userId: string | null;
  sessionId: string | null;
  environment: string | null;
  instrumentationFamily: string | null;
  promptText: string | null;
  completionText: string | null;
  retrieval: RetrievalDoc[] | null;
  attributes: Record<string, JsonValue>;
  pii: PiiFinding[];
  piiCompletion: boolean;
  sampledReason: string;
  ingestedAtUs: number;
  isEval: boolean;
  evalName: string | null;
  evalScore: number | null;
  evalPass: boolean | null;
  evalEngine: string | null;
}

/** Serializable span shape: no BigInt ever reaches SQLite, React, or JSON responses. */
export type SpanRow = Omit<SpanRecord, "startNs" | "endNs">;

export interface OverviewStats {
  spans: number;
  spansPerSec: number;
  costUsd: number;
  p95LatencyMs: number;
  errorRate: number;
  piiPositives: number;
  openAlerts: number;
}

export interface TimeSeriesPoint {
  bucketUs: number;
  spans: number;
  errors: number;
  costUsd: number;
  p95LatencyMs: number;
}

export interface CostByUserRow {
  userId: string;
  costUsd: number;
  spans: number;
  failureRate: number;
}

export interface SpanSearchFilter {
  appId?: string;
  userId?: string;
  model?: string;
  status?: "ok" | "error" | "unset";
  piiOnly?: boolean;
  q?: string;
  sinceUs?: number;
  untilUs?: number;
  limit?: number;
  offset?: number;
}

export interface EvalTrendPoint {
  bucketUs: number;
  metric: string;
  avgScore: number;
  passRate: number;
  n: number;
}

export interface AppAlertStats {
  appId: string;
  spans: number;
  errors: number;
  errorRate: number;
  latencyP95Ms: number;
  piiEvalCount: number;
  piiEvalTotal: number;
  piiEvalRate: number;
  evalAvg: Record<string, number>;
  evalN: Record<string, number>;
  evalPassRate: Record<string, number>;
  driftPsi: number | null;
  openAlerts: number;
}

export interface DriftRunRow {
  id: string;
  computedUs: number;
  appId: string;
  windowStartUs: number;
  windowEndUs: number;
  psi: number;
  kl: number;
  nCurrent: number;
  nBaseline: number;
  threshold: number;
  alert: boolean;
  status: string;
  detailJson: string;
}

export interface AlertRow {
  id: string;
  fingerprint: string;
  rule: string;
  severity: "warning" | "critical";
  appId: string;
  summary: string;
  description: string;
  status: "open" | "acked";
  occurrences: number;
  createdUs: number;
  updatedUs: number;
  payloadJson: string;
}

export interface TriageRow {
  id: string;
  spanId: string;
  traceId: string;
  score: number;
  reason: string;
  excerpt: string;
  status: "open" | "resolved";
  createdUs: number;
  resolvedUs: number | null;
}

export interface EvalRunRow {
  id: string;
  startedUs: number;
  finishedUs: number;
  windowStartUs: number;
  windowEndUs: number;
  sampled: number;
  evaluated: number;
  engine: string;
}

export interface AlertDeliveryRow {
  alertId: string;
  sink: string;
  status: string;
  detail: string | null;
  attemptedUs: number;
}
