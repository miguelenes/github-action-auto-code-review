---
name: review-app-typescript
description: Apply this repository's TypeScript and Node conventions when changing application code, contracts, tests, or package configuration.
---

Use Node 24, ESM, the pinned pnpm version, and the project's strict TypeScript configuration. Read package.json, tsconfig.json, and nearby code before changing a boundary. Run `pnpm check` for application changes.

This app deliberately compiles TypeScript with `tsc` and runs emitted ESM from `dist/`; do not switch it to Node's type-stripping mode or add `.ts` import extensions unless the package/build design is intentionally changed. For server lifecycle changes, consult `vendor/skills/node/rules/graceful-shutdown.md` and `vendor/skills/node/rules/async-patterns.md`; adapt its guidance to the built-in `node:http` server and `node:sqlite` rather than adding framework-specific dependencies by default. On shutdown, stop accepting work, allow active review work to finish or remain recoverable in the durable queue, and close SQLite only after the server has drained.

Treat HTTP, webhook, model, persisted, YAML, and GitHub API payloads as `unknown` until parsed. Use Zod schemas at trust boundaries and derive internal types from the canonical schemas. Prefer narrowing and discriminated state over unchecked casts, non-null assertions, or bags of optional flags. Keep domain logic deterministic and independent of Octokit, HTTP servers, Actions, and model-provider clients.

Use advanced generic or conditional types only when they make an existing public contract materially safer or simpler. Do not add type-level abstractions to mirror straightforward runtime validation. Add tests for meaningful boundary behavior: malformed data, missing fields, stale evidence, duplicate events, and invalid state transitions.

Preserve safety invariants: PR text and model output are untrusted; app credentials stay outside reviewer/fixer prompts and validation jobs; model selection must not imply account eligibility; and paid inference fallback remains disabled. Consult `vendor/skills/typescript-pro/` for focused type guards, discriminated unions, and compiler configuration, and `vendor/skills/typescript-advanced-types/` only when a concrete advanced type-design problem calls for them. These are reference material, not mandates to add branded IDs, tRPC, type-coverage tooling, project references, or elaborate type utilities. Keep runtime schemas authoritative at trust boundaries and builds on the current `pnpm build` / `pnpm check` path.

Use Context7 or current official Node documentation when a change depends on version-specific runtime behavior. Consult the upstream Node skill under `vendor/skills/node/` only for a relevant topic; its generic recommendation to use type stripping does not apply to this compiled project.
