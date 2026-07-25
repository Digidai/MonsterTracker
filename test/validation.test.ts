import { describe, expect, it } from "vitest";

import { normalizeTargetUrl, normalizeWorkerUrl } from "../src/validation";

describe("URL validation", () => {
  it("blocks credentials and IP-literal monitoring targets", () => {
    expect(() => normalizeTargetUrl("https://user:pass@example.com/")).toThrow("credentials");
    expect(() => normalizeTargetUrl("https://8.8.8.8/")).toThrow("IP-literal");
  });

  it("restricts probe routes to the configured account subdomain", () => {
    expect(
      normalizeWorkerUrl("https://monstertracker-probe-use1.genedai.workers.dev", {
        allowedHostnameSuffix: ".genedai.workers.dev"
      })
    ).toBe("https://monstertracker-probe-use1.genedai.workers.dev/");
    expect(() =>
      normalizeWorkerUrl("https://attacker.workers.dev", {
        allowedHostnameSuffix: ".genedai.workers.dev"
      })
    ).toThrow("hostname");
  });
});
