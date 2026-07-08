import type { RetrievalDoc } from "../types";

export type EvalMetric =
  | "faithfulness"
  | "toxicity"
  | "answer_relevance"
  | "pii_leak"
  | "context_precision"
  | "context_recall";

export const EVAL_METRICS: EvalMetric[] = [
  "faithfulness",
  "toxicity",
  "answer_relevance",
  "pii_leak",
  "context_precision",
  "context_recall",
];

const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "to",
  "of",
  "and",
  "or",
  "in",
  "on",
  "for",
  "with",
  "it",
  "this",
  "that",
  "as",
  "at",
  "by",
  "from",
  "your",
  "you",
  "we",
  "our",
  "can",
  "will",
  "how",
  "do",
  "i",
  "my",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "not",
  "no",
  "yes",
  "about",
  "into",
  "than",
  "then",
  "so",
  "if",
  "but",
]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 1 && !STOPWORDS.has(token))
    .map((token) => (token.length > 3 && token.endsWith("s") ? token.slice(0, -1) : token));
}

function sentences(text: string): string[] {
  return text
    .split(/[.!?]+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

export interface MetricResult {
  score: number;
  reason: string;
}

export function faithfulness(answer: string, context: RetrievalDoc[] | null): MetricResult | null {
  if (!context || context.length === 0) return null;
  const answerSentences = sentences(answer);
  if (answerSentences.length === 0) return { score: 0, reason: "empty answer" };
  const contextTokens = context.map((doc) => new Set(tokenize(doc.text)));
  let total = 0;
  for (const sentence of answerSentences) {
    const tokens = tokenize(sentence);
    if (tokens.length === 0) continue;
    let best = 0;
    for (const docTokens of contextTokens) {
      let overlap = 0;
      for (const token of tokens) if (docTokens.has(token)) overlap += 1;
      best = Math.max(best, overlap / tokens.length);
    }
    total += best;
  }
  const score = total / answerSentences.length;
  return {
    score: Math.max(0, Math.min(1, score)),
    reason: `${answerSentences.length} answer sentence(s) checked against ${context.length} context doc(s)`,
  };
}

export function answerRelevance(question: string, answer: string): MetricResult {
  const questionTokens = tokenize(question);
  const answerTokens = tokenize(answer);
  if (questionTokens.length === 0 || answerTokens.length === 0) {
    return { score: 0, reason: "empty question or answer tokens" };
  }
  const termFrequency = (tokens: string[]) => {
    const frequency = new Map<string, number>();
    for (const token of tokens) frequency.set(token, (frequency.get(token) ?? 0) + 1);
    return frequency;
  };
  const questionFrequency = termFrequency(questionTokens);
  const answerFrequency = termFrequency(answerTokens);
  let dot = 0;
  for (const [token, count] of questionFrequency.entries()) {
    dot += count * (answerFrequency.get(token) ?? 0);
  }
  const norm = (frequency: Map<string, number>) =>
    Math.sqrt([...frequency.values()].reduce((sum, count) => sum + count * count, 0));
  const denominator = norm(questionFrequency) * norm(answerFrequency);
  const score = denominator === 0 ? 0 : dot / denominator;
  return {
    score: Math.max(0, Math.min(1, score)),
    reason: `cosine over ${questionTokens.length} question and ${answerTokens.length} answer content tokens`,
  };
}

const MILD_TOXICITY = new Set(["stupid", "idiot", "dumb", "trash", "useless"]);
const SEVERE_TOXICITY = new Set(["hate", "kill", "die", "moron"]);

export function toxicity(text: string): MetricResult {
  const tokens = tokenize(text);
  let mild = 0;
  let severe = 0;
  for (const token of tokens) {
    if (MILD_TOXICITY.has(token)) mild += 1;
    if (SEVERE_TOXICITY.has(token)) severe += 1;
  }
  const score = Math.min(1, mild * 0.2 + severe * 0.6);
  return {
    score,
    reason: `${mild} mild and ${severe} severe lexicon match(es) in ${tokens.length} tokens`,
  };
}

export function contextPrecision(
  retrieved: RetrievalDoc[] | null,
  expectedIds: string[] | null,
): MetricResult | null {
  if (!expectedIds || expectedIds.length === 0) return null;
  if (!retrieved || retrieved.length === 0) return { score: 0, reason: "no retrieved documents" };
  const expected = new Set(expectedIds);
  let relevantSeen = 0;
  let precisionSum = 0;
  for (let index = 0; index < retrieved.length; index += 1) {
    if (!expected.has(retrieved[index].id)) continue;
    relevantSeen += 1;
    precisionSum += relevantSeen / (index + 1);
  }
  if (relevantSeen === 0) return { score: 0, reason: "no expected document retrieved" };
  return {
    score: Math.max(0, Math.min(1, precisionSum / relevantSeen)),
    reason: `${relevantSeen} relevant document(s) in ${retrieved.length} retrieved`,
  };
}

export function contextRecall(
  retrieved: RetrievalDoc[] | null,
  expectedIds: string[] | null,
): MetricResult | null {
  if (!expectedIds || expectedIds.length === 0) return null;
  const retrievedIds = new Set((retrieved ?? []).map((doc) => doc.id));
  const found = expectedIds.filter((id) => retrievedIds.has(id)).length;
  return {
    score: found / expectedIds.length,
    reason: `${found} of ${expectedIds.length} expected document(s) retrieved`,
  };
}

export function expectedIdsFromAttributes(
  attributes: Record<string, unknown>,
): string[] | null {
  const raw = attributes["retrieval.expected_ids"];
  if (raw === undefined || raw === null) return null;
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      return null;
    }
  }
  if (!Array.isArray(parsed)) return null;
  return parsed.filter((value): value is string => typeof value === "string");
}
