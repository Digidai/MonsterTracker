import "./styles.css";

import { Sidebar as ProSidebar } from "@heroui-pro/react/sidebar";
import { EmptyState } from "@heroui-pro/react/empty-state";
import { Segment } from "@heroui-pro/react/segment";

import {
  AlertDialog,
  Button,
  Card,
  Chip,
  Input,
  Modal,
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
  LogOut,
  Play,
  Plus,
  RefreshCw,
  Search,
  Server,
  Settings2,
  ShieldCheck,
  Signal,
  Trash2,
  X,
  Zap
} from "lucide-react";
import {
  Component,
  lazy,
  Suspense,
  createContext,
  useContext,
  useCallback,
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
  RegionConfig,
  RegionConfigPatch,
  RunStatus,
  StatusFilter,
  Summary,
  UsageSummary,
  ViewKey
} from "./types";

import { applyGlobalDailyCap } from "../../src/budget";
import { estimateCost } from "../../src/cost";
import { monitorStatus, isRegionResultStale } from "../../src/health";
import { downloadText, monitorBackup } from "./export";

const MonitorHistory = lazy(() => import("./components/MonitorHistory"));
const DiagnosticsPanel = lazy(() => import("./components/DiagnosticsPanel"));

const DirtyContext = createContext<(key: string, dirty: boolean) => void>(() => {});
const NavigateContext = createContext<(action: () => void) => void>((action) => action());
function useDirtyDraft(key: string, dirty: boolean) {
  const report = useContext(DirtyContext);
  useEffect(() => { report(key, dirty); return () => report(key, false); }, [key, dirty, report]);
}

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

const primaryNavItems: Array<{ key: ViewKey; label: string; icon: typeof Activity }> = [
  { key: "overview", label: "Overview", icon: Activity },
  { key: "monitors", label: "Monitors", icon: Server },
  { key: "regions", label: "Regions", icon: Globe2 },
  { key: "incidents", label: "Incidents", icon: AlertTriangle }
];

const systemNavItems: Array<{ key: ViewKey; label: string; icon: typeof Activity }> = [
  { key: "usage", label: "Usage", icon: BarChart3 },
  { key: "tokens", label: "Settings", icon: Settings2 }
];

const navItems = [...primaryNavItems, ...systemNavItems];

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
type InspectorMode = "closed" | "detail" | "create";

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
  const [inspectorMode, setInspectorMode] = useState<InspectorMode>("closed");
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [refreshing, setRefreshing] = useState(false);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [historyRefreshKey, setHistoryRefreshKey] = useState(0);
  const [toast, setToast] = useState<{ tone: "success" | "danger" | "info"; message: string } | null>(null);
  const [form, setForm] = useState<MonitorDraft>(defaultMonitorDraft);
  const [createError, setCreateError] = useState<string | null>(null);
  const summaryRequestId = useRef(0);
  const tokenVerificationId = useRef(0);
  const summaryAbort = useRef<AbortController | null>(null);
  const dirtyDrafts = useRef(new Set<string>());
  const [leaveAction, setLeaveAction] = useState<{ execute: () => void } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<MonitorConfig | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [runFeedback, setRunFeedback] = useState<string | null>(null);
  const [pendingRunId, setPendingRunId] = useState<string | null>(null);
  const [draftGeneration, setDraftGeneration] = useState(0);
  const reportDirty = useCallback((key: string, dirty: boolean) => {
    if (dirty) dirtyDrafts.current.add(key); else dirtyDrafts.current.delete(key);
  }, []);

  function navigate(action: () => void) {
    if (pendingAction) return;
    if (dirtyDrafts.current.size) setLeaveAction({ execute: action }); else action();
  }

  useEffect(() => {
    const preventLoss = (event: BeforeUnloadEvent) => {
      if (dirtyDrafts.current.size) event.preventDefault();
    };
    window.addEventListener("beforeunload", preventLoss);
    return () => window.removeEventListener("beforeunload", preventLoss);
  }, []);

  useEffect(() => {
    reportDirty("create", inspectorMode === "create" && JSON.stringify(form) !== JSON.stringify(defaultMonitorDraft));
  }, [form, inspectorMode, reportDirty]);

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
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(null), 3800);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  useEffect(() => {
    if (inspectorMode === "closed") return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !leaveAction && !deleteTarget) navigate(() => setInspectorMode("closed"));
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [inspectorMode, leaveAction, deleteTarget, pendingAction]);

  const data = useMemo(() => {
    if (!summary) return emptySummary;
    const effective = applyGlobalDailyCap(summary.monitors, summary.runtime.maxDailyProbes);
    return { ...summary, monitors: summary.monitors.map((monitor, index) => ({
      ...monitor, effectiveDailyBudget: monitor.enabled ? effective[index]?.dailyBudget ?? 0 : 0
    })) };
  }, [summary]);
  const latestByMonitor = useMemo(() => groupLatest(data.latest), [data.latest]);
  const selectedMonitor = data.monitors.find((monitor) => monitor.id === selectedMonitorId) || null;
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
  const openIncidentCount = data.incidents.filter((incident) => incident.status !== "resolved").length;

  async function requestJson<T>(path: string, init: RequestInit = {}, authToken = token): Promise<T> {
    const response = await fetch(path, {
      ...init,
      signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(path === "/api/run" ? 300_000 : 30_000),
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${authToken.trim()}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers
      }
    });
    // An aborted or malformed successful body is not a valid empty payload.
    const body = (await response.json()) as { error?: string };
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
    summaryAbort.current?.abort();
    summaryAbort.current = new AbortController();
    setRefreshing(true);
    try {
      const next = await requestJson<Summary>("/api/summary", { signal: summaryAbort.current.signal }, authToken);
      if (requestId !== summaryRequestId.current) return;
      setSummary(next);
      setSummaryError(null);
      if (notify) showToast("success", "Summary refreshed.");
      return true;
    } catch (error) {
      if (requestId !== summaryRequestId.current) return;
      const message = error instanceof Error ? error.message : "Failed to refresh.";
      setSummaryError(message);
      if (error instanceof ApiError && error.status === 401) setAuthStatus("error");
      if (notify || Boolean(summary)) showToast("danger", message);
      if (!summary) setView("tokens");
      return false;
    } finally {
      if (requestId === summaryRequestId.current) setRefreshing(false);
    }
  }

  async function saveToken(nextToken: string) {
    const normalized = nextToken.trim();
    setPendingAction("token");
    try {
      if (!normalized) {
        summaryRequestId.current += 1;
        tokenVerificationId.current += 1;
        summaryAbort.current?.abort();
        sessionStorage.removeItem("monstertracker.adminToken");
        setToken("");
        setAuthStatus("locked");
        setSummary(null);
        setSummaryError(null);
        setSelectedMonitorId(null);
        setInspectorMode("closed");
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
    if (!summary) setSummaryError(null);
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
    setView((current) => current === "tokens" ? "overview" : current);
    return true;
  }

  async function createMonitor() {
    if (!form.url.trim()) {
      setCreateError("URL is required.");
      return;
    }
    const parsed = parseMonitorForm(form, data.runtime.maxMonitorDailyBudget);
    if (!parsed.ok) {
      setCreateError(parsed.error);
      return;
    }
    setCreateError(null);
    setPendingAction("create-monitor");
    try {
      const body = await requestJson<{ monitor: MonitorConfig }>("/api/monitors", {
        method: "POST",
        body: JSON.stringify(parsed.patch)
      });
      setSummary((current) => current ? { ...current, monitors: [body.monitor, ...current.monitors] } : current);
      setSelectedMonitorId(body.monitor.id);
      setView("monitors");
      setDetailTab("overview");
      setInspectorMode("detail");
      setForm(defaultMonitorDraft);
      setCreateError(null);
      await loadSummary(token, false);
      showToast("success", "Monitor created.");
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : "Create failed.");
    } finally {
      setPendingAction(null);
    }
  }

  async function confirmMonitorDeletion() {
    if (!deleteTarget || pendingAction) return;
    const id = deleteTarget.id;
    setPendingAction(`delete:${id}`);
    setDeleteError(null);
    try {
      await requestJson(`/api/monitors/${encodeURIComponent(id)}`, { method: "DELETE" });
      // A summary read started before deletion must not restore stale UI.
      summaryRequestId.current += 1;
      summaryAbort.current?.abort();
      reportDirty(`monitor:${id}`, false);
      setSummary((current) => current ? {
        ...current,
        monitors: current.monitors.filter((item) => item.id !== id),
        latest: current.latest.filter((item) => item.monitorId !== id),
        incidents: current.incidents.filter((item) => item.monitorId !== id)
      } : current);
      setSelectedMonitorId(null);
      setInspectorMode("closed");
      setDeleteTarget(null);
      setView("monitors");
      await loadSummary(token, false);
      showToast("success", "Monitor deleted. No new checks will be scheduled.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to delete monitor. Please retry.";
      setDeleteError(message);
      if (error instanceof ApiError && error.status === 401) {
        setSummaryError("Verify your admin token to continue deleting this monitor.");
        setAuthStatus("error");
      }
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
      reportDirty(`monitor:${id}`, false);
      setSummary((current) => current ? {
        ...current,
        monitors: current.monitors.map((item) => item.id === id ? body.monitor : item),
        // Until refresh confirms the new configuration, do not attach old evidence to it.
        latest: current.latest.filter((item) => item.monitorId !== id)
      } : current);
      await loadSummary(token, false);
      setHistoryRefreshKey((value) => value + 1);
      showToast("success", "Monitor configuration saved.");
    } catch (error) {
      showToast("danger", error instanceof Error ? error.message : "Monitor update failed.");
      throw error;
    } finally {
      setPendingAction(null);
    }
  }

  async function saveRegionConfig(id: string, patch: RegionConfigPatch) {
    setPendingAction(`region:${id}`);
    try {
      const body = await requestJson<{ region: RegionConfig }>(`/api/regions/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify(patch)
      });
      reportDirty(`region:${id}`, false);
      setSummary((current) => current ? { ...current, regions: current.regions.map((item) => item.id === id ? body.region : item) } : current);
      await loadSummary(token, false);
      showToast("success", "Region configuration saved.");
    } catch (error) {
      showToast("danger", error instanceof Error ? error.message : "Region update failed.");
      throw error;
    } finally {
      setPendingAction(null);
    }
  }

  async function runDueNow() {
    setPendingRunId(null);
    setPendingAction("run-due");
    setRunFeedback("Running checks due in the current minute…");
    try {
      const body = await requestJson<{
        runId: string;
        plannedJobs: number;
        dispatchedJobs: number;
        successfulJobs: number;
        failedJobs: number;
        unknownJobs: number;
        queued: boolean;
        reason: "no_due_jobs" | "no_enabled_regions" | "already_scheduled" | null;
      }>("/api/run", {
        method: "POST",
        body: JSON.stringify({ mode: "due" })
      });
      if (body.reason === "no_due_jobs") {
        setRunFeedback("No checks are due in this UTC minute. Scheduled checks run automatically.");
        showToast("info", "No monitor jobs are due in this UTC minute.");
      } else if (body.reason === "no_enabled_regions") {
        setRunFeedback("No probe regions are enabled. Configure regions before running checks.");
        showToast("danger", "No probe regions are enabled.");
      } else {
        showToast("info", body.reason === "already_scheduled" ? "This minute is already scheduled; checking its results." : `Dispatched ${body.dispatchedJobs} probe job${body.dispatchedJobs === 1 ? "" : "s"}; verifying results.`);
        setPendingRunId(body.runId);
        const run = await waitForRun(body.runId);
        showRunOutcome(run, body.successfulJobs, body.failedJobs, body.unknownJobs);
      }
      await loadSummary(token, false);
    } catch (error) {
      setRunFeedback(error instanceof Error ? error.message : "Run failed.");
      showToast("danger", error instanceof Error ? error.message : "Run failed.");
    } finally {
      setPendingAction(null);
    }
  }

  async function runMonitorSample(monitorId: string) {
    setPendingRunId(null);
    setPendingAction(`sample:${monitorId}`);
    setRunFeedback("Contacting regional probes…");
    try {
      const body = await requestJson<{
        runId: string;
        plannedJobs: number;
        dispatchedJobs: number;
        successfulJobs: number;
        failedJobs: number;
        unknownJobs: number;
        queued: boolean;
      }>("/api/run", {
          method: "POST",
          body: JSON.stringify({ mode: "sample", monitorId })
        });
      showToast("info", `Dispatched ${body.dispatchedJobs} regional checks; verifying results.`);
      if (!body.runId) {
        setRunFeedback("No checks were started. Enable a probe region before sampling.");
        return;
      }
      setPendingRunId(body.runId);
      const run = await waitForRun(body.runId);
      showRunOutcome(run, body.successfulJobs, body.failedJobs, body.unknownJobs);
      await loadSummary(token, false);
      setHistoryRefreshKey((value) => value + 1);
    } catch (error) {
      setRunFeedback(error instanceof Error ? error.message : "Sample run failed.");
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
      setRunFeedback(`${latest.storedResults} / ${latest.plannedJobs} regional results stored.`);
      if (latest.pendingResults === 0 || (latest.error && latest.finishedAt)) return latest;
    }
    return latest;
  }

  function showRunOutcome(run: RunStatus | null, immediateSuccesses: number, immediateFailures: number, immediateUnknown = 0) {
    setPendingRunId(run && run.pendingResults > 0 && !(run.error && run.finishedAt) ? run.id : null);
    if (run?.error) {
      const message = run.error === "daily_probe_budget_exhausted" ? "The daily probe budget is exhausted. No new checks were started." : `Run incomplete: ${run.error}`;
      setRunFeedback(message);
      showToast("danger", message);
      return;
    }
    const successes = run?.successfulResults ?? immediateSuccesses;
    const failures = run?.failedResults ?? immediateFailures;
    const pending = run?.pendingResults ?? 0;
    const unknown = run?.unknownResults ?? immediateUnknown;
    const cancelled = run?.cancelledResults ?? 0;
    setRunFeedback(`${successes} passed · ${failures} target failures · ${unknown} unavailable probes · ${pending} pending.${cancelled ? ` ${cancelled} cancelled after configuration changes.` : ""}${pending > 0 ? " Results are still arriving. Recheck for the latest status." : ""}`);
    if (pending > 0) {
      showToast("info", `${successes + failures + unknown} results stored; ${pending} still pending.`);
    } else if (failures > 0) {
      showToast("danger", `${successes} checks passed; ${failures} failed.`);
    } else if (unknown > 0) {
      showToast("info", `${unknown} probes unavailable; target status is unconfirmed.`);
    } else if (cancelled > 0) {
      showToast("info", `${successes} checks passed; ${cancelled} cancelled after configuration changes.`);
    } else {
      showToast("success", `${successes} checks passed and were stored.`);
    }
  }

  function selectView(next: ViewKey) {
    if (next === view && inspectorMode === "closed") return;
    navigate(() => { setView(next); setInspectorMode("closed"); });
  }

  function openAddMonitor() {
    if (!sessionReady) {
      setView("tokens");
      showToast("danger", "Verify an admin token before creating monitors.");
      return;
    }
    navigate(() => {
      setView("monitors"); setCreateError(null); setInspectorMode("create"); focusInspectorOnCompact();
    });
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

  if (!sessionReady && !summary) {
    return (
      <>
        <AccessGate
          authStatus={authStatus}
          error={summaryError}
          loading={pendingAction === "token" || authStatus === "verifying"}
          onTokenSave={saveToken}
        />
        {toast ? <Toast tone={toast.tone} message={toast.message} /> : null}
      </>
    );
  }

  const showInspector = (view === "overview" || view === "monitors") && inspectorMode !== "closed";

  return (
    <DirtyContext.Provider value={reportDirty}>
    <NavigateContext.Provider value={navigate}>
    <ProSidebar.Provider collapsible="icon" toggleShortcut={false} className={`app-shell${showInspector ? " has-inspector" : ""}`}>
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
          {runFeedback ? <div className="run-feedback" role="status"><Activity size={16} /><span>{runFeedback}</span>
            {pendingRunId ? <Button size="sm" variant="outline" isDisabled={actionLoading} onPress={async () => {
              setPendingAction("recheck-run");
              try { showRunOutcome(await waitForRun(pendingRunId), 0, 0); await loadSummary(); }
              catch (error) { showToast("danger", error instanceof Error ? error.message : "Unable to recheck run."); }
              finally { setPendingAction(null); }
            }}>Recheck</Button> : null}
            <Button size="sm" variant="ghost" isDisabled={actionLoading} onPress={() => { setRunFeedback(null); setPendingRunId(null); }}>Dismiss</Button>
          </div> : null}
          <DataStateBanner
            authStatus={authStatus}
            generatedAt={summary?.generatedAt ?? null}
            hasData={Boolean(summary)}
            summaryError={summaryError}
          />
          <MainView
            key={`view:${draftGeneration}`}
            view={view}
            summary={data}
            health={health}
            latestByMonitor={latestByMonitor}
            monitors={filteredMonitors}
            selectedMonitorId={inspectorMode === "detail" ? selectedMonitorId : null}
            token={sessionReady ? token : ""}
            onUnauthorized={() => setAuthStatus("error")}
            loading={actionLoading || !sessionReady}
            onTokenSave={saveToken}
            onRegionSave={saveRegionConfig}
            onMonitorSelect={(monitor) => navigate(() => {
              setView("monitors");
              setSelectedMonitorId(monitor.id);
              setDetailTab("overview");
              setInspectorMode("detail");
              focusInspectorOnCompact();
            })}
          />
        </section>
      </main>
      {showInspector ? (
        <Inspector
          key={`inspector:${draftGeneration}`}
          summary={data}
          monitor={selectedMonitor}
          latest={selectedLatest}
          token={sessionReady ? token : ""}
          historyRefreshKey={historyRefreshKey}
          onUnauthorized={() => setAuthStatus("error")}
          mode={inspectorMode}
          tab={detailTab}
          form={form}
          createError={createError}
          loading={actionLoading}
          onClose={() => navigate(() => setInspectorMode("closed"))}
          onTabChange={(tab) => { if (tab !== detailTab) navigate(() => setDetailTab(tab)); }}
          onMonitorSave={saveMonitorConfig}
          onMonitorRun={runMonitorSample}
          onMonitorDelete={(monitor) => { setDeleteError(null); setDeleteTarget(monitor); }}
          onFormChange={(nextForm) => {
            setForm(nextForm);
            if (createError) setCreateError(null);
          }}
          onCreate={createMonitor}
        />
      ) : null}
      {toast ? <Toast tone={toast.tone} message={toast.message} /> : null}
      <AlertDialog.Backdrop isOpen={Boolean(deleteTarget) && sessionReady} isDismissable={false}
        isKeyboardDismissDisabled={actionLoading}
        onOpenChange={(open) => { if (!open && !actionLoading) setDeleteTarget(null); }}>
        <AlertDialog.Container size="sm"><AlertDialog.Dialog>
          <AlertDialog.Header>
            <AlertDialog.Icon status="danger"><Trash2 size={20} /></AlertDialog.Icon>
            <AlertDialog.Heading>Delete monitor?</AlertDialog.Heading>
          </AlertDialog.Header>
          <AlertDialog.Body className="delete-monitor-copy">
            <p><strong>{deleteTarget?.name}</strong><br /><span className="field-note">{deleteTarget?.url}</span></p>
            <p>This removes the monitor from your dashboard and stops future scheduled checks. Checks already in progress may finish.</p>
            <p>Historical records remain subject to the existing retention policy. This cannot be undone. To pause instead, turn off “Enabled for scheduling” in Settings and save.</p>
            {deleteTarget && dirtyDrafts.current.has(`monitor:${deleteTarget.id}`) ? <p>Unsaved changes to this monitor will also be discarded.</p> : null}
            {deleteError ? <p className="notice-panel danger" role="alert">{deleteError}</p> : null}
          </AlertDialog.Body>
          <AlertDialog.Footer>
            <Button autoFocus isDisabled={actionLoading} variant="secondary" onPress={() => setDeleteTarget(null)}>Cancel</Button>
            <Button isDisabled={actionLoading} isPending={actionLoading} variant="danger" onPress={confirmMonitorDeletion}>
              {actionLoading ? "Deleting…" : "Delete monitor"}
            </Button>
          </AlertDialog.Footer>
        </AlertDialog.Dialog></AlertDialog.Container>
      </AlertDialog.Backdrop>
      <Modal.Backdrop isOpen={!sessionReady && Boolean(summary)} isDismissable={false}>
        <Modal.Container size="sm"><Modal.Dialog>
          <Modal.Header><Modal.Heading>Verify admin access</Modal.Heading></Modal.Header>
          <Modal.Body>
            <p>Your unsaved configuration is preserved. Verify your token to continue.</p>
            <TokenForm loading={authStatus === "verifying"} submitLabel="Verify and continue" tokenSet={false} onTokenSave={saveToken} />
            {summaryError ? <p role="alert">{summaryError}</p> : null}
          </Modal.Body>
        </Modal.Dialog></Modal.Container>
      </Modal.Backdrop>
      <Modal.Backdrop isOpen={Boolean(leaveAction)} onOpenChange={(open) => { if (!open) setLeaveAction(null); }}>
        <Modal.Container size="sm"><Modal.Dialog>
          <Modal.Header><Modal.Heading>Discard unsaved changes?</Modal.Heading></Modal.Header>
          <Modal.Body>Your saved configuration will stay unchanged.</Modal.Body>
          <Modal.Footer>
            <Button variant="secondary" onPress={() => setLeaveAction(null)}>Keep editing</Button>
            <Button variant="danger-soft" onPress={() => {
              dirtyDrafts.current.clear(); setDraftGeneration((value) => value + 1); setForm(defaultMonitorDraft); leaveAction?.execute(); setLeaveAction(null);
            }}>Discard changes</Button>
          </Modal.Footer>
        </Modal.Dialog></Modal.Container>
      </Modal.Backdrop>
    </ProSidebar.Provider>
    </NavigateContext.Provider>
    </DirtyContext.Provider>
  );
}

function AccessGate({
  authStatus,
  error,
  loading,
  onTokenSave
}: {
  authStatus: AuthStatus;
  error: string | null;
  loading: boolean;
  onTokenSave: (value: string) => void | Promise<void>;
}) {
  return (
    <main className="access-shell">
      <section className="access-panel" aria-labelledby="access-title">
        <div className="access-brand">
          <div className="brand-mark">
            <Signal size={18} />
          </div>
          <div>
            <strong>MonsterTracker</strong>
            <span>Cloudflare edge monitor</span>
          </div>
        </div>
        <div className="access-heading">
          <div className="access-icon"><KeyRound size={20} /></div>
          <div>
            <h1 id="access-title">Admin access</h1>
            <p>Enter the <code>ADMIN_TOKEN</code> configured for the control Worker.</p>
          </div>
        </div>
        <TokenForm
          loading={loading}
          submitLabel={authStatus === "verifying" ? "Verifying access" : "Open console"}
          tokenSet={false}
          onTokenSave={onTokenSave}
        />
        {error ? (
          <div className="access-error" role="alert">
            <AlertTriangle size={16} />
            <span>{error}</span>
          </div>
        ) : null}
        <div className="access-footnote">
          <LockKeyhole size={14} />
          <span>Stored only in this browser session and sent as Bearer authorization.</span>
        </div>
      </section>
    </main>
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
  const contents = <>
    <ProSidebar.Header>
      <div className="brand-row">
        <div className="brand-mark">
          <Signal size={18} />
        </div>
        <div>
          <strong>MonsterTracker</strong>
          <span>Edge monitor control</span>
        </div>
      </div>

    </ProSidebar.Header>
    <ProSidebar.Content>
      <nav className="nav-stack" aria-label="Primary navigation">
        <NavGroup items={primaryNavItems} label="Monitor" openIncidentCount={openIncidentCount} summary={summary} view={view} onChange={onChange} />
        <NavGroup items={systemNavItems} label="System" openIncidentCount={openIncidentCount} summary={summary} view={view} onChange={onChange} />
      </nav>
    </ProSidebar.Content>
    <ProSidebar.Footer>
      <Surface className="operator-card">
        <div>
          <span>Cloudflare account</span>
          <strong>{sessionLabel}</strong>
        </div>
        <Chip color={tokenSet ? "success" : "warning"} size="sm" variant="soft">
          {tokenSet ? "Ready" : authStatus === "verifying" ? "Checking" : "Token"}
        </Chip>
      </Surface>

      <div className="sidebar-footer">
        <div className="quota-ring">
          <span>{Math.min(100, health.budgetPct)}%</span>
        </div>
        <div>
          <strong>Daily probe progress</strong>
          <span>{formatNumber(summary.usage.reservedProbes)} reserved · {formatNumber(summary.usage.probeResults)} recorded</span>
        </div>
      </div>
    </ProSidebar.Footer>
  </>;
  return <><ProSidebar className="app-nav">{contents}</ProSidebar><ProSidebar.Mobile>{contents}</ProSidebar.Mobile></>;
}

function NavGroup({
  items,
  label,
  openIncidentCount,
  summary,
  view,
  onChange
}: {
  items: Array<{ key: ViewKey; label: string; icon: typeof Activity }>;
  label: string;
  openIncidentCount: number;
  summary: Summary;
  view: ViewKey;
  onChange: (view: ViewKey) => void;
}) {
  return (
    <ProSidebar.Group>
      <ProSidebar.GroupLabel>{label}</ProSidebar.GroupLabel>
      <ProSidebar.Menu aria-label={label}>
      {items.map((item) => {
          const Icon = item.icon;
          const count = item.key === "overview" || item.key === "monitors"
            ? summary.monitors.length
            : item.key === "regions"
              ? summary.regions.filter((region) => region.enabled).length
              : item.key === "incidents"
                ? openIncidentCount
                : undefined;
          return (
            <ProSidebar.MenuItem
              id={item.key}
              textValue={item.label}
              isCurrent={view === item.key}
              key={item.key}
              onAction={() => onChange(item.key)}
            >
              <ProSidebar.MenuIcon><Icon size={18} /></ProSidebar.MenuIcon>
              <ProSidebar.MenuLabel>{item.label}</ProSidebar.MenuLabel>
              {typeof count === "number" ? <ProSidebar.MenuChip>{count}</ProSidebar.MenuChip> : null}
            </ProSidebar.MenuItem>
          );
        })}
      </ProSidebar.Menu>
    </ProSidebar.Group>
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
    overview: ["Overview", `${summary.monitors.length} monitors across ${summary.regions.filter((region) => region.enabled).length} enabled regions`],
    monitors: ["Monitors", `${summary.monitors.length} configured targets`],
    regions: ["Regions", `${summary.regions.filter((region) => region.enabled).length} enabled probe locations`],
    incidents: [
      "Incidents",
      `${summary.incidents.filter((incident) => incident.status !== "resolved").length} open · ${summary.incidents.length} recent`
    ],
    usage: ["Usage", `${formatNumber(summary.usage.probeResults)} probe results today`],
    placement: ["Regions", `${summary.regions.length} Worker routes and placement hints`],
    tokens: ["Settings", tokenSet ? "Admin session and runtime configuration" : "Admin token required"]
  };
  const [title, subtitle] = titles[view];
  const showRunAction = view === "overview" || view === "monitors";

  return (
    <header className="topbar">
      <div className="title-block">
        <ProSidebar.Trigger className="mobile-nav-trigger" aria-label="Open navigation" />
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
          <ProgressBar aria-label="Probe budget used" value={health.budgetPct}><ProgressBar.Track><ProgressBar.Fill /></ProgressBar.Track></ProgressBar>
          <strong>{health.budgetPct}%</strong>
        </Surface>
        <Button isDisabled={refreshing} onPress={onRefresh} size="sm" variant="outline">
          <RefreshCw size={16} />
          {refreshing ? "Refreshing" : "Refresh"}
        </Button>
        {showRunAction ? (
          <Button className="primary-action" isDisabled={actionLoading || !tokenSet} onPress={onRun} size="sm" variant="primary">
            <Play size={16} />
            Run due checks
          </Button>
        ) : null}
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
    <div className={`commandbar${showFilters ? "" : " mobile-only-commandbar"}`}>
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
              <option value="partial">Degraded</option>
              <option value="unknown">Unknown</option>
              <option value="incomplete">Gathering coverage</option>
              <option value="stale">Stale</option>
              <option value="paused">Paused</option>
              <option value="idle">Not checked</option>
            </select>
          </label>
          <Button onPress={onAdd} size="sm" variant="secondary">
            <Plus size={16} />
            Add monitor
          </Button>
        </>
      ) : null}
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
  onUnauthorized,
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
  onUnauthorized: () => void;
  loading: boolean;
  onTokenSave: (value: string) => void | Promise<void>;
  onRegionSave: (id: string, patch: RegionConfigPatch) => void | Promise<void>;
  onMonitorSelect: (monitor: MonitorConfig) => void;
}) {
  if (view === "regions" || view === "placement") {
    return (
      <RegionsView
        allowedHostnameSuffix={summary.runtime.probeWorkerHostSuffix}
        loading={loading}
        regions={summary.regions}
        onRegionSave={onRegionSave}
      />
    );
  }
  if (view === "incidents") {
    return (
      <IncidentsView
        incidents={summary.incidents}
        monitors={summary.monitors}
        retentionDays={summary.runtime.retentionDays}
        onMonitorSelect={onMonitorSelect}
      />
    );
  }
  if (view === "usage") return <UsageView summary={summary} health={health} token={token} onUnauthorized={onUnauthorized} />;
  if (view === "tokens") {
    return <SettingsView summary={summary} tokenSet={Boolean(token.trim())} onTokenSave={onTokenSave} />;
  }
  return (
    <>
      {view === "overview" ? <MetricStrip summary={summary} health={health} /> : null}
      <MonitorTable
        description={view === "overview" ? "Fresh status and coverage from enabled regions." : "Select a target to inspect, test, or edit its configuration."}
        latestByMonitor={latestByMonitor}
        monitors={monitors}
        regions={summary.regions}
        selectedMonitorId={selectedMonitorId}
        title={view === "overview" ? "Monitor status" : "All monitors"}
        onMonitorSelect={onMonitorSelect}
      />
    </>
  );
}

function MetricStrip({ summary, health }: { summary: Summary; health: HealthSummary }) {
  const attention = health.down + health.partial + health.stale + health.unknown;
  const unchecked = health.idle + health.incomplete;
  return (
    <div className="metric-strip">
      <MetricCard icon={CheckCircle2} label="Healthy" note={`${summary.monitors.length} total monitors`} tone="green" value={health.up} />
      <MetricCard icon={AlertTriangle} label="Needs attention" note="failed, unknown, or stale" tone="rose" value={attention} />
      <MetricCard icon={Clock3} label="Gathering evidence" note={`${health.paused} paused · awaiting full coverage`} tone="amber" value={unchecked} />
      <MetricCard
        icon={ShieldCheck}
        label="Open incidents"
        note={`${summary.incidents.length} retained incidents`}
        tone="indigo"
        value={summary.incidents.filter((incident) => incident.status !== "resolved").length}
      />
    </div>
  );
}

function MetricCard({
  icon: Icon,
  label,
  note,
  value,
  tone
}: {
  icon: typeof Activity;
  label: string;
  note: string;
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
        <small>{note}</small>
      </Card.Content>
    </Card>
  );
}

function MonitorTable({
  title,
  description,
  monitors,
  latestByMonitor,
  regions,
  selectedMonitorId,
  onMonitorSelect
}: {
  title: string;
  description: string;
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
    const freshLatest = latest.filter((item) => item.resultType !== "infrastructure" && !isRegionResultStale(item, monitor, regions));
    const status = monitorStatus(latest, monitor, regions);
    const latency = median(freshLatest.map((item) => item.latencyMs).filter(isFiniteNumber));
    const checked = freshLatest.length;
    const selected = monitor.id === selectedMonitorId;
    return { checked, latency, latest, monitor, selected, status };
  });

  return (
    <Card className="data-card" variant="default">
      <Card.Header>
        <div>
          <Card.Title>{title}</Card.Title>
          <Card.Description>{description}</Card.Description>
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
          <EmptyState size="sm"><EmptyState.Header>
            <EmptyState.Media variant="icon"><Search size={22} /></EmptyState.Media>
            <EmptyState.Title>No monitors match this view</EmptyState.Title>
            <EmptyState.Description>Adjust the search or status filter, or add a monitor.</EmptyState.Description>
          </EmptyState.Header></EmptyState>
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

function RegionsView({
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
  const [section, setSection] = useState<"status" | "routing">("status");
  const navigate = useContext(NavigateContext);

  return (
    <>
      <div className="page-section-bar">
        <div>
          <strong>Probe network</strong>
          <span>Status is observational; routing changes scheduler dispatch.</span>
        </div>
        <div className="incident-filters" role="group" aria-label="Region view">
          <button aria-pressed={section === "status"} onClick={() => { if (section !== "status") navigate(() => setSection("status")); }} type="button">Status</button>
          <button aria-pressed={section === "routing"} onClick={() => setSection("routing")} type="button">Routing</button>
        </div>
      </div>
      {section === "status" ? (
        <Card className="data-card" variant="default">
          <Card.Header>
            <div>
              <Card.Title>Regional probe status</Card.Title>
              <Card.Description>Latest Worker presence and placement metadata.</Card.Description>
            </div>
            <Chip size="sm" variant="soft">{regions.filter((region) => region.enabled).length} enabled</Chip>
          </Card.Header>
          <Card.Content className="region-board">
            <div className="region-column-head" aria-hidden="true">
              <span>Location</span>
              <span>State</span>
              <span>Provider region</span>
              <span>Placement hint</span>
              <span>Last seen</span>
            </div>
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
      ) : (
        <PlacementView
          allowedHostnameSuffix={allowedHostnameSuffix}
          loading={loading}
          regions={regions}
          onRegionSave={onRegionSave}
        />
      )}
    </>
  );
}

function IncidentsView({
  incidents,
  monitors,
  retentionDays,
  onMonitorSelect
}: {
  incidents: Incident[];
  monitors: MonitorConfig[];
  retentionDays: number;
  onMonitorSelect: (monitor: MonitorConfig) => void;
}) {
  const [scope, setScope] = useState<"open" | "resolved">("open");
  const visibleIncidents = incidents.filter((incident) => scope === "open" ? incident.status !== "resolved" : incident.status === "resolved");
  const monitorById = new Map(monitors.map((monitor) => [monitor.id, monitor]));

  if (!incidents.length) {
    return (
      <EmptyState><EmptyState.Header>
        <EmptyState.Media variant="icon"><ShieldCheck size={26} /></EmptyState.Media>
        <EmptyState.Title>No incident history</EmptyState.Title>
        <EmptyState.Description>Incident records will appear after a monitor reports a regional failure.</EmptyState.Description>
      </EmptyState.Header></EmptyState>
    );
  }
  return (
    <Card className="data-card" variant="default">
      <Card.Header>
        <div>
          <Card.Title>Incident timeline</Card.Title>
          <Card.Description>Open or unconfirmed incidents and resolved history retained for {retentionDays} days.</Card.Description>
        </div>
        <Segment selectedKey={scope} onSelectionChange={(key) => setScope(key as "open" | "resolved")} aria-label="Incident status">
          <Segment.Item id="open">
            Open {incidents.filter((incident) => incident.status !== "resolved").length}
          </Segment.Item>
          <Segment.Item id="resolved">
            Resolved
          </Segment.Item>
        </Segment>
      </Card.Header>
      <Card.Content className="stack-list">
        {visibleIncidents.length ? visibleIncidents.map((incident) => {
          const monitor = monitorById.get(incident.monitorId);
          return (
            <Surface className="incident-card" key={incident.id}>
              <div>
                <strong>{monitor?.name || incident.monitorId}</strong>
                <span>{incident.summary} · opened {relativeTime(incident.openedAt)}</span>
                {incident.closedAt ? <span>Resolved {relativeTime(incident.closedAt)}</span> : null}
              </div>
              <div className="incident-actions">
                <div className="incident-meta">
                  <Chip color={incident.status === "unknown" ? "warning" : incident.status === "open" ? "danger" : "success"} size="sm" variant="soft">
                    {incident.status}
                  </Chip>
                  <span>{incident.severity}</span>
                </div>
                <Button isDisabled={!monitor} onPress={() => monitor && onMonitorSelect(monitor)} size="sm" variant="secondary">
                  <Server size={14} />
                  Inspect
                </Button>
              </div>
            </Surface>
          );
        }) : (
          <div className="inline-empty-state compact">
            <ShieldCheck size={22} />
            <strong>No {scope} incidents</strong>
          </div>
        )}
      </Card.Content>
    </Card>
  );
}

function UsageView({ summary, health, token, onUnauthorized }: { summary: Summary; health: HealthSummary; token: string; onUnauthorized: () => void }) {
  const estimate = estimateCost({ urlCount: summary.monitors.length, probesPerDay: 0,
    monitorBudgets: summary.monitors.filter((monitor) => monitor.enabled).map((monitor) => monitor.effectiveDailyBudget ?? monitor.dailyBudget),
    queueBatchSize: summary.runtime.resultQueueBatchSize });
  const queueOps = summary.usage.queueMessages * 3;
  const rows: Array<[string, string | number, number, string]> = [
    [
      "Reserved probe budget",
      formatNumber(summary.usage.reservedProbes),
      Math.min(100, Math.round((summary.usage.reservedProbes / summary.runtime.maxDailyProbes) * 100)),
      `new-check allocation limit ${formatNumber(summary.runtime.maxDailyProbes)}; recovery attempts are extra`
    ],
    [
      "Probe results",
      formatNumber(summary.usage.probeResults),
      Math.min(100, Math.round((summary.usage.probeResults / summary.runtime.maxDailyProbes) * 100)),
      `configured cap ${formatNumber(summary.runtime.maxDailyProbes)}`
    ],
    ["Tracked Worker invocations", formatNumber(summary.usage.workerInvocations), Math.min(100, Math.round((summary.usage.workerInvocations / 100_000) * 100)), "internal estimate"],
    ["Analytics points", formatNumber(summary.usage.probeResults), Math.min(100, Math.round((summary.usage.probeResults / 100_000) * 100)), "Free reference 100k/day"],
    ["Queue operations (baseline)", formatNumber(queueOps), Math.min(100, Math.round((queueOps / 10_000) * 100)), `${formatNumber(summary.usage.queueMessages)} messages × 3; excludes retries and size overhead`]
  ];
  return (
    <>
      <MetricStrip summary={summary} health={health} />
      <Card className="data-card" variant="default">
        <Card.Header>
          <div>
            <Card.Title>Daily usage guardrails</Card.Title>
            <Card.Description>Today in UTC. Application counters are estimates, not your Cloudflare bill.</Card.Description>
          </div>
        </Card.Header>
        <Card.Content className="quota-list">
          <div className="strategy-note">
            <strong>{formatNumber(estimate.queueOperationsPerDay)} Queue operations / scheduled day</strong>
            <span>Based on each monitor’s effective budget and {summary.runtime.resultQueueBatchSize}-result messages. Manual runs and retries use additional capacity.</span>
            <span>D1: {formatNumber(summary.usage.d1Writes)} logical row writes tracked. Indexes, acknowledgements and scheduling add writes; check Cloudflare for metered usage.</span>
          </div>
          {rows.map(([label, value, pct, note]) => (
            <div className="quota-row" key={label}>
              <div>
                <strong>{label}</strong>
                <span>{value} · {note}</span>
              </div>
              <ProgressBar aria-label={label} value={pct}><ProgressBar.Track><ProgressBar.Fill /></ProgressBar.Track></ProgressBar>
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
      <Suspense fallback={<div className="notice-panel">Loading delivery diagnostics…</div>}>
        <DiagnosticsPanel token={token} onUnauthorized={onUnauthorized} />
      </Suspense>
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
    try {
      await onSave(region.id, { workerUrl: workerUrl.trim() || null, weight: parsedWeight, enabled });
    } catch (error) { setValidationError(error instanceof Error ? error.message : "Save failed. Please retry."); }
  }

  const dirty =
    workerUrl.trim() !== (region.workerUrl || "") ||
    weight !== String(region.weight) ||
    enabled !== region.enabled;
  useDirtyDraft(`region:${region.id}`, dirty);

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
  loading = false,
  submitLabel,
  tokenSet,
  onTokenSave
}: {
  loading?: boolean;
  submitLabel?: string;
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
          disabled={loading}
          onChange={(event) => setDraft(event.currentTarget.value)}
          placeholder={tokenSet ? "Enter a new token" : "ADMIN_TOKEN"}
          type={revealed ? "text" : "password"}
          value={draft}
          variant="secondary"
        />
        <Button
          aria-label={revealed ? "Hide token" : "Show token"}
          className="icon-button"
          isDisabled={loading || !draft}
          onPress={() => setRevealed((current) => !current)}
          size="sm"
          type="button"
          variant="secondary"
        >
          {revealed ? <EyeOff size={16} /> : <Eye size={16} />}
        </Button>
      </div>
      <div className="token-actions">
        <Button className="primary-action" isDisabled={loading || !draft.trim()} size="sm" type="submit" variant="primary">
          {submitLabel || (tokenSet ? "Update token" : "Save token")}
        </Button>
        {tokenSet ? (
          <Button isDisabled={loading} onPress={clearToken} size="sm" type="button" variant="secondary">
            <LogOut size={15} />
            Sign out
          </Button>
        ) : null}
      </div>
    </form>
  );
}

function SettingsView({
  summary,
  tokenSet,
  onTokenSave
}: {
  summary: Summary;
  tokenSet: boolean;
  onTokenSave: (value: string) => void | Promise<void>;
}) {
  return (
    <div className="settings-page-grid">
      <Card className="data-card" variant="default">
        <Card.Header>
          <div>
            <Card.Title>Admin session</Card.Title>
            <Card.Description>Replace the current token or end this browser session.</Card.Description>
          </div>
          <Chip color={tokenSet ? "success" : "warning"} size="sm" variant="soft">
            {tokenSet ? "Authenticated" : "Locked"}
          </Chip>
        </Card.Header>
        <Card.Content className="settings-card-content">
          <TokenForm tokenSet={tokenSet} onTokenSave={onTokenSave} />
          <div className="access-footnote compact">
            <LockKeyhole size={14} />
            <span>The token remains in session storage and is never returned by the API.</span>
          </div>
        </Card.Content>
      </Card>
      <Card className="data-card" variant="default">
        <Card.Header>
          <div>
            <Card.Title>Runtime policy</Card.Title>
            <Card.Description>Read-only limits applied by the control Worker.</Card.Description>
          </div>
        </Card.Header>
        <Card.Content className="runtime-policy-list">
          <RuntimeItem label="Daily probe cap" value={formatNumber(summary.runtime.maxDailyProbes)} />
          <RuntimeItem label="Per-monitor cap" value={formatNumber(summary.runtime.maxMonitorDailyBudget)} />
          <RuntimeItem label="Retention" value={`${summary.runtime.retentionDays} days`} />
          <RuntimeItem label="Probe batch" value={summary.runtime.probeBatchSize} />
          <RuntimeItem label="Result queue batch" value={summary.runtime.resultQueueBatchSize} />
          <RuntimeItem label="Dispatch concurrency" value={summary.runtime.dispatchConcurrency} />
        </Card.Content>
      </Card>
      <Card className="data-card" variant="default">
        <Card.Header><div><Card.Title>Configuration backup</Card.Title>
          <Card.Description>Download monitor settings as a versioned JSON file.</Card.Description></div></Card.Header>
        <Card.Content className="settings-card-content">
          <p className="panel-help">Includes targets, check rules, budgets, tags and enabled states from the current dashboard snapshot. Tokens, Worker bindings and probe history are excluded. Automatic restore is not available.</p>
          <Button variant="secondary" isDisabled={!tokenSet || !summary.monitors.length} onPress={() => downloadText(
            `monstertracker-monitors-${new Date().toISOString().slice(0, 10)}.json`,
            JSON.stringify(monitorBackup(summary.monitors, summary.generatedAt), null, 2), "application/json")}>Export {summary.monitors.length} monitor configurations</Button>
        </Card.Content>
      </Card>
    </div>
  );
}

function RuntimeItem({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="runtime-policy-row">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function Inspector({
  summary,
  monitor,
  latest,
  token,
  historyRefreshKey,
  onUnauthorized,
  mode,
  tab,
  form,
  createError,
  loading,
  onClose,
  onTabChange,
  onMonitorSave,
  onMonitorRun,
  onMonitorDelete,
  onFormChange,
  onCreate
}: {
  summary: Summary;
  monitor: MonitorConfig | null;
  latest: LatestResult[];
  token: string;
  historyRefreshKey: number;
  onUnauthorized: () => void;
  mode: InspectorMode;
  tab: DetailTab;
  form: MonitorDraft;
  createError: string | null;
  loading: boolean;
  onClose: () => void;
  onTabChange: (tab: DetailTab) => void;
  onMonitorSave: (id: string, patch: MonitorConfigPatch) => void | Promise<void>;
  onMonitorRun: (id: string) => void | Promise<void>;
  onMonitorDelete: (monitor: MonitorConfig) => void;
  onFormChange: (form: MonitorDraft) => void;
  onCreate: () => void;
}) {
  const enabledRegionCount = summary.regions.filter((region) => region.enabled).length;
  const status = monitorStatus(latest, monitor, summary.regions);
  const creating = mode === "create";
  return (
    <aside aria-label={creating ? "Add monitor" : "Monitor details"} className="inspector">
      <div className="inspector-head">
        <div>
          <h2>{creating ? "Add monitor" : monitor?.name || "No monitor"}</h2>
          <p>{creating ? "Configure a target and its daily probe budget." : monitor?.url || "Select a monitor"}</p>
        </div>
        <div className="inspector-head-actions">
          {creating ? null : <StatusChip status={status} />}
          <span title="Close panel">
            <Button aria-label="Close panel" className="icon-button" onPress={onClose} size="sm" variant="secondary">
              <X size={16} />
            </Button>
          </span>
        </div>
      </div>
      {creating ? (
        <AddMonitorForm
          enabledRegionCount={enabledRegionCount}
          error={createError}
          form={form}
          loading={loading}
          maxDailyBudget={summary.runtime.maxMonitorDailyBudget}
          tokenSet
          onChange={onFormChange}
          onCreate={onCreate}
        />
      ) : (
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
            <OverviewPanel
              remainingBudget={Math.max(0, summary.runtime.maxDailyProbes - summary.usage.reservedProbes)}
              regions={summary.regions}
              enabledRegionCount={enabledRegionCount}
              latest={latest}
              loading={loading}
              monitor={monitor}
              onRun={onMonitorRun}
            />
          </Tabs.Panel>
          <Tabs.Panel id="history">
            {monitor && tab === "history" && token ? <Suspense fallback={<div className="notice-panel">Loading history…</div>}>
              <MonitorHistory key={monitor.id} monitor={monitor} regions={summary.regions} token={token} refreshKey={historyRefreshKey} onUnauthorized={onUnauthorized} />
            </Suspense> : <div className="notice-panel">Verify your admin session to view history.</div>}
          </Tabs.Panel>
          <Tabs.Panel id="regions">
            <CoveragePanel latest={latest} monitor={monitor} regions={summary.regions} />
          </Tabs.Panel>
          <Tabs.Panel id="alerts">
            <AlertsPanel incidents={summary.incidents.filter((incident) => incident.monitorId === monitor?.id)} />
          </Tabs.Panel>
          <Tabs.Panel id="settings">
            <SettingsPanel
              enabledRegionCount={enabledRegionCount}
              loading={loading}
              maxDailyBudget={summary.runtime.maxMonitorDailyBudget}
              monitor={monitor}
              onMonitorSave={onMonitorSave}
              onMonitorRun={onMonitorRun}
              onMonitorDelete={onMonitorDelete}
            />
          </Tabs.Panel>
        </Tabs>
      )}
    </aside>
  );
}

function OverviewPanel({
  remainingBudget,
  regions,
  enabledRegionCount,
  monitor,
  latest,
  loading,
  onRun
}: {
  remainingBudget: number;
  regions: RegionConfig[];
  enabledRegionCount: number;
  monitor: MonitorConfig | null;
  latest: LatestResult[];
  loading: boolean;
  onRun: (id: string) => void | Promise<void>;
}) {
  if (!monitor) return <div className="notice-panel">No monitor selected.</div>;
  const status = monitorStatus(latest, monitor, regions);
  return (
    <div className="overview-panel">
      {status === "unknown" ? <div className="notice-panel" role="status">Probe availability is uncertain. Inspect Regions or History before judging the website.</div> : null}
      {status === "incomplete" ? <div className="notice-panel">Checks received so far passed. Regional coverage is still being collected.</div> : null}
      {status === "stale" ? <div className="notice-panel">These results are older than the monitoring window. Run a sample for fresh evidence.</div> : null}
      <div className="detail-grid">
        <InfoItem label="Status" value={monitorStatusLabel(monitorStatus(latest, monitor, regions))} />
        <InfoItem label="Method" value={monitor.method} />
        <InfoItem label="Last check" value={latest[0] ? relativeTime(latest[0].checkedAt) : "never"} />
        <InfoItem label="Timeout" value={`${monitor.timeoutMs} ms`} />
        <InfoItem label="Daily budget" value={monitor.dailyBudget} />
        <InfoItem label="Expected" value={`${monitor.expectedStatusMin}-${monitor.expectedStatusMax}`} />
      </div>
      <BudgetHint budget={monitor.effectiveDailyBudget ?? monitor.dailyBudget} regions={enabledRegionCount} />
      {(monitor.effectiveDailyBudget ?? monitor.dailyBudget) < monitor.dailyBudget && monitor.enabled ?
        <p className="field-note">Requested {monitor.dailyBudget}/day; effective {monitor.effectiveDailyBudget}/day after the global cap.</p> : null}
      <Button
        fullWidth
        isDisabled={loading || !monitor.enabled || enabledRegionCount === 0 || remainingBudget < enabledRegionCount}
        onPress={() => onRun(monitor.id)}
        size="sm"
        variant="secondary"
      >
        <Play size={15} />
        Run {enabledRegionCount}-region sample
      </Button>
      <p className="field-note">One sample uses {enabledRegionCount} probes. {formatNumber(remainingBudget)} remain in today’s UTC budget.</p>
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
      .filter((item) => monitor && isRegionResultStale(item, monitor, enabledRegions))
      .map((item) => item.regionId)
  );
  const fresh = relevant.filter((item) => item.resultType !== "infrastructure" && !stale.has(item.regionId));
  const unknown = new Set(relevant.filter((item) => item.resultType === "infrastructure").map((item) => item.regionId));
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
                : unknown.has(region.id)
                  ? "region-chip stale"
                : failing.has(region.id)
                  ? "region-chip danger"
                  : seen.has(region.id)
                    ? "region-chip ok"
                    : "region-chip"
            }
            key={region.id}
            title={`${region.label}: ${!region.enabled ? "Paused" : stale.has(region.id) ? "Stale evidence" : unknown.has(region.id) ? "Probe unavailable; target status unknown" : failing.has(region.id) ? "Target check failed" : seen.has(region.id) ? "Target check passed" : "Awaiting first result"}`}
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
  onMonitorSave,
  onMonitorRun,
  onMonitorDelete
}: {
  monitor: MonitorConfig | null;
  loading: boolean;
  maxDailyBudget: number;
  enabledRegionCount: number;
  onMonitorSave: (id: string, patch: MonitorConfigPatch) => void | Promise<void>;
  onMonitorRun: (id: string) => void | Promise<void>;
  onMonitorDelete: (monitor: MonitorConfig) => void;
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
      {monitor ? <section className="monitor-delete-section" aria-label="Delete monitor">
        <h3>Delete monitor</h3>
        <p>Stop future checks and remove this monitor from the dashboard. To stop checks temporarily, pause scheduling above.</p>
        <Button size="sm" type="button" variant="danger-soft" isDisabled={loading} onPress={() => onMonitorDelete(monitor)}>
          <Trash2 size={15} />Delete monitor
        </Button>
      </section> : null}
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
  useDirtyDraft(`monitor:${monitor.id}`, dirty);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = parseMonitorForm(form, maxDailyBudget);
    if (!parsed.ok) {
      setValidationError(parsed.error);
      return;
    }
    setValidationError(null);
    try { await onSave(monitor.id, parsed.patch); }
    catch (error) { setValidationError(error instanceof Error ? error.message : "Save failed. Please retry."); }
  }

  return (
    <form className="monitor-config-form" onSubmit={save}>
      <div className="config-section-title">
        <strong>Monitor configuration</strong>
        <Chip color={form.enabled ? "success" : "warning"} size="sm" variant="soft">
          {form.enabled ? "enabled" : "paused"}
        </Chip>
      </div>
      <BudgetHint budget={Number(form.dailyBudget)} regions={enabledRegionCount} />
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
      {dirty ? <Button variant="ghost" size="sm" type="button" isDisabled={loading} onPress={() => { setForm(savedForm); setValidationError(null); }}>Reset changes</Button> : null}
      {validationError ? <div className="notice-panel danger">{validationError}</div> : null}
    </form>
  );
}

function AddMonitorForm({
  enabledRegionCount,
  error,
  form,
  loading,
  maxDailyBudget,
  tokenSet,
  onChange,
  onCreate
}: {
  enabledRegionCount: number;
  error: string | null;
  form: MonitorDraft;
  loading: boolean;
  maxDailyBudget: number;
  tokenSet: boolean;
  onChange: (form: MonitorDraft) => void;
  onCreate: () => void;
}) {
  return (
    <form
      className="create-form"
      onSubmit={(event) => {
        event.preventDefault();
        onCreate();
      }}
    >
      <div className="create-form-intro">
        <Globe2 size={16} />
        <span>Daily budget is distributed across enabled regions.</span>
      </div>
      <BudgetHint budget={Number(form.dailyBudget)} regions={enabledRegionCount} />
      <div className="create-form-content">
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
        {error ? (
          <div className="notice-panel danger" role="alert">
            <AlertTriangle size={16} />
            <span>{error}</span>
          </div>
        ) : null}
        <Button className="primary-action" fullWidth isDisabled={loading || !tokenSet} type="submit" variant="primary">
          <Plus size={16} />
          {tokenSet ? "Create monitor" : "Token required"}
        </Button>
      </div>
    </form>
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

function BudgetHint({ budget, regions }: { budget: number; regions: number }) {
  if (!Number.isFinite(budget) || budget <= 0) return <p className="field-note">No automatic checks allocated.</p>;
  const minutes = 1440 / budget;
  const formatInterval = (value: number) => value < 1 ? "less than a minute" : value < 60 ? `${Math.round(value * 10) / 10} min` : `${Math.round(value / 6) / 10} hr`;
  return <div className="strategy-note">
    <strong>One scheduled check about every {formatInterval(minutes)}</strong>
    <span>{regions > 0 ? `About ${formatInterval(minutes * regions)} per region at equal weights. Regions rotate; this is not a simultaneous global check.` : "Enable a region to start checking."}</span>
  </div>;
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
      {monitorStatusLabel(status)}
    </Chip>
  );
}

function monitorStatusLabel(status: MonitorStatus): string {
  const labels: Record<MonitorStatus, string> = {
    up: "Up",
    down: "Down",
    partial: "Degraded",
    unknown: "Unknown",
    incomplete: "Gathering",
    stale: "Stale",
    paused: "Paused",
    idle: "Not checked"
  };
  return labels[status];
}

function CoverageMini({ checked, total }: { checked: number; total: number }) {
  const blocks = Array.from({ length: Math.min(18, Math.max(total, 1)) });
  return (
    <div className="coverage-mini">
      <span>{checked} / {total}</span>
      <div>
        {blocks.map((_, index) => (
          <i className={index < Math.round(blocks.length * checked / Math.max(1, total)) ? "on" : ""} key={index} />
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
  partial: number;
  stale: number;
  unknown: number;
  incomplete: number;
  paused: number;
  idle: number;
  budgetPct: number;
}

function computeHealth(summary: Summary, latestByMonitor: Map<string, LatestResult[]>): HealthSummary {
  let up = 0;
  let down = 0;
  let partial = 0;
  let stale = 0;
  let unknown = 0;
  let incomplete = 0;
  let paused = 0;
  let idle = 0;
  const totalBudget = summary.monitors.reduce((total, monitor) => total + (monitor.enabled ? monitor.dailyBudget : 0), 0);
  const enabledRegions = summary.regions.filter((region) => region.enabled);
  const enabledRegionIds = new Set(enabledRegions.map((region) => region.id));
  for (const monitor of summary.monitors) {
    const relevant = (latestByMonitor.get(monitor.id) || []).filter((item) => enabledRegionIds.has(item.regionId));
    const status = monitorStatus(relevant, monitor, enabledRegions);
    if (status === "up") up += 1;
    else if (status === "down") down += 1;
    else if (status === "partial") partial += 1;
    else if (status === "stale") stale += 1;
    else if (status === "unknown") unknown += 1;
    else if (status === "incomplete") incomplete += 1;
    else if (status === "paused") paused += 1;
    else idle += 1;
  }
  return {
    up,
    down,
    partial,
    stale,
    unknown,
    incomplete,
    paused,
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
    const status = monitorStatus(relevant, monitor, enabledRegions);
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
    map.set(item.monitorId, list);
  }
  for (const list of map.values()) list.sort((a, b) => b.checkedAt.localeCompare(a.checkedAt));
  return map;
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
