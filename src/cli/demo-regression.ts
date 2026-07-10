import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { tmpdir } from "node:os";
import path from "node:path";
import { createObsService } from "../service";
import { buildFamilyTrace } from "../sdk/families";
import type { OtlpResourceSpans } from "../otlp/types";

interface MockSink {
  url: string;
  messages: string[];
  close: () => Promise<void>;
}

async function mockSink(): Promise<MockSink> {
  const messages: string[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk.toString();
    });
    request.on("end", () => {
      messages.push(body);
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    messages,
    close: async () => {
      const closed = Promise.withResolvers<void>();
      server.close(() => closed.resolve());
      await closed.promise;
    },
  };
}

function sleep(ms: number): Promise<void> {
  const done = Promise.withResolvers<void>();
  setTimeout(done.resolve, ms);
  return done.promise;
}

let sentTraces = 0;
function buildBatch(leak: boolean, count = 10): { resourceSpans: OtlpResourceSpans[] } {
  const resourceSpans: OtlpResourceSpans[] = [];
  for (let index = 0; index < count; index += 1) {
    sentTraces += 1;
    const leaking = leak && sentTraces % 100 === 0;
    const payload = buildFamilyTrace("openai", {
      appId: "support-bot",
      userId: `u_demo_${sentTraces % 12}`,
      sessionId: `s_demo_${sentTraces % 50}`,
      prompt: "My refund has not arrived. Please help.",
      completion: leaking
        ? "Customer SSN is 123-45-6789. The refund is queued."
        : "Refunds are available within 30 days of purchase.",
      startUs: Date.now() * 1000,
    });
    resourceSpans.push(...payload.resourceSpans);
  }
  return { resourceSpans };
}

const tempDir = mkdtempSync(path.join(tmpdir(), "llm-obs-mttd-"));
const slack = await mockSink();
const pager = await mockSink();
let service: ReturnType<typeof createObsService> | null = null;
let failure: string | null = null;
try {
  service = createObsService({
    dbPath: path.join(tempDir, "obs.db"),
    archiveDir: path.join(tempDir, "archive"),
    enableWorker: true,
    policyOverrides: {
      sampling: { successRate: 1, decisionWaitMs: 10 },
      eval: { windowMs: 300_000, sampleRate: 1, batchSize: 200, intervalMs: 300 },
      alerts: { intervalMs: 300, piiMinCount: 2, piiRateThreshold: 0.002 },
    },
    env: {
      SLACK_WEBHOOK_URL: slack.url,
      PAGERDUTY_ROUTING_KEY: "pd_test_only",
      PAGERDUTY_URL: pager.url,
      CAPTURE_CONTENT: "1",
      LOG_LEVEL: "warn",
    },
  });
  const address = await service.start();
  const postBatch = async (leak: boolean): Promise<void> => {
    const response = await fetch(`${address.url}/v1/traces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(buildBatch(leak)),
    });
    if (!response.ok) throw new Error(`ingest failed: HTTP ${response.status}`);
  };

  for (let batchIndex = 0; batchIndex < 50; batchIndex += 1) {
    await postBatch(false);
    await sleep(100);
  }
  await sleep(2000);
  const baselineAlerts = service.store
    .listAlerts(50)
    .filter((alert) => alert.rule === "PiiLeakDetected").length;
  if (baselineAlerts !== 0) throw new Error(`expected zero baseline PII alerts, got ${baselineAlerts}`);
  if (slack.messages.some((message) => message.includes("PII leak"))) {
    throw new Error("baseline produced a PII Slack message");
  }

  const started = performance.now();
  let detected = false;
  while (performance.now() - started < 60_000) {
    await postBatch(true);
    await sleep(100);
    if (slack.messages.some((message) => message.includes("PII leak"))) {
      detected = true;
      break;
    }
  }
  const mttdMs = Math.round(performance.now() - started);
  if (!detected) throw new Error("PII regression was not detected within 60 seconds");
  if (mttdMs >= 300_000) throw new Error(`MTTD ${mttdMs} ms exceeds five minutes`);

  const alerts = service.store.listAlerts(50);
  const piiAlert = alerts.find((alert) => alert.rule === "PiiLeakDetected");
  if (!piiAlert) throw new Error("PII alert missing from the store");
  if (pager.messages.length === 0) throw new Error("critical PII alert did not reach PagerDuty");

  const result = {
    scenario: "injected-ssn-1pct",
    mttd_ms: mttdMs,
    spans_after_injection: sentTraces - 500,
    baseline_spans: 500,
    leak_rate: 0.01,
    baseline_pii_alerts: baselineAlerts,
    eval_spans: service.store.countEvalSpans(),
    alerts: alerts.length,
    slack_messages: slack.messages.length,
    pagerduty_messages: pager.messages.length,
    sink: "slack+pagerduty",
  };
  mkdirSync("results", { recursive: true });
  writeFileSync("results/mttd.json", `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  failure = (error as Error).message;
  console.error(`[mttd] ${failure}`);
} finally {
  if (service) await service.close();
  await slack.close();
  await pager.close();
  rmSync(tempDir, { recursive: true, force: true });
}
if (failure) process.exitCode = 1;
