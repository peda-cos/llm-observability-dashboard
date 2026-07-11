import Link from "next/link";
import { formatDateTime, formatInt, formatMs, formatUsd, relativeUs, shortId } from "../lib/format";
import { getStore } from "../lib/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type SearchParams = Record<string, string | string[] | undefined>;
type Props = { searchParams: Promise<SearchParams> };

function first(value: string | string[] | undefined): string | undefined {
  const resolved = Array.isArray(value) ? value[0] : value;
  return resolved && resolved.length > 0 ? resolved : undefined;
}

export default async function TracesPage({ searchParams }: Props) {
  const params = await searchParams;
  const appId = first(params.app);
  const userId = first(params.user);
  const model = first(params.model);
  const statusValue = first(params.status);
  const status = statusValue === "ok" || statusValue === "error" || statusValue === "unset" ? statusValue : undefined;
  const piiOnly = first(params.pii) === "1";
  const q = first(params.q);
  const offset = Math.max(0, Number(first(params.offset) ?? 0) || 0);
  const limit = 50;
  const nowUs = Date.now() * 1000;
  const store = getStore();
  const { rows, total } = store.search({ appId, userId, model, status, piiOnly, q, limit, offset });
  const apps = store.getMeta().apps;

  const pageHref = (nextOffset: number) => {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries({ app: appId, user: userId, model, status, pii: piiOnly ? "1" : undefined, q })) {
      if (value) search.set(key, value);
    }
    search.set("offset", String(nextOffset));
    return `/traces?${search.toString()}`;
  };

  return (
    <>
      <div className="page-head">
        <div>
          <p className="eyebrow">Trace explorer</p>
          <h1>Traces</h1>
          <p className="subtitle">
            Search stored GenAI spans by app, user, model, status, PII flag, or content. Open a
            trace to inspect the waterfall and linked eval spans.
          </p>
        </div>
        <span className="pill">{formatInt(total)} matching spans</span>
      </div>

      <section className="panel" style={{ marginBottom: 16 }}>
        <div className="panel-body">
          <form className="search-form" method="get" action="/traces">
            <label className="field">
              App
              <select name="app" defaultValue={appId ?? ""}>
                <option value="">All apps</option>
                {apps.map((app) => (
                  <option key={app.id} value={app.id}>
                    {app.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              User
              <input type="text" name="user" defaultValue={userId ?? ""} placeholder="u_001" />
            </label>
            <label className="field">
              Model
              <input type="text" name="model" defaultValue={model ?? ""} placeholder="gpt-4o-mini" />
            </label>
            <label className="field">
              Status
              <select name="status" defaultValue={status ?? ""}>
                <option value="">Any</option>
                <option value="ok">OK</option>
                <option value="error">Error</option>
                <option value="unset">Unset</option>
              </select>
            </label>
            <label className="field">
              Search content
              <input type="search" name="q" defaultValue={q ?? ""} placeholder="refund, trace id…" />
            </label>
            <label className="checkbox">
              <input type="checkbox" name="pii" value="1" defaultChecked={piiOnly} />
              PII flagged
            </label>
            <button type="submit">Filter</button>
            <Link className="badge" href="/traces">
              Reset
            </Link>
          </form>
        </div>
      </section>

      <section className="panel">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>App</th>
                <th>User</th>
                <th>Model</th>
                <th>Operation</th>
                <th className="right">Tokens</th>
                <th className="right">Cost</th>
                <th className="right">Latency</th>
                <th>Status</th>
                <th>Flags</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={10} className="empty">
                    No traces match these filters.
                  </td>
                </tr>
              ) : (
                rows.map((span) => (
                  <tr key={span.spanId}>
                    <td className="nowrap">
                      <Link href={`/traces/${span.traceId}`} className="mono">
                        {formatDateTime(span.startUs)}
                      </Link>
                      <div className="muted" style={{ fontSize: 11 }}>
                        {relativeUs(span.startUs, nowUs)} · {shortId(span.traceId, 10)}
                      </div>
                    </td>
                    <td>{span.appId}</td>
                    <td className="mono">{span.userId ?? "anonymous"}</td>
                    <td className="mono">{span.requestModel ?? "unknown"}</td>
                    <td>{span.operation ?? span.name}</td>
                    <td className="right">{formatInt(span.inputTokens + span.outputTokens)}</td>
                    <td className="right">{formatUsd(span.costUsd)}</td>
                    <td className="right">{formatMs(span.latencyMs)}</td>
                    <td>
                      <span className={`badge ${span.statusCode === 2 ? "danger" : "good"}`}>
                        {span.statusCode === 2 ? "error" : span.statusCode === 1 ? "ok" : "unset"}
                      </span>
                    </td>
                    <td>
                      <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                        {span.pii.length > 0 ? <span className="badge warn">PII</span> : null}
                        {span.retrieval ? <span className="badge info">RAG</span> : null}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <div className="panel-body" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span className="muted">
            Showing {rows.length === 0 ? 0 : offset + 1}–{Math.min(offset + rows.length, total)} of {formatInt(total)}
          </span>
          <div className="toolbar">
            {offset > 0 ? <Link className="badge" href={pageHref(Math.max(0, offset - limit))}>← Previous</Link> : null}
            {offset + limit < total ? <Link className="badge" href={pageHref(offset + limit)}>Next →</Link> : null}
          </div>
        </div>
      </section>
    </>
  );
}
