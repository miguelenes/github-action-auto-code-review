# Testing and verification

- Run `pnpm check` after source, contract, or test changes. It builds TypeScript and runs the built-in Node test suite.
- Keep default tests deterministic and independent of live GitHub, Cloudflare, and model providers. Inject clocks, fetchers, GitHub clients, persistence, and executor hooks at existing seams.
- Test externally meaningful invariants at trust and persistence boundaries: malformed payloads, stale heads, duplicate events, idempotency, checkpoint recovery, quota exhaustion, and invalid state transitions.
- Test both accepted and blocked outcomes where a boundary protects authorization, source integrity, capacity, or merge readiness.
- When changing the hosted Node server, verify liveness and readiness separately, durable recovery, and graceful shutdown. A local container smoke test does not prove remote GitHub or provider readiness.
- When changing GitHub Actions, validate workflow YAML, permissions, fork trust, and pinned third-party action SHAs. Never interpolate contributor-controlled data into shell scripts.
