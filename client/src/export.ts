import type { MonitorConfig, ProbeResult } from "./types";

/** Quote every cell and neutralize spreadsheet formulas in untrusted target data. */
export function csvCell(value: unknown): string {
  const text = value == null ? "" : String(value);
  const safe = /^[\s\u0000-\u001f]*[=+@-]/.test(text) || /^[\t\r\n]/.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
}

export function historyCsv(results: ProbeResult[]): string {
  const header = ["checked_at_utc", "region", "outcome", "http_status", "latency_ms", "error", "url", "config_version", "result_id"];
  return [header, ...results.map((result) => [result.checkedAt, result.regionId,
    result.resultType === "infrastructure" ? "infrastructure" : result.ok ? "pass" : "fail",
    result.status, result.latencyMs, result.error, result.targetUrl, result.monitorConfigVersion, result.id])]
    .map((row) => row.map(csvCell).join(",")).join("\r\n");
}

export function monitorBackup(monitors: MonitorConfig[], generatedAt: string) {
  // Explicit allowlist: no tokens, runtime bindings, historical evidence or browser state.
  return { format: "monstertracker-monitor-config", version: 1, exportedAt: new Date().toISOString(), snapshotAt: generatedAt,
    monitors: monitors.map((m) => ({ name: m.name, url: m.url, method: m.method,
      expectedStatusMin: m.expectedStatusMin, expectedStatusMax: m.expectedStatusMax,
      bodyMatch: m.bodyMatch, timeoutMs: m.timeoutMs, dailyBudget: m.dailyBudget,
      enabled: m.enabled, tags: m.tags })) };
}

export function downloadText(filename: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement("a");
  link.href = url; link.download = filename;
  document.body.appendChild(link); link.click(); link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
