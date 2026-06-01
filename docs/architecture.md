# Architecture Review

## Decision

Use Workers as both the control plane and probe runtime. Do not use Cloudflare Health Checks.

## Components

- Control Worker: dashboard, API, scheduler, result persistence.
- Probe Worker: same source code with `ROLE=probe`, deployed once per `placement.region`.
- D1: monitors, regions, latest results, raw results, incidents, daily usage.
- Queues: batches probe results so high-frequency schedules do not synchronously write many D1 rows.
- Analytics Engine: query-friendly time-series points.
- R2: raw JSON archives for replay and export.

## Region Strategy

Workers cannot choose an arbitrary Cloudflare city or PoP for an outbound `fetch`. Placement Hints are the most practical Cloudflare-only control surface. They place a Worker near a cloud region while still executing on Cloudflare.

The project therefore separates:

- Active placed probes: deterministic coverage from configured region hints.
- Passive edge probes, future work: dashboard/status visitors can trigger checks from their nearest Cloudflare colo.

## Budget Strategy

Daily budget is per monitor. The scheduler uses a cumulative floor function so a monitor with `100` daily probes runs exactly 100 times per UTC day, and a monitor with `10,000` daily probes runs exactly 10,000 times.

Region selection rotates deterministically by monitor id and date. Region weights expand the deterministic rotation pool, so a higher-weight region gets proportionally more probes without changing the monitor's daily budget. This avoids persistent hot spots without requiring mutable scheduler state.

## Review Findings

- No Health Checks dependency: meets project constraint.
- No third-party backend: all runtime services are Cloudflare products.
- Free-tier viable for `10 URLs / 10,000 total probes/day` if Queue results are batched.
- High-scale mode requires Workers Paid mainly for Worker count, Cron limits, and operational headroom.
- Extended region packs can exceed the Free subrequest limit because the scheduler calls one probe Worker per active region in a single invocation.
- Control-to-probe dispatch over workers.dev requires `global_fetch_strictly_public`; otherwise Cloudflare returns Worker error `1042` for same-zone Worker fetches. Service Bindings should be evaluated once the deployment target can tolerate static bindings for every probe Worker.
- D1 raw result storage is acceptable for MVP but should be downsampled or moved primarily to Analytics Engine/R2 for very high volumes.
- Placement region support can drift. Use `scripts/list-supported-regions.mjs` before deploying a large region pack.
- `/api/summary` is intentionally admin-gated because monitor URLs can contain private operational details.
- Private, local, reserved, and credential-bearing target URLs are blocked by default.
- Runtime config edits must affect runtime behavior immediately; monitor edits reset stale latest state, region weights feed the scheduler, and manual samples validate a selected monitor after edits.
- Scheduler run records should be kept lightweight and bounded in the dashboard because D1 remains the source of truth for config/latest data, not a high-volume event store.
