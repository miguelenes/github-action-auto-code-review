# Architecture and coding

- Keep deterministic review domain logic separate from application orchestration, provider and GitHub integrations, and CLI, Actions, Node-server, or Cloudflare adapters.
- Use strict TypeScript and Zod at untrusted input boundaries. Parse into canonical domain types once; prefer narrowing and explicit state transitions over unchecked casts and optional-field bags.
- Keep Node 24 ESM and the pinned pnpm version. The project compiles through `tsc`; do not switch to type stripping or add `.ts` import suffixes without intentionally changing the package contract.
- Keep the engine package dependency-light and runtime-neutral. Pin cloud consumers to an immutable GitHub Release artifact with its SHA-256 and lockfile integrity recorded.
- Follow existing formatting, naming, exports, and error conventions. Add a dependency only when an existing runtime capability cannot satisfy the requirement.
- Read version-matched Context7 or official documentation before changing a platform API; confirm behavior in the current adapter and tests.
