import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { databaseHarness } from "./d1-harness";

const databases: ReturnType<typeof databaseHarness>[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.sqlite.close(); vi.restoreAllMocks(); });
const context = { waitUntil: () => {} } as unknown as ExecutionContext;
function setup() {
  const db = databaseHarness(); databases.push(db);
  Object.assign(db.env, { ADMIN_TOKEN: "test-only-admin" });
  db.sqlite.prepare("INSERT INTO monitors (id,name,url,created_at,updated_at) VALUES ('m','Example','https://example.com',?,?)")
    .run(new Date().toISOString(), new Date().toISOString());
  return db;
}
function request(path: string, authorized = true) {
  return new Request(`https://example.com${path}`, { headers: authorized ? { Authorization: "Bearer test-only-admin" } : {} });
}

describe("private operations API", () => {
  for (const path of ["/api/diagnostics", "/api/monitors/m/history"]) {
    it(`authenticates before accessing storage: ${path}`, async () => {
      const db = setup();
      const response = await worker.fetch(request(path, false), db.env, context);
      expect(response.status).toBe(401); expect(db.count()).toBe(0);
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    });
    it(`returns uncached data and safe storage failures: ${path}`, async () => {
      const db = setup();
      const response = await worker.fetch(request(path), db.env, context);
      expect(response.status).toBe(200);
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
      db.env.DB.prepare = () => { throw new Error("internal-database-detail"); };
      vi.spyOn(console, "error").mockImplementation(() => {});
      const failed = await worker.fetch(request(path), db.env, context);
      expect(failed.status).toBe(503);
      expect(await failed.text()).not.toContain("internal-database-detail");
    });
  }
  it("rejects malformed history parameters and excludes deleted monitors", async () => {
    const db = setup();
    expect((await worker.fetch(request("/api/monitors/m/history?limit=1000"), db.env, context)).status).toBe(400);
    db.sqlite.exec("UPDATE monitors SET deleted_at='2026-09-16T00:00:00.000Z'");
    expect((await worker.fetch(request("/api/monitors/m/history"), db.env, context)).status).toBe(404);
  });
});
