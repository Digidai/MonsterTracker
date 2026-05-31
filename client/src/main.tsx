import "@heroui/react/styles";
import "./styles.css";

import {
  Button,
  Card,
  Chip,
  Input,
  ProgressBar,
  Surface,
  Tabs
} from "@heroui/react";
import {
  Activity,
  AlertTriangle,
  BarChart3,
  CheckCircle2,
  CircleDot,
  Clock3,
  Command,
  Eye,
  EyeOff,
  Globe2,
  KeyRound,
  Layers3,
  ListFilter,
  LockKeyhole,
  MapPinned,
  Play,
  Plus,
  RefreshCw,
  Search,
  Server,
  Settings2,
  ShieldCheck,
  Signal,
  Trash2,
  Zap
} from "lucide-react";
import { type FormEvent, type Key, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";

import type {
  DetailTab,
  Incident,
  LatestResult,
  MonitorConfig,
  MonitorConfigPatch,
  MonitorMethod,
  RegionConfig,
  RegionConfigPatch,
  StatusFilter,
  Summary,
  UsageSummary,
  ViewKey
} from "./types";

const navItems: Array<{ key: ViewKey; label: string; icon: typeof Activity }> = [
  { key: "overview", label: "Overview", icon: Activity },
  { key: "monitors", label: "Monitors", icon: Server },
  { key: "regions", label: "Regions", icon: Globe2 },
  { key: "incidents", label: "Incidents", icon: AlertTriangle },
  { key: "usage", label: "Usage", icon: BarChart3 },
  { key: "placement", label: "Placement", icon: MapPinned },
  { key: "tokens", label: "Tokens", icon: KeyRound }
];

const detailTabs: Array<{ key: DetailTab; label: string }> = [
  { key: "overview", label: "Overview" },
  { key: "regions", label: "Regions" },
  { key: "alerts", label: "Alerts" },
  { key: "settings", label: "Settings" }
];

const emptySummary: Summary = {
  generatedAt: new Date(0).toISOString(),
  monitors: [],
  regions: [],
  latest: [],
  incidents: [],
  usage: {
    date: "",
    probeResults: 0,
    workerInvocations: 0,
    queueMessages: 0,
    d1Writes: 0
  }
};

function App() {
  const [token, setToken] = useState(() => sessionStorage.getItem("monstertracker.adminToken") || "");
  const [view, setView] = useState<ViewKey>(() => (sessionStorage.getItem("monstertracker.view") as ViewKey) || "overview");
  const [detailTab, setDetailTab] = useState<DetailTab>(
    () => (sessionStorage.getItem("monstertracker.detailTab") as DetailTab) || "overview"
  );
  const [summary, setSummary] = useState<Summary | null>(null);
  const [selectedMonitorId, setSelectedMonitorId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState<{ tone: "success" | "danger" | "info"; message: string } | null>(null);
  const [form, setForm] = useState({
    url: "",
    name: "",
    dailyBudget: "100",
    method: "HEAD" as MonitorMethod
  });

  useEffect(() => {
    sessionStorage.setItem("monstertracker.adminToken", token);
  }, [token]);

  useEffect(() => {
    sessionStorage.setItem("monstertracker.view", view);
  }, [view]);

  useEffect(() => {
    sessionStorage.setItem("monstertracker.detailTab", detailTab);
  }, [detailTab]);

  useEffect(() => {
    if (token.trim()) {
      void loadSummary();
    } else {
      setView("tokens");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(null), 3800);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  const data = summary || emptySummary;
  const latestByMonitor = useMemo(() => groupLatest(data.latest), [data.latest]);
  const selectedMonitor = data.monitors.find((monitor) => monitor.id === selectedMonitorId) || data.monitors[0] || null;
  const selectedLatest = selectedMonitor ? latestByMonitor.get(selectedMonitor.id) || [] : [];
  const health = useMemo(() => computeHealth(data, latestByMonitor), [data, latestByMonitor]);
  const filteredMonitors = useMemo(
    () => filterMonitors(data.monitors, latestByMonitor, query, statusFilter),
    [data.monitors, latestByMonitor, query, statusFilter]
  );

  async function requestJson<T>(path: string, init: RequestInit = {}, authToken = token): Promise<T> {
    const response = await fetch(path, {
      ...init,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${authToken.trim()}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers
      }
    });
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    if (!response.ok) {
      throw new Error(body.error || `Request failed: ${response.status}`);
    }
    return body as T;
  }

  async function loadSummary(authToken = token) {
    if (!authToken.trim()) {
      setView("tokens");
      showToast("danger", "Admin token is required.");
      return;
    }
    setLoading(true);
    try {
      const next = await requestJson<Summary>("/api/summary", {}, authToken);
      setSummary(next);
      if (!selectedMonitorId && next.monitors[0]) setSelectedMonitorId(next.monitors[0].id);
      showToast("success", "Summary refreshed.");
    } catch (error) {
      showToast("danger", error instanceof Error ? error.message : "Failed to refresh.");
      if (!summary) setView("tokens");
    } finally {
      setLoading(false);
    }
  }

  async function saveToken(nextToken: string) {
    const normalized = nextToken.trim();
    setToken(normalized);
    if (!normalized) {
      setSummary(null);
      setSelectedMonitorId(null);
      setView("tokens");
      showToast("info", "Admin token cleared.");
      return;
    }
    showToast("info", "Admin token saved for this session.");
    await loadSummary(normalized);
  }

  async function createMonitor() {
    if (!form.url.trim()) {
      showToast("danger", "URL is required.");
      return;
    }
    setLoading(true);
    try {
      const body = await requestJson<{ monitor: MonitorConfig }>("/api/monitors", {
        method: "POST",
        body: JSON.stringify({
          url: form.url.trim(),
          name: form.name.trim(),
          dailyBudget: Number.parseInt(form.dailyBudget, 10) || 100,
          method: form.method
        })
      });
      setSelectedMonitorId(body.monitor.id);
      setView("overview");
      setDetailTab("overview");
      setForm({ url: "", name: "", dailyBudget: "100", method: "HEAD" });
      await loadSummary();
      showToast("success", "Monitor created.");
    } catch (error) {
      showToast("danger", error instanceof Error ? error.message : "Create failed.");
    } finally {
      setLoading(false);
    }
  }

  async function saveMonitorConfig(id: string, patch: MonitorConfigPatch) {
    setLoading(true);
    try {
      const body = await requestJson<{ monitor: MonitorConfig }>(`/api/monitors/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify(patch)
      });
      setSelectedMonitorId(body.monitor.id);
      await loadSummary();
      showToast("success", "Monitor configuration saved.");
    } catch (error) {
      showToast("danger", error instanceof Error ? error.message : "Monitor update failed.");
    } finally {
      setLoading(false);
    }
  }

  async function saveRegionConfig(id: string, patch: RegionConfigPatch) {
    setLoading(true);
    try {
      await requestJson<{ region: RegionConfig }>(`/api/regions/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify(patch)
      });
      await loadSummary();
      showToast("success", "Region configuration saved.");
    } catch (error) {
      showToast("danger", error instanceof Error ? error.message : "Region update failed.");
    } finally {
      setLoading(false);
    }
  }

  async function runDueNow() {
    setLoading(true);
    try {
      const body = await requestJson<{ plannedJobs: number; dispatchedJobs: number; queued: boolean }>("/api/run", {
        method: "POST",
        body: JSON.stringify({ mode: "due" })
      });
      showToast("success", `Dispatched ${body.dispatchedJobs} probe job${body.dispatchedJobs === 1 ? "" : "s"}.`);
      window.setTimeout(() => void loadSummary(), body.queued ? 900 : 100);
    } catch (error) {
      showToast("danger", error instanceof Error ? error.message : "Run failed.");
    } finally {
      setLoading(false);
    }
  }

  function selectView(next: ViewKey) {
    setView(next);
    if (next === "regions" || next === "placement") setDetailTab("regions");
    if (next === "incidents") setDetailTab("alerts");
    if (next === "tokens" || next === "monitors") setDetailTab("settings");
  }

  function showToast(tone: "success" | "danger" | "info", message: string) {
    setToast({ tone, message });
  }

  return (
    <div className="app-shell">
      <Sidebar
        view={view}
        summary={data}
        onChange={selectView}
        tokenSet={Boolean(token.trim())}
        health={health}
      />
      <main className="workspace">
        <TopBar
          view={view}
          summary={data}
          health={health}
          loading={loading}
          tokenSet={Boolean(token.trim())}
          onRefresh={loadSummary}
          onRun={runDueNow}
        />
        <CommandBar
          view={view}
          query={query}
          statusFilter={statusFilter}
          onQueryChange={setQuery}
          onFilterChange={setStatusFilter}
          onAdd={() => {
            setView("monitors");
            setDetailTab("settings");
          }}
        />
        <section className="workspace-body">
          <MainView
            view={view}
            summary={data}
            health={health}
            latestByMonitor={latestByMonitor}
            monitors={filteredMonitors}
            selectedMonitorId={selectedMonitorId}
            token={token}
            loading={loading}
            onTokenSave={saveToken}
            onRegionSave={saveRegionConfig}
            onMonitorSelect={(monitor) => {
              setSelectedMonitorId(monitor.id);
              setDetailTab("overview");
            }}
          />
        </section>
      </main>
      <Inspector
        summary={data}
        monitor={selectedMonitor}
        latest={selectedLatest}
        tab={detailTab}
        form={form}
        token={token}
        loading={loading}
        onTabChange={setDetailTab}
        onTokenSave={saveToken}
        onMonitorSave={saveMonitorConfig}
        onFormChange={setForm}
        onCreate={createMonitor}
      />
      {toast ? <Toast tone={toast.tone} message={toast.message} /> : null}
    </div>
  );
}

function Sidebar({
  view,
  summary,
  health,
  tokenSet,
  onChange
}: {
  view: ViewKey;
  summary: Summary;
  health: HealthSummary;
  tokenSet: boolean;
  onChange: (view: ViewKey) => void;
}) {
  return (
    <aside className="sidebar">
      <div className="brand-row">
        <div className="brand-mark">
          <Signal size={18} />
        </div>
        <div>
          <strong>MonsterTracker</strong>
          <span>Edge monitor control</span>
        </div>
      </div>

      <Surface className="operator-card">
        <div>
          <span>Cloudflare account</span>
          <strong>{tokenSet ? "Admin session" : "Locked session"}</strong>
        </div>
        <Chip color={tokenSet ? "success" : "warning"} size="sm" variant="soft">
          {tokenSet ? "Ready" : "Token"}
        </Chip>
      </Surface>

      <nav className="nav-stack">
        {navItems.map((item) => {
          const Icon = item.icon;
          const count = item.key === "overview" || item.key === "monitors"
            ? summary.monitors.length
            : item.key === "regions" || item.key === "placement"
              ? summary.regions.filter((region) => region.enabled).length
              : item.key === "incidents"
                ? summary.incidents.length
                : undefined;
          return (
            <button
              className={view === item.key ? "nav-button active" : "nav-button"}
              key={item.key}
              onClick={() => onChange(item.key)}
              type="button"
            >
              <span>
                <Icon size={17} />
                {item.label}
              </span>
              {typeof count === "number" ? <em>{count}</em> : null}
            </button>
          );
        })}
      </nav>

      <div className="sidebar-footer">
        <div className="quota-ring">
          <span>{Math.min(100, health.budgetPct)}%</span>
        </div>
        <div>
          <strong>Free tier fit</strong>
          <span>{summary.usage.probeResults <= 100_000 ? "Within daily request budget" : "Paid plan recommended"}</span>
        </div>
      </div>
    </aside>
  );
}

function TopBar({
  view,
  summary,
  health,
  loading,
  tokenSet,
  onRefresh,
  onRun
}: {
  view: ViewKey;
  summary: Summary;
  health: HealthSummary;
  loading: boolean;
  tokenSet: boolean;
  onRefresh: () => void;
  onRun: () => void;
}) {
  const titles: Record<ViewKey, [string, string]> = {
    overview: ["Global Monitors", `${summary.monitors.length} monitors across ${summary.regions.length} placed regions`],
    monitors: ["Monitor Config", `${summary.monitors.length} configured targets`],
    regions: ["Probe Regions", `${summary.regions.filter((region) => region.enabled).length} active placement hints`],
    incidents: ["Incidents", `${summary.incidents.length} tracked incident records`],
    usage: ["Usage", `${formatNumber(summary.usage.probeResults)} probe results today`],
    placement: ["Placement", `${summary.regions.length} Worker routes and placement hints`],
    tokens: ["Access", tokenSet ? "Admin token is active in this browser session" : "Admin token required"]
  };
  const [title, subtitle] = titles[view];

  return (
    <header className="topbar">
      <div className="title-block">
        <div className="title-icon">
          <Zap size={20} />
        </div>
        <div>
          <h1>{title}</h1>
          <p>{subtitle}</p>
        </div>
      </div>
      <div className="top-actions">
        <Surface className="budget-meter">
          <span>Probe budget</span>
          <ProgressBar aria-label="Probe budget used" value={health.budgetPct} />
          <strong>{health.budgetPct}%</strong>
        </Surface>
        <Button isDisabled={loading} onPress={onRefresh} size="sm" variant="outline">
          <RefreshCw size={16} />
          Refresh
        </Button>
        <Button className="primary-action" isDisabled={loading || !tokenSet} onPress={onRun} size="sm" variant="primary">
          <Play size={16} />
          Run Due Now
        </Button>
      </div>
    </header>
  );
}

function CommandBar({
  view,
  query,
  statusFilter,
  onQueryChange,
  onFilterChange,
  onAdd
}: {
  view: ViewKey;
  query: string;
  statusFilter: StatusFilter;
  onQueryChange: (value: string) => void;
  onFilterChange: (value: StatusFilter) => void;
  onAdd: () => void;
}) {
  const showFilters = view === "overview" || view === "monitors";
  return (
    <div className="commandbar">
      {showFilters ? (
        <>
          <label className="search-box">
            <Search size={16} />
            <input
              aria-label="Search monitors"
              onChange={(event) => onQueryChange(event.currentTarget.value)}
              placeholder="Search monitors, URLs, tags"
              value={query}
            />
          </label>
          <label className="filter-select">
            <ListFilter size={16} />
            <select
              aria-label="Filter monitor status"
              onChange={(event) => onFilterChange(event.currentTarget.value as StatusFilter)}
              value={statusFilter}
            >
              <option value="all">All status</option>
              <option value="up">Up</option>
              <option value="down">Down</option>
              <option value="idle">Idle</option>
            </select>
          </label>
        </>
      ) : (
        <div className="command-context">
          <Command size={16} />
          <span>{viewLabel(view)}</span>
        </div>
      )}
      <Button onPress={onAdd} size="sm" variant="secondary">
        <Plus size={16} />
        Add Monitor
      </Button>
    </div>
  );
}

function MainView({
  view,
  summary,
  health,
  latestByMonitor,
  monitors,
  selectedMonitorId,
  token,
  loading,
  onTokenSave,
  onRegionSave,
  onMonitorSelect
}: {
  view: ViewKey;
  summary: Summary;
  health: HealthSummary;
  latestByMonitor: Map<string, LatestResult[]>;
  monitors: MonitorConfig[];
  selectedMonitorId: string | null;
  token: string;
  loading: boolean;
  onTokenSave: (value: string) => void | Promise<void>;
  onRegionSave: (id: string, patch: RegionConfigPatch) => void | Promise<void>;
  onMonitorSelect: (monitor: MonitorConfig) => void;
}) {
  if (view === "regions") return <RegionsView regions={summary.regions} />;
  if (view === "incidents") return <IncidentsView incidents={summary.incidents} />;
  if (view === "usage") return <UsageView summary={summary} health={health} />;
  if (view === "placement") return <PlacementView loading={loading} regions={summary.regions} onRegionSave={onRegionSave} />;
  if (view === "tokens") return <TokensView tokenSet={Boolean(token.trim())} onTokenSave={onTokenSave} />;
  return (
    <>
      <MetricStrip summary={summary} health={health} />
      <MonitorTable
        latestByMonitor={latestByMonitor}
        monitors={monitors}
        regionCount={summary.regions.length}
        selectedMonitorId={selectedMonitorId}
        onMonitorSelect={onMonitorSelect}
      />
    </>
  );
}

function MetricStrip({ summary, health }: { summary: Summary; health: HealthSummary }) {
  return (
    <div className="metric-strip">
      <MetricCard icon={Server} label="Monitors" tone="teal" value={summary.monitors.length} />
      <MetricCard icon={Globe2} label="Regions" tone="indigo" value={summary.regions.filter((region) => region.enabled).length} />
      <MetricCard icon={CheckCircle2} label="Up" tone="green" value={health.up} />
      <MetricCard icon={AlertTriangle} label="Down" tone="amber" value={health.down} />
      <MetricCard icon={Clock3} label="Daily probes" tone="purple" value={formatNumber(summary.usage.probeResults)} />
      <MetricCard icon={Layers3} label="D1 writes" tone="rose" value={formatNumber(summary.usage.d1Writes)} />
    </div>
  );
}

function MetricCard({
  icon: Icon,
  label,
  value,
  tone
}: {
  icon: typeof Activity;
  label: string;
  value: string | number;
  tone: string;
}) {
  return (
    <Card className="metric-card" variant="default">
      <Card.Content>
        <div className={`metric-icon ${tone}`}>
          <Icon size={17} />
        </div>
        <span>{label}</span>
        <strong>{value}</strong>
      </Card.Content>
    </Card>
  );
}

function MonitorTable({
  monitors,
  latestByMonitor,
  regionCount,
  selectedMonitorId,
  onMonitorSelect
}: {
  monitors: MonitorConfig[];
  latestByMonitor: Map<string, LatestResult[]>;
  regionCount: number;
  selectedMonitorId: string | null;
  onMonitorSelect: (monitor: MonitorConfig) => void;
}) {
  const rows = monitors.map((monitor) => {
    const latest = latestByMonitor.get(monitor.id) || [];
    const status = monitorStatus(latest);
    const latency = median(latest.map((item) => item.latencyMs).filter(isFiniteNumber));
    const checked = latest.length;
    const selected = monitor.id === selectedMonitorId;
    return { checked, latency, latest, monitor, selected, status };
  });

  return (
    <Card className="data-card" variant="default">
      <Card.Header>
        <div>
          <Card.Title>Monitor worklist</Card.Title>
          <Card.Description>Operational status, latency and regional coverage.</Card.Description>
        </div>
        <Chip size="sm" variant="soft">{monitors.length} targets</Chip>
      </Card.Header>
      <Card.Content className="table-frame">
        <table className="monitor-table">
          <thead>
            <tr>
              <th>Status</th>
              <th>Target</th>
              <th>Last Check</th>
              <th>Latency</th>
              <th>Coverage</th>
              <th>Budget</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ checked, latency, latest, monitor, selected, status }) => {
              return (
                <tr
                  className={selected ? "selected" : ""}
                  key={monitor.id}
                  onClick={() => onMonitorSelect(monitor)}
                >
                  <td>
                    <StatusChip status={status} />
                  </td>
                  <td>
                    <div className="target-cell">
                      <strong>{monitor.name}</strong>
                      <span>{monitor.method} / {monitor.url}</span>
                    </div>
                  </td>
                  <td>{latest[0] ? relativeTime(latest[0].checkedAt) : "never"}</td>
                  <td>{latency ? `${latency} ms` : "-"}</td>
                  <td>
                    <CoverageMini checked={checked} total={regionCount} />
                  </td>
                  <td>
                    <div className="budget-cell">
                      <ProgressBar aria-label={`${monitor.name} budget`} value={Math.min(100, Math.round((checked / Math.max(1, monitor.dailyBudget)) * 100))} />
                      <span>{monitor.dailyBudget}</span>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="mobile-monitor-list">
          {rows.map(({ checked, latency, latest, monitor, selected, status }) => (
            <button
              className={`mobile-monitor-card${selected ? " selected" : ""}`}
              key={monitor.id}
              onClick={() => onMonitorSelect(monitor)}
              type="button"
            >
              <div className="mobile-monitor-head">
                <StatusChip status={status} />
                <span>{latest[0] ? relativeTime(latest[0].checkedAt) : "never"}</span>
              </div>
              <strong>{monitor.name}</strong>
              <span className="mobile-monitor-url">{monitor.method} / {monitor.url}</span>
              <div className="mobile-monitor-meta">
                <span>{latency ? `${latency} ms` : "No latency"}</span>
                <span>{monitor.dailyBudget} daily</span>
              </div>
              <CoverageMini checked={checked} total={regionCount} />
            </button>
          ))}
        </div>
      </Card.Content>
    </Card>
  );
}

function RegionsView({ regions }: { regions: RegionConfig[] }) {
  return (
    <Card className="data-card" variant="default">
      <Card.Header>
        <div>
          <Card.Title>Regional probe mesh</Card.Title>
          <Card.Description>Placement hints and last seen metadata from Workers.</Card.Description>
        </div>
      </Card.Header>
      <Card.Content className="region-board">
        {regions.map((region) => (
          <Surface className="region-row" key={region.id}>
            <div className="region-lead">
              <span className="status-dot ok" />
              <div>
                <strong>{region.label}</strong>
                <span>{region.area}</span>
              </div>
            </div>
            <Chip size="sm" variant="soft">{region.id.toUpperCase()}</Chip>
            <span>{region.provider}:{region.providerRegion}</span>
            <span>{region.placementRegion}</span>
            <span>{region.lastSeenAt ? relativeTime(region.lastSeenAt) : "never"}</span>
          </Surface>
        ))}
      </Card.Content>
    </Card>
  );
}

function IncidentsView({ incidents }: { incidents: Incident[] }) {
  if (!incidents.length) {
    return (
      <Card className="empty-state" variant="default">
        <Card.Content>
          <ShieldCheck size={30} />
          <strong>No open incidents</strong>
          <span>Incident records will appear here when regional failures cross the configured threshold.</span>
        </Card.Content>
      </Card>
    );
  }
  return (
    <div className="stack-list">
      {incidents.map((incident) => (
        <Card className="incident-card" key={incident.id}>
          <Card.Content>
            <div>
              <strong>{incident.severity}</strong>
              <span>{incident.summary}</span>
            </div>
            <Chip color={incident.status === "open" ? "danger" : "success"} size="sm" variant="soft">
              {incident.status}
            </Chip>
          </Card.Content>
        </Card>
      ))}
    </div>
  );
}

function UsageView({ summary, health }: { summary: Summary; health: HealthSummary }) {
  const rows: Array<[string, string | number, number]> = [
    ["Worker requests", formatNumber(summary.usage.probeResults), Math.min(100, Math.round((summary.usage.probeResults / 100_000) * 100))],
    ["Analytics points", formatNumber(summary.usage.probeResults), Math.min(100, Math.round((summary.usage.probeResults / 100_000) * 100))],
    ["D1 writes", formatNumber(summary.usage.d1Writes), Math.min(100, Math.round((summary.usage.d1Writes / 100_000) * 100))],
    ["Queue messages", formatNumber(summary.usage.queueMessages), Math.min(100, Math.round((summary.usage.queueMessages / 10_000) * 100))]
  ];
  return (
    <>
      <MetricStrip summary={summary} health={health} />
      <Card className="data-card" variant="default">
        <Card.Header>
          <div>
            <Card.Title>Free quota fit</Card.Title>
            <Card.Description>Daily counters compared with Cloudflare Free planning assumptions.</Card.Description>
          </div>
        </Card.Header>
        <Card.Content className="quota-list">
          {rows.map(([label, value, pct]) => (
            <div className="quota-row" key={label}>
              <div>
                <strong>{label}</strong>
                <span>{value}</span>
              </div>
              <ProgressBar aria-label={label} value={pct} />
              <em>{pct}%</em>
            </div>
          ))}
        </Card.Content>
      </Card>
    </>
  );
}

function PlacementView({
  regions,
  loading,
  onRegionSave
}: {
  regions: RegionConfig[];
  loading: boolean;
  onRegionSave: (id: string, patch: RegionConfigPatch) => void | Promise<void>;
}) {
  return (
    <Card className="data-card" variant="default">
      <Card.Header>
        <div>
          <Card.Title>Worker dispatch routes</Card.Title>
          <Card.Description>Control Worker uses these URLs before falling back to templates.</Card.Description>
        </div>
      </Card.Header>
      <Card.Content className="stack-list">
        {regions.map((region) => (
          <RegionRouteEditor key={region.id} loading={loading} region={region} onSave={onRegionSave} />
        ))}
      </Card.Content>
    </Card>
  );
}

function RegionRouteEditor({
  region,
  loading,
  onSave
}: {
  region: RegionConfig;
  loading: boolean;
  onSave: (id: string, patch: RegionConfigPatch) => void | Promise<void>;
}) {
  const [workerUrl, setWorkerUrl] = useState(region.workerUrl || "");
  const [weight, setWeight] = useState(String(region.weight));
  const [enabled, setEnabled] = useState(region.enabled);

  useEffect(() => {
    setWorkerUrl(region.workerUrl || "");
    setWeight(String(region.weight));
    setEnabled(region.enabled);
  }, [region.id, region.workerUrl, region.weight, region.enabled]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await onSave(region.id, {
      workerUrl: workerUrl.trim() || null,
      weight: Number.parseInt(weight, 10) || 1,
      enabled
    });
  }

  return (
    <Surface className="route-row editable">
      <form className="route-form" onSubmit={save}>
        <div className="route-heading">
          <div>
            <strong>{region.workerName}</strong>
            <span>{region.label} · {region.placementRegion}</span>
          </div>
          <Chip color={enabled ? "success" : "warning"} size="sm" variant="soft">
            {enabled ? "enabled" : "paused"}
          </Chip>
        </div>
        <Input
          aria-label={`${region.label} Worker URL`}
          fullWidth
          onChange={(event) => setWorkerUrl(event.currentTarget.value)}
          placeholder="https://<probe-worker>.workers.dev"
          type="url"
          value={workerUrl}
          variant="secondary"
        />
        <div className="route-controls">
          <label className="check-row">
            <input checked={enabled} onChange={(event) => setEnabled(event.currentTarget.checked)} type="checkbox" />
            Enabled
          </label>
          <Input
            aria-label={`${region.label} weight`}
            fullWidth
            max={100}
            min={1}
            onChange={(event) => setWeight(event.currentTarget.value)}
            type="number"
            value={weight}
            variant="secondary"
          />
          <Button className="primary-action" isDisabled={loading} size="sm" type="submit" variant="primary">
            Save route
          </Button>
        </div>
      </form>
    </Surface>
  );
}

function TokenForm({
  tokenSet,
  onTokenSave
}: {
  tokenSet: boolean;
  onTokenSave: (value: string) => void | Promise<void>;
}) {
  const [draft, setDraft] = useState("");
  const [revealed, setRevealed] = useState(false);

  async function submitToken(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft.trim()) return;
    await onTokenSave(draft);
    setDraft("");
    setRevealed(false);
  }

  async function clearToken() {
    setDraft("");
    setRevealed(false);
    await onTokenSave("");
  }

  return (
    <form className="token-form" onSubmit={submitToken}>
      <input autoComplete="username" hidden readOnly type="text" value="admin" />
      <div className="token-input-row">
        <Input
          aria-label="Admin token"
          autoComplete="current-password"
          fullWidth
          onChange={(event) => setDraft(event.currentTarget.value)}
          placeholder={tokenSet ? "Token set for this session" : "ADMIN_TOKEN"}
          type={revealed ? "text" : "password"}
          value={draft}
          variant="secondary"
        />
        <Button
          aria-label={revealed ? "Hide token" : "Show token"}
          className="icon-button"
          isDisabled={!draft}
          onPress={() => setRevealed((current) => !current)}
          size="sm"
          type="button"
          variant="secondary"
        >
          {revealed ? <EyeOff size={16} /> : <Eye size={16} />}
        </Button>
      </div>
      <div className="token-actions">
        <Button className="primary-action" isDisabled={!draft.trim()} size="sm" type="submit" variant="primary">
          Save token
        </Button>
        <Button
          isDisabled={!tokenSet && !draft}
          onPress={clearToken}
          size="sm"
          type="button"
          variant="secondary"
        >
          <Trash2 size={15} />
          Clear
        </Button>
      </div>
    </form>
  );
}

function TokensView({
  tokenSet,
  onTokenSave
}: {
  tokenSet: boolean;
  onTokenSave: (value: string) => void | Promise<void>;
}) {
  return (
    <Card className="token-panel" variant="default">
      <Card.Header>
        <div>
          <Card.Title>Admin access</Card.Title>
          <Card.Description>Token is stored only in this browser session.</Card.Description>
        </div>
        <LockKeyhole size={20} />
      </Card.Header>
      <Card.Content>
        <TokenForm tokenSet={tokenSet} onTokenSave={onTokenSave} />
        <div className="token-states">
          <Chip color={tokenSet ? "success" : "warning"} size="sm" variant="soft">
            {tokenSet ? "Token set" : "Missing token"}
          </Chip>
          <span>Session storage</span>
          <span>Bearer auth</span>
        </div>
      </Card.Content>
    </Card>
  );
}

function Inspector({
  summary,
  monitor,
  latest,
  tab,
  form,
  token,
  loading,
  onTabChange,
  onTokenSave,
  onMonitorSave,
  onFormChange,
  onCreate
}: {
  summary: Summary;
  monitor: MonitorConfig | null;
  latest: LatestResult[];
  tab: DetailTab;
  form: { url: string; name: string; dailyBudget: string; method: MonitorMethod };
  token: string;
  loading: boolean;
  onTabChange: (tab: DetailTab) => void;
  onTokenSave: (value: string) => void | Promise<void>;
  onMonitorSave: (id: string, patch: MonitorConfigPatch) => void | Promise<void>;
  onFormChange: (form: { url: string; name: string; dailyBudget: string; method: MonitorMethod }) => void;
  onCreate: () => void;
}) {
  const status = monitorStatus(latest);
  return (
    <aside className="inspector">
      <div className="inspector-head">
        <div>
          <h2>{monitor?.name || "No monitor"}</h2>
          <p>{monitor?.url || "Create or select a monitor"}</p>
        </div>
        <StatusChip status={status} />
      </div>
      <Tabs
        className="detail-tabs"
        onSelectionChange={(key: Key) => onTabChange(String(key) as DetailTab)}
        selectedKey={tab}
        variant="secondary"
      >
        <Tabs.List>
          {detailTabs.map((item) => (
            <Tabs.Tab id={item.key} key={item.key}>
              {item.label}
            </Tabs.Tab>
          ))}
        </Tabs.List>
        <Tabs.Panel id="overview">
          <OverviewPanel latest={latest} monitor={monitor} />
        </Tabs.Panel>
        <Tabs.Panel id="regions">
          <CoveragePanel latest={latest} regions={summary.regions} />
        </Tabs.Panel>
        <Tabs.Panel id="alerts">
          <AlertsPanel incidents={summary.incidents.filter((incident) => incident.monitorId === monitor?.id)} />
        </Tabs.Panel>
        <Tabs.Panel id="settings">
          <SettingsPanel
            loading={loading}
            monitor={monitor}
            tokenSet={Boolean(token.trim())}
            onMonitorSave={onMonitorSave}
            onTokenSave={onTokenSave}
          />
        </Tabs.Panel>
      </Tabs>
      <AddMonitorForm form={form} loading={loading} onChange={onFormChange} onCreate={onCreate} />
    </aside>
  );
}

function OverviewPanel({ monitor, latest }: { monitor: MonitorConfig | null; latest: LatestResult[] }) {
  if (!monitor) return <div className="notice-panel">No monitor selected.</div>;
  return (
    <div className="detail-grid">
      <InfoItem label="Status" value={monitorStatus(latest)} />
      <InfoItem label="Method" value={monitor.method} />
      <InfoItem label="Last check" value={latest[0] ? relativeTime(latest[0].checkedAt) : "never"} />
      <InfoItem label="Timeout" value={`${monitor.timeoutMs} ms`} />
      <InfoItem label="Daily budget" value={monitor.dailyBudget} />
      <InfoItem label="Expected" value={`${monitor.expectedStatusMin}-${monitor.expectedStatusMax}`} />
    </div>
  );
}

function CoveragePanel({ regions, latest }: { regions: RegionConfig[]; latest: LatestResult[] }) {
  const seen = new Set(latest.map((item) => item.regionId));
  const failing = new Set(latest.filter((item) => !item.ok).map((item) => item.regionId));
  return (
    <div className="coverage-panel">
      <div className="coverage-head">
        <strong>{seen.size} / {regions.length}</strong>
        <span>regions checked</span>
      </div>
      <div className="region-grid">
        {regions.map((region) => (
          <span className={failing.has(region.id) ? "region-chip danger" : seen.has(region.id) ? "region-chip ok" : "region-chip"} key={region.id}>
            {region.id.toUpperCase()}
          </span>
        ))}
      </div>
    </div>
  );
}

function AlertsPanel({ incidents }: { incidents: Incident[] }) {
  if (!incidents.length) {
    return (
      <div className="notice-panel good">
        <CheckCircle2 size={18} />
        No incident records for this monitor.
      </div>
    );
  }
  return (
    <div className="stack-list">
      {incidents.map((incident) => (
        <div className="alert-row" key={incident.id}>
          <strong>{incident.severity}</strong>
          <span>{incident.summary}</span>
        </div>
      ))}
    </div>
  );
}

function SettingsPanel({
  monitor,
  loading,
  tokenSet,
  onMonitorSave,
  onTokenSave
}: {
  monitor: MonitorConfig | null;
  loading: boolean;
  tokenSet: boolean;
  onMonitorSave: (id: string, patch: MonitorConfigPatch) => void | Promise<void>;
  onTokenSave: (value: string) => void | Promise<void>;
}) {
  return (
    <div className="settings-panel">
      {monitor ? (
        <MonitorConfigForm loading={loading} monitor={monitor} onSave={onMonitorSave} />
      ) : null}
      <div className="settings-meta">
        <strong>Access token</strong>
        <TokenForm tokenSet={tokenSet} onTokenSave={onTokenSave} />
      </div>
    </div>
  );
}

function MonitorConfigForm({
  monitor,
  loading,
  onSave
}: {
  monitor: MonitorConfig;
  loading: boolean;
  onSave: (id: string, patch: MonitorConfigPatch) => void | Promise<void>;
}) {
  const [form, setForm] = useState(() => monitorToForm(monitor));

  useEffect(() => {
    setForm(monitorToForm(monitor));
  }, [monitor.id, monitor.updatedAt]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await onSave(monitor.id, {
      name: form.name,
      url: form.url,
      method: form.method,
      expectedStatusMin: Number.parseInt(form.expectedStatusMin, 10),
      expectedStatusMax: Number.parseInt(form.expectedStatusMax, 10),
      bodyMatch: form.bodyMatch.trim() || null,
      timeoutMs: Number.parseInt(form.timeoutMs, 10),
      dailyBudget: Number.parseInt(form.dailyBudget, 10),
      enabled: form.enabled,
      tags: splitTags(form.tags)
    });
  }

  return (
    <form className="monitor-config-form" onSubmit={save}>
      <div className="config-section-title">
        <strong>Monitor configuration</strong>
        <Chip color={form.enabled ? "success" : "warning"} size="sm" variant="soft">
          {form.enabled ? "enabled" : "paused"}
        </Chip>
      </div>
      <label className="check-row">
        <input
          checked={form.enabled}
          onChange={(event) => setForm({ ...form, enabled: event.currentTarget.checked })}
          type="checkbox"
        />
        Enabled for scheduling
      </label>
      <Input
        aria-label="Monitor name"
        fullWidth
        onChange={(event) => setForm({ ...form, name: event.currentTarget.value })}
        placeholder="Example API"
        value={form.name}
        variant="secondary"
      />
      <Input
        aria-label="Monitor URL"
        fullWidth
        onChange={(event) => setForm({ ...form, url: event.currentTarget.value })}
        placeholder="https://example.com/health"
        type="url"
        value={form.url}
        variant="secondary"
      />
      <div className="form-row">
        <label className="method-select">
          <span>Method</span>
          <select
            onChange={(event) => setForm({ ...form, method: event.currentTarget.value as MonitorMethod })}
            value={form.method}
          >
            <option value="HEAD">HEAD</option>
            <option value="GET">GET</option>
          </select>
        </label>
        <Input
          aria-label="Daily budget"
          fullWidth
          min={1}
          onChange={(event) => setForm({ ...form, dailyBudget: event.currentTarget.value })}
          type="number"
          value={form.dailyBudget}
          variant="secondary"
        />
      </div>
      <div className="form-row">
        <Input
          aria-label="Expected status min"
          fullWidth
          max={599}
          min={100}
          onChange={(event) => setForm({ ...form, expectedStatusMin: event.currentTarget.value })}
          type="number"
          value={form.expectedStatusMin}
          variant="secondary"
        />
        <Input
          aria-label="Expected status max"
          fullWidth
          max={599}
          min={100}
          onChange={(event) => setForm({ ...form, expectedStatusMax: event.currentTarget.value })}
          type="number"
          value={form.expectedStatusMax}
          variant="secondary"
        />
      </div>
      <Input
        aria-label="Timeout milliseconds"
        fullWidth
        max={60000}
        min={1000}
        onChange={(event) => setForm({ ...form, timeoutMs: event.currentTarget.value })}
        type="number"
        value={form.timeoutMs}
        variant="secondary"
      />
      <textarea
        aria-label="Body match"
        className="textarea-control"
        onChange={(event) => setForm({ ...form, bodyMatch: event.currentTarget.value })}
        placeholder="Optional response text match for GET checks"
        value={form.bodyMatch}
      />
      <Input
        aria-label="Tags"
        fullWidth
        onChange={(event) => setForm({ ...form, tags: event.currentTarget.value })}
        placeholder="production, api"
        value={form.tags}
        variant="secondary"
      />
      <div className="detail-grid single compact">
        <InfoItem label="Monitor ID" value={monitor.id} />
        <InfoItem label="Updated" value={relativeTime(monitor.updatedAt)} />
      </div>
      <Button className="primary-action" fullWidth isDisabled={loading} size="sm" type="submit" variant="primary">
        Save configuration
      </Button>
    </form>
  );
}

function AddMonitorForm({
  form,
  loading,
  onChange,
  onCreate
}: {
  form: { url: string; name: string; dailyBudget: string; method: MonitorMethod };
  loading: boolean;
  onChange: (form: { url: string; name: string; dailyBudget: string; method: MonitorMethod }) => void;
  onCreate: () => void;
}) {
  return (
    <Card className="create-card" variant="secondary">
      <Card.Header>
        <div>
          <Card.Title>Add monitor</Card.Title>
          <Card.Description>Budget is distributed across enabled regions.</Card.Description>
        </div>
      </Card.Header>
      <Card.Content>
        <Input
          aria-label="URL"
          fullWidth
          onChange={(event) => onChange({ ...form, url: event.currentTarget.value })}
          placeholder="https://example.com/health"
          type="url"
          value={form.url}
          variant="secondary"
        />
        <div className="form-row">
          <Input
            aria-label="Name"
            fullWidth
            onChange={(event) => onChange({ ...form, name: event.currentTarget.value })}
            placeholder="Example API"
            value={form.name}
            variant="secondary"
          />
          <Input
            aria-label="Daily budget"
            fullWidth
            min={1}
            onChange={(event) => onChange({ ...form, dailyBudget: event.currentTarget.value })}
            type="number"
            value={form.dailyBudget}
            variant="secondary"
          />
        </div>
        <label className="method-select">
          <span>Method</span>
          <select
            onChange={(event) => onChange({ ...form, method: event.currentTarget.value as MonitorMethod })}
            value={form.method}
          >
            <option value="HEAD">HEAD</option>
            <option value="GET">GET</option>
          </select>
        </label>
        <Button className="primary-action" fullWidth isDisabled={loading} onPress={onCreate} variant="primary">
          <Plus size={16} />
          Create Monitor
        </Button>
      </Card.Content>
    </Card>
  );
}

function InfoItem({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="info-item">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function StatusChip({ status }: { status: "up" | "down" | "idle" }) {
  const color = status === "up" ? "success" : status === "down" ? "danger" : "warning";
  return (
    <Chip color={color} size="sm" variant="soft">
      <CircleDot size={12} />
      {status}
    </Chip>
  );
}

function CoverageMini({ checked, total }: { checked: number; total: number }) {
  const blocks = Array.from({ length: Math.min(18, Math.max(total, 1)) });
  return (
    <div className="coverage-mini">
      <span>{checked} / {total}</span>
      <div>
        {blocks.map((_, index) => (
          <i className={index < checked ? "on" : ""} key={index} />
        ))}
      </div>
    </div>
  );
}

function Toast({ tone, message }: { tone: "success" | "danger" | "info"; message: string }) {
  return (
    <div className={`toast ${tone}`}>
      {tone === "success" ? <CheckCircle2 size={16} /> : tone === "danger" ? <AlertTriangle size={16} /> : <Activity size={16} />}
      {message}
    </div>
  );
}

interface HealthSummary {
  up: number;
  down: number;
  idle: number;
  budgetPct: number;
}

function computeHealth(summary: Summary, latestByMonitor: Map<string, LatestResult[]>): HealthSummary {
  let up = 0;
  let down = 0;
  let idle = 0;
  const totalBudget = summary.monitors.reduce((total, monitor) => total + (monitor.enabled ? monitor.dailyBudget : 0), 0);
  for (const monitor of summary.monitors) {
    const status = monitorStatus(latestByMonitor.get(monitor.id) || []);
    if (status === "up") up += 1;
    else if (status === "down") down += 1;
    else idle += 1;
  }
  return {
    up,
    down,
    idle,
    budgetPct: totalBudget ? Math.min(100, Math.round((summary.usage.probeResults / totalBudget) * 100)) : 0
  };
}

function filterMonitors(
  monitors: MonitorConfig[],
  latestByMonitor: Map<string, LatestResult[]>,
  query: string,
  statusFilter: StatusFilter
) {
  const normalized = query.trim().toLowerCase();
  return monitors.filter((monitor) => {
    const status = monitorStatus(latestByMonitor.get(monitor.id) || []);
    if (statusFilter !== "all" && status !== statusFilter) return false;
    if (!normalized) return true;
    return [monitor.name, monitor.url, monitor.method, ...monitor.tags]
      .join(" ")
      .toLowerCase()
      .includes(normalized);
  });
}

function groupLatest(items: LatestResult[]) {
  const map = new Map<string, LatestResult[]>();
  for (const item of items) {
    const list = map.get(item.monitorId) || [];
    list.push(item);
    list.sort((a, b) => b.checkedAt.localeCompare(a.checkedAt));
    map.set(item.monitorId, list);
  }
  return map;
}

function monitorStatus(latest: LatestResult[]): "up" | "down" | "idle" {
  if (!latest.length) return "idle";
  return latest.some((item) => !item.ok) ? "down" : "up";
}

function median(values: number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.floor(sorted.length / 2)] || 0);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function relativeTime(iso: string) {
  const delta = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(delta)) return "unknown";
  if (delta < 60_000) return `${Math.max(1, Math.round(delta / 1000))}s ago`;
  if (delta < 3_600_000) return `${Math.round(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.round(delta / 3_600_000)}h ago`;
  return `${Math.round(delta / 86_400_000)}d ago`;
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("en", { maximumFractionDigits: 0 }).format(value);
}

function viewLabel(view: ViewKey) {
  return navItems.find((item) => item.key === view)?.label || "Overview";
}

function monitorToForm(monitor: MonitorConfig) {
  return {
    name: monitor.name,
    url: monitor.url,
    method: monitor.method,
    expectedStatusMin: String(monitor.expectedStatusMin),
    expectedStatusMax: String(monitor.expectedStatusMax),
    bodyMatch: monitor.bodyMatch || "",
    timeoutMs: String(monitor.timeoutMs),
    dailyBudget: String(monitor.dailyBudget),
    enabled: monitor.enabled,
    tags: monitor.tags.join(", ")
  };
}

function splitTags(value: string) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

createRoot(document.getElementById("root")!).render(<App />);
