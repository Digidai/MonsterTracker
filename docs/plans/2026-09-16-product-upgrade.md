# Product upgrade: trustworthy status and predictable operation

## Scope

Preserve the previous uncommitted navigation redesign. Complete the monitoring workflow with distinct target failure, infrastructure failure, incomplete coverage, and stale evidence. Keep Cloudflare-only deployment and the existing Queue recovery boundary.

## Decisions

- Keep Queue and raise result payloads to ten only after measuring the maximum D1 queries in a real SQL integration test. Replace per-monitor incident queries and per-result analytics acknowledgements with batch operations. Direct persistence and a new R2 replay architecture would change failure semantics and are deferred.
- Mark dispatch errors as infrastructure outcomes at the control boundary. Older probe Workers remain compatible; genuine target errors are still target observations.
- Unknown/stale evidence must not create a target outage or claim recovery. An existing incident becomes unconfirmed until fresh evidence resolves it.
- Use shared scheduling/health policy for effective budgets, weighted regional freshness, and UI status. Partial coverage is separate from a degraded website.
- Simulate 1,440 scheduler minutes to estimate Queue messages. Clearly distinguish application counters from Cloudflare billing, including index writes, retries and 64 KB message units.
- Load history only when requested; cancel obsolete reads. Protect unsaved edits and show cadence and manual budget costs before runs.
- Serve static assets directly and keep API responses private/no-store.

## Release gates

TypeScript and existing tests; SQLite-backed migration/persistence tests for ten distinct monitors, duplicates, ordering, infrastructure failure, stale incidents and recovery; desktop/mobile browser flows; Worker dry-run; authenticated remote migrations and deployment; remote read-only health and protocol checks. No claim of zero defects or guaranteed free billing.

## Implementation and review

- HeroUI Pro Sidebar (desktop and mobile sheet), Segment and EmptyState are now package imports, alongside OSS base controls. Only required component CSS is loaded. No premium implementation source or source maps are published from this repository. Building the frontend requires a separate HeroUI Pro license; application code remains MIT.
- Two independent review passes covered backend failure boundaries and frontend state transitions. Fixed terminal runs displaying success, swallowed JSON body errors, discarded drafts remaining mounted, reauthentication losing edits, polling failures losing the Recheck action, and a newly created monitor being replaced by a different selection when refresh fails.
- Backend regressions cover manual due Queue failure recovery, legacy Queue messages without result type, natural weighted scheduling gaps across UTC midnight, a three-attempt crash recovery limit, and the aggregate 50-query bound when no Queue is configured.
- Recovery attempts can repeat outbound requests. The reservation cap counts new logical jobs; it is not a strict cap on every physical retry request. The estimator explicitly excludes retry traffic.

## Verification (2026-09-16)

- Fresh authenticated `npm ci` succeeds; npm audit reports zero vulnerabilities.
- `npm run check`: TypeScript, 59 tests in 10 files, and production build pass.
- A ten-result Queue consumer with ten failing monitors executes 40 D1 statements in the SQLite-backed harness.
- Desktop 1440×1000 and mobile 390×844 browser verification covers navigation, history on demand, unsaved-change confirmation, discarded region routing edits, expired authentication with draft recovery, malformed-summary resilience, terminal budget errors, polling error/recheck, and successful creation followed by failed refresh. Error paths use intercepted test responses, not production faults.
- CSS: 430.01 KB / 42.97 KB gzip before Pro integration and selective imports; 159.26 KB / 21.32 KB gzip after. Pro navigation increases JavaScript from 437.87 KB / 133.89 KB gzip to about 711.53 KB / 218.66 KB gzip. Further JavaScript splitting remains a follow-up; no claim of reduced JS size.
- Wrangler dry-run succeeds. Remote D1 export completed before migration; the export is stored in ignored `output/backups/` with restricted permissions.
- Remote migration `0007_result_evidence.sql` applied successfully. Control Worker version `bfa5b8f2-36b3-4c0c-a18a-5677228b4a29` serves the release at `https://monstertracker-control.genedai.workers.dev/`. The runtime reports a ten-result Queue batch.
- Both production JavaScript and CSS were downloaded over HTTPS and matched the local build byte for byte.
- Live example.com sample `manual_ebcfa650772a4ceeb8895ca87d7c88c4`: 24 planned, 24 dispatched, 24 successful observations stored, zero pending, zero infrastructure errors. Existing probe Workers remain compatible.
- This machine's default workers.dev connection failed during verification. HTTPS using the public DNS-resolved address succeeded; verification does not assert the local DNS/proxy issue is fixed.

## Remaining boundaries

Placement Hints do not guarantee a city/PoP. Queue protects result persistence but there is no automatic DLQ replay UI. D1 metered writes include indexes and operational work beyond application counters. Pro frontend dependencies require their own license. No alert-delivery service or external monitoring supplier is introduced.
