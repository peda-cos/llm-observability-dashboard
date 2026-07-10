import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createObsService } from "../service";
import { buildFamilyTrace } from "../sdk/families";
import type { OtlpResourceSpans } from "../otlp/types";

function option(name: string, fallback: number): number {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  return Number(process.argv[index + 1] ?? fallback);
}

function sleep(ms: number): Promise<void> {
  const done = Promise.withResolvers<void>();
  setTimeout(done.resolve, Math.max(0, ms));
  return done.promise;
}

function batch(count: number): { resourceSpans: OtlpResourceSpans[] } {
  const resourceSpans: OtlpResourceSpans[] = [];
  for (let index = 0; index < count; index += 1) {
    const payload = buildFamilyTrace("openai", {
      appId: index % 2 === 0 ? "support-bot" : "docs-search",
      userId: `u_load_${index % 12}`,
      sessionId: `s_load_${index % 50}`,
      prompt: "How do I request a refund?",
      completion: "Refunds are available within 30 days of purchase.",
      startUs: Date.now() * 1000,
    });
    resourceSpans.push(...payload.resourceSpans);
  }
  return { resourceSpans };
}

const targetRate = Math.max(1, option("rate", 1000));
const seconds = Math.max(1, option("seconds", 20));
const batchSize = Math.max(1, option("batch", 100));
const batchesPerSecond = Math.max(1, Math.ceil(targetRate / batchSize));
const intervalMs = 1000 / batchesPerSecond;
const tempDir = mkdtempSync(path.join(tmpdir(), "llm-obs-load-"));
const service = createObsService({
  dbPath: path.join(tempDir, "obs.db"),
  archiveDir: path.join(tempDir, "archive"),
  enableWorker: false,
  policyOverrides: {
    sampling: { successRate: 1, decisionWaitMs: 10 },
    storage: { maxBodyBytes: 16 * 1024 * 1024 },
  },
  env: { LOG_LEVEL: "warn" },
});
try {
  const address = await service.start();
  const started = performance.now();
  let sent = 0;
  let maxPending = 0;
  const latencies: number[] = [];
  while ((performance.now() - started) / 1000 < seconds) {
    const requestStarted = performance.now();
    const response = await fetch(`${address.url}/v1/traces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(batch(batchSize)),
    });
    if (!response.ok) throw new Error(`ingest failed: HTTP ${response.status}`);
    sent += batchSize;
    latencies.push(performance.now() - requestStarted);
    maxPending = Math.max(maxPending, service.collector.pendingTraces());
    await sleep(intervalMs - (performance.now() - requestStarted));
  }
  await service.collector.flush(true);
  const elapsedSeconds = (performance.now() - started) / 1000;
  const stored = service.store.countSpans();
  const sorted = [...latencies].sort((left, right) => left - right);
  const p95 = sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * 0.95))] ?? 0;
  const result = {
    target_rate: targetRate,
    requested_rate: batchesPerSecond * batchSize,
    measured_rate: stored / elapsedSeconds,
    seconds: elapsedSeconds,
    sent,
    stored,
    kept_ratio: sent > 0 ? stored / sent : 0,
    requests: latencies.length,
    p95_post_ms: p95,
    max_pending_traces: maxPending,
    rss_mb: process.memoryUsage().rss / 1_000_000,
  };
  mkdirSync("results", { recursive: true });
  writeFileSync("results/loadtest.json", `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
  if (stored < sent * 0.99) {
    console.error(`[load] stored ${stored} of ${sent} spans`);
    process.exitCode = 1;
  }
} finally {
  await service.close();
  rmSync(tempDir, { recursive: true, force: true });
}
