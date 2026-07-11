import { DriftLineChart } from "../components/charts";
import { formatDateTime, formatInt, formatPct } from "../lib/format";
import { getStore } from "../lib/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function DriftPage() {
  const nowUs = Date.now() * 1000;
  const store = getStore();
  const trend = store.driftTrend(nowUs, 35);
  const latest = store.latestDriftByApp();
  const apps = [...new Set(trend.filter((run) => run.appId !== "__all__").map((run) => run.appId))].sort();
  const buckets = new Map<number, Record<string, number | string>>();
  for (const run of trend) {
    if (run.appId === "__all__") continue;
    const row = buckets.get(run.windowEndUs) ?? { windowEndUs: run.windowEndUs };
    row[run.appId] = run.psi;
    buckets.set(run.windowEndUs, row);
  }
  const series = [...buckets.values()].sort((left, right) => Number(left.windowEndUs) - Number(right.windowEndUs));
  const threshold = latest[0]?.threshold ?? 0.2;
  const detailed = latest.find((run) => run.appId === "support-bot") ?? latest.find((run) => run.appId !== "__all__");
  const detail = detailed ? (JSON.parse(detailed.detailJson) as { clusterProps?: { base: number; current: number }[] }) : null;
  const maxCluster = Math.max(1, ...(detail?.clusterProps ?? []).map((cluster) => Math.max(cluster.base, cluster.current)));

  return (
    <>
      <div className="page-head">
        <div>
          <p className="eyebrow">Distribution monitoring</p>
          <h1>Drift</h1>
          <p className="subtitle">
            Weekly PSI between the current 7-day pooled prompt embedding distribution and the
            trailing four-week baseline. Threshold {threshold}; per-app isolation catches a single
            product surface drifting.
          </p>
        </div>
        <span className="pill">{apps.length} apps tracked</span>
      </div>

      <section className="panel" style={{ marginBottom: 16 }}>
        <div className="panel-head">
          <div>
            <h2>PSI by app</h2>
            <span className="muted">26 bins → 6 baseline clusters · hash-128 embeddings</span>
          </div>
          <span className={`badge ${latest.some((run) => run.alert) ? "danger" : "good"}`}>
            {latest.filter((run) => run.alert).length} drifting
          </span>
        </div>
        <div className="chart">
          {series.length === 0 ? <p className="empty">No drift runs yet. Run `npm run drift` after ingesting prompts.</p> : <DriftLineChart data={series} apps={apps} threshold={threshold} />}
        </div>
      </section>

      <div className="grid grid-2">
        <section className="panel">
          <div className="panel-head">
            <h2>Latest runs</h2>
            <span className="muted">one row per app</span>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>App</th>
                  <th className="right">PSI</th>
                  <th className="right">KL</th>
                  <th className="right">Baseline</th>
                  <th className="right">Current</th>
                  <th>Status</th>
                  <th>Window end</th>
                </tr>
              </thead>
              <tbody>
                {latest.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="empty">
                      No drift runs yet.
                    </td>
                  </tr>
                ) : (
                  latest.map((run) => (
                    <tr key={run.id}>
                      <td className="mono">{run.appId}</td>
                      <td className="right">{run.psi.toFixed(3)}</td>
                      <td className="right">{run.kl.toFixed(3)}</td>
                      <td className="right">{formatInt(run.nBaseline)}</td>
                      <td className="right">{formatInt(run.nCurrent)}</td>
                      <td>
                        <span className={`badge ${run.alert ? "danger" : run.status === "insufficient_data" ? "warn" : "good"}`}>
                          {run.status}
                        </span>
                      </td>
                      <td className="nowrap">{formatDateTime(run.windowEndUs)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>

        <section className="panel">
          <div className="panel-head">
            <div>
              <h2>Cluster shift</h2>
              <span className="muted">{detailed ? `${detailed.appId} · latest baseline proportions` : "no run"}</span>
            </div>
            {detailed ? <span className={`badge ${detailed.alert ? "danger" : "good"}`}>PSI {detailed.psi.toFixed(2)}</span> : null}
          </div>
          <div className="panel-body">
            {detail?.clusterProps && detail.clusterProps.length > 0 ? (
              <div className="bar-list">
                {detail.clusterProps.map((cluster, index) => (
                  <div className="bar-list-row" key={index}>
                    <span className="mono muted">cluster {index}</span>
                    <div>
                      <div className="muted" style={{ fontSize: 10, marginBottom: 2 }}>
                        baseline {formatPct(cluster.base)} → current {formatPct(cluster.current)}
                      </div>
                      <div className="bar-list-track">
                        <div
                          className="bar-list-fill"
                          style={{ width: `${(Math.max(cluster.base, cluster.current) / maxCluster) * 100}%` }}
                        />
                      </div>
                    </div>
                    <span className="badge warn">Δ {formatPct(cluster.current - cluster.base)}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="empty">Insufficient samples for cluster detail.</p>
            )}
            <p className="muted" style={{ marginTop: 16, fontSize: 12 }}>
              PSI above {threshold} fires the DriftPsiHigh warning. Cluster proportions are stored
              with every run so the trail remains inspectable after new traffic arrives.
            </p>
          </div>
        </section>
      </div>
    </>
  );
}
