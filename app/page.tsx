import Link from "next/link";
import { CostByUserChart, LatencyLineChart, SpansAreaChart, type TimePoint } from "./components/charts";
import { formatInt, formatMs, formatPct, formatUsd, relativeUs } from "./lib/format";
import { getStore } from "./lib/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Props = {
  searchParams: Promise<{ window?: string }>;
};

export default async function OverviewPage({ searchParams }: Props) {
  const params = await searchParams;
  const windowKey = params.window === "7d" ? "7d" : "24h";
  const windowUs = windowKey === "7d" ? 7 * 86_400_000_000 : 86_400_000_000;
  const bucketUs = windowKey === "7d" ? 3_600_000_000 : 300_000_000;
  const nowUs = Date.now() * 1000;
  const store = getStore();
  const overview = store.overview(nowUs, windowUs);
  const series = store.timeseries(nowUs, windowUs, bucketUs);
  const cost = store.costByUser(nowUs, windowUs, 7);
  const models = store.topModels(nowUs, windowUs, 6);
  const alerts = store.listAlerts(4);
  const chartData: TimePoint[] = series.map((point) => ({
    bucketUs: point.bucketUs,
    spans: point.spans,
    errors: point.errors,
    p95LatencyMs: point.p95LatencyMs,
    costUsd: point.costUsd,
  }));

  return (
    <>
      <div className="page-head">
        <div>
          <p className="eyebrow">Production plane</p>
          <h1>LLM observability overview</h1>
          <p className="subtitle">
            OTLP GenAI spans, eval scores, prompt drift, and alert state in one self-hosted view.
            Window: {windowKey === "7d" ? "last 7 days" : "last 24 hours"}.
          </p>
        </div>
        <div className="toolbar">
          <div className="segmented" aria-label="Time window">
            <Link href="/?window=24h" className={windowKey === "24h" ? "active" : undefined}>
              24h
            </Link>
            <Link href="/?window=7d" className={windowKey === "7d" ? "active" : undefined}>
              7d
            </Link>
          </div>
          <Link className="pill" href="/alerts">
            {overview.openAlerts} open alert{overview.openAlerts === 1 ? "" : "s"}
          </Link>
        </div>
      </div>

      {overview.spans === 0 ? (
        <div className="notice" style={{ marginBottom: 16 }}>
          No spans yet. Run <span className="mono">npm run seed</span>, start{" "}
          <span className="mono">npm run ingress</span>, or POST OTLP JSON to{" "}
          <span className="mono">/v1/traces</span>.
        </div>
      ) : null}

      <section className="cards" aria-label="Key metrics">
        <Stat label="Spans" value={formatInt(overview.spans)} detail={`${overview.spansPerSec.toFixed(1)} spans/sec in the last minute`} />
        <Stat label="Cost" value={formatUsd(overview.costUsd)} detail={`${cost.length ? `top user ${cost[0].userId}` : "no attributed users"}`} />
        <Stat label="p95 latency" value={formatMs(overview.p95LatencyMs)} detail="all non-eval spans" />
        <Stat label="Error rate" value={formatPct(overview.errorRate, 2)} detail="status_code = ERROR" />
        <Stat label="PII-positive evals" value={formatInt(overview.piiPositives)} detail="eval.pii_leak failures" />
        <Stat label="Open alerts" value={formatInt(overview.openAlerts)} detail="local + Alertmanager" />
      </section>

      <div className="grid grid-2" style={{ marginBottom: 16 }}>
        <section className="panel">
          <div className="panel-head">
            <div>
              <h2>Traffic</h2>
              <span className="muted">spans and error spans per bucket</span>
            </div>
            <span className="badge info">{windowKey}</span>
          </div>
          <div className="chart">
            <SpansAreaChart data={chartData} />
          </div>
        </section>
        <section className="panel">
          <div className="panel-head">
            <div>
              <h2>Latency</h2>
              <span className="muted">p95 latency per bucket</span>
            </div>
            <span className="badge warn">SLO watch</span>
          </div>
          <div className="chart">
            <LatencyLineChart data={chartData} />
          </div>
        </section>
      </div>

      <div className="grid grid-2" style={{ marginBottom: 16 }}>
        <section className="panel">
          <div className="panel-head">
            <h2>Cost by user</h2>
            <span className="muted">unit economics</span>
          </div>
          <div className="chart">
            <CostByUserChart data={cost} />
          </div>
        </section>
        <section className="panel">
          <div className="panel-head">
            <h2>Models</h2>
            <span className="muted">top by span count</span>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Model</th>
                  <th>Provider</th>
                  <th className="right">Spans</th>
                  <th className="right">p95</th>
                  <th className="right">Cost</th>
                  <th className="right">Errors</th>
                </tr>
              </thead>
              <tbody>
                {models.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="empty">
                      No model activity in this window.
                    </td>
                  </tr>
                ) : (
                  models.map((model) => (
                    <tr key={`${model.provider}:${model.model}`}>
                      <td className="mono">{model.model}</td>
                      <td>
                        <span className="badge">{model.provider}</span>
                      </td>
                      <td className="right">{formatInt(model.spans)}</td>
                      <td className="right">{formatMs(model.p95LatencyMs)}</td>
                      <td className="right">{formatUsd(model.costUsd)}</td>
                      <td className="right">{formatPct(model.errorRate, 1)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      <section className="panel">
        <div className="panel-head">
          <h2>Recent alerts</h2>
          <Link href="/alerts">Open alert center</Link>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Severity</th>
                <th>Alert</th>
                <th>App</th>
                <th>Summary</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {alerts.length === 0 ? (
                <tr>
                  <td colSpan={5} className="empty">
                    No alerts recorded. The detection loop is quiet.
                  </td>
                </tr>
              ) : (
                alerts.map((alert) => (
                  <tr key={alert.id}>
                    <td>
                      <span className={`badge ${alert.severity}`}>{alert.severity}</span>
                    </td>
                    <td className="mono">{alert.rule}</td>
                    <td>{alert.appId}</td>
                    <td>{alert.summary}</td>
                    <td className="muted nowrap">{relativeUs(alert.createdUs, nowUs)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      <div className="footer-links">
        <Link href="/traces">Search traces →</Link>
        <Link href="/evals">Eval trends →</Link>
        <Link href="/drift">Drift detector →</Link>
        <span className="mono">OTLP endpoint http://127.0.0.1:4318/v1/traces</span>
      </div>
    </>
  );
}

function Stat({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <article className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      <div className="stat-detail">{detail}</div>
    </article>
  );
}
