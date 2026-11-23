import React, { useEffect, useState } from "react";
import { api } from "./api";
import type { DailyRenders, InsightWindow, PlatformInsights, ReportInsights, TenantInsights, UserInsights } from "./insight-types";
import { dailySeries, hourlySeries, insightPresets, presetWindow, type InsightPreset } from "./insight-chart-data";
import { BarChart, LineChart } from "./insight-charts";

const seconds = (ms: number) => `${(ms / 1000).toLocaleString(undefined, { maximumFractionDigits: 2 })} s`;
function useInsight<T>(url: string, version: number): { data?: T; error?: string } {
  const [state, setState] = useState<{ data?: T; error?: string; url: string; version: number }>({ url: "", version: -1 });
  useEffect(() => {
    let active = true;
    void api<T>(url).then(data => { if (active) setState({ data, url, version }); })
      .catch(error => { if (active) setState({ error: error.message, url, version }); });
    return () => { active = false; };
  }, [url, version]);
  return state.url === url && state.version === version ? state : {};
}
function Metrics({ values }: { values: [string, number][] }) {
  return <dl className="insight-metrics">{values.map(([label, value]) => <div key={label}>
    <dt>{label}</dt><dd>{value.toLocaleString()}</dd></div>)}</dl>;
}
function Daily({ range, rows }: { range: InsightWindow; rows: DailyRenders[] }) {
  const series = dailySeries(range, rows);
  return <LineChart title="Completed report renders per day (UTC)" unit="renders" integers labels={series.labels} values={series.counts} />;
}
export function InsightsPage({ tenantId, version }: { tenantId?: string; version: number }) {
  const [range, setRange] = useState<InsightWindow>(() => presetWindow("week"));
  const [draft, setDraft] = useState(range);
  const [preset, setPreset] = useState<InsightPreset | "custom">("week");
  const [revision, setRevision] = useState(0);
  const query = new URLSearchParams({ from: range.from, to: range.to }).toString();
  return <div className="insights-page">
    <section><h2>{tenantId ? "Tenant insights" : "Platform insights"}</h2>
      <p>Metadata-backed usage analytics. No tenant capacity or Power BI report is started to view this page.
        The management database must be available. All date buckets use server request time in UTC.</p>
      <form className="inline" onSubmit={event => {
        event.preventDefault();
        const next = preset === "custom" ? draft : presetWindow(preset);
        setRange(next); setDraft(next); setRevision(v => v + 1);
      }}>
        <label>Time range<select value={preset} onChange={event => {
          const value = event.target.value as InsightPreset | "custom";
          setPreset(value);
          if (value !== "custom") {
            const next = presetWindow(value); setRange(next); setDraft(next); setRevision(v => v + 1);
          }
        }}>{insightPresets.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
          <option value="custom">Custom range</option>
        </select></label>
        {preset === "custom" && <>
          <label>From (UTC)<input type="date" name="from" value={draft.from} required
            onChange={event => setDraft(value => ({ ...value, from: event.target.value }))} /></label>
          <label>Through (UTC)<input type="date" name="to" value={draft.to} required
            onChange={event => setDraft(value => ({ ...value, to: event.target.value }))} /></label>
        </>}
        <button>Apply / refresh</button>
      </form>
      <p>{range.from} through {range.to} (inclusive UTC dates). Presets are rolling periods ending today.</p>
      <p className="muted">Custom ranges support up to 366 days. Users and hosted reports are current metadata counts, including unpublished
        nondeleted reports. Completed renders are best-effort client telemetry, not billing or proof of reading.
        These pages show report usage, not Fabric CU or Azure billing consumption.</p>
    </section>
    {tenantId ? <TenantSummary key={tenantId} tenantId={tenantId} query={query} version={version + revision} /> :
      <PlatformSummary query={query} version={version + revision} />}
  </div>;
}
function PlatformSummary({ query, version }: { query: string; version: number }) {
  const { data, error } = useInsight<PlatformInsights>(`/api/admin/insights?${query}`, version);
  const [selected, setSelected] = useState("");
  if (!data) return <section><p role={error ? "alert" : "status"}>{error ?? "Loading platform insights..."}</p></section>;
  const tenant = data.tenants.find(t => t.tenantId === selected);
  const daily = tenant ? data.daily.filter(row => row.tenantId === tenant.tenantId) :
    [...data.daily.reduce((map, row) => map.set(row.day, (map.get(row.day) ?? 0) + row.renders), new Map<string, number>())]
      .map(([day, renders]) => ({ day, renders }));
  return <>
    <section><Metrics values={[["Total tenants", data.totals.tenants], ["Total users", data.totals.users], ["Hosted reports", data.totals.reports]]} />
      <p>Platform-only accounts count in total users but not any tenant's users. No individual user or report usage details are exposed.</p>
      <div className="insight-chart-grid">
        <BarChart title="Users by tenant" unit="users" selected={selected} onSelect={setSelected}
          rows={data.tenants.map(t => ({ id: t.tenantId, label: t.name, value: t.users }))} />
        <BarChart title="Hosted reports by tenant" unit="reports" selected={selected} onSelect={setSelected}
          rows={data.tenants.map(t => ({ id: t.tenantId, label: t.name, value: t.reports }))} />
      </div>
      <BarChart title="Completed renders by tenant" unit="renders in range" selected={selected} onSelect={setSelected}
        rows={data.tenants.map(t => ({ id: t.tenantId, label: t.name, value: t.renders }))} />
      {!data.tenants.length && <p>No tenants registered.</p>}
    </section>
    <section><label>Daily renders for<select value={tenant?.tenantId ?? ""} onChange={event => setSelected(event.target.value)}>
      <option value="">All tenants</option>{data.tenants.map(t => <option key={t.tenantId} value={t.tenantId}>{t.name}</option>)}
    </select></label><Daily range={data.window} rows={daily} /></section>
  </>;
}
function TenantSummary({ tenantId, query, version }: { tenantId: string; query: string; version: number }) {
  const base = `/api/tenants/${tenantId}/insights?${query}`;
  const { data, error } = useInsight<TenantInsights>(base, version);
  const [detail, setDetail] = useState<{ kind: "report" | "user"; id: string }>();
  const [page, setPage] = useState(0);
  if (!data) return <section><p role={error ? "alert" : "status"}>{error ?? "Loading tenant insights..."}</p></section>;
  return <>
    <section><h3>{data.name}</h3><Metrics values={[["Users", data.totals.users], ["Hosted reports", data.totals.reports], ["Completed renders in range", data.totals.renders]]} />
      <Daily range={data.window} rows={data.daily} />
    </section>
    <section><h3>User and report details</h3>
      <div className="inline"><label>Report<select value={detail?.kind === "report" ? detail.id : ""} onChange={e => {
        setDetail(e.target.value ? { kind: "report", id: e.target.value } : undefined); setPage(0);
      }}><option value="">Choose report</option>{data.reports.map(r => <option value={r.id} key={r.id}>{r.name} ({r.id.slice(0, 8)})</option>)}</select></label>
        <label>User<select value={detail?.kind === "user" ? detail.id : ""} onChange={e => {
          setDetail(e.target.value ? { kind: "user", id: e.target.value } : undefined); setPage(0);
        }}><option value="">Choose user</option>{data.users.map(u => <option value={u.id} key={u.id}>{u.name} ({u.id.slice(0, 8)})</option>)}</select></label>
      </div>
      <p className="muted">Lists include historical identities/reports retained in telemetry. Historical names may differ from current names.
        Viewing usage does not grant permission to open a report.</p>
      {data.directoryLimited && <p role="status">Only the first 500 users/reports are listed.</p>}
    </section>
    {detail?.kind === "report" && <ReportDetail url={`${base}&reportId=${encodeURIComponent(detail.id)}`} version={version} />}
    {detail?.kind === "user" && <UserDetail url={`${base}&userId=${encodeURIComponent(detail.id)}&page=${page}`} version={version}
      page={page} setPage={setPage} rangeKey={query} />}
  </>;
}
function ReportDetail({ url, version }: { url: string; version: number }) {
  const { data, error } = useInsight<ReportInsights>(url, version);
  if (!data) return <section><p role={error ? "alert" : "status"}>{error ?? "Loading report usage..."}</p></section>;
  const hourly = hourlySeries(data.window, data.hourly);
  const daily = dailySeries(data.window, data.daily);
  return <section><h3>Report: {data.report.name}</h3>
    <LineChart title="Completed renders per hour (UTC)" unit="renders" integers labels={hourly.labels} values={hourly.counts} />
    <LineChart title="Completed renders per day (UTC)" unit="renders" integers labels={daily.labels} values={daily.counts} />
    <LineChart title="Average render duration by day (UTC)" unit="seconds" labels={daily.labels} values={daily.averages} />
    <p>Duration includes token generation and any capacity startup/recovery; it is not pure Power BI visual rendering time.</p>
  </section>;
}
function UserDetail({ url, version, page, setPage, rangeKey }: {
  url: string; version: number; page: number; setPage: (page: number) => void; rangeKey: string;
}) {
  useEffect(() => { setPage(0); }, [rangeKey, setPage]);
  const { data, error } = useInsight<UserInsights>(url, version);
  if (!data) return <section><p role={error ? "alert" : "status"}>{error ?? "Loading user usage..."}</p></section>;
  const statuses = { Requested: "Unconfirmed (received)", Authorized: "Unconfirmed (authorized)",
    Failed: "Embed request failed", Rendered: "Rendered" };
  return <section><h3>User: {data.user.name}</h3>
    <BarChart title="Most-used reports" unit="completed renders" rows={data.usage.map(row => ({
      id: row.reportId, label: row.name, value: row.renders,
      detail: `${row.reportId} \u00b7 ${seconds(row.averageDurationMs)} average`,
    }))} />
    {!data.usage.length && <p>No completed renders in this range.</p>}
    {data.usageLimited && <p>Showing the top 500 reports.</p>}
    <h4>Report request history</h4>
    <p>Includes failed and unconfirmed initial attempts received after request tracking was enabled, plus older completed renders.
      An unconfirmed request may still be loading, abandoned, or missing completion telemetry; it is not proof of failure.
      Requests that never reach the authenticated server, or cannot be recorded, are not available.</p>
    <div className="insight-scroll"><table><caption>Request history, newest first (UTC)</caption>
      <thead><tr><th>Server received</th><th>Client requested</th><th>Report</th><th>Mode</th><th>Outcome</th><th>Duration</th></tr></thead>
      <tbody>{data.history.map(row => <tr key={row.id}><td>{new Date(row.receivedAt).toISOString()}</td>
        <td>{new Date(row.requestedAt).toISOString()}</td><td>{row.reportName}<small>{row.reportId}</small></td>
        <td>{row.mode}</td><td>{statuses[row.status]}</td><td>{row.durationMs === null ? "\u2014" : seconds(row.durationMs)}</td></tr>)}</tbody>
    </table></div>
    {!data.history.length && <p>No requests on this page.</p>}
    <div className="actions"><button disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</button>
      <span>Page {page + 1}</span><button disabled={!data.hasMore || page >= 1000} onClick={() => setPage(page + 1)}>Next</button></div>
  </section>;
}
