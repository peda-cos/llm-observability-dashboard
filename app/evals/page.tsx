import Link from "next/link";
import { resolveTriageAction } from "../actions";
import { EvalTrendChart } from "../components/charts";
import { formatDateTime, formatInt, formatMs, formatPct, relativeUs } from "../lib/format";
import { getStore } from "../lib/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function EvalsPage() {
  const nowUs = Date.now() * 1000;
  const store = getStore();
  const stats = store.alertStats(nowUs);
  const all = stats.find((stat) => stat.appId === "__all__");
  const trend = store.evalTrend(nowUs, 86_400_000_000, 900_000_000);
  const recent = store.recentEvals(40);
  const triage = store.triage("open");
  const metrics = ["faithfulness", "toxicity", "answer_relevance", "pii_leak", "context_precision", "context_recall"].filter(
    (metric) => trend.some((point) => point.metric === metric),
  );
  const buckets = new Map<number, Record<string, number | string>>();
  for (const point of trend) {
    const bucket = buckets.get(point.bucketUs) ?? { bucketUs: point.bucketUs };
    bucket[point.metric] = point.avgScore;
    buckets.set(point.bucketUs, bucket);
  }
  const series = [...buckets.values()].sort((left, right) => Number(left.bucketUs) - Number(right.bucketUs));
  const avg = all?.evalAvg ?? {};
  const passRate = all?.evalPassRate ?? {};
  const n = all?.evalN ?? {};

  return (
    <>
      <div className="page-head">
        <div>
          <p className="eyebrow">Evaluation plane</p>
          <h1>Evals</h1>
          <p className="subtitle">
            Deterministic local metrics over sampled traces. Every score is an eval span linked to
            its parent LLM span; PII findings land in the triage queue.
          </p>
        </div>
        <span className="pill">{formatInt(all?.piiEvalCount ?? 0)} PII-positive evals in 5m</span>
      </div>

      <section className="cards" style={{ gridTemplateColumns: "repeat(5, minmax(0, 1fr))" }}>
        <div className="stat">
          <div className="stat-label">Faithfulness</div>
          <div className="stat-value">{avg.faithfulness === undefined ? "—" : avg.faithfulness.toFixed(2)}</div>
          <div className="stat-detail">{n.faithfulness ?? 0} evals · {formatPct(passRate.faithfulness ?? 0)} pass</div>
        </div>
        <div className="stat">
          <div className="stat-label">Toxicity</div>
          <div className="stat-value">{avg.toxicity === undefined ? "—" : avg.toxicity.toFixed(2)}</div>
          <div className="stat-detail">{n.toxicity ?? 0} evals · lower is better</div>
        </div>
        <div className="stat">
          <div className="stat-label">Answer relevance</div>
          <div className="stat-value">{avg.answer_relevance === undefined ? "—" : avg.answer_relevance.toFixed(2)}</div>
          <div className="stat-detail">{n.answer_relevance ?? 0} evals · {formatPct(passRate.answer_relevance ?? 0)} pass</div>
        </div>
        <div className="stat">
          <div className="stat-label">PII leak</div>
          <div className="stat-value">{formatInt(all?.piiEvalCount ?? 0)}</div>
          <div className="stat-detail">{all?.piiEvalTotal ?? 0} judged · {formatPct(all?.piiEvalRate ?? 0)} positive</div>
        </div>
        <div className="stat">
          <div className="stat-label">Triage queue</div>
          <div className="stat-value">{triage.length}</div>
          <div className="stat-detail">open redacted excerpts</div>
        </div>
      </section>

      <section className="panel" style={{ marginBottom: 16 }}>
        <div className="panel-head">
          <div>
            <h2>Score trend</h2>
            <span className="muted">15-minute buckets · last 24 hours</span>
          </div>
          <span className="badge info">{formatInt(recent.length)} recent evals</span>
        </div>
        <div className="chart">
          {series.length === 0 ? <p className="empty">No eval spans yet. Run the seeder or wait for the eval job.</p> : <EvalTrendChart data={series} metrics={metrics} />}
        </div>
      </section>

      <div className="grid grid-2" style={{ marginBottom: 16 }}>
        <section className="panel">
          <div className="panel-head">
            <h2>Triage queue</h2>
            <span className="muted">PII score ≥ 0.7</span>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Score</th>
                  <th>Excerpt</th>
                  <th>Trace</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {triage.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="empty">
                      No open triage items.
                    </td>
                  </tr>
                ) : (
                  triage.map((item) => (
                    <tr key={item.id}>
                      <td>
                        <span className="badge danger">{item.score.toFixed(2)}</span>
                      </td>
                      <td className="mono" style={{ maxWidth: 360 }}>
                        {item.excerpt}
                      </td>
                      <td>
                        <Link href={`/traces/${item.traceId}`} className="mono">
                          {item.traceId.slice(0, 10)}
                        </Link>
                      </td>
                      <td>
                        <form action={resolveTriageAction}>
                          <input type="hidden" name="id" value={item.id} />
                          <button className="ghost" type="submit">
                            Resolve
                          </button>
                        </form>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>

        <section className="panel">
          <div className="panel-head">
            <h2>Pass rates</h2>
            <span className="muted">thresholded metric verdicts</span>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Metric</th>
                  <th className="right">Average</th>
                  <th className="right">Pass rate</th>
                  <th className="right">n</th>
                </tr>
              </thead>
              <tbody>
                {metrics.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="empty">
                      No metric data.
                    </td>
                  </tr>
                ) : (
                  metrics.map((metric) => (
                    <tr key={metric}>
                      <td className="mono">{metric}</td>
                      <td className="right">{avg[metric]?.toFixed(3) ?? "—"}</td>
                      <td className="right">{formatPct(passRate[metric] ?? 0)}</td>
                      <td className="right">{n[metric] ?? 0}</td>
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
          <h2>Recent eval spans</h2>
          <span className="muted">newest first</span>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Trace</th>
                <th>Metric</th>
                <th className="right">Score</th>
                <th>Verdict</th>
                <th>Engine</th>
                <th>Reason</th>
              </tr>
            </thead>
            <tbody>
              {recent.length === 0 ? (
                <tr>
                  <td colSpan={7} className="empty">
                    No eval spans yet.
                  </td>
                </tr>
              ) : (
                recent.map((span) => (
                  <tr key={span.spanId}>
                    <td className="nowrap">{formatDateTime(span.startUs)}</td>
                    <td>
                      <Link href={`/traces/${span.traceId}`} className="mono">
                        {span.traceId.slice(0, 10)}
                      </Link>
                    </td>
                    <td className="mono">{span.evalName}</td>
                    <td className="right">{span.evalScore?.toFixed(3)}</td>
                    <td>
                      <span className={`badge ${span.evalPass ? "good" : "danger"}`}>
                        {span.evalPass ? "pass" : "fail"}
                      </span>
                    </td>
                    <td>{span.evalEngine}</td>
                    <td className="muted" style={{ maxWidth: 280 }}>
                      {String(span.attributes["eval.reason"] ?? "")}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <div className="panel-body muted">
          Eval span latency is {formatMs(0.001)}; parent linkage is visible in the trace waterfall.
        </div>
      </section>
    </>
  );
}
