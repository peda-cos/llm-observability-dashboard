import type { Logger } from "../logging";
import type { SQLiteStore } from "../storage/sqliteStore";
import type { AlertRow } from "../types";

export type SinkName = "local" | "slack" | "pagerduty";
export type SinkStatus = "sent" | "skipped" | "failed";

export interface SinkResult {
  sink: SinkName;
  status: SinkStatus;
  detail?: string;
}

export interface AlertSink {
  readonly name: SinkName;
  send(alert: AlertRow): Promise<SinkResult>;
}

class LocalSink implements AlertSink {
  readonly name = "local";

  async send(): Promise<SinkResult> {
    return { sink: this.name, status: "sent", detail: "stored in SQLite alerts table" };
  }
}

class SlackSink implements AlertSink {
  readonly name = "slack";

  constructor(
    private readonly url: string | undefined,
    private readonly fetchImpl: typeof fetch,
  ) {}

  async send(alert: AlertRow): Promise<SinkResult> {
    if (!this.url) return { sink: this.name, status: "skipped", detail: "SLACK_WEBHOOK_URL unset" };
    const body = {
      text: `[${alert.severity.toUpperCase()}] ${alert.summary}`,
      blocks: [
        {
          type: "section",
          text: { type: "mrkdwn", text: `*${alert.summary}*\n${alert.description}` },
        },
      ],
    };
    try {
      const response = await this.fetchImpl(this.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return response.ok
        ? { sink: this.name, status: "sent", detail: String(response.status) }
        : { sink: this.name, status: "failed", detail: `HTTP ${response.status}` };
    } catch (error) {
      return { sink: this.name, status: "failed", detail: (error as Error).message };
    }
  }
}

class PagerDutySink implements AlertSink {
  readonly name = "pagerduty";

  constructor(
    private readonly routingKey: string | undefined,
    private readonly url: string,
    private readonly fetchImpl: typeof fetch,
  ) {}

  async send(alert: AlertRow): Promise<SinkResult> {
    if (!this.routingKey) {
      return { sink: this.name, status: "skipped", detail: "PAGERDUTY_ROUTING_KEY unset" };
    }
    const body = {
      routing_key: this.routingKey,
      event_action: "trigger",
      dedup_key: alert.fingerprint,
      payload: {
        summary: alert.summary,
        source: "llm-observability-dashboard",
        severity: alert.severity,
        custom_details: {
          app: alert.appId,
          rule: alert.rule,
          description: alert.description,
        },
      },
    };
    try {
      const response = await this.fetchImpl(this.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return response.ok
        ? { sink: this.name, status: "sent", detail: String(response.status) }
        : { sink: this.name, status: "failed", detail: `HTTP ${response.status}` };
    } catch (error) {
      return { sink: this.name, status: "failed", detail: (error as Error).message };
    }
  }
}

export interface DispatcherDeps {
  store: SQLiteStore;
  slackUrl?: string;
  pagerDutyKey?: string;
  pagerDutyUrl?: string;
  fetchImpl?: typeof fetch;
  nowUs?: () => number;
  logger?: Logger;
}

export class Dispatcher {
  private readonly deps: DispatcherDeps;
  private readonly nowUs: () => number;
  private readonly local: LocalSink;
  private readonly slack: SlackSink;
  private readonly pagerDuty: PagerDutySink;

  constructor(deps: DispatcherDeps) {
    this.deps = deps;
    this.nowUs = deps.nowUs ?? (() => Date.now() * 1000);
    const fetchImpl = deps.fetchImpl ?? fetch;
    this.local = new LocalSink();
    this.slack = new SlackSink(deps.slackUrl, fetchImpl);
    this.pagerDuty = new PagerDutySink(
      deps.pagerDutyKey,
      deps.pagerDutyUrl ?? "https://events.pagerduty.com/v2/enqueue",
      fetchImpl,
    );
  }

  async dispatch(alert: AlertRow): Promise<SinkResult[]> {
    const sinks: AlertSink[] = [this.local, this.slack];
    if (alert.severity === "critical") sinks.push(this.pagerDuty);
    const results = await Promise.all(sinks.map((sink) => sink.send(alert)));
    for (const result of results) {
      this.deps.store.insertDelivery({
        alertId: alert.id,
        sink: result.sink,
        status: result.status,
        detail: result.detail ?? null,
        attemptedUs: this.nowUs(),
      });
      if (result.status === "failed") {
        this.deps.logger?.warn("alert delivery failed", {
          alertId: alert.id,
          sink: result.sink,
          detail: result.detail,
        });
      }
    }
    return results;
  }
}
