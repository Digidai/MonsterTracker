# Research Notes

## Cloudflare Constraints

- Workers run at Cloudflare edge locations, but normal Workers cannot select an arbitrary outbound probe city.
- Cron Triggers do not provide deterministic region selection.
- Placement Hints are the available Worker-native mechanism for steering execution near a named cloud region.
- Free accounts have enough daily request capacity for low-frequency self-hosted monitoring, but Worker count and Cron count become design constraints.
- Workers allow at most six simultaneous outgoing connections per invocation, so both target probes and control-to-probe dispatch use bounded concurrency of six.
- Workers Free currently allows 50 subrequests per invocation; core placement stays below this at 24 regions, while a larger pack needs Workers Paid or sharded dispatch.
- Queues provide at-least-once delivery and do not guarantee ordering. Raw result ids therefore act as idempotency keys, and latest-state writes compare timestamps before updating.
- D1 Free permits 50 queries per Worker invocation. Result Queue messages therefore use a five-result safety batch, leaving room for usage and incident queries.
- Worker-to-Worker calls should use Service Bindings when the probe fleet is static. URL dispatch remains configurable for this open-source deployment, with `global_fetch_strictly_public` and authenticated internal requests.

Current primary references:

- [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
- [Queues delivery guarantees](https://developers.cloudflare.com/queues/reference/delivery-guarantees/)
- [D1 limits](https://developers.cloudflare.com/d1/platform/limits/)
- [Queues dead-letter queues](https://developers.cloudflare.com/queues/configuration/dead-letter-queues/)
- [Workers Placement](https://developers.cloudflare.com/workers/configuration/placement/)

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
