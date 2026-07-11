import Link from "next/link";
import { notFound } from "next/navigation";
import { Waterfall } from "../../components/waterfall";
import { formatDateTime, formatInt, formatMs, formatPct, formatUsd, relativeUs, shortId } from "../../lib/format";
import { getStore } from "../../lib/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Props = { params: Promise<{ traceId: string }> };

export default async function TraceDetailPage({ params }: Props) {
  const { traceId } = await params;
  const store = getStore();
  const spans = store.getTrace(traceId);
  if (spans.length === 0) notFound();
  const nowUs = Date.now() * 1000;
  const start = Math.min(...spans.map((span) => span.startUs));
  const end = Math.max(...spans.map((span) => span.endUs));
  const cost = spans.reduce((sum, span) => sum + span.costUsd, 0);
  const tokens = spans.reduce((sum, span) => sum + span.inputTokens + span.outputTokens, 0);
  const errors = spans.filter((span) => span.statusCode === 2).length;
  const piiSpans = spans.filter((span) => span.pii.length > 0);
  const promptSpans = spans.filter((span) => span.promptText || span.completionText);
  const evalSpans = spans.filter((span) => span.isEval);
  const first = spans[0];

  return (
    <>
      <div className="page-head">
        <div>
          <p className="eyebrow">Trace detail</p>
          <h1 className="mono" style={{ fontSize: 22 }}>
            {traceId}
          </h1>
          <p className="subtitle">
            {first.appId} · {first.userId ?? "anonymous"} · session {first.sessionId ?? "none"} ·{" "}
            {formatDateTime(start)} ({relativeUs(start, nowUs)})
          </p>
        </div>
        <Link className="badge info" href="/traces">
          ← Back to traces
        </Link>
      </div>

      <section className="cards" style={{ gridTemplateColumns: "repeat(5, minmax(0, 1fr))" }}>
        <div className="stat">
          <div className="stat-label">Spans</div>
          <div className="stat-value">{spans.length}</div>
          <div className="stat-detail">{evalSpans.length} eval spans</div>
        </div>
        <div className="stat">
          <div className="stat-label">Duration</div>
          <div className="stat-value">{formatMs((end - start) / 1000)}</div>
          <div className="stat-detail">wall clock</div>
        </div>
        <div className="stat">
          <div className="stat-label">Tokens</div>
          <div className="stat-value">{formatInt(tokens)}</div>
          <div className="stat-detail">input + output</div>
        </div>
        <div className="stat">
          <div className="stat-label">Cost</div>
          <div className="stat-value">{formatUsd(cost)}</div>
          <div className="stat-detail">priced models</div>
        </div>
        <div className="stat">
          <div className="stat-label">Errors</div>
          <div className="stat-value">{errors}</div>
          <div className="stat-detail">{formatPct(spans.length ? errors / spans.length : 0, 1)}</div>
        </div>
      </section>

      {piiSpans.length > 0 ? (
        <div className="notice" style={{ marginBottom: 16 }}>
          PII detector flagged {piiSpans.length} span(s) in this trace. Content below may contain
          sensitive values; triage excerpts are redacted.
        </div>
      ) : null}

      <section className="panel" style={{ marginBottom: 16 }}>
        <div className="panel-head">
          <h2>Waterfall</h2>
          <span className="muted">{spans.length} spans · {evalSpans.length} evals</span>
        </div>
        <div className="panel-body">
          <Waterfall spans={spans} />
        </div>
      </section>

      <div className="grid grid-2" style={{ marginBottom: 16 }}>
        {promptSpans.map((span) => (
          <section className="panel" key={`content-${span.spanId}`}>
            <div className="panel-head">
              <div>
                <h2>{span.isEval ? `Eval · ${span.evalName}` : span.name}</h2>
                <span className="muted mono">{shortId(span.spanId)}</span>
              </div>
              <div className="toolbar">
                {span.isEval ? <span className="badge eval">score {span.evalScore?.toFixed(3)}</span> : null}
                {span.piiCompletion ? <span className="badge danger">completion PII</span> : null}
              </div>
            </div>
            <div className="panel-body">
              {span.promptText ? (
                <>
                  <h3>Prompt</h3>
                  <pre>{span.promptText}</pre>
                </>
              ) : null}
              {span.completionText ? (
                <>
                  <h3 style={{ marginTop: 12 }}>Completion</h3>
                  <pre>{span.completionText}</pre>
                </>
              ) : null}
              {span.retrieval ? (
                <>
                  <h3 style={{ marginTop: 12 }}>Retrieval context</h3>
                  <div className="bar-list">
                    {span.retrieval.map((doc) => (
                      <div key={doc.id} className="bar-list-row">
                        <span className="mono">{doc.id}</span>
                        <span className="muted" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {doc.text}
                        </span>
                        <span className="badge info">{doc.score?.toFixed(2) ?? "—"}</span>
                      </div>
                    ))}
                  </div>
                </>
              ) : null}
              <details>
                <summary>Attributes · {Object.keys(span.attributes).length} keys</summary>
                <pre>{JSON.stringify(span.attributes, null, 2)}</pre>
              </details>
            </div>
          </section>
        ))}
      </div>

      <section className="panel">
        <div className="panel-head">
          <h2>Eval spans</h2>
          <span className="muted">linked by parent_span_id</span>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Metric</th>
                <th className="right">Score</th>
                <th>Pass</th>
                <th>Engine</th>
                <th>Reason</th>
                <th>Parent</th>
              </tr>
            </thead>
            <tbody>
              {evalSpans.length === 0 ? (
                <tr>
                  <td colSpan={6} className="empty">
                    No eval spans for this trace yet.
                  </td>
                </tr>
              ) : (
                evalSpans.map((span) => (
                  <tr key={span.spanId}>
                    <td className="mono">{span.evalName}</td>
                    <td className="right">{span.evalScore?.toFixed(3)}</td>
                    <td>
                      <span className={`badge ${span.evalPass ? "good" : "danger"}`}>
                        {span.evalPass ? "pass" : "fail"}
                      </span>
                    </td>
                    <td>{span.evalEngine}</td>
                    <td className="muted">{String(span.attributes["eval.reason"] ?? "")}</td>
                    <td className="mono">{shortId(span.parentSpanId ?? "", 10)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
