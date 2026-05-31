import coreSeeds from "../config/regions.core.json";
import extendedSeeds from "../config/regions.extended.json";
import type { RegionSeed } from "./domain";

const core = coreSeeds as RegionSeed[];
const extended = extendedSeeds as RegionSeed[];

export function getRegionSeeds(pack: "core" | "extended" | "max" = "core"): RegionSeed[] {
  if (pack === "core") return dedupeSeeds(core);
  return dedupeSeeds(extended);
}

export function probeWorkerName(regionId: string): string {
  return `monstertracker-probe-${regionId}`;
}

function dedupeSeeds(seeds: RegionSeed[]): RegionSeed[] {
  const seen = new Set<string>();
  const deduped: RegionSeed[] = [];
  for (const seed of seeds) {
    if (seen.has(seed.id)) continue;
    seen.add(seed.id);
    deduped.push(seed);
  }
  return deduped;
}
