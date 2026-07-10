import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { loadPolicy } from "../config";
import { LocalEvalEngine, metricPass } from "../eval/engine";
import type { EvalMetric } from "../eval/metrics";

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
  readFileSync(new URL("../../tests/fixtures/eval-labels.json", import.meta.url), "utf8"),
) as LabelCase[];
const policy = loadPolicy();
const engine = new LocalEvalEngine();
const results: {
  id: string;
  scores: Record<string, number>;
  expected: Record<string, number>;
  passAgreement: boolean;
}[] = [];
let absoluteError = 0;
let compared = 0;
let passMatches = 0;
let passTotal = 0;

for (const label of cases) {
  const outputs = await engine.evaluate({
    prompt: label.prompt,
    completion: label.completion,
    retrieval: label.context ?? null,
    expectedIds: label.expectedIds ?? null,
  });
  const scores: Record<string, number> = {};
  let agreement = true;
  for (const [metric, expectedScore] of Object.entries(label.expected) as [EvalMetric, number][]) {
    const output = outputs.find((entry) => entry.metric === metric);
    if (!output) {
      agreement = false;
      continue;
    }
    scores[metric] = output.score;
    absoluteError += Math.abs(output.score - expectedScore);
    compared += 1;
  }
  for (const [metric, expectedPass] of Object.entries(label.pass) as [EvalMetric, boolean][]) {
    const output = outputs.find((entry) => entry.metric === metric);
    passTotal += 1;
    if (output && metricPass(output.metric, output.score, policy.eval) === expectedPass) {
      passMatches += 1;
    } else {
      agreement = false;
    }
  }
  results.push({ id: label.id, scores, expected: label.expected, passAgreement: agreement });
}

const report = {
  engine: engine.name,
  cases: results,
  metricValues: compared,
  mae: compared > 0 ? absoluteError / compared : 0,
  passAgreement: passTotal > 0 ? passMatches / passTotal : 0,
};
mkdirSync("results", { recursive: true });
writeFileSync("results/eval-quality.json", `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
