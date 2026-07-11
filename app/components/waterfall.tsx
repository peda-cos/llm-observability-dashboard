import type { SpanRow } from "../../src/types";
import { formatMs, formatUsd, shortId } from "../lib/format";

export function Waterfall({ spans }: { spans: SpanRow[] }) {
  if (spans.length === 0) return <p className="empty">No spans in this trace.</p>;
  const start = Math.min(...spans.map((span) => span.startUs));
  const end = Math.max(...spans.map((span) => span.endUs));
  const total = Math.max(1, end - start);
  const byId = new Map(spans.map((span) => [span.spanId, span]));

  const depthOf = (span: SpanRow): number => {
    let depth = 0;
    let current = span;
    const seen = new Set<string>();
    while (current.parentSpanId && byId.has(current.parentSpanId) && depth < 12) {
      if (seen.has(current.parentSpanId)) break;
      seen.add(current.parentSpanId);
      current = byId.get(current.parentSpanId)!;
      depth += 1;
    }
    return depth;
  };

  return (
    <div className="waterfall">
      <div className="wf-header">
        <span>span</span>
        <span>0 ms</span>
        <span>{formatMs(total / 1000)}</span>
      </div>
      {spans.map((span) => {
        const left = ((span.startUs - start) / total) * 100;
        const width = Math.max(0.5, (Math.max(0, span.endUs - span.startUs) / total) * 100);
        const depth = depthOf(span);
        const kindClass = span.statusCode === 2 ? "error" : span.isEval ? "eval" : span.kind;
        return (
          <div className="wf-row" key={span.spanId}>
            <div className="wf-label" style={{ paddingLeft: depth * 14 }}>
              <span className={`kind-dot ${kindClass}`} aria-hidden />
              <span className="wf-name" title={span.name}>
                {span.name}
              </span>
              <span className="mono muted">{shortId(span.spanId)}</span>
              {span.isEval ? <span className="badge eval">{span.evalName} {span.evalScore?.toFixed(2)}</span> : null}
              {span.piiCompletion ? <span className="badge danger">PII</span> : null}
              <span className="wf-meta">
                {formatMs(span.latencyMs)} · {formatUsd(span.costUsd)} · {span.inputTokens + span.outputTokens} tok
              </span>
            </div>
            <div className="wf-track">
              <div
                className={`wf-bar ${kindClass}`}
                style={{ left: `${left}%`, width: `${width}%` }}
                title={`${span.name} · ${formatMs(span.latencyMs)}`}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
