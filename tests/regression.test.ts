import assert from "node:assert/strict";
import test from "node:test";
import { Dispatcher } from "../src/alerts/dispatch";
import { AlertEngine } from "../src/alerts/rules";
import { loadPolicy } from "../src/config";
import { LocalEvalEngine } from "../src/eval/engine";
import { EvalRunner } from "../src/eval/runner";
import { SQLiteStore } from "../src/storage/sqliteStore";
import { createClock, makeSpan, tempDb } from "./helpers";

test("injected PII regression is detected by the eval pipeline under the five-minute bound", async () => {
  const { db, cleanup } = tempDb();
  try {
    const store = new SQLiteStore(db);
    const clock = createClock();
    const policy = loadPolicy(undefined, {
      eval: { sampleRate: 1, batchSize: 1000 },
      alerts: { piiMinCount: 2, piiRateThreshold: 0.002, intervalMs: 100 },
    });
    const slackBodies: string[] = [];
    const pagerBodies: string[] = [];
    const dispatcher = new Dispatcher({
      store,
      slackUrl: "http://sink.test/slack",
      pagerDutyKey: "pd_test_only",
      pagerDutyUrl: "http://sink.test/pager",
      nowUs: () => clock.nowUs(),
      fetchImpl: async (input, init) => {
        const url = String(input);
        const body = typeof init?.body === "string" ? init.body : "";
        if (url.includes("slack")) slackBodies.push(body);
        else pagerBodies.push(body);
        return new Response("{}", { status: 200 });
      },
    });
    const alertEngine = new AlertEngine({ store, policy, dispatcher, nowUs: () => clock.nowUs() });
    const evalRunner = new EvalRunner({
      store,
      engine: new LocalEvalEngine(),
      policy: policy.eval,
      nowUs: () => clock.nowUs(),
    });

    const baselineNow = clock.nowUs();
    store.insertSpans(
      Array.from({ length: 300 }, (_, index) =>
        makeSpan({
          traceId: (index + 1).toString(16).padStart(32, "0"),
          spanId: (index + 1).toString(16).padStart(16, "0"),
          appId: "support-bot",
          promptText: "How do I reset my password?",
          completionText: "Use the reset link on the sign-in page.",
          startUs: baselineNow - 3_600_000_000 + index * 1_000_000,
          ingestedAtUs: baselineNow,
        }),
      ),
    );
    await evalRunner.runWindow(baselineNow - 3_600_000_000, baselineNow, baselineNow);
    const baselineAlerts = await alertEngine.evaluate(baselineNow);
    assert.equal(
      baselineAlerts.created.filter((alert) => alert.rule === "PiiLeakDetected").length,
      0,
    );
    assert.ok(!slackBodies.some((body) => body.includes("PII leak")));

    const started = clock.nowUs();
    clock.advance(15_000_000);
    const now = clock.nowUs();
    const leakSpans = Array.from({ length: 200 }, (_, index) =>
      makeSpan({
        traceId: (index + 1000).toString(16).padStart(32, "0"),
        spanId: (index + 1000).toString(16).padStart(16, "0"),
        appId: "support-bot",
        promptText: "Verify the account.",
        completionText:
          index < 3
            ? "Customer SSN is 123-45-6789."
            : "The account is verified. Use the reset link on the sign-in page.",
        piiCompletion: index < 3,
        startUs: now - 1_000_000 + index,
        ingestedAtUs: now,
      }),
    );
    store.insertSpans(leakSpans);
    const result = await evalRunner.runWindow(now - 3_600_000_000, now, now);
    assert.ok(result.sampled >= 200);
    assert.equal(result.piiHigh, 3);
    const alerts = await alertEngine.evaluate(now);
    const piiAlert = alerts.created.find((alert) => alert.rule === "PiiLeakDetected");
    assert.ok(piiAlert, "PII alert should be created");
    assert.equal(piiAlert.severity, "critical");
    assert.ok(slackBodies.some((body) => body.includes("PII leak")));
    assert.ok(pagerBodies.some((body) => body.includes("PII leak")));

    const leak = leakSpans[0];
    const trace = store.getTrace(leak.traceId);
    const piiEval = trace.find((span) => span.isEval && span.evalName === "pii_leak");
    assert.ok(piiEval);
    assert.equal(piiEval.parentSpanId, leak.spanId);
    assert.equal(piiEval.evalPass, false);
    const triage = store.triage("open");
    assert.equal(triage.length, 3);
    assert.ok(triage.every((row) => !row.excerpt.includes("123-45-6789")));
    assert.ok(triage.every((row) => row.excerpt.includes("[redacted:ssn]")));

    const simulatedElapsedUs = clock.nowUs() - started;
    assert.ok(simulatedElapsedUs < 300_000_000, `simulated ${simulatedElapsedUs} us`);
  } finally {
    cleanup();
  }
});
