import { Button, Chip, Label, ListBox, Select } from "@heroui/react";
import { Download, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { HistoryOutcome, HistoryRange, HistoryResponse } from "../../../src/history";
import type { MonitorConfig, RegionConfig } from "../types";
import { downloadText, historyCsv } from "../export";

interface Props {
  monitor: MonitorConfig;
  regions: RegionConfig[];
  token: string;
  refreshKey: number;
  onUnauthorized: () => void;
}

export default function MonitorHistory({ monitor, regions, token, refreshKey, onUnauthorized }: Props) {
  const [range, setRange] = useState<HistoryRange>("24h");
  const [outcome, setOutcome] = useState<HistoryOutcome>("all");
  const [region, setRegion] = useState("all");
  const [data, setData] = useState<HistoryResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const unauthorized = useRef(onUnauthorized);
  unauthorized.current = onUnauthorized;

  const load = useCallback(async (cursor?: string) => {
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    const requestId = ++generation.current;
    if (!cursor) setData(null);
    setError(null); setLoading(true);
    try {
      const params = new URLSearchParams({ range, outcome, limit: "50" });
      if (region !== "all") params.set("region", region);
      if (cursor) params.set("cursor", cursor);
      const response = await fetch(`/api/monitors/${encodeURIComponent(monitor.id)}/history?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)])
      });
      if (controller.signal.aborted || requestId !== generation.current) return;
      if (response.status === 401) unauthorized.current();
      const body = await response.json() as HistoryResponse & { error?: string };
      if (!response.ok) throw new Error(body.error || "Unable to load history.");
      if (requestId !== generation.current) return;
      setData((previous) => ({ ...body, results: cursor && previous
        ? [...previous.results, ...body.results.filter((row) => !previous.results.some((old) => old.id === row.id))]
        : body.results }));
    } catch (failure) {
      if (!controller.signal.aborted && requestId === generation.current)
        setError(failure instanceof Error ? failure.message : "Unable to load history.");
    } finally { if (requestId === generation.current) setLoading(false); }
  }, [monitor.id, monitor.configVersion, token, range, outcome, region, refreshKey]);

  useEffect(() => {
    if (token) void load();
    return () => { ++generation.current; active.current?.abort(); };
  }, [load, token]);

  const stats = data?.stats;
  return <section className="history-panel" aria-label="Probe history" aria-busy={loading}>
    <p className="panel-help">Results for configuration v{data?.configVersion ?? monitor.configVersion}. Changing the target or check rules starts a new evidence window.</p>
    {data && data.configVersion !== monitor.configVersion ? <div className="notice-panel" role="status">The monitor was updated since the dashboard snapshot. These results use the latest configuration, v{data.configVersion}. Refresh the dashboard to update its target details.</div> : null}
    <div className="history-filters">
      <HistoryFilter label="Time range" value={range} onChange={(value) => setRange(value as HistoryRange)}
        options={[["24h", "Last 24 hours"], ["7d", "Last 7 days"], ["30d", "Last 30 days"]]} />
      <HistoryFilter label="Result" value={outcome} onChange={(value) => setOutcome(value as HistoryOutcome)}
        options={[["all", "All results"], ["pass", "Passed"], ["fail", "Target failed"], ["infrastructure", "Probe unavailable"]]} />
      <HistoryFilter label="Region" value={region} onChange={setRegion}
        options={[["all", "All regions"], ...regions.map((r): [string, string] => [r.id, r.label])]} />
    </div>
    <div className="history-actions">
      <Button size="sm" variant="secondary" isDisabled={loading || !token} onPress={() => void load()}><RefreshCw size={14} />Refresh</Button>
      <Button size="sm" variant="outline" isDisabled={!data?.results.length || loading} onPress={() => {
        if (data) downloadText(`monstertracker-history-${monitor.id}.csv`, "\uFEFF" + historyCsv(data.results), "text/csv;charset=utf-8");
      }}><Download size={14} />Export {data?.results.length || 0} loaded rows</Button>
    </div>
    {stats ? <>
      <div className="history-stats">
        <HistoryStat label="Observed pass rate" value={stats.observedSuccessRate === null ? "—" : `${(stats.observedSuccessRate * 100).toFixed(1)}%`} />
        <HistoryStat label="Average response" value={stats.averageLatencyMs === null ? "—" : `${Math.round(stats.averageLatencyMs)} ms`} />
        <HistoryStat label="Target observations" value={String(stats.passed + stats.failed)} />
        <HistoryStat label="Unavailable probes" value={String(stats.infrastructure)} />
      </div>
      <p className="panel-help">Statistics cover all outcomes in this time range and region. Unavailable probes are excluded from the pass rate; this is not time-based uptime.</p>
      <p className="panel-help">Snapshot through {new Date(data.window.to).toLocaleString()}. Refresh to include newer results. Retention may remove older records.</p>
    </> : null}
    {error ? <div className="notice-panel danger" role="alert"><span>{error}</span>
      <Button size="sm" variant="secondary" isDisabled={loading} onPress={() => void load()}>Reload history</Button></div> : null}
    {loading && !data ? <div className="notice-panel" role="status">Loading probe history…</div> : null}
    {data && !data.results.length ? <div className="notice-panel">No results match these filters for the current configuration.</div> : null}
    <div className="history-list">
      {data?.results.map((result) => <article className="history-entry" key={result.id}>
        <div className="history-entry-heading"><strong>{regions.find((r) => r.id === result.regionId)?.label || result.regionId}</strong>
          <Chip size="sm" variant="soft" color={result.resultType === "infrastructure" ? "warning" : result.ok ? "success" : "danger"}>
            {result.resultType === "infrastructure" ? "Unavailable" : result.ok ? "Passed" : "Failed"}
          </Chip></div>
        <time dateTime={result.checkedAt}>{new Date(result.checkedAt).toLocaleString()}</time>
        <span>{result.status === null ? "No HTTP response" : `HTTP ${result.status}`} · {result.latencyMs === null ? "No latency" : `${result.latencyMs} ms`}</span>
        {result.error ? <p>{result.error}</p> : null}
      </article>)}
    </div>
    {data?.nextCursor ? <Button fullWidth variant="secondary" isDisabled={loading || !token} onPress={() => void load(data.nextCursor!)}>
      {loading ? "Loading…" : "Load 50 more"}</Button> : data?.results.length ? <p className="panel-help">All {data.results.length} matching results loaded.</p> : null}
  </section>;
}

function HistoryFilter({ label, value, options, onChange }: { label: string; value: string; options: [string, string][]; onChange: (value: string) => void }) {
  return <Select value={value} onChange={(key) => { if (typeof key === "string") onChange(key); }} variant="secondary">
    <Label>{label}</Label><Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger>
    <Select.Popover><ListBox>{options.map(([id, text]) => <ListBox.Item key={id} id={id} textValue={text}>{text}<ListBox.ItemIndicator /></ListBox.Item>)}</ListBox></Select.Popover>
  </Select>;
}
function HistoryStat({ label, value }: { label: string; value: string }) {
  return <div><span>{label}</span><strong>{value}</strong></div>;
}
