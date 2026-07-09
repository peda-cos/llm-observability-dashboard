import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { handleAlertmanagerWebhook, parseAlertmanagerWebhook } from "../src/alerts/alertmanager";
import { Dispatcher } from "../src/alerts/dispatch";
import { renderMetrics } from "../src/alerts/prometheus";
import { AlertEngine } from "../src/alerts/rules";
import { loadPolicy } from "../src/config";
import { SQLiteStore } from "../src/storage/sqliteStore";
import { emptyIngestCounters } from "../src/types";
import { createClock, makeEvalSpan, makeSpan, tempDb } from "./helpers";

interface Captured {
  url: string;
  body: string;
}

async function mockEndpoint(): Promise<{
  url: string;
  captured: Captured[];
  server: ReturnType<typeof createServer>;
}> {
  const captured: Captured[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk.toString();
    });
    request.on("end", () => {
      captured.push({ url: request.url ?? "", body });
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, captured, server };
}

test("latency warning goes to Slack only; PII critical goes to Slack and PagerDuty", async () => {
  const slack = await mockEndpoint();
  const pager = await mockEndpoint();
  const { db, cleanup } = tempDb();
  try {
    const store = new SQLiteStore(db);
    const clock = createClock();
    const now = clock.nowUs();
    const policy = loadPolicy();
    const dispatcher = new Dispatcher({
      store,
      slackUrl: slack.url,
      pagerDutyKey: "pd_test_only",
      pagerDutyUrl: pager.url,
      nowUs: () => now,
    });
    const engine = new AlertEngine({ store, policy, dispatcher, nowUs: () => now });

    store.insertSpans(
      Array.from({ length: 25 }, (_, index) =>
        makeSpan({
          traceId: (index + 1).toString(16).padStart(32, "0"),
          spanId: (index + 100).toString(16).padStart(16, "0"),
          appId: "latency-app",
          latencyMs: 3000,
          startUs: now - 10_000_000 - index,
          ingestedAtUs: now,
        }),
      ),
    );
    const warning = await engine.evaluate(now);
    assert.equal(warning.created.length, 1);
    assert.equal(warning.created[0].rule, "LatencyP95High");
    assert.equal(warning.created[0].severity, "warning");
    assert.equal(slack.captured.length, 1);
    assert.equal(pager.captured.length, 0);
    assert.ok(slack.captured[0].body.includes("Elevated p95 latency"));
    assert.equal(store.getDeliveries(warning.created[0].id).length, 2);

    const piiParents = Array.from({ length: 10 }, (_, index) =>
      makeSpan({
        traceId: (index + 200).toString(16).padStart(32, "0"),
        spanId: (index + 200).toString(16).padStart(16, "0"),
        appId: "pii-app",
        startUs: now - 20_000_000 - index,
        ingestedAtUs: now,
      }),
    );
    store.insertSpans(piiParents);
    store.insertSpans(
      piiParents.flatMap((parent, index) => [
        makeEvalSpan(parent, {
          evalName: "pii_leak",
          evalScore: index < 2 ? 1 : 0,
          evalPass: index >= 2,
        }),
      ]),
    );
    const critical = await engine.evaluate(now);
    const piiAlert = critical.created.find((alert) => alert.rule === "PiiLeakDetected");
    assert.ok(piiAlert);
    assert.equal(piiAlert.severity, "critical");
    assert.ok(slack.captured.length >= 2);
    assert.equal(pager.captured.length, 1);
    const pagerBody = JSON.parse(pager.captured[0].body) as {
      event_action: string;
      dedup_key: string;
      payload: { severity: string; summary: string };
    };
    assert.equal(pagerBody.event_action, "trigger");
    assert.equal(pagerBody.dedup_key, piiAlert.fingerprint);
    assert.equal(pagerBody.payload.severity, "critical");
    assert.ok(pagerBody.payload.summary.includes("PII leak"));

    const beforeSlack = slack.captured.length;
    const repeat = await engine.evaluate(now);
    assert.equal(repeat.created.length, 0);
    assert.equal(slack.captured.length, beforeSlack);
    const stored = store.getAlert(piiAlert.id);
    assert.ok(stored);
    assert.ok(stored.occurrences >= 2);
  } finally {
    slack.server.close();
    pager.server.close();
    cleanup();
  }
});

test("missing webhook config records skipped deliveries without throwing", async () => {
  const { db, cleanup } = tempDb();
  try {
    const store = new SQLiteStore(db);
    const now = createClock().nowUs();
    const policy = loadPolicy();
    const dispatcher = new Dispatcher({ store, nowUs: () => now });
    const engine = new AlertEngine({ store, policy, dispatcher, nowUs: () => now });
    store.insertSpans(
      Array.from({ length: 25 }, (_, index) =>
        makeSpan({
          traceId: (index + 1).toString(16).padStart(32, "0"),
          spanId: (index + 300).toString(16).padStart(16, "0"),
          appId: "quiet-app",
          latencyMs: 7000,
          startUs: now - 10_000_000 - index,
          ingestedAtUs: now,
        }),
      ),
    );
    const result = await engine.evaluate(now);
    assert.equal(result.created.length, 1);
    const deliveries = store.getDeliveries(result.created[0].id);
    assert.equal(deliveries.find((row) => row.sink === "local")?.status, "sent");
    assert.equal(deliveries.find((row) => row.sink === "slack")?.status, "skipped");
    assert.equal(deliveries.find((row) => row.sink === "pagerduty")?.status, "skipped");
  } finally {
    cleanup();
  }
});

test("Prometheus exposition carries the alert-rule metric families", () => {
  const { db, cleanup } = tempDb();
  try {
    const store = new SQLiteStore(db);
    const now = createClock().nowUs();
    store.insertSpans(
      Array.from({ length: 25 }, (_, index) =>
        makeSpan({
          traceId: (index + 1).toString(16).padStart(32, "0"),
          spanId: (index + 400).toString(16).padStart(16, "0"),
          appId: "metrics-app",
          latencyMs: index === 0 ? 6000 : 100,
          costUsd: 0.01,
          statusCode: index === 0 ? 2 : 1,
          startUs: now - 10_000_000 - index,
          ingestedAtUs: now,
        }),
      ),
    );
    const parent = store.search({ limit: 1 }).rows[0];
    store.insertSpans([
      makeEvalSpan(parent, { evalName: "pii_leak", evalScore: 1, evalPass: false }),
      makeEvalSpan(parent, { evalName: "pii_leak", evalScore: 0, evalPass: true }),
      makeEvalSpan(parent, { evalName: "faithfulness", evalScore: 0.4, evalPass: false }),
    ]);
    const counters = { ...emptyIngestCounters(), offered: 100, kept: 80, dropped: 15, rejected: 5 };
    const text = renderMetrics(store, counters, now);
    assert.ok(text.includes("# TYPE llm_pii_positive_ratio gauge"));
    assert.ok(text.includes('llm_pii_positive_ratio{app="metrics-app"} 0.5'));
    assert.ok(text.includes('llm_latency_p95_ms{app="metrics-app"}'));
    assert.ok(text.includes('llm_error_ratio{app="metrics-app"} 0.04'));
    assert.ok(text.includes('llm_cost_usd_total{app="metrics-app"} 0.25'));
    assert.ok(text.includes('llm_eval_score{metric="faithfulness",app="metrics-app"} 0.4'));
    assert.ok(text.includes('llm_spans_ingested_total{decision="offered"} 100'));
    assert.ok(text.includes("llm_open_alerts"));
  } finally {
    cleanup();
  }
});

test("Alertmanager v4 webhook creates and resolves alerts through the dispatcher", async () => {
  const slack = await mockEndpoint();
  const { db, cleanup } = tempDb();
  try {
    const store = new SQLiteStore(db);
    const now = createClock().nowUs();
    const dispatcher = new Dispatcher({ store, slackUrl: slack.url, nowUs: () => now });
    const payload = {
      version: "4",
      groupKey: "{}:{alertname=\"PiiLeakDetected\"}",
      truncatedAlerts: 0,
      status: "firing",
      receiver: "critical-fanout",
      groupLabels: { alertname: "PiiLeakDetected" },
      commonLabels: { alertname: "PiiLeakDetected", severity: "critical", app: "webhook-app" },
      commonAnnotations: { summary: "PII leak from Alertmanager" },
      externalURL: "http://localhost:9093",
      alerts: [
        {
          status: "firing",
          labels: { alertname: "PiiLeakDetected", severity: "critical", app: "webhook-app" },
          annotations: { summary: "PII leak from Alertmanager", description: "2 evals" },
          startsAt: new Date(now / 1000).toISOString(),
          endsAt: "0001-01-01T00:00:00Z",
          generatorURL: "http://localhost:9090",
          fingerprint: "abcdef0123456789",
        },
      ],
    };
    const parsed = parseAlertmanagerWebhook(payload);
    assert.equal(parsed.length, 1);
    const result = await handleAlertmanagerWebhook(payload, { store, dispatcher, nowUs: () => now });
    assert.deepEqual(result, { received: 1, fired: 1, resolved: 0, created: 1 });
    assert.equal(slack.captured.length, 1);
    const stored = store.listAlerts();
    assert.equal(stored.length, 1);
    assert.equal(stored[0].appId, "webhook-app");
    assert.equal(stored[0].status, "open");

    const resolved = await handleAlertmanagerWebhook(
      {
        ...payload,
        alerts: [{ ...payload.alerts[0], status: "resolved" }],
      },
      { store, dispatcher, nowUs: () => now + 1_000_000 },
    );
    assert.equal(resolved.resolved, 1);
    assert.equal(store.listAlerts()[0].status, "acked");
    assert.throws(() => parseAlertmanagerWebhook({ version: "3", alerts: [] }), /version/);
  } finally {
    slack.server.close();
    cleanup();
  }
});
