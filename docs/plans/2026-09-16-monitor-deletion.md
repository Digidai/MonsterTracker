# Monitor deletion

## Behavior

Select a monitor in Monitors, open its **Settings** tab and choose **Delete monitor** at the bottom, separated from the configuration form. A HeroUI AlertDialog names the target, explains retained history and in-flight checks, and offers Cancel before the destructive action. Cancel preserves drafts. Success clears selection, history and visible incidents; failure keeps the confirmation open with a retryable error. Expired authorization prompts for a token before retrying.

## Data and concurrency

`DELETE /api/monitors/:id` requires admin authorization and is idempotent. A single D1 transaction marks `deleted_at`, disables the monitor, advances its configuration version, clears latest evidence, and closes incidents with an administrative reason. Unknown IDs return 404. Deleted monitors cannot be read, edited, sampled or scheduled through the public control API.

The monitor row remains as a tombstone for delayed Queue messages and historical foreign keys. Raw probe history, usage totals and existing archives are not erased by deletion and keep their existing retention behavior. This is removal from monitoring, not a data-erasure endpoint. There is no restore feature; Pause remains the reversible alternative.

Recovered runs check their stored jobs against the current monitor list. Deleted jobs are recorded as cancellations on the run, without a synthetic probe result or outbound request. Original job identities remain stable, so delayed real evidence can still be recorded and replace a cancellation in run-status counts. Other jobs still complete, and reserved usage is not refunded. After recovery, the next schedule is rebuilt from current monitors before reservation. Work already in flight at deletion can finish but cannot recreate latest evidence or incidents. Concurrent edits cannot re-enable tombstones.

## Verification

SQLite-backed integration checks cover authorization, idempotency, retained history, late Queue results, concurrent edits, run recovery and stable result IDs. Browser checks cover cancel/draft preservation, failure/retry, successful removal even when the next refresh fails, and mobile layout. No existing production monitor is deleted during validation.

- `npm run check`: TypeScript, 70 tests across 11 files, and production build pass. The no-Queue recovery-plus-new-run regression uses 46 D1 statements, below the 50-statement limit. Cancelled jobs are excluded from persistence preflight; a six-job recovery with five deleted monitors plus current work uses 40 statements.
- Browser validation passed at 1440×1000 and 390×844, including 503 deletion failure and 401 reauthentication. The deletion fixture was local and removed after testing; preexisting monitors remain intact.
- Review found and prompted fixes for cancellation IDs replacing delayed real evidence and stale current-minute plans following a long recovery. Both cases now have regression coverage.
- Final independent review found no remaining issues in the fixes and reproduced the 40-statement cancellation case with both runs completed and zero pending results.
- A remote D1 export was saved before migration under ignored `output/backups/` with restricted permissions. No credentials are committed.
- Remote migration `0008_monitor_deletion.sql` applied successfully. Final control Worker version: `88a800df-1486-4463-9fbc-bb4d0a1b7a4c`. The authenticated DELETE route was checked using a nonexistent ID, returning the expected 404 without deleting existing targets. Run status exposes cancellation accounting. Production JavaScript and CSS match the local build byte for byte.
