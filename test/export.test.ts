import { describe, expect, it } from "vitest";
import { csvCell, historyCsv, monitorBackup } from "../client/src/export";
import type { MonitorConfig, ProbeResult } from "../client/src/types";

describe("operator exports", () => {
  it("neutralizes spreadsheet formulas, including whitespace and multiline prefixes", () => {
    for (const value of ["=1+1", "+SUM(1)", "-1+1", "@SUM(1)", "  =1", "\t=1", "\n=1"]) {
      expect(csvCell(value)).toBe(`"'${value}"`);
    }
    expect(csvCell('HTTP "503", retry\nsoon')).toBe('"HTTP ""503"", retry\nsoon"');
    expect(csvCell(null)).toBe('""');
  });

  it("keeps infrastructure distinct in a parseable, fully quoted CSV", () => {
    const csv = historyCsv([{ checkedAt: "2026-09-16T00:00:00.000Z", regionId: "test", resultType: "infrastructure",
      ok: false, status: null, latencyMs: null, error: "=untrusted", targetUrl: "https://example.com/?a=1,b=2",
      monitorConfigVersion: 2, id: "result" } as ProbeResult]);
    expect(csv).toContain('"infrastructure","","","\'=untrusted"');
    expect(csv.split("\r\n")).toHaveLength(2);
  });

  it("backs up only configuration fields, never future sensitive fields or derived evidence", () => {
    const monitor = { id: "private-id", name: "Example", url: "https://example.com", method: "HEAD",
      expectedStatusMin: 200, expectedStatusMax: 399, bodyMatch: null, timeoutMs: 10000, dailyBudget: 100,
      enabled: false, tags: ["example"], configVersion: 1, createdAt: "", updatedAt: "",
      effectiveDailyBudget: 99, adminToken: "sensitive" } as MonitorConfig;
    const backup = monitorBackup([monitor], "snapshot");
    expect(backup.monitors[0]).toEqual({ name: "Example", url: "https://example.com", method: "HEAD",
      expectedStatusMin: 200, expectedStatusMax: 399, bodyMatch: null, timeoutMs: 10000, dailyBudget: 100,
      enabled: false, tags: ["example"] });
    expect(JSON.stringify(backup)).not.toContain("sensitive");
    expect(backup.snapshotAt).toBe("snapshot");
  });
});
