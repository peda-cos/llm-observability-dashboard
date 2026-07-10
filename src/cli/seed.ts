import { mkdirSync, writeFileSync } from "node:fs";
import { AlertEngine } from "../alerts/rules";
import { Dispatcher } from "../alerts/dispatch";
import { costUsd, loadPolicy, loadPricing } from "../config";
import { DriftDetector } from "../drift/detector";
import { LocalEvalEngine } from "../eval/engine";
import { LocalPiiJudge } from "../eval/judge";
import { EvalRunner } from "../eval/runner";
import { newSpanId, newTraceId, promptHash } from "../ids";
import { detectPii, hasCompletionPii } from "../pii";
import { FAMILIES, type Family } from "../sdk/families";
import { openDb } from "../storage/db";
import { SQLiteStore } from "../storage/sqliteStore";
import type { JsonValue, RetrievalDoc, SpanRow } from "../types";

const DAY_US = 86_400_000_000;

interface AppDefinition {
  id: string;
  name: string;
  team: string;
  topics: string[];
  currentTopic: string;
  answers: Record<string, string>;
}

const apps: AppDefinition[] = [
  {
    id: "support-bot",
    name: "Support Bot",
    team: "Customer Experience",
    topics: [
      "refund policy billing invoice charge",
      "reset password sign in account",
      "shipping delivery tracking parcel",
      "order status delivery estimate",
    ],
    currentTopic: "refund escalation chargeback dispute urgent customer",
    answers: {
      "refund policy billing invoice charge":
        "Refunds are available within 30 days of purchase through the billing portal.",
      "reset password sign in account": "Use the reset link on the sign-in page.",
      "shipping delivery tracking parcel": "Standard shipping takes three to five business days.",
      "order status delivery estimate": "Track the order from the confirmation email.",
      "refund escalation chargeback dispute urgent customer":
        "Escalate the chargeback to the billing team within one business day.",
    },
  },
  {
    id: "docs-search",
    name: "Docs Search",
    team: "Developer Experience",
    topics: [
      "install sdk authentication token",
      "retry webhook delivery signature",
      "pagination cursor rate limit",
      "vector index embedding dimensions",
    ],
    currentTopic: "install sdk authentication token",
    answers: {
      "install sdk authentication token": "Install the SDK and pass the API token from the environment.",
      "retry webhook delivery signature": "Verify the signature and retry with exponential backoff.",
      "pagination cursor rate limit": "Use the cursor parameter and respect the rate limit headers.",
      "vector index embedding dimensions": "The index expects 128-dimensional normalized embeddings.",
    },
  },
  {
    id: "sales-copilot",
    name: "Sales Copilot",
    team: "Revenue",
    topics: [
      "pricing objection enterprise plan",
      "security review data retention",
      "contract terms annual billing",
      "migration onboarding timeline",
    ],
    currentTopic: "pricing objection enterprise plan",
    answers: {
      "pricing objection enterprise plan": "The enterprise plan includes volume pricing and SSO.",
      "security review data retention": "Data retention is configurable and encrypted at rest.",
      "contract terms annual billing": "Annual billing includes a 15 percent discount.",
      "migration onboarding timeline": "Migration usually completes in two weeks.",
    },
  },
  {
    id: "code-assistant",
    name: "Code Assistant",
    team: "Platform",
    topics: [
      "typescript generic error inference",
      "react hook dependency cleanup",
      "sql query index plan",
      "python async timeout retry",
    ],
    currentTopic: "typescript generic error inference",
    answers: {
      "typescript generic error inference": "Narrow the generic with a discriminated union before indexing.",
      "react hook dependency cleanup": "Include the dependency and guard the effect cleanup.",
      "sql query index plan": "Check the query plan and add a composite index.",
      "python async timeout retry": "Wrap the coroutine with a timeout and bounded retry.",
    },
  },
];

const userNames = [
  "Avery Chen",
  "Jordan Patel",
  "Riley Novak",
  "Casey Morgan",
  "Taylor Brooks",
  "Morgan Silva",
  "Devon Park",
  "Quinn Foster",
  "Reese Kim",
  "Skyler Ortiz",
  "Drew Hassan",
  "Emerson Reed",
];
const users = userNames.map((displayName, index) => ({
  id: `u_${String(index + 1).padStart(3, "0")}`,
  displayName,
  tier: index % 3 === 0 ? "pro" : "free",
}));

const modelByFamily: Record<Family, string> = {
  openai: "gpt-4o-mini",
  anthropic: "claude-3-5-sonnet-20241022",
  google: "gemini-1.5-flash",
  langchain: "gpt-4o-mini",
  llamaindex: "gpt-4o-mini",
  vllm: "meta-llama/Llama-3.1-8B-Instruct",
};
const providerByFamily: Record<Family, string> = {
  openai: "openai",
  anthropic: "anthropic",
  google: "gcp.gemini",
  langchain: "openai",
  llamaindex: "openai",
  vllm: "vllm",
};

const args = process.argv.slice(2);
const reset = !args.includes("--no-reset");
const nowUs = Date.now() * 1000;
const policy = loadPolicy(undefined, { eval: { sampleRate: 0.25, batchSize: 1000 } });
const pricing = loadPricing();
const db = openDb();
const store = new SQLiteStore(db);
if (reset) {
  db.exec(`
    DELETE FROM alert_deliveries;
    DELETE FROM alerts;
    DELETE FROM triage_queue;
    DELETE FROM drift_runs;
    DELETE FROM eval_runs;
    DELETE FROM spans;
    DELETE FROM sessions;
    DELETE FROM apps;
    DELETE FROM users;
  `);
}
store.upsertApps(apps.map((app) => ({ id: app.id, name: app.name, team: app.team, createdUs: nowUs })));
store.upsertUsers(users.map((user) => ({ ...user, createdUs: nowUs })));
store.insertSessions(
  apps.flatMap((app, appIndex) =>
    Array.from({ length: 35 }, (_, day) => ({
      id: `s_${app.id}_${day}`,
      userId: users[(day + appIndex) % users.length].id,
      appId: app.id,
      startedUs: nowUs - day * DAY_US,
    })),
  ),
);

const rows: SpanRow[] = [];
let sequence = 0;
function flushRows(): void {
  if (rows.length === 0) return;
  store.insertSpans(rows.splice(0));
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
}

function addSpan(
  app: AppDefinition,
  startUs: number,
  index: number,
  options: { leak?: boolean; unsupported?: boolean; latencyMs?: number } = {},
): void {
  sequence += 1;
  const family = FAMILIES[sequence % FAMILIES.length];
  const model = modelByFamily[family];
  const currentWeek = startUs >= nowUs - 7 * DAY_US;
  const topic =
    app.id === "support-bot" && currentWeek && index % 10 < 5 ? app.currentTopic : app.topics[index % app.topics.length];
  const variants = ["Please help.", "Need guidance.", "Quick question."];
  const prompt = `${topic}. ${variants[sequence % variants.length]}`;
  let completion = app.answers[topic] ?? app.answers[app.topics[0]];
  if (options.unsupported) completion = "The refund window is 90 days. Cats can fly to Mars.";
  if (options.leak) completion = "Customer SSN is 123-45-6789.";
  const latencyMs = options.latencyMs ?? 80 + (sequence % 7) * 35;
  const inputTokens = 80 + (sequence % 11) * 17;
  const outputTokens = 30 + (sequence % 5) * 11;
  const price = costUsd(pricing, model, inputTokens, outputTokens);
  const pii = [...detectPii(prompt, "prompt"), ...detectPii(completion, "completion")];
  const docId = `doc-${slug(topic)}`;
  const retrieval: RetrievalDoc[] | null =
    family === "llamaindex"
      ? [
          { id: docId, text: completion, score: 0.9 },
          { id: "doc-shipping", text: "Standard shipping takes three to five business days." },
        ]
      : null;
  const attributes: Record<string, JsonValue> = { "seed.synthetic": true };
  if (retrieval) attributes["retrieval.expected_ids"] = JSON.stringify([docId]);
  rows.push({
    spanId: newSpanId(),
    traceId: newTraceId(),
    parentSpanId: null,
    name: `chat ${model}`,
    kind: "client",
    startUs,
    endUs: startUs + latencyMs * 1000,
    latencyMs,
    statusCode: sequence % 97 === 0 ? 2 : 1,
    statusMessage: sequence % 97 === 0 ? "synthetic upstream error" : null,
    genAiSystem: providerByFamily[family],
    requestModel: model,
    responseModel: model,
    responseId: `seed-${sequence}`,
    operation: "chat",
    inputTokens,
    outputTokens,
    costUsd: price.usd,
    promptHash: promptHash(prompt),
    appId: app.id,
    userId: users[sequence % users.length].id,
    sessionId: `s_${app.id}_${Math.floor((nowUs - startUs) / DAY_US)}`,
    environment: "seed",
    instrumentationFamily: family,
    promptText: prompt,
    completionText: completion,
    retrieval,
    attributes,
    pii,
    piiCompletion: hasCompletionPii(pii),
    sampledReason: "success_sample",
    ingestedAtUs: nowUs,
    isEval: false,
    evalName: null,
    evalScore: null,
    evalPass: null,
    evalEngine: null,
  });
  if (rows.length >= 500) flushRows();
}

for (let day = 1; day <= 34; day += 1) {
  const dayStart = nowUs - day * DAY_US + 8 * 3_600_000_000;
  for (const [appIndex, app] of apps.entries()) {
    for (let hour = 0; hour < 8; hour += 1) {
      for (let index = 0; index < 8; index += 1) {
        const startUs = dayStart + hour * 3_600_000_000 + index * 60_000_000 + appIndex * 1000;
        addSpan(app, startUs, index, {
          unsupported: app.id === "support-bot" && day <= 2 && index % 5 === 0,
        });
      }
    }
  }
}

for (const [appIndex, app] of apps.entries()) {
  for (let index = 0; index < 20; index += 1) {
    const startUs = nowUs - (20 - index) * 10_000_000 - appIndex * 1000;
    addSpan(app, startUs, index, {
      leak: app.id === "support-bot" && index < 3,
      unsupported: app.id === "support-bot" && index >= 5 && index % 5 === 0,
      latencyMs: app.id === "support-bot" ? 3000 : undefined,
    });
  }
}
flushRows();

const judge = new LocalPiiJudge();
const dailyPolicy = { ...policy.eval, sampleRate: 0.25, batchSize: 1000 };
const dailyRunner = new EvalRunner({
  store,
  engine: new LocalEvalEngine(judge),
  policy: dailyPolicy,
  nowUs: () => nowUs,
});
for (let day = 1; day <= 6; day += 1) {
  const end = nowUs - day * DAY_US;
  await dailyRunner.runWindow(end - DAY_US, end, end);
}
const allRunner = new EvalRunner({
  store,
  engine: new LocalEvalEngine(judge),
  policy: { ...policy.eval, sampleRate: 1, batchSize: 2000 },
  nowUs: () => nowUs,
});
await allRunner.runWindow(nowUs - DAY_US, nowUs, nowUs);

const driftDetector = new DriftDetector({ store, policy: policy.drift, nowUs: () => nowUs });
await driftDetector.run({ nowUs });
await driftDetector.run({ nowUs: nowUs - 7 * DAY_US });

const dispatcher = new Dispatcher({ store, nowUs: () => nowUs });
const alertEngine = new AlertEngine({ store, policy, dispatcher, nowUs: () => nowUs });
await alertEngine.evaluate(nowUs);

const stats = store.alertStats(nowUs);
const drift = store.latestDriftByApp();
const alerts = store.listAlerts(50);
const summary = {
  source: "synthetic seed",
  spanCount: store.countSpans(),
  evalSpanCount: store.countEvalSpans(),
  overview7d: store.overview(nowUs, 7 * DAY_US),
  evalStats: stats,
  drift: drift.map((run) => ({
    appId: run.appId,
    psi: run.psi,
    kl: run.kl,
    status: run.status,
    nCurrent: run.nCurrent,
    nBaseline: run.nBaseline,
  })),
  alerts: alerts.map((alert) => ({
    rule: alert.rule,
    severity: alert.severity,
    appId: alert.appId,
    status: alert.status,
    summary: alert.summary,
  })),
};
mkdirSync("results", { recursive: true });
writeFileSync("results/seed-summary.json", `${JSON.stringify(summary, null, 2)}\n`);
console.log(
  JSON.stringify(
    {
      spans: summary.spanCount,
      evals: store.countEvalSpans(),
      cost7d: summary.overview7d.costUsd,
      drift: summary.drift,
      alerts: summary.alerts,
    },
    null,
    2,
  ),
);
store.close();
