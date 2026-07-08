import assert from "node:assert/strict";
import test from "node:test";
import { loadPolicy } from "../src/config";
import { LocalEvalEngine } from "../src/eval/engine";
import { EvalRunner } from "../src/eval/runner";
import { SQLiteStore } from "../src/storage/sqliteStore";
import { createClock, makeSpan, tempDb } from "./helpers";

test("eval runner writes linked eval spans, triages PII, and is idempotent", async () => {
  const { db, cleanup } = tempDb();
  try {
    const store = new SQLiteStore(db);
    const clock = createClock();
    const now = clock.nowUs();
    const clean = makeSpan({
      traceId: "1".repeat(32),
      spanId: "a".repeat(16),
      appId: "docs-search",
      promptText: "refund policy",
      completionText: "Refunds are available within 30 days.",
      retrieval: [{ id: "doc-1", text: "Refunds are available within 30 days." }],
      attributes: { "retrieval.expected_ids": JSON.stringify(["doc-1"]) },
      startUs: now - 3_600_000_000,
      ingestedAtUs: now,
    });
    const leak = makeSpan({
      traceId: "2".repeat(32),
      spanId: "b".repeat(16),
      appId: "support-bot",
      promptText: "verify account",
      completionText: "Customer SSN is 123-45-6789.",
      startUs: now - 3_500_000_000,
      ingestedAtUs: now,
    });
    const unsupported = makeSpan({
      traceId: "3".repeat(32),
      spanId: "c".repeat(16),
      appId: "support-bot",
      promptText: "refund window",
      completionText: "The refund window is 90 days. Cats can fly to Mars.",
      retrieval: [{ id: "doc-1", text: "The refund window is 30 days." }],
      attributes: { "retrieval.expected_ids": ["doc-1"] },
      startUs: now - 3_400_000_000,
      ingestedAtUs: now,
    });
    store.insertSpans([clean, leak, unsupported]);

    const policy = loadPolicy(undefined, {
      eval: { sampleRate: 1, batchSize: 100 },
    });
    const runner = new EvalRunner({
      store,
      engine: new LocalEvalEngine(),
      policy: policy.eval,
      nowUs: () => now,
    });
    const result = await runner.runWindow(now - 3_600_000_000, now, now);
    assert.equal(result.sampled, 3);
    assert.equal(result.evaluated, 3);
    assert.ok(result.evalSpans >= 10);
    assert.equal(result.piiHigh, 1);

    const leakTrace = store.getTrace(leak.traceId);
    const evalSpans = leakTrace.filter((span) => span.isEval);
    assert.ok(evalSpans.length >= 3);
    for (const span of evalSpans) {
      assert.equal(span.parentSpanId, leak.spanId);
      assert.equal(span.traceId, leak.traceId);
      assert.equal(span.evalEngine, "local-v1");
      assert.equal("startNs" in span, false);
    }
    const piiEval = evalSpans.find((span) => span.evalName === "pii_leak");
    assert.ok(piiEval);
    assert.equal(piiEval.evalScore, 1);
    assert.equal(piiEval.evalPass, false);

    const triage = store.triage("open");
    assert.equal(triage.length, 1);
    assert.equal(triage[0].spanId, leak.spanId);
    assert.equal(triage[0].excerpt.includes("123-45-6789"), false);
    assert.ok(triage[0].excerpt.includes("[redacted:ssn]"));

    const before = store.countSpans();
    const second = await runner.runWindow(now - 3_600_000_000, now, now);
    assert.equal(second.evaluated, 0);
    assert.equal(second.evalSpans, 0);
    assert.equal(store.countSpans(), before);

    const stats = store.alertStats(now);
    const all = stats.find((stat) => stat.appId === "__all__");
    assert.ok(all);
    assert.equal(all.piiEvalCount, 1);
    assert.equal(all.piiEvalTotal, 3);
    assert.ok(Math.abs(all.piiEvalRate - 1 / 3) < 1e-9);
  } finally {
    cleanup();
  }
});

test("eval sampling rate zero produces no eval spans", async () => {
  const { db, cleanup } = tempDb();
  try {
    const store = new SQLiteStore(db);
    const now = createClock().nowUs();
    store.insertSpans([
      makeSpan({
        traceId: "4".repeat(32),
        spanId: "d".repeat(16),
        completionText: "A clean answer.",
        startUs: now - 1_000_000,
        ingestedAtUs: now,
      }),
    ]);
    const policy = loadPolicy(undefined, { eval: { sampleRate: 0, batchSize: 100 } });
    const runner = new EvalRunner({
      store,
      engine: new LocalEvalEngine(),
      policy: policy.eval,
      nowUs: () => now,
    });
    const result = await runner.runOnce(now);
    assert.equal(result.sampled, 0);
    assert.equal(result.evalSpans, 0);
    assert.equal(store.recentEvals().length, 0);
  } finally {
    cleanup();
  }
});
