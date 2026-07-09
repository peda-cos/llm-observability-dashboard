import { hashHex } from "../ids";
import { isRecord } from "../json";
import type { SQLiteStore } from "../storage/sqliteStore";
import type { AlertRow } from "../types";
import type { Dispatcher } from "./dispatch";

export interface IncomingAlert {
  status: "firing" | "resolved";
  labels: Record<string, string>;
  annotations: Record<string, string>;
  startsAt?: string;
  endsAt?: string;
  fingerprint?: string;
}

function stringMap(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") result[key] = entry;
  }
  return result;
}

export function parseAlertmanagerWebhook(payload: unknown): IncomingAlert[] {
  if (!isRecord(payload)) throw new Error("Alertmanager webhook payload must be an object");
  if (payload.version !== "4") throw new Error("Unsupported Alertmanager webhook version");
  if (!Array.isArray(payload.alerts)) throw new Error("Alertmanager webhook is missing alerts");
  return payload.alerts.map((raw) => {
    if (!isRecord(raw)) throw new Error("Alertmanager alert must be an object");
    return {
      status: raw.status === "resolved" ? "resolved" : "firing",
      labels: stringMap(raw.labels),
      annotations: stringMap(raw.annotations),
      startsAt: typeof raw.startsAt === "string" ? raw.startsAt : undefined,
      endsAt: typeof raw.endsAt === "string" ? raw.endsAt : undefined,
      fingerprint: typeof raw.fingerprint === "string" ? raw.fingerprint : undefined,
    };
  });
}

export interface AlertmanagerWebhookDeps {
  store: SQLiteStore;
  dispatcher: Dispatcher;
  nowUs?: () => number;
}

export interface AlertmanagerWebhookResult {
  received: number;
  fired: number;
  resolved: number;
  created: number;
}

export async function handleAlertmanagerWebhook(
  payload: unknown,
  deps: AlertmanagerWebhookDeps,
): Promise<AlertmanagerWebhookResult> {
  const nowUs = (deps.nowUs ?? (() => Date.now() * 1000))();
  const alerts = parseAlertmanagerWebhook(payload);
  let fired = 0;
  let resolved = 0;
  let created = 0;
  for (const alert of alerts) {
    const fingerprint =
      alert.fingerprint ??
      hashHex(JSON.stringify({ labels: alert.labels, startsAt: alert.startsAt ?? "" })).slice(0, 16);
    if (alert.status === "resolved") {
      deps.store.ackAlertByFingerprint(fingerprint, nowUs);
      resolved += 1;
      continue;
    }
    fired += 1;
    const severity = alert.labels.severity === "critical" ? "critical" : "warning";
    const appId = alert.labels.app ?? "__all__";
    const rule = alert.labels.alertname ?? "AlertmanagerAlert";
    const summary = alert.annotations.summary ?? rule;
    const description = alert.annotations.description ?? "";
    const row: AlertRow = {
      id: `alert:am:${fingerprint}`,
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
      payloadJson: JSON.stringify(alert),
    };
    const result = deps.store.insertAlert(row);
    if (result.created) {
      created += 1;
      await deps.dispatcher.dispatch(result.alert);
    }
  }
  return { received: alerts.length, fired, resolved, created };
}
