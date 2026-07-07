import { costUsd, type Pricing } from "../config";
import { promptHash as hashPrompt } from "../ids";
import { isRecord } from "../json";
import { detectPii, hasCompletionPii } from "../pii";
import type { JsonValue, RetrievalDoc, SpanRecord, SpanRow } from "../types";
import type { DecodedSpan } from "./types";

export interface NormalizeOptions {
  pricing: Pricing;
  captureContent: boolean;
  maxContentChars: number;
  nowUs: number;
}

function firstAttribute(
  attributes: Record<string, JsonValue>,
  keys: string[],
): JsonValue | undefined {
  for (const key of keys) {
    const value = attributes[key];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

function stringAttribute(attributes: Record<string, JsonValue>, keys: string[]): string | null {
  const value = firstAttribute(attributes, keys);
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

function numberAttribute(attributes: Record<string, JsonValue>, keys: string[]): number {
  const value = firstAttribute(attributes, keys);
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0;
}

function maybeJson(value: JsonValue): JsonValue {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith("[") && !trimmed.startsWith("{")) return value;
  try {
    return JSON.parse(trimmed) as JsonValue;
  } catch {
    return value;
  }
}

function collectText(value: JsonValue | undefined, output: string[]): void {
  if (value === undefined || value === null) return;
  if (typeof value === "string") {
    const parsed = maybeJson(value);
    if (parsed !== value) collectText(parsed, output);
    else if (value.trim().length > 0) output.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectText(item, output);
    return;
  }
  if (!isRecord(value)) return;
  const record = value as Record<string, JsonValue>;
  if (typeof record.content === "string") output.push(record.content);
  else if (record.content !== undefined) collectText(record.content, output);
  if (typeof record.text === "string") output.push(record.text);
  if (record.parts !== undefined) collectText(record.parts, output);
}

function extractText(
  attributes: Record<string, JsonValue>,
  keys: string[],
  events: DecodedSpan["events"],
  eventNames: string[],
): string | null {
  const output: string[] = [];
  for (const key of keys) collectText(attributes[key], output);
  for (const event of events) {
    if (!eventNames.includes(event.name)) continue;
    for (const [key, value] of Object.entries(event.attributes)) {
      if (key === "gen_ai.prompt" || key === "gen_ai.completion" || key === "gen_ai.input.messages" || key === "gen_ai.output.messages") {
        collectText(value, output);
      }
    }
  }
  const text = output.join("\n").trim();
  return text.length > 0 ? text : null;
}

function extractRetrieval(attributes: Record<string, JsonValue>): RetrievalDoc[] | null {
  const raw = maybeJson(
    firstAttribute(attributes, ["retrieval.documents", "llm.retrieval.documents"]) ?? null,
  );
  if (!Array.isArray(raw)) return null;
  const docs: RetrievalDoc[] = [];
  for (const item of raw) {
    if (typeof item === "string") {
      docs.push({ id: `doc_${docs.length}`, text: item });
      continue;
    }
    if (!isRecord(item)) continue;
    const record = item as Record<string, JsonValue>;
    const id = typeof record.id === "string" ? record.id : `doc_${docs.length}`;
    const text = typeof record.text === "string" ? record.text : typeof record.content === "string" ? record.content : "";
    if (!text) continue;
    const score = typeof record.score === "number" ? record.score : undefined;
    docs.push({ id, text, ...(score === undefined ? {} : { score }) });
  }
  return docs.length > 0 ? docs : null;
}

function normalizeProvider(raw: string | null): string {
  if (!raw) return "unknown";
  const value = raw.trim().toLowerCase();
  if (value === "google" || value === "gemini" || value === "gcp.gemini" || value === "gcp.gen_ai") {
    return "gcp.gemini";
  }
  return value || "unknown";
}

function instrumentationFamily(
  attributes: Record<string, JsonValue>,
  scopeName: string | null,
): string | null {
  const explicit = stringAttribute(attributes, ["instrumentation.family"]);
  if (explicit) return explicit.toLowerCase();
  const scope = (scopeName ?? "").toLowerCase();
  if (scope.includes("langchain")) return "langchain";
  if (scope.includes("llamaindex") || scope.includes("llama_index")) return "llamaindex";
  if (scope.includes("google") || scope.includes("gemini") || scope.includes("vertex")) return "google";
  if (scope.includes("anthropic")) return "anthropic";
  if (scope.includes("openai")) return "openai";
  if (scope.includes("vllm")) return "vllm";
  return null;
}

function truncate(text: string | null, limit: number): string | null {
  if (text === null) return null;
  return text.length > limit ? `${text.slice(0, limit)}\n[truncated]` : text;
}

export function normalizeSpans(
  decoded: DecodedSpan[],
  options: NormalizeOptions,
): { spans: SpanRecord[]; rejected: number } {
  const spans: SpanRecord[] = [];
  for (const span of decoded) {
    const attributes: Record<string, JsonValue> = {
      ...span.attributes,
      resource: span.resource,
    };
    const capture = options.captureContent;
    const prompt = capture
      ? extractText(
          span.attributes,
          ["gen_ai.input.messages", "gen_ai.prompt", "llm.prompts"],
          span.events,
          ["gen_ai.content.prompt", "gen_ai.prompt"],
        )
      : null;
    const completion = capture
      ? extractText(
          span.attributes,
          ["gen_ai.output.messages", "gen_ai.completion", "llm.completions"],
          span.events,
          ["gen_ai.content.completion", "gen_ai.completion"],
        )
      : null;
    if (!capture) {
      for (const key of [
        "gen_ai.input.messages",
        "gen_ai.output.messages",
        "gen_ai.prompt",
        "gen_ai.completion",
        "llm.prompts",
        "llm.completions",
        "retrieval.documents",
        "retrieval.expected_ids",
      ]) {
        delete attributes[key];
      }
    }
    const pii = [...detectPii(prompt, "prompt"), ...detectPii(completion, "completion")];
    const provider = normalizeProvider(
      stringAttribute(span.attributes, ["gen_ai.provider.name", "gen_ai.system", "llm.system"]),
    );
    const requestModel = stringAttribute(span.attributes, [
      "gen_ai.request.model",
      "llm.request.model",
      "gen_ai.response.model",
    ]);
    const responseModel =
      stringAttribute(span.attributes, ["gen_ai.response.model"]) ?? requestModel;
    const inputTokens = numberAttribute(span.attributes, [
      "gen_ai.usage.input_tokens",
      "gen_ai.usage.prompt_tokens",
      "llm.usage.prompt_tokens",
    ]);
    const outputTokens = numberAttribute(span.attributes, [
      "gen_ai.usage.output_tokens",
      "gen_ai.usage.completion_tokens",
      "llm.usage.completion_tokens",
    ]);
    const price = costUsd(options.pricing, requestModel, inputTokens, outputTokens);
    if (!price.matched && requestModel) attributes["cost.unknown"] = true;
    const startUs = Number(span.startNs / 1000n);
    const endUs = Number(span.endNs / 1000n);
    const latencyMs = span.endNs >= span.startNs ? Number(span.endNs - span.startNs) / 1e6 : 0;
    if (span.endNs < span.startNs) attributes["invalid.timing"] = true;
    const llmType = stringAttribute(span.attributes, ["llm.request.type"]);
    const operation =
      stringAttribute(span.attributes, ["gen_ai.operation.name"]) ??
      (llmType === "chat" ? "chat" : llmType) ??
      span.name.split(/\s+/)[0] ??
      null;
    const retrieval = capture ? extractRetrieval(span.attributes) : null;
    spans.push({
      spanId: span.spanId,
      traceId: span.traceId,
      parentSpanId: span.parentSpanId,
      name: span.name,
      kind: span.kind,
      startNs: span.startNs,
      endNs: span.endNs,
      startUs,
      endUs,
      latencyMs,
      statusCode: span.statusCode,
      statusMessage: span.statusMessage,
      genAiSystem: provider,
      requestModel,
      responseModel,
      responseId: stringAttribute(span.attributes, ["gen_ai.response.id", "llm.response.id"]),
      operation,
      inputTokens,
      outputTokens,
      costUsd: price.usd,
      promptHash: prompt ? hashPrompt(prompt) : null,
      appId:
        stringAttribute(span.resource, ["app.id"]) ??
        stringAttribute(span.resource, ["service.name"]) ??
        "unknown",
      userId:
        stringAttribute(span.attributes, ["user.id", "enduser.id", "llm.user", "gen_ai.request.user"]) ??
        stringAttribute(span.resource, ["user.id", "enduser.id"]),
      sessionId:
        stringAttribute(span.attributes, ["session.id", "gen_ai.conversation.id"]) ??
        stringAttribute(span.resource, ["session.id"]),
      environment:
        stringAttribute(span.resource, ["deployment.environment", "deployment.environment.name"]),
      instrumentationFamily: instrumentationFamily(span.attributes, span.scopeName),
      promptText: truncate(prompt, options.maxContentChars),
      completionText: truncate(completion, options.maxContentChars),
      retrieval,
      attributes,
      pii,
      piiCompletion: hasCompletionPii(pii),
      sampledReason: "",
      ingestedAtUs: options.nowUs,
      isEval: false,
      evalName: null,
      evalScore: null,
      evalPass: null,
      evalEngine: null,
    });
  }
  return { spans, rejected: 0 };
}

export function toSpanRow(span: SpanRecord): SpanRow {
  const { startNs, endNs, ...row } = span;
  void startNs;
  void endNs;
  return row;
}
