import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import test from "node:test";
import { loadPolicy } from "../src/config";
import { LocalEvalEngine, metricPass } from "../src/eval/engine";
import { LlmPiiJudge, type PiiJudge } from "../src/eval/judge";
import type { EvalMetric } from "../src/eval/metrics";

interface LabelCase {
  id: string;
  prompt: string;
  completion: string;
  context?: { id: string; text: string }[];
  expectedIds?: string[];
  expected: Record<string, number>;
  pass: Record<string, boolean>;
}

const cases = JSON.parse(
  readFileSync(new URL("./fixtures/eval-labels.json", import.meta.url), "utf8"),
) as LabelCase[];

test("local eval engine agrees with hand-labeled scores and pass labels", async () => {
  const engine = new LocalEvalEngine();
  const policy = loadPolicy();
  let absoluteError = 0;
  let compared = 0;
  for (const label of cases) {
    const outputs = await engine.evaluate({
      prompt: label.prompt,
      completion: label.completion,
      retrieval: label.context ?? null,
      expectedIds: label.expectedIds ?? null,
    });
    const byMetric = new Map(outputs.map((output) => [output.metric, output]));
    for (const [metric, expectedScore] of Object.entries(label.expected) as [EvalMetric, number][]) {
      const output = byMetric.get(metric);
      assert.ok(output, `${label.id}: missing ${metric}`);
      absoluteError += Math.abs(output.score - expectedScore);
      compared += 1;
      assert.ok(
        Math.abs(output.score - expectedScore) <= 0.15,
        `${label.id}: ${metric} expected ~${expectedScore}, got ${output.score}`,
      );
    }
    for (const [metric, expectedPass] of Object.entries(label.pass) as [EvalMetric, boolean][]) {
      const output = byMetric.get(metric);
      assert.ok(output, `${label.id}: missing ${metric}`);
      assert.equal(
        metricPass(output.metric, output.score, policy.eval),
        expectedPass,
        `${label.id}: ${metric} pass label`,
      );
    }
  }
  assert.ok(compared >= 15, `compared ${compared} metric values`);
  assert.ok(absoluteError / compared <= 0.15, `MAE ${absoluteError / compared}`);
});

test("metrics that need retrieval context are omitted when context is absent", async () => {
  const engine = new LocalEvalEngine();
  const outputs = await engine.evaluate({
    prompt: "hello",
    completion: "hello there",
    retrieval: null,
    expectedIds: null,
  });
  const metrics = outputs.map((output) => output.metric);
  assert.ok(!metrics.includes("faithfulness"));
  assert.ok(!metrics.includes("context_precision"));
  assert.ok(!metrics.includes("context_recall"));
  assert.ok(metrics.includes("toxicity"));
  assert.ok(metrics.includes("answer_relevance"));
  assert.ok(metrics.includes("pii_leak"));
});

test("LLM guard judge sends the rubric and parses JSON scores", async () => {
  let requestBody = "";
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk.toString();
    });
    request.on("end", () => {
      requestBody = body;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ score: 0.91, reason: "SSN in completion" }) } }],
        }),
      );
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  try {
    const judge = new LlmPiiJudge({
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: "sk_test_only",
      model: "guard-test",
    });
    const result = await judge.score({
      prompt: "account help",
      completion: "The SSN is 123-45-6789.",
    });
    assert.equal(result.score, 0.91);
    assert.equal(result.reason, "SSN in completion");
    assert.ok(requestBody.includes("Score only the assistant completion"));
    assert.ok(requestBody.includes("guard-test"));
    assert.ok(requestBody.includes("123-45-6789"));
  } finally {
    server.close();
  }
});

test("a failing guard judge falls back to the local detector", async () => {
  class FailingJudge implements PiiJudge {
    readonly name = "failing";
    async score(): Promise<{ score: number; reason: string }> {
      throw new Error("provider unavailable");
    }
  }
  const engine = new LocalEvalEngine(new FailingJudge());
  const outputs = await engine.evaluate({
    prompt: null,
    completion: "Customer SSN is 123-45-6789.",
    retrieval: null,
    expectedIds: null,
  });
  const pii = outputs.find((output) => output.metric === "pii_leak");
  assert.ok(pii);
  assert.equal(pii.score, 1);
  assert.equal(pii.engine, "local-v1+pii-fallback");
  assert.ok(pii.reason.startsWith("judge fallback:"));
});
