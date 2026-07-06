import assert from "node:assert/strict";
import test from "node:test";
import { SQLiteStore } from "../src/storage/sqliteStore";
import { newSpanId } from "../src/ids";
import type { AlertRow, DriftRunRow, TriageRow } from "../src/types";
import { createClock, makeEvalSpan, makeSpan, tempDb } from "./helpers";

test("inserts spans idempotently and excludes eval spans from traffic aggregates", () => {
  const { db, cleanup } = tempDb();
  try {
    const store = new SQLiteStore(db);
    const clock = createClock();
    const now = clock.nowUs();
    const fast = makeSpan({ spanId: "a".repeat(16), startUs: now - 60_000_000, latencyMs: 80, costUsd: 0.001 });
    const slowError = makeSpan({
      spanId: "b".repeat(16),
      startUs: now - 30_000_000,
      latencyMs: 900,
      statusCode: 2,
      costUsd: 0.002,
      traceId: "1".repeat(32),
    });
    const mid = makeSpan({
      spanId: "c".repeat(16),
      startUs: now - 10_000_000,
      latencyMs: 300,
      costUsd: 0.003,
      userId: "u_002",
    });
    store.insertSpans([fast, slowError, mid]);
    store.insertSpans([fast]);
    assert.equal(store.countSpans(), 3);

    const evalSpan = makeEvalSpan(mid, { evalName: "pii_leak", evalScore: 1, evalPass: false });
    store.insertSpans([evalSpan]);

    const overview = store.overview(now, 86_400_000_000);
    assert.equal(overview.spans, 3);
    assert.equal(overview.piiPositives, 1);
    assert.equal(overview.errorRate, 1 / 3);
    assert.ok(overview.p95LatencyMs >= 300);
    assert.ok(Math.abs(overview.costUsd - 0.006) < 1e-9);

    const series = store.timeseries(now, 3_600_000_000, 300_000_000);
    assert.ok(series.length >= 10);
    assert.equal(series.reduce((sum, point) => sum + point.spans, 0), 3);
    assert.ok(series.some((point) => point.errors === 1));

    const cost = store.costByUser(now, 86_400_000_000);
    assert.equal(cost.length, 2);
    const byUser = new Map(cost.map((row) => [row.userId, row]));
    assert.equal(byUser.get("u_002")?.costUsd, 0.003);
    assert.ok(Math.abs((byUser.get("u_001")?.costUsd ?? 0) - 0.003) < 1e-9);
  } finally {
    cleanup();
  }
});

test("search filters and trace lookup return serializable rows", () => {
  const { db, cleanup } = tempDb();
  try {
    const store = new SQLiteStore(db);
    const now = createClock().nowUs();
    const traceId = "d".repeat(32);
    const parent = makeSpan({
      traceId,
      spanId: "e".repeat(16),
      appId: "docs-search",
      requestModel: "gemini-1.5-flash",
      promptText: "Find the refund policy",
      completionText: "Refunds are available within 30 days.",
      pii: [{ type: "email", confidence: 0.5, field: "prompt" }],
      piiCompletion: false,
      startUs: now - 60_000_000,
    });
    const child = makeSpan({
      traceId,
      spanId: "f".repeat(16),
      parentSpanId: parent.spanId,
      name: "retrieval",
      operation: "retrieval",
      statusCode: 2,
      startUs: now - 59_000_000,
      appId: "docs-search",
      requestModel: "gemini-1.5-flash",
    });
    store.insertSpans([parent, child]);
    store.insertSpans([
      makeEvalSpan(parent, {
        evalName: "faithfulness",
        evalScore: 0.4,
        evalPass: false,
        startUs: now - 58_000_000,
        endUs: now - 57_999_000,
      }),
    ]);

    assert.equal(store.search({ appId: "docs-search" }).total, 2);
    assert.equal(store.search({ model: "gemini-1.5-flash" }).rows.length, 2);
    assert.equal(store.search({ status: "error" }).total, 1);
    assert.equal(store.search({ q: "refund" }).total, 1);
    assert.equal(store.search({ piiOnly: true }).total, 1);
    assert.equal(store.search({ offset: 1, limit: 1 }).rows.length, 1);

    const trace = store.getTrace(traceId);
    assert.equal(trace.length, 3);
    assert.equal(trace[0].spanId, parent.spanId);
    assert.equal(trace[1].spanId, child.spanId);
    assert.equal(trace[2].isEval, true);
    assert.equal(trace[2].evalName, "faithfulness");
    assert.equal("startNs" in trace[0], false);
    assert.deepEqual(trace[0].pii[0], { type: "email", confidence: 0.5, field: "prompt" });

    const trend = store.evalTrend(now, 86_400_000_000, 300_000_000);
    assert.equal(trend.length, 1);
    assert.equal(trend[0].metric, "faithfulness");
    assert.equal(trend[0].avgScore, 0.4);
    assert.equal(trend[0].passRate, 0);
  } finally {
    cleanup();
  }
});

test("eval candidates sample traces and skip already evaluated spans", () => {
  const { db, cleanup } = tempDb();
  try {
    const store = new SQLiteStore(db, { evalSalt: "test" });
    const now = createClock().nowUs();
    const spans = Array.from({ length: 60 }, (_, index) =>
      makeSpan({
        spanId: index.toString(16).padStart(16, "0"),
        traceId: (index + 1).toString(16).padStart(32, "0"),
        startUs: now - (index + 1) * 1_000_000,
        completionText: `answer ${index}`,
      }),
    );
    store.insertSpans(spans);
    const all = store.evalCandidates(now, 86_400_000_000, 1, 100);
    assert.equal(all.length, 60);
    assert.equal(store.evalCandidates(now, 86_400_000_000, 0, 100).length, 0);
    const sampled = store.evalCandidates(now, 86_400_000_000, 0.5, 100);
    assert.ok(sampled.length >= 20 && sampled.length <= 40, `unexpected sample size ${sampled.length}`);

    store.insertSpans([makeEvalSpan(spans[0])]);
    const remaining = store.evalCandidates(now, 86_400_000_000, 1, 100);
    assert.equal(remaining.length, 59);
    assert.ok(!remaining.some((span) => span.spanId === spans[0].spanId));
  } finally {
    cleanup();
  }
});

test("alert, triage, drift, and metadata persistence are idempotent", () => {
  const { db, cleanup } = tempDb();
  try {
    const store = new SQLiteStore(db);
    const now = createClock().nowUs();
    const alert: AlertRow = {
      id: "alert:test",
      fingerprint: "fingerprint-1",
      rule: "PiiLeakDetected",
      severity: "critical",
      appId: "support-bot",
      summary: "PII leak suspected in support-bot",
      description: "2 PII-positive evals",
      status: "open",
      occurrences: 1,
      createdUs: now,
      updatedUs: now,
      payloadJson: "{}",
    };
    assert.equal(store.insertAlert(alert).created, true);
    const second = store.insertAlert({ ...alert, updatedUs: now + 1 });
    assert.equal(second.created, false);
    assert.equal(second.alert.occurrences, 2);
    assert.equal(store.listAlerts().length, 1);
    assert.equal(store.ackAlert(alert.id, now + 2), true);
    assert.equal(store.ackAlert(alert.id, now + 3), false);
    assert.equal(store.getAlert(alert.id)?.status, "acked");

    const delivery = store.getDeliveries(alert.id);
    assert.equal(delivery.length, 0);
    store.insertDelivery({
      alertId: alert.id,
      sink: "slack",
      status: "sent",
      detail: "200",
      attemptedUs: now,
    });
    assert.equal(store.getDeliveries(alert.id)[0].status, "sent");

    const triage: TriageRow = {
      id: "triage:test",
      spanId: "a".repeat(16),
      traceId: "b".repeat(32),
      score: 1,
      reason: "ssn",
      excerpt: "Customer SSN is [redacted:ssn].",
      status: "open",
      createdUs: now,
      resolvedUs: null,
    };
    assert.equal(store.insertTriage(triage), true);
    assert.equal(store.insertTriage(triage), false);
    assert.equal(store.triage("open").length, 1);
    assert.equal(store.resolveTriage(triage.id, now + 1), true);
    assert.equal(store.triage("open").length, 0);
    assert.equal(store.triage("resolved").length, 1);

    const drift: DriftRunRow = {
      id: "drift:support-bot:1",
      computedUs: now,
      appId: "support-bot",
      windowStartUs: now - 604_800_000_000,
      windowEndUs: now,
      psi: 0.31,
      kl: 0.4,
      nCurrent: 200,
      nBaseline: 800,
      threshold: 0.2,
      alert: true,
      status: "ok",
      detailJson: "{}",
    };
    store.insertDriftRun(drift);
    store.insertDriftRun({ ...drift, psi: 0.32 });
    const latest = store.latestDriftRuns(10, "support-bot");
    assert.equal(latest.length, 1);
    assert.equal(latest[0].psi, 0.32);
    assert.equal(store.driftTrend(now, 10).length, 1);

    store.upsertApps([{ id: "support-bot", name: "Support Bot", team: "CX", createdUs: now }]);
    store.upsertUsers([{ id: "u_001", displayName: "Avery Chen", tier: "pro", createdUs: now }]);
    store.insertSessions([{ id: "s_001", userId: "u_001", appId: "support-bot", startedUs: now }]);
    const meta = store.getMeta();
    assert.equal(meta.apps[0].name, "Support Bot");
    assert.equal(meta.users[0].displayName, "Avery Chen");
  } finally {
    cleanup();
  }
});

test("alert stats aggregate per app and keep PII from eval spans only", () => {
  const { db, cleanup } = tempDb();
  try {
    const store = new SQLiteStore(db);
    const now = createClock().nowUs();
    const spans = Array.from({ length: 20 }, (_, index) =>
      makeSpan({
        spanId: newSpanId(),
        traceId: (index + 10).toString(16).padStart(32, "0"),
        appId: index % 2 === 0 ? "support-bot" : "docs-search",
        statusCode: index === 0 ? 2 : 0,
        latencyMs: index === 0 ? 4000 : 100,
        startUs: now - 10_000_000 - index * 1000,
      }),
    );
    store.insertSpans(spans);
    const piiParent = spans[0];
    store.insertSpans([
      makeEvalSpan(piiParent, { evalName: "pii_leak", evalScore: 1, evalPass: false }),
      makeEvalSpan(piiParent, { evalName: "pii_leak", evalScore: 1, evalPass: false }),
      makeEvalSpan(spans[1], { evalName: "toxicity", evalScore: 0.1, evalPass: true }),
      makeEvalSpan(spans[2], { evalName: "faithfulness", evalScore: 0.4, evalPass: false }),
    ]);
    const stats = store.alertStats(now);
    const all = stats.find((stat) => stat.appId === "__all__");
    assert.ok(all);
    assert.equal(all.spans, 20);
    assert.equal(all.errors, 1);
    assert.equal(all.piiEvalTotal, 2);
    assert.equal(all.piiEvalCount, 2);
    assert.equal(all.piiEvalRate, 1);
    assert.ok(all.latencyP95Ms >= 100);
    assert.equal(all.evalN.faithfulness, 1);
    assert.equal(all.evalAvg.faithfulness, 0.4);
    const support = stats.find((stat) => stat.appId === "support-bot");
    assert.ok(support);
    assert.equal(support.piiEvalCount, 2);
    const docs = stats.find((stat) => stat.appId === "docs-search");
    assert.ok(docs);
    assert.equal(docs.piiEvalCount, 0);
  } finally {
    cleanup();
  }
});
