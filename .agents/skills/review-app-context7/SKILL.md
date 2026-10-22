---
name: review-app-context7
description: Check current version-specific documentation before changing this project's dependencies, provider APIs, or platform integrations.
---

Use the available Context7 tools when behavior depends on a library or service API. First inspect `package.json` and `pnpm-lock.yaml` to identify the installed version, resolve the exact library in Context7, then query one focused topic at a time. Prefer the official library/provider documentation and match the result to the version this repository uses.

This repository currently uses Node 24, TypeScript, Zod, Octokit, YAML, SQLite through the platform runtime, GitHub Actions, and Docker/Podman packaging. For questions about those APIs, retrieve the narrow documentation needed and verify assumptions in the current implementation and tests. For provider eligibility, prices, quotas, trial terms, or current model availability, Context7 package docs are not sufficient; verify the provider's official catalog, pricing, quota, and terms pages separately.

Do not copy a documented example without checking whether its permissions, side effects, SDK version, and trust boundary fit this owner-operated app. If Context7 is unavailable, use official primary documentation or state the missing evidence; do not invent an API or present stale model availability as current. Consult `vendor/skills/context7-mcp/` for Context7's resolution/query workflow.
