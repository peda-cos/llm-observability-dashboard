import assert from "node:assert/strict";
import test from "node:test";
import { loadPolicy } from "../src/config";
import { TailSampler } from "../src/ingest/tailSampler";
import { makeSpan } from "./helpers";
import { toRecord } from "./spanRecord";

const basePolicy = loadPolicy();

test("keeps 100% of errored traces and roughly the success rate", () => {
  let now = 0;
  const sampler = new TailSampler(
    {
      ...basePolicy.sampling,
      successRate: 0.1,
      decisionWaitMs: 100,
      keepErrorTraces: true,
      keepPiiTraces: true,
    },
    { now: () => now },
  );
  let kept = 0;
  for (let index = 0; index < 10_000; index += 1) {
    sampler.offer([
      toRecord(
        makeSpan({
          traceId: (index + 1).toString(16).padStart(32, "0"),
          spanId: "a".repeat(16),
        }),
      ),
    ]);
  }
  now = 101;
  const decisions = sampler.flushExpired();
  for (const decision of decisions) {
    assert.equal(decision.keep, decision.reason === "success_sample");
    if (decision.keep) kept += 1;
  }
  assert.equal(decisions.length, 10_000);
  assert.ok(kept >= 800 && kept <= 1200, `kept ${kept}`);
});

test("errors and PII are kept even when the success rate is zero", () => {
  const sampler = new TailSampler({
    ...basePolicy.sampling,
    successRate: 0,
    decisionWaitMs: 10,
    keepErrorTraces: true,
    keepPiiTraces: true,
  });
  sampler.offer([toRecord(makeSpan({ traceId: "1".repeat(32), statusCode: 2 }))]);
  sampler.offer([
    toRecord(
      makeSpan({
        traceId: "2".repeat(32),
        pii: [{ type: "ssn", confidence: 1, field: "completion" }],
        piiCompletion: true,
      }),
    ),
  ]);
  sampler.offer([toRecord(makeSpan({ traceId: "3".repeat(32) }))]);
  const decisions = sampler.flushExpired(Date.now() + 1000);
  const byTrace = new Map(decisions.map((decision) => [decision.traceId, decision]));
  assert.equal(byTrace.get("1".repeat(32))?.reason, "error");
  assert.equal(byTrace.get("1".repeat(32))?.keep, true);
  assert.equal(byTrace.get("2".repeat(32))?.reason, "pii");
  assert.equal(byTrace.get("2".repeat(32))?.keep, true);
  assert.equal(byTrace.get("3".repeat(32))?.reason, "dropped");
  assert.equal(byTrace.get("3".repeat(32))?.keep, false);
});

test("all spans of a trace share one decision and deadline postpones flush", () => {
  let now = 0;
  const sampler = new TailSampler(
    {
      ...basePolicy.sampling,
      successRate: 1,
      decisionWaitMs: 500,
      keepPiiTraces: true,
    },
    { now: () => now },
  );
  const traceId = "4".repeat(32);
  sampler.offer([toRecord(makeSpan({ traceId, spanId: "a".repeat(16), startUs: 1000 }))]);
  sampler.offer([toRecord(makeSpan({ traceId, spanId: "b".repeat(16), startUs: 900 }))]);
  assert.equal(sampler.pendingTraces(), 1);
  assert.equal(sampler.pendingSpans(), 2);
  assert.equal(sampler.flushExpired().length, 0);
  now = 501;
  const decisions = sampler.flushExpired();
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].spans.length, 2);
  assert.equal(decisions[0].keep, true);
  assert.equal(sampler.pendingSpans(), 0);
});

test("force flushes all pending traces", () => {
  const sampler = new TailSampler({ ...basePolicy.sampling, decisionWaitMs: 999999 });
  sampler.offer([toRecord(makeSpan({ traceId: "5".repeat(32) }))]);
  assert.equal(sampler.flushExpired().length, 0);
  assert.equal(sampler.flushExpired(Date.now(), true).length, 1);
});
