import type { SQLiteStore } from "../storage/sqliteStore";
import type { IngestCounters } from "../types";

function escapeLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function line(name: string, labels: Record<string, string>, value: number): string {
  const entries = Object.entries(labels);
  const suffix = entries.length
    ? `{${entries.map(([key, label]) => `${key}="${escapeLabel(label)}"`).join(",")}}`
    : "";
  return `${name}${suffix} ${Number.isFinite(value) ? value : 0}`;
}

export function renderMetrics(
  store: SQLiteStore,
  counters: IngestCounters,
  nowUs: number,
): string {
  const stats = store.alertStats(nowUs).filter((stat) => stat.appId !== "__all__");
  const open = store.listAlerts(500).filter((alert) => alert.status === "open");
  const lines: string[] = [];
  const family = (name: string, type: "counter" | "gauge", help: string) => {
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
  };

  family("llm_spans_ingested_total", "counter", "OTLP spans offered or rejected at ingest.");
  lines.push(line("llm_spans_ingested_total", { decision: "offered" }, counters.offered));
  lines.push(line("llm_spans_ingested_total", { decision: "kept" }, counters.kept));
  lines.push(line("llm_spans_ingested_total", { decision: "dropped" }, counters.dropped));
  lines.push(line("llm_spans_ingested_total", { decision: "rejected" }, counters.rejected));

  family("llm_spans_stored_total", "gauge", "Spans stored in the current 5-minute window per app.");
  family("llm_cost_usd_total", "gauge", "USD cost in the current 5-minute window per app.");
  family("llm_latency_p95_ms", "gauge", "p95 span latency in milliseconds per app.");
  family("llm_error_ratio", "gauge", "Error span ratio in the current 5-minute window per app.");
  family("llm_pii_positive_ratio", "gauge", "PII-positive eval ratio in the current 5-minute window.");
  family("llm_drift_psi", "gauge", "Latest PSI against the trailing four-week baseline.");
  family("llm_eval_score", "gauge", "Average eval score over the last 15 minutes.");
  family("llm_eval_pass_ratio", "gauge", "Eval pass ratio over the last 15 minutes.");
  for (const app of stats) {
    lines.push(line("llm_spans_stored_total", { app: app.appId }, app.spans));
    lines.push(line("llm_cost_usd_total", { app: app.appId }, app.costUsd));
    lines.push(line("llm_latency_p95_ms", { app: app.appId }, app.latencyP95Ms));
    lines.push(line("llm_error_ratio", { app: app.appId }, app.errorRate));
    lines.push(line("llm_pii_positive_ratio", { app: app.appId }, app.piiEvalRate));
    if (app.driftPsi !== null) lines.push(line("llm_drift_psi", { app: app.appId }, app.driftPsi));
    for (const [metric, value] of Object.entries(app.evalAvg)) {
      lines.push(line("llm_eval_score", { metric, app: app.appId }, value));
    }
    for (const [metric, value] of Object.entries(app.evalPassRate)) {
      lines.push(line("llm_eval_pass_ratio", { metric, app: app.appId }, value));
    }
  }

  family("llm_open_alerts", "gauge", "Open alerts by severity.");
  lines.push(
    line(
      "llm_open_alerts",
      { severity: "warning" },
      open.filter((alert) => alert.severity === "warning").length,
    ),
  );
  lines.push(
    line(
      "llm_open_alerts",
      { severity: "critical" },
      open.filter((alert) => alert.severity === "critical").length,
    ),
  );
  return `${lines.join("\n")}\n`;
}
