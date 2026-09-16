# Architecture Review

## Decision

Use Workers as both the control plane and probe runtime. Do not use Cloudflare Health Checks.

## Components

- Control Worker: dashboard, API, scheduler, result persistence.
- Probe Worker: same source code with `ROLE=probe`, deployed once per `placement.region`.
- D1: monitors, regions, latest results, raw results, incidents, daily usage.
- Queues: batches probe results so high-frequency schedules do not synchronously write many D1 rows.
- Analytics Engine: query-friendly time-series points.
- R2: raw JSON archives for export. Automatic archive replay is not implemented.

## Region Strategy

Workers cannot choose an arbitrary Cloudflare city or PoP for an outbound `fetch`. Placement Hints are the most practical Cloudflare-only control surface. They place a Worker near a cloud region while still executing on Cloudflare.

The project therefore separates:

- Active placed probes: deterministic coverage from configured region hints.
- Passive edge probes, future work: dashboard/status visitors can trigger checks from their nearest Cloudflare colo.

## Budget Strategy

Daily budget is per monitor. The scheduler uses a cumulative floor function so a monitor with `100` daily probes plans exactly 100 times per UTC day, and a monitor with `10,000` daily probes plans exactly 10,000 times when all minute Cron Triggers run. Missed triggers are not replayed.

Region selection rotates deterministically by monitor id and date. Region weights expand the deterministic rotation pool, so a higher-weight region gets proportionally more probes without changing the monitor's daily budget. This avoids persistent hot spots without requiring mutable scheduler state.

## Review Findings

- No Health Checks dependency: meets project constraint.
- No third-party backend: all runtime services are Cloudflare products.
- For `10 URLs / 10,000 total probes/day`, ten-result messages reduce Queue usage to about 3,000 operations/day. D1 metered writes must be measured before promising a free deployment.
- High-scale mode requires Workers Paid mainly for Worker count, Cron limits, and operational headroom.
- Extended region packs can exceed the Free subrequest limit because the scheduler calls one probe Worker per active region in a single invocation.
- Control-to-probe dispatch over workers.dev requires `global_fetch_strictly_public`; otherwise Cloudflare returns Worker error `1042` for same-zone Worker fetches. Service Bindings should be evaluated once the deployment target can tolerate static bindings for every probe Worker.
- D1 raw result storage is acceptable for MVP but should be downsampled or moved primarily to Analytics Engine/R2 for very high volumes.
- Placement region support can drift. Use `scripts/list-supported-regions.mjs` before deploying a large region pack.
- `/api/summary` is intentionally admin-gated because monitor URLs can contain private operational details.
- Private, local, reserved, and credential-bearing target URLs are blocked by default.
- Runtime config edits must affect runtime behavior immediately; monitor edits reset stale latest state, region weights feed the scheduler, and manual samples validate a selected monitor after edits.
- Scheduler run records should be kept lightweight and bounded in the dashboard because D1 remains the source of truth for config/latest data, not a high-volume event store.
- Probe and dispatch concurrency are capped at six to match the Workers simultaneous outgoing connection limit.
- Internal probe payloads are bounded and revalidated at the probe Worker, so the shared-secret endpoint cannot bypass target URL policy.
- Probe Worker responses are size-bounded and reconciled one-for-one with dispatched jobs; missing or malformed results become infrastructure records, never target outages.
- Queue consumers are idempotent because raw result ids use conflict-ignore semantics, usage counters advance only for newly accepted results, and stale deliveries cannot overwrite newer latest state.
- Incident evaluation ignores region results after a schedule-aware freshness window, while resolved incident and raw result history follow the configured retention period.
- Queue messages are capped at ten results and consumed one message per invocation so D1 Free query limits remain bounded. Failed messages move to a dedicated dead-letter queue.
- Result usage and Analytics Engine delivery use per-result effect markers. Queue retries can complete interrupted side effects without double-counting accepted raw rows.
- Every dispatched job carries a monitor configuration version. Results from a disabled or superseded configuration are rejected by conditional D1 writes.
- Probe budget is atomically reserved before dispatch, and scheduled run ids are deterministic per UTC minute to prevent duplicate Cron work.
- Scheduled jobs are persisted with a 16-minute execution lease aligned with the Worker execution ceiling. A later Cron trigger reclaims an unfinished expired run, so termination after budget reservation does not lose the minute or overlap a still-running invocation.
- Recovery is limited to three attempts. `MAX_DAILY_PROBES` bounds reservations for new logical checks; recovery can repeat outbound requests without reserving the same jobs again. Cost estimates exclude these additional attempts. Result IDs remain deterministic, so stored observations and usage effects are not duplicated.
- Regional dispatch accepts only the configured account Worker hostname suffix and does not follow redirects with the shared secret.
- R2 object keys are derived from result ids, and observation timestamps, so duplicate deliveries reuse an object while a recovered probe attempt preserves its distinct evidence.
- Open incidents carry a weighted, effective-budget freshness window. Stale or unavailable evidence changes an incident to unknown; only fresh successful evidence from all enabled regions confirms recovery. Config changes explicitly close superseded incidents.
