# Research Notes

## Cloudflare Constraints

- Workers run at Cloudflare edge locations, but normal Workers cannot select an arbitrary outbound probe city.
- Cron Triggers do not provide deterministic region selection.
- Placement Hints are the available Worker-native mechanism for steering execution near a named cloud region.
- Free accounts have enough daily request capacity for low-frequency self-hosted monitoring, but Worker count and Cron count become design constraints.

## edgetunnel Patterns Reused

edgetunnel is useful as a Cloudflare Worker adoption reference, not as monitoring logic.

Reusable patterns:

- Self-hosted single Worker experience.
- Config through environment variables.
- First-run state initialization.
- Admin panel served by Worker.
- Edge metadata recording from `request.cf`.
- Async persistence/logging with `ctx.waitUntil()`.

Patterns intentionally not reused:

- Tunneling/proxy protocol implementation.
- SOCKS/HTTP proxy routing.
- Subscription generation.
- Large mutable globals for request-scoped behavior.
