import { Button, Card, Chip } from "@heroui/react";
import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { DiagnosticsReport, QueueDiagnostics } from "../../../src/diagnostics";

export default function DiagnosticsPanel({ token, onUnauthorized }: { token: string; onUnauthorized: () => void }) {
  const [data, setData] = useState<DiagnosticsReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const active = useRef<AbortController | null>(null);
  const unauthorized = useRef(onUnauthorized);
  unauthorized.current = onUnauthorized;
  const refresh = useCallback(async () => {
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    setLoading(true); setError(null);
    try {
      const response = await fetch("/api/diagnostics", { headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]) });
      if (controller.signal.aborted || active.current !== controller) return;
      if (response.status === 401) unauthorized.current();
      const body = await response.json() as DiagnosticsReport & { error?: string };
      if (!response.ok) throw new Error(body.error || "Unable to load diagnostics.");
      if (!controller.signal.aborted) setData(body);
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "Unable to load diagnostics.");
    } finally { if (!controller.signal.aborted) setLoading(false); }
  }, [token]);
  useEffect(() => {
    setData(null);
    if (token) void refresh();
    else { setLoading(false); setError(null); }
    return () => active.current?.abort();
  }, [token, refresh]);

  return <Card className="data-card diagnostics-panel" variant="default">
    <Card.Header><div><Card.Title>Scheduler & delivery</Card.Title>
      <Card.Description>Confirm that checks run and their results reach storage.</Card.Description></div>
      <Button size="sm" variant="secondary" isDisabled={loading || !token} onPress={() => void refresh()}><RefreshCw size={14} />{loading ? "Checking…" : "Refresh diagnostics"}</Button>
    </Card.Header>
    <Card.Content className="diagnostics-content" aria-busy={loading}>
      {error ? <div className="notice-panel danger" role="alert">{error}{data ? " Displaying the previous snapshot." : " Retry using Refresh diagnostics."}</div> : null}
      {!token ? <div className="notice-panel">Verify your admin session to view diagnostics.</div> : null}
      {loading && !data ? <div className="notice-panel" role="status">Checking scheduler and queues…</div> : null}
      {data ? <>
        <div className="diagnostic-grid">
          <div className="diagnostic-tile"><span>Scheduler heartbeat</span><strong>{data.scheduler.status === "recent" ? "Recent tick" : data.scheduler.status === "stale" ? "Overdue tick" : "Not observed"}</strong>
            <p>{data.scheduler.lastTickAt ? new Date(data.scheduler.lastTickAt).toLocaleString() : "Awaiting the first five-minute checkpoint."}</p>
            <p>A tick confirms cron activity; result delivery is tracked below.</p>
          </div>
          <QueueTile label="Result queue" queue={data.queues.results} />
          <QueueTile label="Dead-letter queue" queue={data.queues.deadLetter} deadLetter />
        </div>
        {data.scheduler.status === "stale" ? <div className="notice-panel danger" role="status">No scheduler tick observed for over 15 minutes. Check the control Worker’s cron trigger and logs.</div> : null}
        {(data.queues.deadLetter.backlogCount ?? 0) > 0 ? <div className="notice-panel danger" role="status">Some messages exhausted delivery retries. Inspect the dead-letter queue in Cloudflare and resolve the storage error before considering a replay. This page does not replay messages.</div> : null}
        <div className="diagnostics-bindings">
          <span>Bindings:</span>
          {([
            ["Results queue", data.configuration.queueConfigured], ["R2 archive", data.configuration.archiveConfigured],
            ["Analytics", data.configuration.analyticsConfigured], ["Probe secret", data.configuration.probeSecretConfigured]
          ] as const).map(([label, configured]) => <Chip key={label} size="sm" variant="soft" color={configured ? "default" : "warning"}>{label}: {configured ? "configured" : "missing"}</Chip>)}
        </div>
        <p className="panel-help">Latest 20 runs · Stored means persisted in D1. Reservations are logical checks; a retry can repeat outbound requests.</p>
        <div className="delivery-list">
          {data.runs.length ? data.runs.map((run) => <article className="delivery-row" key={run.id}>
            <div className="delivery-heading"><strong>{run.storedResults} / {run.plannedJobs} results stored</strong>
              <Chip size="sm" variant="soft" color={run.state === "complete" ? "success" : run.state === "failed" ? "danger" : "warning"}>{run.state.replaceAll("-", " ")}</Chip></div>
            <span>{new Date(run.startedAt).toLocaleString()} · {run.attemptCount} scheduler attempt{run.attemptCount === 1 ? "" : "s"}</span>
            <span>{run.pendingResults} missing · {run.cancelledResults} cancelled</span>
            {run.error ? <p className="delivery-error">{run.error}</p> : null}
            {run.leaseExpiresAt && !run.finishedAt ? <span>Lease expires {new Date(run.leaseExpiresAt).toLocaleString()}</span> : null}
            <code>{run.id}</code>
          </article>) : <div className="notice-panel">No scheduled or manual runs recorded yet.</div>}
        </div>
        <p className="panel-help">Snapshot: {new Date(data.generatedAt).toLocaleString()}. Metrics refresh only when you open this page or request a refresh. Binding presence does not verify service health or archive retention.</p>
      </> : null}
    </Card.Content>
  </Card>;
}

function QueueTile({ label, queue, deadLetter = false }: { label: string; queue: QueueDiagnostics; deadLetter?: boolean }) {
  return <div className="diagnostic-tile"><span>{label}</span><strong>
    {queue.state === "available" ? queue.backlogCount === null ? "Count unavailable" : `${queue.backlogCount.toLocaleString()} waiting` : queue.state === "unavailable" ? "Metrics unavailable" : "Not configured"}
  </strong><p>{queue.backlogBytes === null ? "Backlog size unavailable." : `${queue.backlogBytes.toLocaleString()} bytes in backlog`}</p>
    <p>{queue.oldestMessageAt ? `Oldest: ${new Date(queue.oldestMessageAt).toLocaleString()}` : queue.state === "available" && queue.backlogCount === 0 ? "No queued messages." : "Oldest message time unavailable."}</p>
    {deadLetter ? <p>Messages here need operator attention.</p> : null}
  </div>;
}
