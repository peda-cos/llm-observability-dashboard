import type { Policy } from "../config";
import { hashHex } from "../ids";
import type { Logger } from "../logging";
import type { SQLiteStore } from "../storage/sqliteStore";
import type { AlertRow, AppAlertStats } from "../types";
import type { Dispatcher } from "./dispatch";

export interface AlertmanagerAlert {
  status: "firing" | "resolved";
  labels: Record<string, string>;
  annotations: Record<string, string>;
  startsAt: string;
  endsAt: string;
  generatorURL: string;
  fingerprint: string;
}

export interface AlertDraft {
  row: AlertRow;
  payload: AlertmanagerAlert;
}

function draft(
  rule: string,
  severity: "warning" | "critical",
  appId: string,
  summary: string,
  description: string,
  nowUs: number,
): AlertDraft {
  const fingerprint = hashHex(`${rule}:${appId}`).slice(0, 16);
  const startsAt = new Date(Math.floor(nowUs / 1000)).toISOString();
  const payload: AlertmanagerAlert = {
    status: "firing",
    labels: { alertname: rule, severity, app: appId, rule },
    annotations: { summary, description },
    startsAt,
    endsAt: "0001-01-01T00:00:00Z",
    generatorURL: "http://localhost:3000/alerts",
    fingerprint,
  };
  return {
    payload,
    row: {
      id: `alert:${fingerprint}`,
      fingerprint,
      rule,
      severity,
      appId,
      summary,
      description,
      status: "open",
      occurrences: 1,
      createdUs: nowUs,
      updatedUs: nowUs,
      payloadJson: JSON.stringify(payload),
    },
  };
}

export function evaluateRules(
  stats: AppAlertStats[],
  policy: Policy,
  nowUs: number,
): AlertDraft[] {
  const drafts: AlertDraft[] = [];
  for (const app of stats) {
    if (app.appId === "__all__") continue;
    if (
      app.piiEvalCount >= policy.alerts.piiMinCount &&
      app.piiEvalRate >= policy.alerts.piiRateThreshold
    ) {
      drafts.push(
        draft(
          "PiiLeakDetected",
          "critical",
          app.appId,
          `PII leak suspected in ${app.appId}`,
          `${app.piiEvalCount} PII-positive evals of ${app.piiEvalTotal} (${(
            app.piiEvalRate * 100
          ).toFixed(2)}%) in the last 5 minutes; triage at /evals`,
          nowUs,
        ),
      );
    }
    if ((app.evalN.faithfulness ?? 0) >= 5) {
      const average = app.evalAvg.faithfulness ?? 0;
      if (average < policy.eval.faithfulnessThreshold) {
        drafts.push(
          draft(
            "FaithfulnessLow",
            "warning",
            app.appId,
            `Faithfulness below threshold in ${app.appId}`,
            `average faithfulness ${average.toFixed(2)} over ${app.evalN.faithfulness} evals is below ${policy.eval.faithfulnessThreshold}`,
            nowUs,
          ),
        );
      }
    }
    if ((app.evalN.toxicity ?? 0) >= 5) {
      const average = app.evalAvg.toxicity ?? 0;
      if (average > policy.eval.toxicityThreshold) {
        drafts.push(
          draft(
            "ToxicityHigh",
            "warning",
            app.appId,
            `Toxicity above threshold in ${app.appId}`,
            `average toxicity ${average.toFixed(2)} over ${app.evalN.toxicity} evals is above ${policy.eval.toxicityThreshold}`,
            nowUs,
          ),
        );
      }
    }
    if ((app.evalN.answer_relevance ?? 0) >= 5) {
      const average = app.evalAvg.answer_relevance ?? 0;
      if (average < policy.eval.relevanceThreshold) {
        drafts.push(
          draft(
            "AnswerRelevanceLow",
            "warning",
            app.appId,
            `Answer relevance below threshold in ${app.appId}`,
            `average answer relevance ${average.toFixed(2)} over ${app.evalN.answer_relevance} evals is below ${policy.eval.relevanceThreshold}`,
            nowUs,
          ),
        );
      }
    }
    if (app.latencyP95Ms > policy.alerts.latencyCriticalMs) {
      drafts.push(
        draft(
          "LatencyP95High",
          "critical",
          app.appId,
          `Critical p95 latency in ${app.appId}`,
          `p95 latency ${app.latencyP95Ms.toFixed(0)} ms over ${app.spans} spans exceeds ${policy.alerts.latencyCriticalMs} ms`,
          nowUs,
        ),
      );
    } else if (app.latencyP95Ms > policy.alerts.latencyWarningMs) {
      drafts.push(
        draft(
          "LatencyP95High",
          "warning",
          app.appId,
          `Elevated p95 latency in ${app.appId}`,
          `p95 latency ${app.latencyP95Ms.toFixed(0)} ms over ${app.spans} spans exceeds ${policy.alerts.latencyWarningMs} ms`,
          nowUs,
        ),
      );
    }
    if (app.spans >= 20 && app.errorRate > policy.alerts.errorCriticalRate) {
      drafts.push(
        draft(
          "ErrorRateHigh",
          "critical",
          app.appId,
          `Critical error rate in ${app.appId}`,
          `error rate ${(app.errorRate * 100).toFixed(2)}% over ${app.spans} spans exceeds ${(
            policy.alerts.errorCriticalRate * 100
          ).toFixed(0)}%`,
          nowUs,
        ),
      );
    } else if (app.spans >= 20 && app.errorRate > policy.alerts.errorWarningRate) {
      drafts.push(
        draft(
          "ErrorRateHigh",
          "warning",
          app.appId,
          `Elevated error rate in ${app.appId}`,
          `error rate ${(app.errorRate * 100).toFixed(2)}% over ${app.spans} spans exceeds ${(
            policy.alerts.errorWarningRate * 100
          ).toFixed(0)}%`,
          nowUs,
        ),
      );
    }
    if (app.driftPsi !== null && app.driftPsi > policy.drift.psiThreshold) {
      drafts.push(
        draft(
          "DriftPsiHigh",
          "warning",
          app.appId,
          `Prompt drift in ${app.appId}`,
          `PSI ${app.driftPsi.toFixed(2)} exceeds ${policy.drift.psiThreshold}; inspect /drift`,
          nowUs,
        ),
      );
    }
  }
  return drafts;
}

export interface AlertEngineDeps {
  store: SQLiteStore;
  policy: Policy;
  dispatcher: Dispatcher;
  nowUs?: () => number;
  logger?: Logger;
}

export class AlertEngine {
  private readonly deps: AlertEngineDeps;
  private readonly nowUs: () => number;

  constructor(deps: AlertEngineDeps) {
    this.deps = deps;
    this.nowUs = deps.nowUs ?? (() => Date.now() * 1000);
  }

  async evaluate(nowUs = this.nowUs()): Promise<{ created: AlertRow[]; updated: number }> {
    const stats = this.deps.store.alertStats(nowUs);
    const drafts = evaluateRules(stats, this.deps.policy, nowUs);
    const created: AlertRow[] = [];
    let updated = 0;
    for (const draft of drafts) {
      const result = this.deps.store.insertAlert(draft.row);
      if (!result.created) {
        updated += 1;
        continue;
      }
      created.push(result.alert);
      try {
        await this.deps.dispatcher.dispatch(result.alert);
      } catch (error) {
        this.deps.logger?.error("alert dispatch failed", {
          alertId: result.alert.id,
          error: (error as Error).message,
        });
      }
    }
    return { created, updated };
  }
}
