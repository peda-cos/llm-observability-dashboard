import Link from "next/link";
import { ackAlertAction } from "../actions";
import { formatInt, relativeUs } from "../lib/format";
import { getStore } from "../lib/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function AlertsPage() {
  const nowUs = Date.now() * 1000;
  const store = getStore();
  const alerts = store.listAlerts(100);
  const open = alerts.filter((alert) => alert.status === "open");
  const critical = alerts.filter((alert) => alert.severity === "critical");

  return (
    <>
      <div className="page-head">
        <div>
          <p className="eyebrow">On-call surface</p>
          <h1>Alerts</h1>
          <p className="subtitle">
            Local rule engine plus Alertmanager-v4 webhook delivery. Warnings route to Slack,
            critical alerts fan out to Slack and PagerDuty; every attempt is recorded.
          </p>
        </div>
        <span className="pill">{open.length} open</span>
      </div>

      <section className="cards" style={{ gridTemplateColumns: "repeat(4, minmax(0, 1fr))" }}>
        <div className="stat">
          <div className="stat-label">Open</div>
          <div className="stat-value">{open.length}</div>
          <div className="stat-detail">{formatInt(alerts.length)} total recorded</div>
        </div>
        <div className="stat">
          <div className="stat-label">Critical</div>
          <div className="stat-value">{critical.length}</div>
          <div className="stat-detail">PII leak and hard SLO breaches</div>
        </div>
        <div className="stat">
          <div className="stat-label">Warning</div>
          <div className="stat-value">{alerts.filter((alert) => alert.severity === "warning").length}</div>
          <div className="stat-detail">Slack-routed signals</div>
        </div>
        <div className="stat">
          <div className="stat-label">Acknowledged</div>
          <div className="stat-value">{alerts.filter((alert) => alert.status === "acked").length}</div>
          <div className="stat-detail">human triage applied</div>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>Alert history</h2>
          <span className="muted">newest first · deduped by rule + app</span>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Severity</th>
                <th>Rule</th>
                <th>App</th>
                <th>Summary</th>
                <th>Status</th>
                <th>Deliveries</th>
                <th>When</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {alerts.length === 0 ? (
                <tr>
                  <td colSpan={8} className="empty">
                    No alerts recorded. Inject the regression probe (`npm run demo`) to exercise the chain.
                  </td>
                </tr>
              ) : (
                alerts.map((alert) => {
                  const deliveries = store.getDeliveries(alert.id);
                  const traceHref = alert.rule === "PiiLeakDetected" ? "/traces?pii=1" : "/traces";
                  return (
                    <tr key={alert.id}>
                      <td>
                        <span className={`badge ${alert.severity}`}>{alert.severity}</span>
                      </td>
                      <td>
                        <div className="mono">{alert.rule}</div>
                        <div className="muted" style={{ fontSize: 11 }}>
                          {alert.occurrences} occurrence{alert.occurrences === 1 ? "" : "s"}
                        </div>
                      </td>
                      <td>{alert.appId}</td>
                      <td>
                        <div>{alert.summary}</div>
                        <div className="muted" style={{ fontSize: 11 }}>
                          {alert.description}
                        </div>
                      </td>
                      <td>
                        <span className={`badge ${alert.status === "open" ? "danger" : "good"}`}>{alert.status}</span>
                      </td>
                      <td>
                        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                          {deliveries.length === 0 ? <span className="muted">—</span> : null}
                          {deliveries.map((delivery) => (
                            <span
                              key={delivery.sink}
                              className={`badge ${delivery.status === "sent" ? "good" : delivery.status === "failed" ? "danger" : "warn"}`}
                              title={delivery.detail ?? ""}
                            >
                              {delivery.sink}:{delivery.status}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td className="muted nowrap">{relativeUs(alert.createdUs, nowUs)}</td>
                      <td>
                        <div className="toolbar">
                          <Link className="badge info" href={traceHref}>
                            Traces
                          </Link>
                          {alert.status === "open" ? (
                            <form action={ackAlertAction}>
                              <input type="hidden" name="id" value={alert.id} />
                              <button className="ghost" type="submit">
                                Ack
                              </button>
                            </form>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
        <div className="panel-body muted">
          Prometheus scrapes <span className="mono">/metrics</span>; Alertmanager posts to{" "}
          <span className="mono">/api/alertmanager</span>. Use the deploy configs for the real
          Prometheus → Alertmanager → Slack/PagerDuty chain.
        </div>
      </section>
    </>
  );
}
