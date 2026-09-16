import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import type { RuntimeEnv } from "../src/domain";

// Real SQLite statements and transactions, exposed through D1's binding shape.
// Counts every statement, including batch members, against the invocation cap.
export function databaseHarness(queryLimit = Number.POSITIVE_INFINITY) {
  const sqlite = new DatabaseSync(":memory:");
  for (const file of readdirSync("migrations").filter((file) => file.endsWith(".sql")).sort()) {
    sqlite.exec(readFileSync(`migrations/${file}`, "utf8"));
  }
  let queries = 0;
  class Statement {
    params: (string | number | null)[] = [];
    constructor(readonly sql: string) {}
    bind(...params: (string | number | null)[]) { this.params = params; return this; }
    all() {
      queries++;
      if (queries > queryLimit) throw new Error(`D1 invocation exceeded ${queryLimit} queries`);
      const results = sqlite.prepare(this.sql).all(...this.params);
      const changes = Number(sqlite.prepare("SELECT changes() AS n").get()?.n ?? 0);
      return { results, success: true, meta: { changes } };
    }
    run() { return this.all(); }
    first() { return this.all().results[0] ?? null; }
  }
  const db = {
    prepare: (sql: string) => new Statement(sql),
    async batch(statements: Statement[]) {
      sqlite.exec("BEGIN");
      try { const result = statements.map((statement) => statement.all()); sqlite.exec("COMMIT"); return result; }
      catch (error) { sqlite.exec("ROLLBACK"); throw error; }
    }
  };
  return { sqlite, env: { DB: db, MAX_DAILY_PROBES: "10000" } as unknown as RuntimeEnv,
    count: () => queries, resetCount: () => { queries = 0; } };
}
