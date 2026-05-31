#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const pack = process.argv.includes("--extended") ? "extended" : "core";
const configPath = path.join(root, "config", `regions.${pack}.json`);
const outputDir = path.join(root, "generated", "probes");
const regions = JSON.parse(await readFile(configPath, "utf8"));
const prefix = process.env.MONSTERTRACKER_PROBE_PREFIX || "monstertracker-probe";

await mkdir(outputDir, { recursive: true });

const deployLines = ["#!/usr/bin/env bash", "set -euo pipefail", ""];
const sqlLines = [
  "-- Run after assigning custom domains or workers.dev URLs.",
  "-- Replace WORKERS_SUBDOMAIN before applying.",
  "-- D1 remote SQL import does not accept explicit BEGIN/COMMIT here."
];

for (const region of regions) {
  const workerName = `${prefix}-${region.id}`;
  const file = path.join(outputDir, `${region.id}.wrangler.jsonc`);
  const json = {
    $schema: "../../node_modules/wrangler/config-schema.json",
    name: workerName,
    main: "../../src/index.ts",
    compatibility_date: "2026-05-31",
    compatibility_flags: ["nodejs_compat"],
    observability: {
      enabled: true,
      head_sampling_rate: 0.1
    },
    placement: {
      region: region.placementRegion
    },
    vars: {
      ROLE: "probe",
      REGION_ID: region.id,
      REGION_LABEL: region.label,
      REGION_HINT: region.placementRegion,
      ALLOW_LOCAL_PROBES: "false"
    }
  };
  await writeFile(file, `${JSON.stringify(json, null, 2)}\n`);
  deployLines.push(`wrangler deploy --config generated/probes/${region.id}.wrangler.jsonc`);
  sqlLines.push(
    `UPDATE regions SET worker_url = 'https://${workerName}.WORKERS_SUBDOMAIN.workers.dev', updated_at = datetime('now') WHERE id = '${region.id}';`
  );
}

deployLines.push("");
sqlLines.push("");

await writeFile(path.join(outputDir, "deploy-all.sh"), `${deployLines.join("\n")}\n`, { mode: 0o755 });
await writeFile(path.join(outputDir, "set-worker-urls.sql"), `${sqlLines.join("\n")}\n`);

console.log(`Generated ${regions.length} ${pack} probe Worker configs in generated/probes`);
console.log("Next:");
console.log("  1. Set SHARED_SECRET on each probe Worker with wrangler secret put.");
console.log("  2. Deploy with generated/probes/deploy-all.sh.");
console.log("  3. Update worker_url values using generated/probes/set-worker-urls.sql.");
