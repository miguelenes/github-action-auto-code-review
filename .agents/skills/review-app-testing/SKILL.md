---
name: review-app-testing
description: Add or validate deterministic tests for provider discovery, GitHub events, review rounds, and isolated execution in this repository.
---

# Review App Testing

Use this skill when changing tests or validating behavior in the review application. Read the relevant source and nearby tests first. The project uses Node's built-in test runner, TypeScript compiled by `tsc`, and fixtures injected through function parameters; keep the default test suite deterministic and independent of live providers, GitHub, or external services.

Run `pnpm check` for source or test changes. Tests compile to `dist/` and execute with `node --test dist/*.test.js`; do not introduce a second test framework for a single test case.

Test observable contract behavior at trust and persistence boundaries: malformed and incomplete provider payloads, stale or unknown pricing/quota evidence, webhook signature and authorization outcomes, duplicate/stale events, head-SHA drift, journal conflicts/recovery, path-constrained patches, and exact round-budget termination. Assert both the accepted result and the blocked/terminal result when a boundary is safety-relevant.

Inject fetchers, GitHub clients, clocks, persistence implementations, and executor hooks where the production code already provides seams. Use synthetic credentials only, restore modified environment variables in `finally`, and assert that untrusted payloads never become credentials or executable arguments. Keep fixtures small and representative of official response shapes; malformed fixtures should prove rejection instead of silently normalizing guessed fields.

Avoid tests that merely duplicate an implementation expression or assert wording. Prefer externally meaningful invariants, such as “a stale head causes no write,” “a duplicate delivery consumes no additional round,” and “a request with unknown price is never eligible.”

For workflow YAML syntax/security checks, run the repository's available `actionlint` and inspect trigger permissions and fork trust boundaries. Container smoke checks should use local fixtures and verify health/readiness and graceful shutdown; they do not prove live GitHub installation or deployment readiness.
