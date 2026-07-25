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
import {
  Component,
  type ErrorInfo,
  type FormEvent,
  type Key,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { createRoot } from "react-dom/client";

import type {
  DetailTab,
  Incident,
  LatestResult,
  MonitorConfig,
  MonitorConfigPatch,
  MonitorMethod,
  MonitorStatus,
  ProbeResult,
  RegionConfig,
  RegionConfigPatch,
  RunStatus,
  StatusFilter,
  Summary,
  UsageSummary,
  ViewKey
} from "./types";

interface MonitorDraft {
  url: string;
  name: string;
  dailyBudget: string;
  method: MonitorMethod;
  expectedStatusMin: string;
  expectedStatusMax: string;
  timeoutMs: string;
  bodyMatch: string;
  tags: string;
}

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
  { key: "history", label: "History" },
  { key: "regions", label: "Regions" },
  { key: "alerts", label: "Alerts" },
  { key: "settings", label: "Settings" }
];

const validViews = new Set<ViewKey>(navItems.map((item) => item.key));
const validDetailTabs = new Set<DetailTab>(detailTabs.map((item) => item.key));

type AuthStatus = "locked" | "verifying" | "authenticated" | "error";

class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

const emptySummary: Summary = {
  generatedAt: new Date(0).toISOString(),
  monitors: [],
  regions: [],
  latest: [],
  incidents: [],
  runs: [],
  usage: {
    date: "",
    probeResults: 0,
    workerInvocations: 0,
    queueMessages: 0,
    d1Writes: 0,
    reservedProbes: 0
  },
  runtime: {
    defaultDailyProbeBudget: 100,
    maxDailyProbes: 10_000,
    maxMonitorDailyBudget: 10_000,
    retentionDays: 30,
    probeBatchSize: 5,
    resultQueueBatchSize: 5,
    probeConcurrency: 6,
    dispatchConcurrency: 6,
    probeWorkerHostSuffix: ".genedai.workers.dev"
  }
};

const defaultMonitorDraft: MonitorDraft = {
  url: "",
  name: "",
  dailyBudget: "100",
  method: "HEAD",
  expectedStatusMin: "200",
  expectedStatusMax: "399",
  timeoutMs: "10000",
  bodyMatch: "",
  tags: ""
};

function App() {
  const [token, setToken] = useState("");
  const [authStatus, setAuthStatus] = useState<AuthStatus>("locked");
  const [view, setView] = useState<ViewKey>(() => parseStoredView(sessionStorage.getItem("monstertracker.view")));
  const [detailTab, setDetailTab] = useState<DetailTab>(
    () => parseStoredDetailTab(sessionStorage.getItem("monstertracker.detailTab"))
  );
  const [summary, setSummary] = useState<Summary | null>(null);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [selectedMonitorId, setSelectedMonitorId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [refreshing, setRefreshing] = useState(false);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [history, setHistory] = useState<ProbeResult[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ tone: "success" | "danger" | "info"; message: string } | null>(null);
  const [form, setForm] = useState<MonitorDraft>(defaultMonitorDraft);
  const summaryRequestId = useRef(0);
  const historyRequestId = useRef(0);
  const tokenVerificationId = useRef(0);

  useEffect(() => {
    sessionStorage.setItem("monstertracker.view", view);
  }, [view]);

  useEffect(() => {
    sessionStorage.setItem("monstertracker.detailTab", detailTab);
  }, [detailTab]);

  useEffect(() => {
    const storedToken = sessionStorage.getItem("monstertracker.adminToken")?.trim() || "";
    if (storedToken) {
      void verifyToken(storedToken);
    } else {
      setView("tokens");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (authStatus !== "authenticated" || !token.trim()) return;
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible" && !pendingAction) void loadSummary(token, false);
    };
    const interval = window.setInterval(() => {
      refreshWhenVisible();
    }, 30_000);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authStatus, token, pendingAction]);

  useEffect(() => {
    if (authStatus !== "authenticated" || !token.trim() || !selectedMonitorId) {
      setHistory([]);
      setHistoryError(null);
      return;
    }
    void loadMonitorHistory(selectedMonitorId, token);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authStatus, selectedMonitorId, token]);

  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(null), 3800);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  const data = summary || emptySummary;
  const latestByMonitor = useMemo(() => groupLatest(data.latest), [data.latest]);
  const selectedMonitor = data.monitors.find((monitor) => monitor.id === selectedMonitorId) || data.monitors[0] || null;
  const enabledRegionIds = new Set(data.regions.filter((region) => region.enabled).map((region) => region.id));
  const selectedLatest = selectedMonitor
    ? (latestByMonitor.get(selectedMonitor.id) || []).filter((item) => enabledRegionIds.has(item.regionId))
    : [];
  const health = useMemo(() => computeHealth(data, latestByMonitor), [data, latestByMonitor]);
  const filteredMonitors = useMemo(
    () => filterMonitors(data.monitors, latestByMonitor, data.regions, query, statusFilter),
    [data.monitors, data.regions, latestByMonitor, query, statusFilter]
  );
  const actionLoading = pendingAction !== null;
  const sessionReady = authStatus === "authenticated";
  const openIncidentCount = data.incidents.filter((incident) => incident.status === "open").length;

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
      throw new ApiError(body.error || `Request failed: ${response.status}`, response.status);
    }
    return body as T;
  }

  async function loadSummary(authToken = token, notify = false) {
    if (!authToken.trim()) {
      setView("tokens");
      if (notify) showToast("danger", "Admin token is required.");
      return false;
    }
    const requestId = summaryRequestId.current + 1;
    summaryRequestId.current = requestId;
    setRefreshing(true);
    try {
      const next = await requestJson<Summary>("/api/summary", {}, authToken);
      if (requestId !== summaryRequestId.current) return;
      setSummary(next);
      setSummaryError(null);
      if (!selectedMonitorId && next.monitors[0]) setSelectedMonitorId(next.monitors[0].id);
      if (notify) showToast("success", "Summary refreshed.");
      return true;
    } catch (error) {
      if (requestId !== summaryRequestId.current) return;
      const message = error instanceof Error ? error.message : "Failed to refresh.";
      setSummaryError(message);
      if (error instanceof ApiError && error.status === 401) setAuthStatus("error");
      showToast("danger", message);
      if (!summary) setView("tokens");
      return false;
    } finally {
      if (requestId === summaryRequestId.current) setRefreshing(false);
    }
  }

  async function loadMonitorHistory(monitorId: string, authToken = token) {
    const requestId = historyRequestId.current + 1;
    historyRequestId.current = requestId;
    setHistoryLoading(true);
    setHistory([]);
    setHistoryError(null);
    try {
      const body = await requestJson<{ results: ProbeResult[] }>(
        `/api/monitors/${encodeURIComponent(monitorId)}?limit=100`,
        {},
        authToken
      );
      if (requestId === historyRequestId.current) setHistory(body.results);
    } catch (error) {
      if (requestId === historyRequestId.current) {
        const message = error instanceof Error ? error.message : "Failed to load monitor history.";
        setHistoryError(message);
        showToast("danger", message);
      }
    } finally {
      if (requestId === historyRequestId.current) setHistoryLoading(false);
    }
  }

  async function saveToken(nextToken: string) {
    const normalized = nextToken.trim();
    setPendingAction("token");
    try {
      if (!normalized) {
        summaryRequestId.current += 1;
        historyRequestId.current += 1;
        tokenVerificationId.current += 1;
        sessionStorage.removeItem("monstertracker.adminToken");
        setToken("");
        setAuthStatus("locked");
        setSummary(null);
        setSummaryError(null);
        setSelectedMonitorId(null);
        setHistory([]);
        setHistoryError(null);
        setView("tokens");
        showToast("info", "Admin token cleared.");
        return;
      }
      if (await verifyToken(normalized)) {
        showToast("success", "Admin session verified.");
      }
    } finally {
      setPendingAction(null);
    }
  }

  async function verifyToken(candidate: string): Promise<boolean> {
    const previousAuthStatus = authStatus;
    const verificationId = tokenVerificationId.current + 1;
    tokenVerificationId.current = verificationId;
    setAuthStatus("verifying");
    const verified = await loadSummary(candidate, false);
    if (verificationId !== tokenVerificationId.current) return false;
    if (!verified) {
      setAuthStatus(previousAuthStatus === "authenticated" ? "authenticated" : "error");
      if (previousAuthStatus === "authenticated" && summary) setSummaryError(null);
      return false;
    }
    setToken(candidate);
    sessionStorage.setItem("monstertracker.adminToken", candidate);
    setAuthStatus("authenticated");
    return true;
  }

  async function createMonitor() {
    if (!form.url.trim()) {
      showToast("danger", "URL is required.");
      return;
    }
    const parsed = parseMonitorForm(form, data.runtime.maxMonitorDailyBudget);
    if (!parsed.ok) {
      showToast("danger", parsed.error);
      return;
    }
    setPendingAction("create-monitor");
    try {
      const body = await requestJson<{ monitor: MonitorConfig }>("/api/monitors", {
        method: "POST",
        body: JSON.stringify(parsed.patch)
      });
      setSelectedMonitorId(body.monitor.id);
      setView("overview");
      setDetailTab("overview");
      setForm(defaultMonitorDraft);
      await loadSummary(token, false);
      showToast("success", "Monitor created.");
    } catch (error) {
      showToast("danger", error instanceof Error ? error.message : "Create failed.");
    } finally {
      setPendingAction(null);
    }
  }

  async function saveMonitorConfig(id: string, patch: MonitorConfigPatch) {
    setPendingAction(`monitor:${id}`);
    try {
      const body = await requestJson<{ monitor: MonitorConfig }>(`/api/monitors/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify(patch)
      });
      setSelectedMonitorId(body.monitor.id);
      await loadSummary(token, false);
      await loadMonitorHistory(id);
      showToast("success", "Monitor configuration saved.");
    } catch (error) {
      showToast("danger", error instanceof Error ? error.message : "Monitor update failed.");
    } finally {
      setPendingAction(null);
    }
  }

  async function saveRegionConfig(id: string, patch: RegionConfigPatch) {
    setPendingAction(`region:${id}`);
    try {
      await requestJson<{ region: RegionConfig }>(`/api/regions/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify(patch)
      });
      await loadSummary(token, false);
      showToast("success", "Region configuration saved.");
    } catch (error) {
      showToast("danger", error instanceof Error ? error.message : "Region update failed.");
    } finally {
      setPendingAction(null);
    }
  }

  async function runDueNow() {
    setPendingAction("run-due");
    try {
      const body = await requestJson<{
        runId: string;
        plannedJobs: number;
        dispatchedJobs: number;
        successfulJobs: number;
        failedJobs: number;
        queued: boolean;
        reason: "no_due_jobs" | "no_enabled_regions" | null;
      }>("/api/run", {
        method: "POST",
        body: JSON.stringify({ mode: "due" })
      });
      if (body.reason === "no_due_jobs") {
        showToast("info", "No monitor jobs are due in this UTC minute.");
      } else if (body.reason === "no_enabled_regions") {
        showToast("danger", "No probe regions are enabled.");
      } else {
        showToast("info", `Dispatched ${body.dispatchedJobs} probe job${body.dispatchedJobs === 1 ? "" : "s"}; verifying results.`);
        const run = await waitForRun(body.runId);
        showRunOutcome(run, body.successfulJobs, body.failedJobs);
      }
      await loadSummary(token, false);
    } catch (error) {
      showToast("danger", error instanceof Error ? error.message : "Run failed.");
    } finally {
      setPendingAction(null);
    }
  }

  async function runMonitorSample(monitorId: string) {
    setPendingAction(`sample:${monitorId}`);
    try {
      const body = await requestJson<{
        runId: string;
        plannedJobs: number;
        dispatchedJobs: number;
        successfulJobs: number;
        failedJobs: number;
        queued: boolean;
      }>("/api/run", {
          method: "POST",
          body: JSON.stringify({ mode: "sample", monitorId })
        });
      showToast("info", `Dispatched ${body.dispatchedJobs} regional checks; verifying results.`);
      const run = await waitForRun(body.runId);
      showRunOutcome(run, body.successfulJobs, body.failedJobs);
      await Promise.all([loadSummary(token, false), loadMonitorHistory(monitorId)]);
    } catch (error) {
      showToast("danger", error instanceof Error ? error.message : "Sample run failed.");
    } finally {
      setPendingAction(null);
    }
  }

  async function waitForRun(runId: string): Promise<RunStatus | null> {
    let latest: RunStatus | null = null;
    for (const delay of [100, 400, 900, 1_600, 2_500, 4_000]) {
      await sleep(delay);
      const body = await requestJson<{ run: RunStatus }>(`/api/runs/${encodeURIComponent(runId)}`);
      latest = body.run;
      if (latest.pendingResults === 0) return latest;
    }
    return latest;
  }

  function showRunOutcome(run: RunStatus | null, immediateSuccesses: number, immediateFailures: number) {
    const successes = run?.successfulResults ?? immediateSuccesses;
    const failures = run?.failedResults ?? immediateFailures;
    const pending = run?.pendingResults ?? 0;
    if (pending > 0) {
      showToast("info", `${successes + failures} results stored; ${pending} still pending.`);
    } else if (failures > 0) {
      showToast("danger", `${successes} checks passed; ${failures} failed.`);
    } else {
      showToast("success", `${successes} checks passed and were stored.`);
    }
  }

  function selectView(next: ViewKey) {
    setView(next);
    if (next === "regions" || next === "placement") setDetailTab("regions");
    if (next === "incidents") setDetailTab("alerts");
    if (next === "tokens" || next === "monitors") setDetailTab("settings");
  }

  function openAddMonitor() {
    if (!sessionReady) {
      setView("tokens");
      showToast("danger", "Verify an admin token before creating monitors.");
      return;
    }
    setView("monitors");
    setDetailTab("settings");
    focusInspectorOnCompact();
  }

  function focusInspectorOnCompact() {
    if (!window.matchMedia("(max-width: 1240px)").matches) return;
    window.setTimeout(() => {
      document.querySelector<HTMLElement>(".inspector")?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 0);
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
        authStatus={authStatus}
        health={health}
        openIncidentCount={openIncidentCount}
      />
      <main className="workspace">
        <TopBar
          view={view}
          summary={data}
          health={health}
          actionLoading={actionLoading}
          refreshing={refreshing}
          tokenSet={sessionReady}
          onRefresh={() => loadSummary(token, true)}
          onRun={runDueNow}
        />
        <CommandBar
          view={view}
          query={query}
          statusFilter={statusFilter}
          onQueryChange={setQuery}
          onFilterChange={setStatusFilter}
          onViewChange={selectView}
          onAdd={openAddMonitor}
        />
        <section className="workspace-body">
          <DataStateBanner
            authStatus={authStatus}
            generatedAt={summary?.generatedAt ?? null}
            hasData={Boolean(summary)}
            summaryError={summaryError}
          />
          <MainView
            view={view}
            summary={data}
            health={health}
            latestByMonitor={latestByMonitor}
            monitors={filteredMonitors}
            selectedMonitorId={selectedMonitorId}
            token={sessionReady ? token : ""}
            loading={actionLoading || !sessionReady}
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
        history={history}
        historyError={historyError}
        historyLoading={historyLoading}
        tab={detailTab}
        form={form}
        token={sessionReady ? token : ""}
        loading={actionLoading || !sessionReady}
        onTabChange={setDetailTab}
        onTokenSave={saveToken}
        onMonitorSave={saveMonitorConfig}
        onMonitorRun={runMonitorSample}
        onHistoryRetry={() => selectedMonitorId && loadMonitorHistory(selectedMonitorId)}
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
  authStatus,
  openIncidentCount,
  onChange
}: {
  view: ViewKey;
  summary: Summary;
  health: HealthSummary;
  authStatus: AuthStatus;
  openIncidentCount: number;
  onChange: (view: ViewKey) => void;
}) {
  const tokenSet = authStatus === "authenticated";
  const sessionLabel =
    authStatus === "authenticated" ? "Admin session" : authStatus === "verifying" ? "Verifying access" : "Locked session";
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
          <strong>{sessionLabel}</strong>
        </div>
        <Chip color={tokenSet ? "success" : "warning"} size="sm" variant="soft">
          {tokenSet ? "Ready" : authStatus === "verifying" ? "Checking" : "Token"}
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
                ? openIncidentCount
                : undefined;
          return (
            <button
              aria-label={item.label}
              className={view === item.key ? "nav-button active" : "nav-button"}
              key={item.key}
              onClick={() => onChange(item.key)}
              type="button"
            >
              <span>
                <Icon size={17} />
                <span className="nav-label">{item.label}</span>
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
          <strong>Daily probe progress</strong>
          <span>{formatNumber(summary.usage.reservedProbes)} reserved · {formatNumber(summary.usage.probeResults)} recorded</span>
        </div>
      </div>
    </aside>
  );
}

function DataStateBanner({
  authStatus,
  generatedAt,
  hasData,
  summaryError
}: {
  authStatus: AuthStatus;
  generatedAt: string | null;
  hasData: boolean;
  summaryError: string | null;
}) {
  if (authStatus === "verifying" && !hasData) {
    return (
      <div className="data-state-banner info" role="status">
        <RefreshCw size={15} />
        Verifying access and loading current monitor state...
      </div>
    );
  }
  if (summaryError) {
    return (
      <div className="data-state-banner danger" role="alert">
        <AlertTriangle size={15} />
        <span>
          {hasData && generatedAt ? `Showing cached data from ${relativeTime(generatedAt)}. ` : ""}
          Refresh failed: {summaryError}
        </span>
      </div>
    );
  }
  if (!hasData && authStatus !== "authenticated") return null;
  const generatedAtMs = generatedAt ? Date.parse(generatedAt) : Number.NaN;
  if (Number.isFinite(generatedAtMs) && Date.now() - generatedAtMs > 90_000) {
    return (
      <div className="data-state-banner info" role="status">
        <Clock3 size={15} />
        Cached data was synchronized {relativeTime(generatedAt as string)}. Refreshing when this tab is active.
      </div>
    );
  }
  return (
    <div className="data-state-banner" role="status">
      <CheckCircle2 size={15} />
      Live data synchronized {generatedAt ? relativeTime(generatedAt) : "just now"}.
    </div>
  );
}

function TopBar({
  view,
  summary,
  health,
  refreshing,
  actionLoading,
  tokenSet,
  onRefresh,
  onRun
}: {
  view: ViewKey;
  summary: Summary;
  health: HealthSummary;
  refreshing: boolean;
  actionLoading: boolean;
  tokenSet: boolean;
  onRefresh: () => void;
  onRun: () => void;
}) {
  const titles: Record<ViewKey, [string, string]> = {
    overview: ["Global Monitors", `${summary.monitors.length} monitors across ${summary.regions.length} placed regions`],
    monitors: ["Monitor Config", `${summary.monitors.length} configured targets`],
    regions: ["Probe Regions", `${summary.regions.filter((region) => region.enabled).length} active placement hints`],
    incidents: [
      "Incidents",
      `${summary.incidents.filter((incident) => incident.status === "open").length} open · ${summary.incidents.length} recent`
    ],
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
        <Button isDisabled={refreshing} onPress={onRefresh} size="sm" variant="outline">
          <RefreshCw size={16} />
          {refreshing ? "Refreshing" : "Refresh"}
        </Button>
        <Button className="primary-action" isDisabled={actionLoading || !tokenSet} onPress={onRun} size="sm" variant="primary">
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
  onViewChange,
  onAdd
}: {
  view: ViewKey;
  query: string;
  statusFilter: StatusFilter;
  onQueryChange: (value: string) => void;
  onFilterChange: (value: StatusFilter) => void;
  onViewChange: (view: ViewKey) => void;
  onAdd: () => void;
}) {
  const showFilters = view === "overview" || view === "monitors";
  return (
    <div className="commandbar">
      <label className="mobile-view-select">
        <Command size={16} />
        <select
          aria-label="Dashboard view"
          onChange={(event) => onViewChange(event.currentTarget.value as ViewKey)}
          value={view}
        >
          {navItems.map((item) => (
            <option key={item.key} value={item.key}>{item.label}</option>
          ))}
        </select>
      </label>
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
              <option value="partial">Partial</option>
              <option value="stale">Stale</option>
              <option value="paused">Paused</option>
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
  if (view === "incidents") {
    return (
      <IncidentsView
        incidents={summary.incidents}
        monitors={summary.monitors}
        retentionDays={summary.runtime.retentionDays}
      />
    );
  }
  if (view === "usage") return <UsageView summary={summary} health={health} />;
  if (view === "placement") {
    return (
      <PlacementView
        allowedHostnameSuffix={summary.runtime.probeWorkerHostSuffix}
        loading={loading}
        regions={summary.regions}
        onRegionSave={onRegionSave}
      />
    );
  }
  if (view === "tokens") return <TokensView tokenSet={Boolean(token.trim())} onTokenSave={onTokenSave} />;
  return (
    <>
      <MetricStrip summary={summary} health={health} />
      <MonitorTable
        latestByMonitor={latestByMonitor}
        monitors={monitors}
        regions={summary.regions}
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
      <MetricCard icon={Clock3} label="Stale" tone="rose" value={health.stale} />
      <MetricCard icon={Clock3} label="Daily probes" tone="purple" value={formatNumber(summary.usage.probeResults)} />
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
  regions,
  selectedMonitorId,
  onMonitorSelect
}: {
  monitors: MonitorConfig[];
  latestByMonitor: Map<string, LatestResult[]>;
  regions: RegionConfig[];
  selectedMonitorId: string | null;
  onMonitorSelect: (monitor: MonitorConfig) => void;
}) {
  const enabledRegions = regions.filter((region) => region.enabled);
  const enabledRegionIds = new Set(enabledRegions.map((region) => region.id));
  const regionCount = enabledRegions.length;
  const rows = monitors.map((monitor) => {
    const latest = (latestByMonitor.get(monitor.id) || []).filter((item) => enabledRegionIds.has(item.regionId));
    const freshLatest = latest.filter((item) => !isRegionResultStale(item, monitor, regionCount));
    const status = monitorStatus(latest, monitor, regionCount);
    const latency = median(freshLatest.map((item) => item.latencyMs).filter(isFiniteNumber));
    const checked = freshLatest.length;
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
        {rows.length ? <table className="monitor-table">
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
                >
                  <td>
                    <StatusChip status={status} />
                  </td>
                  <td>
                    <button
                      aria-pressed={selected}
                      className="target-cell target-button"
                      onClick={() => onMonitorSelect(monitor)}
                      type="button"
                    >
                      <strong>{monitor.name}</strong>
                      <span>{monitor.method} / {monitor.url}</span>
                    </button>
                  </td>
                  <td>{latest[0] ? relativeTime(latest[0].checkedAt) : "never"}</td>
                  <td>{latency ? `${latency} ms` : "-"}</td>
                  <td>
                    <CoverageMini checked={checked} total={regionCount} />
                  </td>
                  <td>
                    <div className="budget-value">
                      <strong>{formatNumber(monitor.dailyBudget)}</strong>
                      <span>probes/day</span>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table> : (
          <div className="inline-empty-state">
            <Search size={22} />
            <strong>No monitors match this view</strong>
            <span>Adjust the search or status filter, or add a monitor.</span>
          </div>
        )}
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
        {regions.map((region) => {
          const state = regionOperationalState(region);
          return (
            <Surface className="region-row" key={region.id}>
              <div className="region-lead">
                <span className={`status-dot ${state}`} />
                <div>
                  <strong>{region.label}</strong>
                  <span>{region.area}</span>
                </div>
              </div>
              <Chip color={state === "active" ? "success" : state === "paused" ? "warning" : "danger"} size="sm" variant="soft">
                {state}
              </Chip>
              <span>{region.provider}:{region.providerRegion}</span>
              <span>{region.placementRegion}</span>
              <span>{region.lastSeenAt ? relativeTime(region.lastSeenAt) : "never"}</span>
            </Surface>
          );
        })}
      </Card.Content>
    </Card>
  );
}

function IncidentsView({
  incidents,
  monitors,
  retentionDays
}: {
  incidents: Incident[];
  monitors: MonitorConfig[];
  retentionDays: number;
}) {
  const [scope, setScope] = useState<"open" | "resolved">("open");
  const visibleIncidents = incidents.filter((incident) => incident.status === scope);
  const monitorNames = new Map(monitors.map((monitor) => [monitor.id, monitor.name]));

  if (!incidents.length) {
    return (
      <Card className="empty-state" variant="default">
        <Card.Content>
          <ShieldCheck size={30} />
          <strong>No incident history</strong>
          <span>Incident records will appear after a monitor reports a regional failure.</span>
        </Card.Content>
      </Card>
    );
  }
  return (
    <Card className="data-card" variant="default">
      <Card.Header>
        <div>
          <Card.Title>Incident timeline</Card.Title>
          <Card.Description>Open failures and resolved history retained for {retentionDays} days.</Card.Description>
        </div>
        <div className="incident-filters" role="group" aria-label="Incident status">
          <button aria-pressed={scope === "open"} onClick={() => setScope("open")} type="button">
            Open {incidents.filter((incident) => incident.status === "open").length}
          </button>
          <button aria-pressed={scope === "resolved"} onClick={() => setScope("resolved")} type="button">
            Resolved
          </button>
        </div>
      </Card.Header>
      <Card.Content className="stack-list">
        {visibleIncidents.length ? visibleIncidents.map((incident) => (
          <Surface className="incident-card" key={incident.id}>
            <div>
              <strong>{monitorNames.get(incident.monitorId) || incident.monitorId}</strong>
              <span>{incident.summary} · opened {relativeTime(incident.openedAt)}</span>
              {incident.closedAt ? <span>Resolved {relativeTime(incident.closedAt)}</span> : null}
            </div>
            <div className="incident-meta">
              <Chip color={incident.status === "open" ? "danger" : "success"} size="sm" variant="soft">
                {incident.status}
              </Chip>
              <span>{incident.severity}</span>
            </div>
          </Surface>
        )) : (
          <div className="inline-empty-state compact">
            <ShieldCheck size={22} />
            <strong>No {scope} incidents</strong>
          </div>
        )}
      </Card.Content>
    </Card>
  );
}

function UsageView({ summary, health }: { summary: Summary; health: HealthSummary }) {
  const rows: Array<[string, string | number, number, string]> = [
    [
      "Reserved probe budget",
      formatNumber(summary.usage.reservedProbes),
      Math.min(100, Math.round((summary.usage.reservedProbes / summary.runtime.maxDailyProbes) * 100)),
      `hard cap ${formatNumber(summary.runtime.maxDailyProbes)}`
    ],
    [
      "Probe results",
      formatNumber(summary.usage.probeResults),
      Math.min(100, Math.round((summary.usage.probeResults / summary.runtime.maxDailyProbes) * 100)),
      `configured cap ${formatNumber(summary.runtime.maxDailyProbes)}`
    ],
    ["Tracked Worker invocations", formatNumber(summary.usage.workerInvocations), Math.min(100, Math.round((summary.usage.workerInvocations / 100_000) * 100)), "internal estimate"],
    ["Analytics points", formatNumber(summary.usage.probeResults), Math.min(100, Math.round((summary.usage.probeResults / 100_000) * 100)), "Free reference 100k/day"],
    ["D1 writes", formatNumber(summary.usage.d1Writes), Math.min(100, Math.round((summary.usage.d1Writes / 100_000) * 100)), "Free reference 100k/day"],
    ["Queue messages", formatNumber(summary.usage.queueMessages), Math.min(100, Math.round((summary.usage.queueMessages / 10_000) * 100)), "Free reference 10k ops/day"]
  ];
  return (
    <>
      <MetricStrip summary={summary} health={health} />
      <Card className="data-card" variant="default">
        <Card.Header>
          <div>
            <Card.Title>Daily usage guardrails</Card.Title>
            <Card.Description>Configured scheduler capacity and current Cloudflare Free reference limits.</Card.Description>
          </div>
        </Card.Header>
        <Card.Content className="quota-list">
          {rows.map(([label, value, pct, note]) => (
            <div className="quota-row" key={label}>
              <div>
                <strong>{label}</strong>
                <span>{value} · {note}</span>
              </div>
              <ProgressBar aria-label={label} value={pct} />
              <em>{pct}%</em>
            </div>
          ))}
          <div className="runtime-summary">
            <span>Batch {summary.runtime.probeBatchSize}</span>
            <span>Queue batch {summary.runtime.resultQueueBatchSize}</span>
            <span>Probe concurrency {summary.runtime.probeConcurrency}</span>
            <span>Dispatch concurrency {summary.runtime.dispatchConcurrency}</span>
            <span>Retention {summary.runtime.retentionDays} days</span>
          </div>
        </Card.Content>
      </Card>
      <Card className="data-card" variant="default">
        <Card.Header>
          <div>
            <Card.Title>Recent scheduler runs</Card.Title>
            <Card.Description>Manual samples and cron runs persisted from the control Worker.</Card.Description>
          </div>
          <Chip size="sm" variant="soft">{summary.runs.length} runs</Chip>
        </Card.Header>
        <Card.Content className="run-list">
          {summary.runs.length ? summary.runs.slice(0, 10).map((run) => (
            <Surface className="run-row" key={run.id}>
              <div>
                <strong>{run.trigger === "manual" ? "Manual" : "Cron"} run</strong>
                <span>{relativeTime(run.startedAt)} · {run.id}</span>
              </div>
              <Chip color={run.error ? "danger" : "success"} size="sm" variant="soft">
                {run.error ? "failed" : "ok"}
              </Chip>
              <span>{run.dispatchedJobs} / {run.plannedJobs} jobs</span>
              <span>{run.error ? compactText(run.error, 48) : run.finishedAt ? `finished ${relativeTime(run.finishedAt)}` : `${run.skippedJobs} skipped`}</span>
            </Surface>
          )) : (
            <div className="notice-panel">No scheduler runs recorded yet.</div>
          )}
        </Card.Content>
      </Card>
    </>
  );
}

function PlacementView({
  allowedHostnameSuffix,
  regions,
  loading,
  onRegionSave
}: {
  allowedHostnameSuffix: string;
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
          <RegionRouteEditor
            allowedHostnameSuffix={allowedHostnameSuffix}
            key={region.id}
            loading={loading}
            region={region}
            onSave={onRegionSave}
          />
        ))}
      </Card.Content>
    </Card>
  );
}

function RegionRouteEditor({
  allowedHostnameSuffix,
  region,
  loading,
  onSave
}: {
  allowedHostnameSuffix: string;
  region: RegionConfig;
  loading: boolean;
  onSave: (id: string, patch: RegionConfigPatch) => void | Promise<void>;
}) {
  const [workerUrl, setWorkerUrl] = useState(region.workerUrl || "");
  const [weight, setWeight] = useState(String(region.weight));
  const [enabled, setEnabled] = useState(region.enabled);
  const [validationError, setValidationError] = useState<string | null>(null);

  useEffect(() => {
    setWorkerUrl(region.workerUrl || "");
    setWeight(String(region.weight));
    setEnabled(region.enabled);
    setValidationError(null);
  }, [region.id, region.workerUrl, region.weight, region.enabled]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsedWeight = Number.parseInt(weight, 10);
    if (!Number.isInteger(parsedWeight) || parsedWeight < 1 || parsedWeight > 100) {
      setValidationError("Weight must be a whole number between 1 and 100.");
      return;
    }
    if (workerUrl.trim()) {
      if (workerUrl.trim().length > 2_048) {
        setValidationError("Worker URL must be 2048 characters or fewer.");
        return;
      }
      try {
        const parsedUrl = new URL(workerUrl.trim());
        const localHttp =
          parsedUrl.protocol === "http:" &&
          (parsedUrl.hostname === "localhost" || parsedUrl.hostname === "127.0.0.1");
        if (parsedUrl.protocol !== "https:" && !localHttp) {
          setValidationError("Worker URL must use https outside local development.");
          return;
        }
        if (parsedUrl.username || parsedUrl.password) {
          setValidationError("Worker URL must not include embedded credentials.");
          return;
        }
        if (!localHttp && isBlockedTargetHostname(parsedUrl.hostname)) {
          setValidationError("Worker URL must not use a private, local, reserved, or IP-literal host.");
          return;
        }
        if (
          allowedHostnameSuffix &&
          !localHttp &&
          !parsedUrl.hostname.toLowerCase().endsWith(allowedHostnameSuffix.toLowerCase())
        ) {
          setValidationError(`Worker URL hostname must end with ${allowedHostnameSuffix}.`);
          return;
        }
      } catch {
        setValidationError("Worker URL must be a valid absolute URL.");
        return;
      }
    }
    setValidationError(null);
    await onSave(region.id, {
      workerUrl: workerUrl.trim() || null,
      weight: parsedWeight,
      enabled
    });
  }

  const dirty =
    workerUrl.trim() !== (region.workerUrl || "") ||
    weight !== String(region.weight) ||
    enabled !== region.enabled;

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
          <Button className="primary-action" isDisabled={loading || !dirty} size="sm" type="submit" variant="primary">
            {dirty ? "Save route" : "Saved"}
          </Button>
        </div>
        {validationError ? <div className="notice-panel danger">{validationError}</div> : null}
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
  history,
  historyError,
  historyLoading,
  tab,
  form,
  token,
  loading,
  onTabChange,
  onTokenSave,
  onMonitorSave,
  onMonitorRun,
  onHistoryRetry,
  onFormChange,
  onCreate
}: {
  summary: Summary;
  monitor: MonitorConfig | null;
  latest: LatestResult[];
  history: ProbeResult[];
  historyError: string | null;
  historyLoading: boolean;
  tab: DetailTab;
  form: MonitorDraft;
  token: string;
  loading: boolean;
  onTabChange: (tab: DetailTab) => void;
  onTokenSave: (value: string) => void | Promise<void>;
  onMonitorSave: (id: string, patch: MonitorConfigPatch) => void | Promise<void>;
  onMonitorRun: (id: string) => void | Promise<void>;
  onHistoryRetry: () => void;
  onFormChange: (form: MonitorDraft) => void;
  onCreate: () => void;
}) {
  const enabledRegionCount = summary.regions.filter((region) => region.enabled).length;
  const status = monitorStatus(latest, monitor, enabledRegionCount);
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
          <OverviewPanel enabledRegionCount={enabledRegionCount} latest={latest} monitor={monitor} />
        </Tabs.Panel>
        <Tabs.Panel id="history">
          <HistoryPanel error={historyError} history={history} loading={historyLoading} onRetry={onHistoryRetry} />
        </Tabs.Panel>
        <Tabs.Panel id="regions">
          <CoveragePanel latest={latest} monitor={monitor} regions={summary.regions} />
        </Tabs.Panel>
        <Tabs.Panel id="alerts">
          <AlertsPanel incidents={summary.incidents.filter((incident) => incident.monitorId === monitor?.id)} />
        </Tabs.Panel>
        <Tabs.Panel id="settings">
          <SettingsPanel
            enabledRegionCount={summary.regions.filter((region) => region.enabled).length}
            loading={loading}
            maxDailyBudget={summary.runtime.maxMonitorDailyBudget}
            monitor={monitor}
            tokenSet={Boolean(token.trim())}
            onMonitorSave={onMonitorSave}
            onMonitorRun={onMonitorRun}
            onTokenSave={onTokenSave}
          />
        </Tabs.Panel>
      </Tabs>
      <AddMonitorForm
        form={form}
        loading={loading}
        maxDailyBudget={summary.runtime.maxMonitorDailyBudget}
        tokenSet={Boolean(token.trim())}
        onChange={onFormChange}
        onCreate={onCreate}
      />
    </aside>
  );
}

function OverviewPanel({
  enabledRegionCount,
  monitor,
  latest
}: {
  enabledRegionCount: number;
  monitor: MonitorConfig | null;
  latest: LatestResult[];
}) {
  if (!monitor) return <div className="notice-panel">No monitor selected.</div>;
  return (
    <div className="detail-grid">
      <InfoItem label="Status" value={monitorStatus(latest, monitor, enabledRegionCount)} />
      <InfoItem label="Method" value={monitor.method} />
      <InfoItem label="Last check" value={latest[0] ? relativeTime(latest[0].checkedAt) : "never"} />
      <InfoItem label="Timeout" value={`${monitor.timeoutMs} ms`} />
      <InfoItem label="Daily budget" value={monitor.dailyBudget} />
      <InfoItem label="Expected" value={`${monitor.expectedStatusMin}-${monitor.expectedStatusMax}`} />
    </div>
  );
}

function HistoryPanel({
  error,
  history,
  loading,
  onRetry
}: {
  error: string | null;
  history: ProbeResult[];
  loading: boolean;
  onRetry: () => void;
}) {
  if (loading) return <div className="notice-panel">Loading recent probe results...</div>;
  if (error) {
    return (
      <div className="notice-panel danger" role="alert">
        <AlertTriangle size={16} />
        <span>{error}</span>
        <Button onPress={onRetry} size="sm" type="button" variant="secondary">
          <RefreshCw size={14} />
          Retry
        </Button>
      </div>
    );
  }
  if (!history.length) return <div className="notice-panel">No probe history recorded for this monitor.</div>;
  return (
    <div className="history-list">
      {history.slice(0, 40).map((result) => (
        <div className="history-row" key={result.id}>
          <span className={`status-dot ${result.ok ? "active" : "failed"}`} />
          <div>
            <strong>{result.regionId.toUpperCase()} · {result.status ?? result.error ?? "error"}</strong>
            <span>{relativeTime(result.checkedAt)} · {result.latencyMs === null ? "no latency" : `${result.latencyMs} ms`}</span>
          </div>
          <span>{result.entryColo || result.placement || "-"}</span>
        </div>
      ))}
    </div>
  );
}

function CoveragePanel({
  regions,
  latest,
  monitor
}: {
  regions: RegionConfig[];
  latest: LatestResult[];
  monitor: MonitorConfig | null;
}) {
  const enabledRegions = regions.filter((region) => region.enabled);
  const enabledIds = new Set(enabledRegions.map((region) => region.id));
  const relevant = latest.filter((item) => enabledIds.has(item.regionId));
  const stale = new Set(
    relevant
      .filter((item) => monitor && isRegionResultStale(item, monitor, enabledRegions.length))
      .map((item) => item.regionId)
  );
  const fresh = relevant.filter((item) => !stale.has(item.regionId));
  const seen = new Set(fresh.map((item) => item.regionId));
  const failing = new Set(fresh.filter((item) => !item.ok).map((item) => item.regionId));
  return (
    <div className="coverage-panel">
      <div className="coverage-head">
        <strong>{seen.size} / {enabledRegions.length}</strong>
        <span>regions checked</span>
      </div>
      <div className="region-grid">
        {regions.map((region) => (
          <span
            className={
              !region.enabled
                ? "region-chip paused"
                : stale.has(region.id)
                ? "region-chip stale"
                : failing.has(region.id)
                  ? "region-chip danger"
                  : seen.has(region.id)
                    ? "region-chip ok"
                    : "region-chip"
            }
            key={region.id}
          >
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
  maxDailyBudget,
  enabledRegionCount,
  tokenSet,
  onMonitorSave,
  onMonitorRun,
  onTokenSave
}: {
  monitor: MonitorConfig | null;
  loading: boolean;
  maxDailyBudget: number;
  enabledRegionCount: number;
  tokenSet: boolean;
  onMonitorSave: (id: string, patch: MonitorConfigPatch) => void | Promise<void>;
  onMonitorRun: (id: string) => void | Promise<void>;
  onTokenSave: (value: string) => void | Promise<void>;
}) {
  return (
    <div className="settings-panel">
      {monitor ? (
        <MonitorConfigForm
          enabledRegionCount={enabledRegionCount}
          loading={loading}
          maxDailyBudget={maxDailyBudget}
          monitor={monitor}
          onRun={onMonitorRun}
          onSave={onMonitorSave}
        />
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
  maxDailyBudget,
  enabledRegionCount,
  onRun,
  onSave
}: {
  monitor: MonitorConfig;
  loading: boolean;
  maxDailyBudget: number;
  enabledRegionCount: number;
  onRun: (id: string) => void | Promise<void>;
  onSave: (id: string, patch: MonitorConfigPatch) => void | Promise<void>;
}) {
  const [form, setForm] = useState(() => monitorToForm(monitor));
  const [validationError, setValidationError] = useState<string | null>(null);

  useEffect(() => {
    setForm(monitorToForm(monitor));
    setValidationError(null);
  }, [monitor.id, monitor.updatedAt]);

  const savedForm = monitorToForm(monitor);
  const dirty = JSON.stringify(form) !== JSON.stringify(savedForm);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = parseMonitorForm(form, maxDailyBudget);
    if (!parsed.ok) {
      setValidationError(parsed.error);
      return;
    }
    setValidationError(null);
    await onSave(monitor.id, parsed.patch);
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
      <LabeledField label="Name">
        <Input
          aria-label="Monitor name"
          fullWidth
          onChange={(event) => setForm({ ...form, name: event.currentTarget.value })}
          placeholder="Example API"
          value={form.name}
          variant="secondary"
        />
      </LabeledField>
      <LabeledField label="URL">
        <Input
          aria-label="Monitor URL"
          fullWidth
          onChange={(event) => setForm({ ...form, url: event.currentTarget.value })}
          placeholder="https://example.com/health"
          type="url"
          value={form.url}
          variant="secondary"
        />
      </LabeledField>
      <div className="form-row">
        <LabeledField label="Method">
          <div className="method-select select-only">
            <select
              aria-label="Method"
              onChange={(event) => {
                const method = event.currentTarget.value as MonitorMethod;
                setForm({ ...form, method, bodyMatch: method === "GET" ? form.bodyMatch : "" });
              }}
              value={form.method}
            >
              <option value="HEAD">HEAD</option>
              <option value="GET">GET</option>
            </select>
          </div>
        </LabeledField>
        <LabeledField label="Daily probes">
          <Input
            aria-label="Daily budget"
            fullWidth
            min={1}
            max={maxDailyBudget}
            onChange={(event) => setForm({ ...form, dailyBudget: event.currentTarget.value })}
            type="number"
            value={form.dailyBudget}
            variant="secondary"
          />
        </LabeledField>
      </div>
      <div className="form-row">
        <LabeledField label="Status from">
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
        </LabeledField>
        <LabeledField label="Status to">
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
        </LabeledField>
      </div>
      <LabeledField label="Timeout (ms)">
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
      </LabeledField>
      <LabeledField label="Body match (GET only)">
        <textarea
          aria-label="Body match"
          className="textarea-control"
          disabled={form.method !== "GET"}
          onChange={(event) => setForm({ ...form, bodyMatch: event.currentTarget.value })}
          placeholder={form.method === "GET" ? "Optional response text match" : "Select GET to match response text"}
          value={form.bodyMatch}
        />
      </LabeledField>
      <LabeledField label="Tags">
        <Input
          aria-label="Tags"
          fullWidth
          onChange={(event) => setForm({ ...form, tags: event.currentTarget.value })}
          placeholder="production, api"
          value={form.tags}
          variant="secondary"
        />
      </LabeledField>
      <div className="detail-grid single compact">
        <InfoItem label="Monitor ID" value={monitor.id} />
        <InfoItem label="Updated" value={relativeTime(monitor.updatedAt)} />
      </div>
      <div className="form-actions-grid">
        <Button isDisabled={loading || !monitor.enabled || dirty} onPress={() => onRun(monitor.id)} size="sm" type="button" variant="secondary">
          <Play size={15} />
          {dirty ? "Save first" : `Run ${enabledRegionCount}-region sample`}
        </Button>
        <Button className="primary-action" isDisabled={loading || !dirty} size="sm" type="submit" variant="primary">
          {dirty ? "Save configuration" : "Saved"}
        </Button>
      </div>
      {validationError ? <div className="notice-panel danger">{validationError}</div> : null}
    </form>
  );
}

function AddMonitorForm({
  form,
  loading,
  maxDailyBudget,
  tokenSet,
  onChange,
  onCreate
}: {
  form: MonitorDraft;
  loading: boolean;
  maxDailyBudget: number;
  tokenSet: boolean;
  onChange: (form: MonitorDraft) => void;
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
        <LabeledField label="URL">
          <Input
            aria-label="URL"
            fullWidth
            onChange={(event) => onChange({ ...form, url: event.currentTarget.value })}
            placeholder="https://example.com/health"
            type="url"
            value={form.url}
            variant="secondary"
          />
        </LabeledField>
        <div className="form-row">
          <LabeledField label="Name">
            <Input
              aria-label="Name"
              fullWidth
              onChange={(event) => onChange({ ...form, name: event.currentTarget.value })}
              placeholder="Example API"
              value={form.name}
              variant="secondary"
            />
          </LabeledField>
          <LabeledField label="Daily probes">
            <Input
              aria-label="Daily budget"
              fullWidth
              min={1}
              max={maxDailyBudget}
              onChange={(event) => onChange({ ...form, dailyBudget: event.currentTarget.value })}
              type="number"
              value={form.dailyBudget}
              variant="secondary"
            />
          </LabeledField>
        </div>
        <LabeledField label="Method">
          <div className="method-select select-only">
            <select
              aria-label="Method"
              onChange={(event) => {
                const method = event.currentTarget.value as MonitorMethod;
                onChange({ ...form, method, bodyMatch: method === "GET" ? form.bodyMatch : "" });
              }}
              value={form.method}
            >
              <option value="HEAD">HEAD</option>
              <option value="GET">GET</option>
            </select>
          </div>
        </LabeledField>
        <div className="form-row">
          <LabeledField label="Status from">
            <Input
              aria-label="Expected status min"
              fullWidth
              max={599}
              min={100}
              onChange={(event) => onChange({ ...form, expectedStatusMin: event.currentTarget.value })}
              type="number"
              value={form.expectedStatusMin}
              variant="secondary"
            />
          </LabeledField>
          <LabeledField label="Status to">
            <Input
              aria-label="Expected status max"
              fullWidth
              max={599}
              min={100}
              onChange={(event) => onChange({ ...form, expectedStatusMax: event.currentTarget.value })}
              type="number"
              value={form.expectedStatusMax}
              variant="secondary"
            />
          </LabeledField>
        </div>
        <LabeledField label="Timeout (ms)">
          <Input
            aria-label="Timeout milliseconds"
            fullWidth
            max={60000}
            min={1000}
            onChange={(event) => onChange({ ...form, timeoutMs: event.currentTarget.value })}
            type="number"
            value={form.timeoutMs}
            variant="secondary"
          />
        </LabeledField>
        <LabeledField label="Body match (GET only)">
          <textarea
            aria-label="Body match"
            className="textarea-control compact"
            disabled={form.method !== "GET"}
            onChange={(event) => onChange({ ...form, bodyMatch: event.currentTarget.value })}
            placeholder={form.method === "GET" ? "Optional response text match" : "Select GET to match response text"}
            value={form.bodyMatch}
          />
        </LabeledField>
        <LabeledField label="Tags">
          <Input
            aria-label="Tags"
            fullWidth
            onChange={(event) => onChange({ ...form, tags: event.currentTarget.value })}
            placeholder="production, api"
            value={form.tags}
            variant="secondary"
          />
        </LabeledField>
        <Button className="primary-action" fullWidth isDisabled={loading || !tokenSet} onPress={onCreate} variant="primary">
          <Plus size={16} />
          {tokenSet ? "Create Monitor" : "Token required"}
        </Button>
      </Card.Content>
    </Card>
  );
}

function LabeledField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field-control">
      <span>{label}</span>
      {children}
    </label>
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

function StatusChip({ status }: { status: MonitorStatus }) {
  const color = status === "up" ? "success" : status === "down" || status === "partial" ? "danger" : "warning";
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
    <div aria-live="polite" className={`toast ${tone}`} role={tone === "danger" ? "alert" : "status"}>
      {tone === "success" ? <CheckCircle2 size={16} /> : tone === "danger" ? <AlertTriangle size={16} /> : <Activity size={16} />}
      {message}
    </div>
  );
}

interface HealthSummary {
  up: number;
  down: number;
  stale: number;
  idle: number;
  budgetPct: number;
}

function computeHealth(summary: Summary, latestByMonitor: Map<string, LatestResult[]>): HealthSummary {
  let up = 0;
  let down = 0;
  let stale = 0;
  let idle = 0;
  const totalBudget = summary.monitors.reduce((total, monitor) => total + (monitor.enabled ? monitor.dailyBudget : 0), 0);
  const enabledRegions = summary.regions.filter((region) => region.enabled);
  const enabledRegionIds = new Set(enabledRegions.map((region) => region.id));
  for (const monitor of summary.monitors) {
    const relevant = (latestByMonitor.get(monitor.id) || []).filter((item) => enabledRegionIds.has(item.regionId));
    const status = monitorStatus(relevant, monitor, enabledRegions.length);
    if (status === "up") up += 1;
    else if (status === "down" || status === "partial") down += 1;
    else if (status === "stale") stale += 1;
    else idle += 1;
  }
  return {
    up,
    down,
    stale,
    idle,
    budgetPct: totalBudget ? Math.min(100, Math.round((summary.usage.reservedProbes / totalBudget) * 100)) : 0
  };
}

function filterMonitors(
  monitors: MonitorConfig[],
  latestByMonitor: Map<string, LatestResult[]>,
  regions: RegionConfig[],
  query: string,
  statusFilter: StatusFilter
) {
  const normalized = query.trim().toLowerCase();
  const enabledRegions = regions.filter((region) => region.enabled);
  const enabledRegionIds = new Set(enabledRegions.map((region) => region.id));
  return monitors.filter((monitor) => {
    const relevant = (latestByMonitor.get(monitor.id) || []).filter((item) => enabledRegionIds.has(item.regionId));
    const status = monitorStatus(relevant, monitor, enabledRegions.length);
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

function monitorStatus(
  latest: LatestResult[],
  monitor: MonitorConfig | null = null,
  enabledRegionCount = Math.max(1, latest.length)
): MonitorStatus {
  if (monitor && !monitor.enabled) return "paused";
  if (!latest.length) return "idle";
  const fresh = monitor
    ? latest.filter((item) => !isRegionResultStale(item, monitor, enabledRegionCount))
    : latest;
  if (!fresh.length) return "stale";
  const failures = fresh.filter((item) => !item.ok).length;
  if (fresh.length < Math.max(1, enabledRegionCount)) return "partial";
  if (failures > 0 && failures < fresh.length) return "partial";
  return failures > 0 ? "down" : "up";
}

function isRegionResultStale(result: LatestResult, monitor: MonitorConfig, enabledRegionCount: number): boolean {
  const expectedRegionalInterval =
    (86_400_000 * Math.max(1, enabledRegionCount)) / Math.max(1, monitor.dailyBudget);
  const staleAfter = Math.max(2 * 60 * 60_000, expectedRegionalInterval * 3);
  return Date.now() - new Date(result.checkedAt).getTime() > staleAfter;
}

function regionOperationalState(region: RegionConfig): "active" | "paused" | "unconfigured" | "stale" {
  if (!region.enabled) return "paused";
  if (!region.workerUrl) return "unconfigured";
  if (!region.lastSeenAt || Date.now() - new Date(region.lastSeenAt).getTime() > 24 * 60 * 60_000) return "stale";
  return "active";
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

function compactText(value: string, max = 64) {
  return value.length > max ? `${value.slice(0, max - 1)}...` : value;
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

function parseMonitorForm(
  form: MonitorDraft & { enabled?: boolean },
  maxDailyBudget: number
): { ok: true; patch: MonitorConfigPatch } | { ok: false; error: string } {
  const url = form.url.trim();
  if (!url) return { ok: false, error: "URL is required." };
  if (url.length > 4_096) return { ok: false, error: "URL must be 4096 characters or fewer." };
  if (form.name.trim().length > 256) {
    return { ok: false, error: "Monitor name must be 256 characters or fewer." };
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { ok: false, error: "URL must use http or https." };
    }
    if (parsed.username || parsed.password) {
      return { ok: false, error: "URL must not include embedded credentials." };
    }
    if (isBlockedTargetHostname(parsed.hostname)) {
      return { ok: false, error: "Private, local, reserved, and IP-literal targets are blocked." };
    }
  } catch {
    return { ok: false, error: "URL must be valid." };
  }

  const dailyBudget = parseBoundedInt(form.dailyBudget, "Daily budget", 1, maxDailyBudget);
  if (!dailyBudget.ok) return dailyBudget;
  const expectedStatusMin = parseBoundedInt(form.expectedStatusMin, "Expected status min", 100, 599);
  if (!expectedStatusMin.ok) return expectedStatusMin;
  const expectedStatusMax = parseBoundedInt(form.expectedStatusMax, "Expected status max", 100, 599);
  if (!expectedStatusMax.ok) return expectedStatusMax;
  if (expectedStatusMin.value > expectedStatusMax.value) {
    return { ok: false, error: "Expected status min must be less than or equal to max." };
  }
  const timeoutMs = parseBoundedInt(form.timeoutMs, "Timeout", 1000, 60000);
  if (!timeoutMs.ok) return timeoutMs;
  if (form.bodyMatch.trim() && form.method !== "GET") {
    return { ok: false, error: "Body match requires the GET method." };
  }
  if (new TextEncoder().encode(form.bodyMatch).length > 64 * 1024) {
    return { ok: false, error: "Body match must be 64 KB or smaller." };
  }
  const tags = splitTags(form.tags);
  if (tags.some((tag) => tag.length > 64)) {
    return { ok: false, error: "Each tag must be 64 characters or fewer." };
  }
  if (new Set(tags).size > 20) return { ok: false, error: "A monitor can have at most 20 tags." };

  const patch: MonitorConfigPatch = {
    url,
    name: form.name.trim(),
    method: form.method,
    expectedStatusMin: expectedStatusMin.value,
    expectedStatusMax: expectedStatusMax.value,
    bodyMatch: form.bodyMatch.trim() || null,
    timeoutMs: timeoutMs.value,
    dailyBudget: dailyBudget.value,
    tags
  };
  if (typeof form.enabled === "boolean") patch.enabled = form.enabled;
  return {
    ok: true,
    patch
  };
}

function parseBoundedInt(
  input: string,
  label: string,
  min: number,
  max: number
): { ok: true; value: number } | { ok: false; error: string } {
  if (!/^\d+$/.test(input.trim())) return { ok: false, error: `${label} must be a whole number.` };
  const value = Number.parseInt(input, 10);
  if (!Number.isFinite(value) || value < min || value > max) {
    return { ok: false, error: `${label} must be between ${min} and ${max}.` };
  }
  return { ok: true, value };
}

function parseStoredView(value: string | null): ViewKey {
  return value && validViews.has(value as ViewKey) ? (value as ViewKey) : "overview";
}

function parseStoredDetailTab(value: string | null): DetailTab {
  return value && validDetailTabs.has(value as DetailTab) ? (value as DetailTab) : "overview";
}

function isBlockedTargetHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  if (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local") ||
    normalized.endsWith(".internal") ||
    normalized.endsWith(".home.arpa")
  ) {
    return true;
  }
  const parts = normalized.split(".");
  if (parts.length === 4 && parts.every((part) => /^\d+$/.test(part) && Number(part) <= 255)) return true;
  return normalized.includes(":");
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

class AppErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("dashboard_render_failed", error, info.componentStack);
  }

  render() {
    if (this.state.failed) {
      return (
        <main className="fatal-state" role="alert">
          <AlertTriangle size={24} />
          <h1>Dashboard could not render</h1>
          <p>Your monitoring service is still running. Reload the control console to restore this session.</p>
          <Button className="primary-action" onPress={() => window.location.reload()} variant="primary">
            <RefreshCw size={16} />
            Reload console
          </Button>
        </main>
      );
    }
    return this.props.children;
  }
}

createRoot(document.getElementById("root")!).render(
  <AppErrorBoundary>
    <App />
  </AppErrorBoundary>
);
