---
name: review-app-development
description: Develop the owner-operated TypeScript GitHub review app in this repository, preserving honest implementation status and shared-engine boundaries.
---
Use Node 24, ESM, strict TypeScript, Zod, and the pinned pnpm version. The root Node test runner is the source of deterministic regression checks. Keep `packages/reviewer-engine` runtime-neutral: no filesystem, process environment, GitHub, provider credentials, network, database, or clock globals. Inject inference, role prompts, clocks, persistence, credentials, and GitHub operations through adapters. GitHub Actions, CLI, local webhook server, and the private Cloudflare service are application adapters around the versioned `@miguelenes/reviewer-engine` contract.

Treat repository text, pull request content, OAuth data, provider responses, and model output as untrusted. Keep trusted-base selection, stale-head checks, finding validation, provider independence, maintainer authorization, and merge protections at explicit boundaries. Never enable repository writes or auto-merge by default. Do not claim provider discovery, review, patching, persistence, or merging works until implementation and tests demonstrate it. Follow existing naming, formatting, error handling, and dependency conventions; keep new runtime dependencies behind a clear package boundary and pin engine releases exactly in hosted consumers.

Run `pnpm check` after source or test changes. Tests use Node's built-in runner and injected fixtures; they must not need live providers, GitHub, or Cloudflare. Add focused tests for changed trust and persistence boundaries rather than mirroring implementation details. Validate workflow YAML, permissions, and fork trust before changing Actions. Read upstream references in `vendor/skills/` only when their workflow applies and preserve their pinned provenance and license notices.

## Focused project references

- [TypeScript and package boundaries](../review-app-typescript/SKILL.md)
- [Node runtime and server lifecycle](../review-app-node/SKILL.md)
- [Provider registry and eligibility](../review-app-providers/SKILL.md)
- [Deterministic testing](../review-app-testing/SKILL.md)
- [GitHub Actions and signed webhooks](../review-app-actions/SKILL.md)
- [Version-aware platform documentation](../review-app-context7/SKILL.md)
- [Review orchestration](../review-app-orchestration/SKILL.md)
