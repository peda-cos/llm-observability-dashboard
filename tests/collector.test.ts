import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { loadPolicy, loadPricing } from "../src/config";
import { FileArchive } from "../src/ingest/archive";
import { ClickHouseExporter } from "../src/ingest/clickhouseExporter";
import { Collector } from "../src/ingest/collector";
import { createIngestServer } from "../src/ingest/server";
import { TailSampler } from "../src/ingest/tailSampler";
import { buildFamilyTrace, FAMILIES } from "../src/sdk/families";
import { openDb } from "../src/storage/db";
import { SQLiteStore } from "../src/storage/sqliteStore";
import { emptyIngestCounters } from "../src/types";
import { makeSpan } from "./helpers";

async function listen(server: ReturnType<typeof createIngestServer>): Promise<string> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

function setup(successRate = 1) {
  const dir = mkdtempSync(path.join(tmpdir(), "llm-obs-ingest-"));
  const store = new SQLiteStore(openDb(path.join(dir, "obs.db")));
  const archive = new FileArchive(path.join(dir, "archive"));
  const policy = loadPolicy(undefined, {
    sampling: { successRate, decisionWaitMs: 10 },
  });
  const counters = emptyIngestCounters();
  const collector = new Collector({
    store,
    archive,
    sampler: new TailSampler(policy.sampling),
    policy,
    pricing: loadPricing(),
    counters,
    captureContent: true,
  });
  const server = createIngestServer({
    collector,
    policy,
    counters,
    metrics: () => "# test\n",
  });
  return { dir, store, archive, collector, counters, server };
}

async function post(baseUrl: string, payload: unknown, gzip = false): Promise<Response> {
  const body = gzip ? gzipSync(JSON.stringify(payload)) : JSON.stringify(payload);
  return fetch(`${baseUrl}/v1/traces`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(gzip ? { "content-encoding": "gzip" } : {}) },
    body,
  });
}

test("OTLP HTTP ingest lands canonical spans from six families and archives raw payloads", async () => {
  const ctx = setup(1);
  const baseUrl = await listen(ctx.server);
  try {
    for (const family of FAMILIES) {
      const payload = buildFamilyTrace(family, {
        appId: `app-${family}`,
        userId: "u_100",
        sessionId: "s_100",
        prompt: "How do I request a refund?",
        completion: "Refunds are available within 30 days.",
      });
      const response = await post(baseUrl, payload);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {});
      await ctx.collector.flush(true);
    }
    const all = ctx.store.search({ limit: 100 });
    assert.equal(all.total, 8);
    assert.equal(ctx.store.countSpans(), 8);
    assert.equal(ctx.archive.list().length, 6);
    const families = new Set(all.rows.map((row) => row.instrumentationFamily));
    assert.deepEqual([...families].sort(), ["anthropic", "google", "langchain", "llamaindex", "openai", "vllm"]);
    const chatRows = all.rows.filter((row) => row.completionText !== null);
    assert.equal(chatRows.length, 6);
    for (const row of chatRows) {
      assert.equal(row.appId, `app-${row.instrumentationFamily}`);
      assert.ok(row.inputTokens > 0);
      assert.ok(row.costUsd > 0);
      assert.equal(row.promptText, "How do I request a refund?");
      assert.equal(row.completionText, "Refunds are available within 30 days.");
    }
    assert.equal(ctx.counters.offered, 8);
    assert.equal(ctx.counters.kept, 8);
    assert.equal(ctx.counters.rejected, 0);

    const archivedKey = ctx.archive.list()[0];
    const archived = await ctx.archive.read(archivedKey);
    assert.ok(archived && typeof archived === "object");

    const gzipPayload = buildFamilyTrace("openai", {
      appId: "gzip-app",
      userId: "u_gzip",
      sessionId: "s_gzip",
      prompt: "gzip prompt",
      completion: "gzip completion",
    });
    const gzipResponse = await post(baseUrl, gzipPayload, true);
    assert.equal(gzipResponse.status, 200);
    await ctx.collector.flush(true);
    assert.equal(ctx.store.countSpans(), 9);
  } finally {
    ctx.server.close();
    ctx.store.close();
    rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test("tail sampling keeps errors and PII at zero success rate and drops clean traces", async () => {
  const ctx = setup(0);
  const baseUrl = await listen(ctx.server);
  try {
    const errorPayload = buildFamilyTrace("openai", {
      appId: "error-app",
      userId: "u_error",
      sessionId: "s_error",
      prompt: "timeout",
      completion: "",
      error: true,
      traceId: "1".repeat(32),
    });
    assert.equal((await post(baseUrl, errorPayload)).status, 200);
    await ctx.collector.flush(true);
    assert.equal(ctx.store.countSpans(), 1);

    const cleanPayload = buildFamilyTrace("openai", {
      appId: "clean-app",
      userId: "u_clean",
      sessionId: "s_clean",
      prompt: "clean",
      completion: "clean answer",
      traceId: "2".repeat(32),
    });
    assert.equal((await post(baseUrl, cleanPayload)).status, 200);
    await ctx.collector.flush(true);
    assert.equal(ctx.store.countSpans(), 1);
    assert.equal(ctx.counters.dropped, 1);

    const piiPayload = buildFamilyTrace("openai", {
      appId: "pii-app",
      userId: "u_pii",
      sessionId: "s_pii",
      prompt: "account help",
      completion: "Customer SSN is 123-45-6789.",
      traceId: "3".repeat(32),
    });
    assert.equal((await post(baseUrl, piiPayload)).status, 200);
    await ctx.collector.flush(true);
    assert.equal(ctx.store.countSpans(), 2);
    const rows = ctx.store.search({ limit: 10 }).rows;
    assert.equal(rows.find((row) => row.traceId === "3".repeat(32))?.piiCompletion, true);
  } finally {
    ctx.server.close();
    ctx.store.close();
    rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test("collector server rejects malformed JSON and payloads", async () => {
  const ctx = setup(1);
  const baseUrl = await listen(ctx.server);
  try {
    const malformed = await fetch(`${baseUrl}/v1/traces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    assert.equal(malformed.status, 400);
    const missing = await fetch(`${baseUrl}/v1/traces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(missing.status, 400);
    assert.equal((await fetch(`${baseUrl}/healthz`)).status, 200);
    assert.equal((await fetch(`${baseUrl}/metrics`)).status, 200);
    assert.equal((await fetch(`${baseUrl}/nope`)).status, 404);
  } finally {
    ctx.server.close();
    ctx.store.close();
    rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test("ClickHouse exporter sends JSONEachRow with the canonical columns", async () => {
  let capturedUrl = "";
  let capturedBody = "";
  let capturedAuth = "";
  const mock = createServer((request, response) => {
    capturedUrl = request.url ?? "";
    capturedAuth = String(request.headers.authorization ?? "");
    let body = "";
    request.on("data", (chunk) => {
      body += chunk.toString();
    });
    request.on("end", () => {
      capturedBody = body;
      response.writeHead(200);
      response.end();
    });
  });
  mock.listen(0, "127.0.0.1");
  await once(mock, "listening");
  const port = (mock.address() as AddressInfo).port;
  try {
    const exporter = new ClickHouseExporter({
      url: `http://127.0.0.1:${port}`,
      database: "observability",
      username: "demo",
      password: "secret",
    });
    const rows = [
      makeSpan({ spanId: "a".repeat(16) }),
      makeSpan({ spanId: "b".repeat(16) }),
    ];
    await exporter.insert(rows);
    assert.ok(capturedUrl.includes("database=observability"));
    assert.ok(capturedUrl.includes("INSERT%20INTO%20spans%20FORMAT%20JSONEachRow"));
    assert.ok(capturedAuth.startsWith("Basic "));
    const lines = capturedBody.trim().split("\n");
    assert.equal(lines.length, 2);
    const first = JSON.parse(lines[0]) as Record<string, unknown>;
    assert.equal(first.start_time_unix_micros, rows[0].startUs);
    assert.ok("pii_completion" in first);
    assert.ok("attributes" in first);
    assert.equal(first.is_eval, 0);
  } finally {
    mock.close();
  }
});
