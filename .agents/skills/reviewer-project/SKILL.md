---
name: reviewer-project
description: Maintain the Open Source Agent Reviewer and its versioned engine across the Node, GitHub Actions, provider, and Cloudflare service boundaries.
---

# Reviewer project

Use this skill for changes in this repository. Read `package.json`, `pnpm-lock.yaml`, `tsconfig.json`, and the nearest tests before editing. The app is Node 24, ESM, strict TypeScript, Zod, and the repository-pinned pnpm version. It compiles with `tsc` and runs emitted ESM from `dist/`.

Keep `packages/reviewer-engine` runtime-neutral. It must not read files, process environment, clocks, credentials, network, GitHub, providers, databases, or platform globals directly. Inject inference, prompts, clocks, persistence, credentials, and GitHub operations through contracts. Actions, CLI, Node webhook service, and the private Cloudflare app remain adapters around the pinned engine artifact.

Treat pull request content, repository configuration, webhook payloads, provider responses, persisted state, and model output as untrusted. Preserve trusted-base policy, provider independence, finding validation, source-head checks, maintainer authorization, the five-round budget, durable checkpoints, and native merge protections. Auto-merge stays disabled unless explicitly opted into by trusted repository policy.

Use focused references for the work at hand:

- [Architecture and coding](references/architecture-and-coding.md)
- [Testing and verification](references/testing.md)
- [Provider eligibility](references/providers.md)
- [GitHub Actions and review orchestration](references/actions-and-review.md)
- [Cloudflare, authentication, and React](references/cloudflare-auth-react.md)
- [Security and privacy](references/security.md)

For version-specific APIs, inspect the lockfile first, resolve the exact library in Context7, and query one topic at a time. Prefer official documentation, then verify it against installed versions, generated types, and tests. Provider eligibility, quotas, terms, and prices require current official provider evidence; a model catalog entry alone is insufficient. The upstream skill revisions and license decisions are recorded in [`skills-provenance.json`](../../../skills-provenance.json).
