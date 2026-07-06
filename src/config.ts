import { readFileSync } from "node:fs";
import path from "node:path";

export interface SamplingPolicy {
  successRate: number;
  decisionWaitMs: number;
  keepErrorTraces: boolean;
  keepPiiTraces: boolean;
  salt: string;
}

export interface EvalPolicy {
  windowMs: number;
  sampleRate: number;
  batchSize: number;
  intervalMs: number;
  piiThreshold: number;
  faithfulnessThreshold: number;
  toxicityThreshold: number;
  relevanceThreshold: number;
  contextThreshold: number;
}

export interface DriftPolicy {
  currentWindowMs: number;
  baselineWindowMs: number;
  clusters: number;
  psiThreshold: number;
  minCurrent: number;
  minBaseline: number;
  intervalMs: number;
}

export interface AlertsPolicy {
  intervalMs: number;
  windowMs: number;
  piiMinCount: number;
  piiRateThreshold: number;
  latencyWarningMs: number;
  latencyCriticalMs: number;
  errorWarningRate: number;
  errorCriticalRate: number;
}

export interface StoragePolicy {
  maxContentChars: number;
  maxBodyBytes: number;
}

export interface Policy {
  sampling: SamplingPolicy;
  eval: EvalPolicy;
  drift: DriftPolicy;
  alerts: AlertsPolicy;
  storage: StoragePolicy;
}

export interface ModelPrice {
  input: number;
  output: number;
}

export interface Pricing {
  currency: string;
  models: Record<string, ModelPrice>;
}

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

function readJson(file: string): unknown {
  const absolute = path.resolve(file);
  try {
    return JSON.parse(readFileSync(absolute, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`Unable to read JSON config ${absolute}: ${(error as Error).message}`);
  }
}

function mergeSection<T extends object>(base: T, override?: DeepPartial<T>): T {
  return { ...base, ...(override ?? {}) } as T;
}

function assertRange(value: number, min: number, max: number, name: string): void {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`Invalid policy ${name}: ${value} (expected ${min}..${max})`);
  }
}

function validate(policy: Policy): Policy {
  assertRange(policy.sampling.successRate, 0, 1, "sampling.successRate");
  assertRange(policy.sampling.decisionWaitMs, 10, 300000, "sampling.decisionWaitMs");
  assertRange(policy.eval.sampleRate, 0, 1, "eval.sampleRate");
  assertRange(policy.eval.windowMs, 1000, 86400000, "eval.windowMs");
  assertRange(policy.eval.batchSize, 1, 10000, "eval.batchSize");
  assertRange(policy.eval.intervalMs, 100, 86400000, "eval.intervalMs");
  assertRange(policy.eval.piiThreshold, 0, 1, "eval.piiThreshold");
  assertRange(policy.eval.faithfulnessThreshold, 0, 1, "eval.faithfulnessThreshold");
  assertRange(policy.eval.toxicityThreshold, 0, 1, "eval.toxicityThreshold");
  assertRange(policy.drift.currentWindowMs, 3600000, 31536000000, "drift.currentWindowMs");
  assertRange(policy.drift.baselineWindowMs, 3600000, 31536000000, "drift.baselineWindowMs");
  assertRange(policy.drift.clusters, 2, 64, "drift.clusters");
  assertRange(policy.drift.psiThreshold, 0.0001, 10, "drift.psiThreshold");
  assertRange(policy.drift.minCurrent, 1, 100000, "drift.minCurrent");
  assertRange(policy.drift.minBaseline, 1, 100000, "drift.minBaseline");
  assertRange(policy.drift.intervalMs, 1000, 31536000000, "drift.intervalMs");
  assertRange(policy.alerts.intervalMs, 100, 3600000, "alerts.intervalMs");
  assertRange(policy.alerts.windowMs, 1000, 86400000, "alerts.windowMs");
  assertRange(policy.alerts.piiMinCount, 1, 100000, "alerts.piiMinCount");
  assertRange(policy.alerts.piiRateThreshold, 0, 1, "alerts.piiRateThreshold");
  assertRange(policy.storage.maxContentChars, 64, 10_000_000, "storage.maxContentChars");
  assertRange(policy.storage.maxBodyBytes, 1024, 100_000_000, "storage.maxBodyBytes");
  return policy;
}

export function loadPolicy(
  file = process.env.POLICY_PATH ?? "./config/policy.json",
  overrides?: DeepPartial<Policy>,
): Policy {
  const raw = readJson(file) as Policy;
  const merged: Policy = {
    sampling: mergeSection(raw.sampling, overrides?.sampling),
    eval: mergeSection(raw.eval, overrides?.eval),
    drift: mergeSection(raw.drift, overrides?.drift),
    alerts: mergeSection(raw.alerts, overrides?.alerts),
    storage: mergeSection(raw.storage, overrides?.storage),
  };
  return validate(merged);
}

export function loadPricing(file = process.env.PRICING_PATH ?? "./config/pricing.json"): Pricing {
  const raw = readJson(file) as Pricing;
  if (!raw.models || typeof raw.models !== "object") {
    throw new Error(`Invalid pricing config ${file}: missing models`);
  }
  return raw;
}

export function costUsd(
  pricing: Pricing,
  model: string | null,
  inputTokens: number,
  outputTokens: number,
): { usd: number; matched: boolean } {
  if (!model) return { usd: 0, matched: false };
  let key: string | null = null;
  if (pricing.models[model]) {
    key = model;
  } else {
    for (const candidate of Object.keys(pricing.models)) {
      if (model.startsWith(candidate) && (!key || candidate.length > key.length)) key = candidate;
    }
  }
  if (!key) return { usd: 0, matched: false };
  const price = pricing.models[key];
  const usd = (inputTokens / 1_000_000) * price.input + (outputTokens / 1_000_000) * price.output;
  return { usd: Math.round(usd * 1e8) / 1e8, matched: true };
}
