import { describe, expect, it } from "vitest";

import type { ProbeResult, RuntimeEnv } from "../src/domain";
import { claimScheduledRunAndReserve, saveProbeResults } from "../src/storage";

describe("result persistence guardrails", () => {
  it("rejects a batch that could exceed the D1 Free query budget", async () => {
    const result = {
      id: "result",
      runId: "run",
      monitorId: "monitor",
      monitorConfigVersion: 1,
      regionId: "region",
      targetUrl: "https://example.com/",
      checkedAt: "2026-07-26T00:00:00.000Z",
      ok: true,
      status: 200,
      latencyMs: 10,
      error: null,
      method: "HEAD",
      entryColo: "IAD",
      entryCountry: "US",
      entryCity: "Ashburn",
      entryAsn: 13335,
      entryAsOrganization: "Cloudflare",
      placement: "aws:us-east-1",
      responseBytes: 0
    } satisfies ProbeResult;

    await expect(
      saveProbeResults({} as RuntimeEnv, Array.from({ length: 11 }, (_, index) => ({ ...result, id: `result_${index}` })))
    ).rejects.toThrow("10-result D1 safety limit");
  });
});

describe("scheduled run claims", () => {
  it("scopes budget-failure cleanup to the run inserted by the current claim", async () => {
    const statements: Array<{ sql: string; bindings: unknown[] }> = [];
    const db = {
      prepare(sql: string) {
        return {
          sql,
          bindings: [] as unknown[],
          bind(...bindings: unknown[]) {
            this.bindings = bindings;
            statements.push(this);
            return this;
          }
        };
      },
      async batch() {
        return [
          { meta: { changes: 0 } },
          { meta: { changes: 0 } },
          { meta: { changes: 0 } },
          { meta: { changes: 0 } }
        ];
      }
    };

    await claimScheduledRunAndReserve(
      { DB: db } as unknown as RuntimeEnv,
      { id: "cron_202607260000", startedAt: "2026-07-26T00:00:00.000Z", plannedJobs: 0 },
      [],
      10_000,
      "2026-07-26"
    );

    const insertClaimToken = statements[1]?.bindings.at(-1);
    expect(statements[1]?.sql).toContain("claim_token");
    expect(statements[3]?.sql).toContain("claim_token = ?");
    expect(statements[3]?.bindings.at(-1)).toBe(insertClaimToken);
  });
});
