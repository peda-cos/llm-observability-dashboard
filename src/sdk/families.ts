import { newSpanId, newTraceId } from "../ids";
import type { OtlpAnyValue, OtlpKeyValue, OtlpResourceSpans, OtlpScopeSpans, OtlpSpan } from "../otlp/types";
import type { RetrievalDoc } from "../types";

export const FAMILIES = ["openai", "anthropic", "google", "langchain", "llamaindex", "vllm"] as const;
export type Family = (typeof FAMILIES)[number];

export interface FamilyTraceInput {
  appId: string;
  userId: string;
  sessionId: string;
  prompt: string;
  completion: string;
  traceId?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  latencyMs?: number;
  startUs?: number;
  error?: boolean;
  retrieval?: { docs: RetrievalDoc[]; expectedIds: string[] };
}

function any(value: string | number | boolean): OtlpAnyValue {
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { boolValue: value };
  return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
}

function kv(key: string, value: string | number | boolean): OtlpKeyValue {
  return { key, value: any(value) };
}

function jsonKv(key: string, value: unknown): OtlpKeyValue {
  return kv(key, JSON.stringify(value));
}

function nano(us: number): string {
  return (BigInt(Math.round(us)) * 1000n).toString();
}

function span(input: {
  traceId: string;
  spanId: string;
  parentSpanId?: string | null;
  name: string;
  kind: number;
  startUs: number;
  endUs: number;
  attributes: OtlpKeyValue[];
  error?: boolean;
}): OtlpSpan {
  return {
    traceId: input.traceId,
    spanId: input.spanId,
    parentSpanId: input.parentSpanId ?? undefined,
    name: input.name,
    kind: input.kind,
    startTimeUnixNano: nano(input.startUs),
    endTimeUnixNano: nano(input.endUs),
    attributes: input.attributes,
    status: input.error ? { code: 2, message: "upstream timeout" } : { code: 1 },
  };
}

function resource(input: FamilyTraceInput, family: Family): { attributes: OtlpKeyValue[] } {
  const attributes = [
    kv("service.name", input.appId),
    kv("deployment.environment", "local"),
    kv("user.id", input.userId),
    kv("session.id", input.sessionId),
  ];
  if (family === "vllm") attributes.push(kv("instrumentation.family", "vllm"));
  return { attributes };
}

function scope(name: string, spans: OtlpSpan[]) {
  return { scope: { name }, spans };
}

function openAiAttributes(input: FamilyTraceInput, model: string): OtlpKeyValue[] {
  const prompt = [{ role: "user", content: input.prompt }];
  const completion = [{ role: "assistant", content: input.completion }];
  return [
    kv("gen_ai.system", "openai"),
    kv("gen_ai.provider.name", "openai"),
    kv("gen_ai.operation.name", "chat"),
    kv("gen_ai.request.model", model),
    kv("gen_ai.response.model", model),
    kv("gen_ai.response.id", "chatcmpl-demo"),
    kv("gen_ai.usage.prompt_tokens", input.inputTokens ?? 120),
    kv("gen_ai.usage.completion_tokens", input.outputTokens ?? 64),
    kv("llm.request.type", "chat"),
    jsonKv("gen_ai.prompt", prompt),
    jsonKv("gen_ai.completion", completion),
  ];
}

function newMessageAttributes(
  input: FamilyTraceInput,
  model: string,
  provider: "anthropic" | "gcp.gemini",
  operation: "chat" | "generate_content",
): OtlpKeyValue[] {
  const prompt = [{ role: "user", parts: [{ type: "text", content: input.prompt }] }];
  const completion = [{ role: "assistant", parts: [{ type: "text", content: input.completion }] }];
  return [
    kv("gen_ai.provider.name", provider),
    kv("gen_ai.operation.name", operation),
    kv("gen_ai.request.model", model),
    kv("gen_ai.response.model", model),
    kv("gen_ai.response.id", `${provider}-demo-response`),
    kv("gen_ai.usage.input_tokens", input.inputTokens ?? 140),
    kv("gen_ai.usage.output_tokens", input.outputTokens ?? 72),
    jsonKv("gen_ai.input.messages", prompt),
    jsonKv("gen_ai.output.messages", completion),
  ];
}

export function buildFamilyTrace(family: Family, input: FamilyTraceInput): { resourceSpans: OtlpResourceSpans[] } {
  const traceId = input.traceId ?? newTraceId();
  const startUs = input.startUs ?? Date.now() * 1000;
  const latencyUs = (input.latencyMs ?? 180) * 1000;
  const base = { traceId, startUs, endUs: startUs + latencyUs, error: input.error };
  let scopes: OtlpScopeSpans[];

  if (family === "openai") {
    const model = input.model ?? "gpt-4o-mini";
    scopes = [
      scope("@traceloop/instrumentation-openai", [
        span({
          ...base,
          spanId: newSpanId(),
          name: `chat ${model}`,
          kind: 3,
          attributes: openAiAttributes(input, model),
        }),
      ]),
    ];
  } else if (family === "anthropic") {
    const model = input.model ?? "claude-3-5-sonnet-20241022";
    scopes = [
      scope("@traceloop/instrumentation-anthropic", [
        span({
          ...base,
          spanId: newSpanId(),
          name: `chat ${model}`,
          kind: 3,
          attributes: newMessageAttributes(input, model, "anthropic", "chat"),
        }),
      ]),
    ];
  } else if (family === "google") {
    const model = input.model ?? "gemini-1.5-flash";
    scopes = [
      scope("@traceloop/instrumentation-google-generativeai", [
        span({
          ...base,
          spanId: newSpanId(),
          name: `generate_content ${model}`,
          kind: 3,
          attributes: newMessageAttributes(input, model, "gcp.gemini", "generate_content"),
        }),
      ]),
    ];
  } else if (family === "langchain") {
    const model = input.model ?? "gpt-4o-mini";
    const parentId = newSpanId();
    const childId = newSpanId();
    scopes = [
      scope("@traceloop/instrumentation-langchain", [
        span({
          traceId,
          spanId: parentId,
          name: "LangChain.Chain",
          kind: 1,
          startUs,
          endUs: base.endUs + 1000,
          attributes: [
            kv("traceloop.span.kind", "workflow"),
            kv("traceloop.workflow.name", "support-chain"),
          ],
          error: input.error,
        }),
        span({
          ...base,
          spanId: childId,
          parentSpanId: parentId,
          name: `chat ${model}`,
          kind: 3,
          startUs: startUs + 2000,
          attributes: openAiAttributes(input, model),
        }),
      ]),
    ];
  } else if (family === "llamaindex") {
    const model = input.model ?? "gpt-4o-mini";
    const retrievalId = newSpanId();
    const chatId = newSpanId();
    const docs = input.retrieval?.docs ?? [
      { id: "policy-refunds", text: "Refunds are available within 30 days of purchase." },
      { id: "policy-shipping", text: "Standard shipping takes three to five business days." },
    ];
    const expectedIds = input.retrieval?.expectedIds ?? ["policy-refunds"];
    scopes = [
      scope("@traceloop/instrumentation-llamaindex", [
        span({
          traceId,
          spanId: retrievalId,
          name: "retrieval",
          kind: 1,
          startUs,
          endUs: startUs + 10_000,
          attributes: [
            kv("traceloop.span.kind", "task"),
            kv("gen_ai.operation.name", "retrieval"),
            kv("gen_ai.provider.name", "openai"),
            kv("retrieval.query", input.prompt),
            jsonKv("retrieval.documents", docs),
            jsonKv("retrieval.expected_ids", expectedIds),
          ],
        }),
        span({
          ...base,
          spanId: chatId,
          parentSpanId: retrievalId,
          name: `chat ${model}`,
          kind: 3,
          startUs: startUs + 12_000,
          attributes: [
            ...openAiAttributes(input, model),
            jsonKv("retrieval.documents", docs),
            jsonKv("retrieval.expected_ids", expectedIds),
          ],
        }),
      ]),
    ];
  } else {
    const model = input.model ?? "meta-llama/Llama-3.1-8B-Instruct";
    scopes = [
      scope("vllm", [
        span({
          ...base,
          spanId: newSpanId(),
          name: `chat ${model}`,
          kind: 3,
          attributes: [
            kv("gen_ai.provider.name", "vllm"),
            kv("gen_ai.operation.name", "chat"),
            kv("gen_ai.request.model", model),
            kv("gen_ai.response.model", model),
            kv("gen_ai.response.id", "vllm-demo-response"),
            kv("gen_ai.usage.input_tokens", input.inputTokens ?? 96),
            kv("gen_ai.usage.output_tokens", input.outputTokens ?? 48),
            kv("server.address", "127.0.0.1"),
            kv("server.port", 8000),
            jsonKv("gen_ai.input.messages", [
              { role: "user", parts: [{ type: "text", content: input.prompt }] },
            ]),
            jsonKv("gen_ai.output.messages", [
              { role: "assistant", parts: [{ type: "text", content: input.completion }] },
            ]),
          ],
        }),
      ]),
    ];
  }

  return {
    resourceSpans: [{ resource: resource(input, family), scopeSpans: scopes }],
  };
}
