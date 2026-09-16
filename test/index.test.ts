import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { ProbeJob, RuntimeEnv } from "../src/domain";

const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;
const secret = "synthetic-probe-test-only";

function job(regionId = "r"): ProbeJob {
  return { runId: "identity_test", scheduledAt: new Date().toISOString(),
    monitor: { id: "m", name: "Monitor", url: "https://example.com/", method: "HEAD",
      expectedStatusMin: 200, expectedStatusMax: 399, bodyMatch: null, timeoutMs: 1000, configVersion: 1 },
    region: { id: regionId, label: "Region", placementRegion: "aws:us-east-1", workerUrl: null } };
}

function request(jobs = [job()], origin = "https://probe.example.com", authenticated = true) {
  return new Request(`${origin}/internal/probe`, { method: "POST",
    headers: { "Content-Type": "application/json", ...(authenticated ? { "X-MonsterTracker-Secret": secret } : {}) },
    body: JSON.stringify({ jobs }) });
}

function env(patch: Partial<RuntimeEnv> = {}): RuntimeEnv {
  return { ROLE: "probe", REGION_ID: "r", SHARED_SECRET: secret, ...patch } as RuntimeEnv;
}

beforeEach(() => { vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 }))); });
afterEach(() => { vi.unstubAllGlobals(); });

describe("internal probe identity and role", () => {
  it("accepts authenticated jobs for the configured probe region", async () => {
    const response = await worker.fetch(request(), env(), ctx);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ results: [{ regionId: "r", ok: true, status: 204 }] });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects the entire mixed-region batch before any target request", async () => {
    const response = await worker.fetch(request([job(), job("other-region")]), env(), ctx);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("REGION_ID") });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("fails closed when a probe has no configured region", async () => {
    const response = await worker.fetch(request(), env({ REGION_ID: "" }), ctx);
    expect(response.status).toBe(503);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("still requires the internal secret in production", async () => {
    expect((await worker.fetch(request([job()], undefined, false), env(), ctx)).status).toBe(401);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects authenticated production control-role calls without touching its database", async () => {
    expect((await worker.fetch(request(), env({ ROLE: "control" }), ctx)).status).toBe(404);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects the implicit control role in production", async () => {
    const control = env(); delete control.ROLE;
    expect((await worker.fetch(request(), control, ctx)).status).toBe(404);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    { origin: "http://localhost:8787", local: "false" },
    { origin: "https://control.example.com", local: "true" }
  ])("requires both explicit local mode and localhost for control probing: $origin/$local", async ({ origin, local }) => {
    expect((await worker.fetch(request([job()], origin), env({ ROLE: "control", ALLOW_LOCAL_PROBES: local }), ctx)).status).toBe(404);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["control", undefined] as const)("preserves explicit localhost development with role %s", async (role) => {
    const local = { ALLOW_LOCAL_PROBES: "true", ...(role ? { ROLE: role } : {}) } as RuntimeEnv;
    const response = await worker.fetch(request([job("local-region")], "http://localhost:8787", false), local, ctx);
    expect(response.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not let local mode override a configured probe identity", async () => {
    expect((await worker.fetch(request([job("other-region")], "http://localhost:8787", false),
      env({ ALLOW_LOCAL_PROBES: "true" }), ctx)).status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });
});
