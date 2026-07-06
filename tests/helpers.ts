import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { openDb } from "../src/storage/db";
import type { SpanRow } from "../src/types";
import { newSpanId, newTraceId, promptHash } from "../src/ids";

export function createClock(startUs = 1_760_000_000_000_000) {
  let current = startUs;
  return {
    nowUs: () => current,
    advance: (deltaUs: number) => {
      current += deltaUs;
    },
    set: (value: number) => {
      current = value;
    },
  };
}

export function tempDb(prefix = "llm-obs-test-"): { db: DatabaseSync; dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  const db = openDb(path.join(dir, "obs.db"));
  return {
    db,
    dir,
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function makeSpan(overrides: Partial<SpanRow> = {}): SpanRow {
  const now = overrides.startUs ?? 1_760_000_000_000_000;
  const startUs = overrides.startUs ?? now;
  const endUs = overrides.endUs ?? startUs + 120_000;
  const spanId = overrides.spanId ?? newSpanId();
  return {
    spanId,
    traceId: overrides.traceId ?? newTraceId(),
    parentSpanId: overrides.parentSpanId ?? null,
    name: overrides.name ?? "chat gpt-4o-mini",
    kind: overrides.kind ?? "client",
    startUs,
    endUs,
    latencyMs: overrides.latencyMs ?? (endUs - startUs) / 1000,
    statusCode: overrides.statusCode ?? 0,
    statusMessage: overrides.statusMessage ?? null,
    genAiSystem: overrides.genAiSystem ?? "openai",
    requestModel: overrides.requestModel ?? "gpt-4o-mini",
    responseModel: overrides.responseModel ?? overrides.requestModel ?? "gpt-4o-mini",
    responseId: overrides.responseId ?? "chatcmpl-test",
    operation: overrides.operation ?? "chat",
    inputTokens: overrides.inputTokens ?? 100,
    outputTokens: overrides.outputTokens ?? 50,
    costUsd: overrides.costUsd ?? 0.000045,
    promptHash: overrides.promptHash ?? promptHash("How do I reset my password?"),
    appId: overrides.appId ?? "support-bot",
    userId: overrides.userId ?? "u_001",
    sessionId: overrides.sessionId ?? "s_001",
    environment: overrides.environment ?? "local",
    instrumentationFamily: overrides.instrumentationFamily ?? "openai",
    promptText: overrides.promptText ?? "How do I reset my password?",
    completionText: overrides.completionText ?? "Use the reset link on the sign-in page.",
    retrieval: overrides.retrieval ?? null,
    attributes: overrides.attributes ?? {},
    pii: overrides.pii ?? [],
    piiCompletion: overrides.piiCompletion ?? false,
    sampledReason: overrides.sampledReason ?? "success_sample",
    ingestedAtUs: overrides.ingestedAtUs ?? now,
    isEval: overrides.isEval ?? false,
    evalName: overrides.evalName ?? null,
    evalScore: overrides.evalScore ?? null,
    evalPass: overrides.evalPass ?? null,
    evalEngine: overrides.evalEngine ?? null,
  };
}

export function makeEvalSpan(parent: SpanRow, overrides: Partial<SpanRow> = {}): SpanRow {
  return makeSpan({
    spanId: newSpanId(),
    traceId: parent.traceId,
    parentSpanId: parent.spanId,
    name: `eval.${overrides.evalName ?? "faithfulness"}`,
    kind: "internal",
    startUs: parent.endUs,
    endUs: parent.endUs + 1000,
    latencyMs: 0.001,
    genAiSystem: "eval",
    requestModel: "local-v1",
    operation: "eval",
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    promptText: null,
    completionText: null,
    appId: parent.appId,
    userId: parent.userId,
    sessionId: parent.sessionId,
    isEval: true,
    evalName: overrides.evalName ?? "faithfulness",
    evalScore: overrides.evalScore ?? 0.9,
    evalPass: overrides.evalPass ?? true,
    evalEngine: overrides.evalEngine ?? "local-v1",
    sampledReason: "eval",
    ...overrides,
  });
}

export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
