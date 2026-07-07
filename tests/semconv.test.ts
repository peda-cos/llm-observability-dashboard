import assert from "node:assert/strict";
import test from "node:test";
import { loadPricing } from "../src/config";
import { decodeExport } from "../src/otlp/decode";
import { normalizeSpans } from "../src/otlp/normalize";
import { buildFamilyTrace, FAMILIES, type Family, type FamilyTraceInput } from "../src/sdk/families";
import type { SpanRecord } from "../src/types";

const pricing = loadPricing();

function normalizeFamily(family: Family, input: FamilyTraceInput): SpanRecord[] {
  const payload = buildFamilyTrace(family, input);
  const decoded = decodeExport(payload);
  const normalized = normalizeSpans(decoded.spans, {
    pricing,
    captureContent: true,
    maxContentChars: 1000,
    nowUs: 1_760_000_000_000_000,
  });
  return normalized.spans;
}

test("normalizes all six SDK family dialects into canonical spans", () => {
  const familySpans = new Map<Family, SpanRecord[]>();
  for (const family of FAMILIES) {
    familySpans.set(
      family,
      normalizeFamily(family, {
        appId: `app-${family}`,
        userId: "u_family",
        sessionId: "s_family",
        prompt: "How do I request a refund?",
        completion: "Refunds are available within 30 days.",
      }),
    );
  }
  for (const [family, spans] of familySpans.entries()) {
    assert.ok(spans.length >= 1, family);
    const chat = spans.find((span) => span.completionText !== null);
    assert.ok(chat, `${family} has a completion span`);
    assert.equal(chat.appId, `app-${family}`);
    assert.equal(chat.userId, "u_family");
    assert.equal(chat.sessionId, "s_family");
    assert.equal(chat.instrumentationFamily, family);
    assert.ok(chat.inputTokens > 0, `${family} input tokens`);
    assert.ok(chat.outputTokens > 0, `${family} output tokens`);
    assert.ok(chat.costUsd > 0, `${family} cost`);
    assert.equal(chat.promptText, "How do I request a refund?");
    assert.equal(chat.completionText, "Refunds are available within 30 days.");
    assert.ok(chat.promptHash && chat.promptHash.length === 64);
    assert.equal(chat.statusCode, 1);
    assert.equal(chat.isEval, false);
  }
  assert.equal(familySpans.get("openai")?.[0].genAiSystem, "openai");
  assert.equal(familySpans.get("anthropic")?.[0].genAiSystem, "anthropic");
  assert.equal(familySpans.get("google")?.[0].genAiSystem, "gcp.gemini");
  assert.equal(familySpans.get("langchain")?.length, 2);
  assert.equal(familySpans.get("llamaindex")?.length, 2);
  assert.equal(familySpans.get("vllm")?.[0].genAiSystem, "vllm");
});

test("legacy and current token/content attributes both normalize", () => {
  const openai = normalizeFamily("openai", {
    appId: "app-openai",
    userId: "u",
    sessionId: "s",
    prompt: "legacy prompt",
    completion: "legacy completion",
    inputTokens: 111,
    outputTokens: 22,
  })[0];
  assert.equal(openai.inputTokens, 111);
  assert.equal(openai.outputTokens, 22);
  assert.equal(openai.operation, "chat");

  const anthropic = normalizeFamily("anthropic", {
    appId: "app-anthropic",
    userId: "u",
    sessionId: "s",
    prompt: "new prompt",
    completion: "new completion",
    inputTokens: 333,
    outputTokens: 44,
  })[0];
  assert.equal(anthropic.inputTokens, 333);
  assert.equal(anthropic.outputTokens, 44);
  assert.equal(anthropic.requestModel, "claude-3-5-sonnet-20241022");
});

test("retrieval context and expected ids survive normalization for RAGAS metrics", () => {
  const spans = normalizeFamily("llamaindex", {
    appId: "docs-search",
    userId: "u",
    sessionId: "s",
    prompt: "What is the refund window?",
    completion: "Thirty days.",
    retrieval: {
      docs: [
        { id: "doc-1", text: "Refunds are allowed for 30 days.", score: 0.9 },
        { id: "doc-2", text: "Shipping takes 3 days." },
      ],
      expectedIds: ["doc-1"],
    },
  });
  const chat = spans.find((span) => span.completionText);
  assert.ok(chat);
  assert.deepEqual(chat.retrieval?.map((doc) => doc.id), ["doc-1", "doc-2"]);
  assert.equal(chat.retrieval?.[0].score, 0.9);
  assert.equal(JSON.parse(String(chat.attributes["retrieval.expected_ids"])).join(","), "doc-1");
});

test("captureContent=false removes content and retrieval while keeping hashes null", () => {
  const payload = buildFamilyTrace("llamaindex", {
    appId: "docs-search",
    userId: "u",
    sessionId: "s",
    prompt: "secret prompt",
    completion: "secret completion",
  });
  const normalized = normalizeSpans(decodeExport(payload).spans, {
    pricing,
    captureContent: false,
    maxContentChars: 1000,
    nowUs: 1,
  });
  for (const span of normalized.spans) {
    assert.equal(span.promptText, null);
    assert.equal(span.completionText, null);
    assert.equal(span.promptHash, null);
    assert.equal(span.retrieval, null);
    assert.equal(span.attributes["gen_ai.input.messages"], undefined);
    assert.equal(span.attributes["retrieval.documents"], undefined);
  }
});

test("event-carried content is extracted when span attributes are absent", () => {
  const payload = {
    resourceSpans: [
      {
        resource: { attributes: [{ key: "service.name", value: { stringValue: "events-app" } }] },
        scopeSpans: [
          {
            scope: { name: "@traceloop/instrumentation-openai" },
            spans: [
              {
                traceId: "a".repeat(32),
                spanId: "b".repeat(16),
                name: "chat gpt-4o-mini",
                kind: 3,
                startTimeUnixNano: "1760000000000000000",
                endTimeUnixNano: "1760000000100000000",
                attributes: [
                  { key: "gen_ai.system", value: { stringValue: "openai" } },
                  { key: "gen_ai.request.model", value: { stringValue: "gpt-4o-mini" } },
                ],
                events: [
                  {
                    name: "gen_ai.content.prompt",
                    attributes: [{ key: "gen_ai.prompt", value: { stringValue: "event prompt" } }],
                  },
                  {
                    name: "gen_ai.content.completion",
                    attributes: [
                      { key: "gen_ai.completion", value: { stringValue: "event completion" } },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
  const spans = normalizeSpans(decodeExport(payload).spans, {
    pricing,
    captureContent: true,
    maxContentChars: 100,
    nowUs: 1,
  }).spans;
  assert.equal(spans[0].promptText, "event prompt");
  assert.equal(spans[0].completionText, "event completion");
});

test("rejects malformed IDs and timestamps without failing the batch", () => {
  const payload = {
    resourceSpans: [
      {
        scopeSpans: [
          {
            spans: [
              {
                traceId: "not-a-trace",
                spanId: "b".repeat(16),
                startTimeUnixNano: "1760000000000000000",
                endTimeUnixNano: "1760000000100000000",
              },
              {
                traceId: "a".repeat(32),
                spanId: "c".repeat(16),
                startTimeUnixNano: "1760000000000000000",
                endTimeUnixNano: "1760000000100000000",
              },
            ],
          },
        ],
      },
    ],
  };
  const result = decodeExport(payload);
  assert.equal(result.rejected, 1);
  assert.equal(result.spans.length, 1);
});
