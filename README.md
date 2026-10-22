# Open Source Agent Reviewer

An early-stage GitHub pull request review app. It runs independent reviewer and challenger passes over a bounded diff, anchors confirmed findings to added lines, and posts inline `REQUEST_CHANGES` reviews. For same-repository pull requests, it can generate bounded file edits, commit them through GitHub's Git API, dispatch an isolated validation workflow, and ask a verifier model to confirm the fixes. Hosted review intake uses signed webhooks, SQLite queueing, and a shared source-free GitHub round journal.

## Status and limits

This is an alpha. Provider-specific inference transports are implemented for OpenRouter, NVIDIA, Groq, Gemini, Cerebras, Mistral, and Cloudflare; GitHub Models was retired on 2026-07-30 and is unavailable. A review needs three fresh, eligible chat models across at least two enabled providers, enough context for the diff, verified cost eligibility, and quota or spend-cap evidence that prevents silent paid fallback. Before selection, the app probes up to six candidates with a fixed positive security case and a correct negative case; malformed, throttled, or inaccurate candidates are excluded. OpenRouter free variants are capped at zero with provider failover disabled. A trial-credit model is eligible only with fresh owner evidence and a dedicated OpenRouter key whose live finite non-resetting cap, BYOK inclusion, balance, and expiry fit within the attested credit budget; every trial inference rechecks that cap and uses the model's catalog price ceilings with fallback disabled. Direct-provider models require a current owner attestation for the exact model, free account tier, quota behavior, and terms; direct-provider paid credits remain excluded without an equivalent enforced spend cap. Missing catalog prices remain unknown; a model listing does not prove account eligibility. Cloudflare's included daily allocation can incur charges beyond its limit, and NVIDIA API Catalog trials are limited to evaluation unless separate production rights are verified. Fix validation only supports configured commands in the trusted base policy, runs in a disposable GitHub-hosted job with no app/provider secrets, and currently assumes a Node/pnpm toolchain. Fork PRs receive review automatically; an authorized maintainer can issue `/review-app remediate` to create a bot-owned remediation PR under the source PR's five-round budget. Auto-merge is opt-in and uses GitHub's native merge protections; unresolved reviewer/challenger disagreements, unresolved findings, failed validation, incomplete coverage, or an exhausted five-round budget require human handling. Do not treat an empty model result as proof that a change is safe.

## Development

Requires Node.js 24 and the project-pinned pnpm 12.14.0.

    pnpm install --frozen-lockfile
    pnpm build
    pnpm test
    pnpm dev check

## Commands

- `check` reports runtime and provider identifiers.
- `config [--file PATH]` validates local YAML policy and summarizes its execution mode, enabled providers, verified offers, and write/merge settings.
- `discover` queries provider catalogs and shows only fresh, eligible models. Add `--repo OWNER/NAME` to apply the repository's owner-verified free-tier or OpenRouter trial-credit evidence from its trusted default branch. Each provider result includes an availability status; unauthenticated or retired providers are not reported as free.
- `review --repo OWNER/NAME --pr NUMBER` runs review, then applies and validates eligible same-repository fixes under trusted base policy. It needs a GitHub token with contents, pull requests, issues, and Actions write access, plus API keys for at least two enabled providers that have eligible models.
- In Actions mode, an exact `/review-app remediate` PR comment runs the `remediate` command after repository permission verification. In hosted mode, the signed webhook handles the same command and resumes the source PR's current `needs-human` round before creating a bot-owned remediation PR.
- `serve` listens for signed GitHub pull request webhooks at `/webhook`; `/healthz` and `/readyz` expose process health.

Create `review-app.yml` from [the example](review-app.example.yml). The configuration is read from the trusted base commit. Direct-provider models require a fresh `verifiedFreeOffers` entry for that exact catalog model, including zero-price evidence, quota behavior, the account's free tier, and terms. `verifiedTrialOffers` supports OpenRouter only and requires a live finite spend cap within the attested budget; see [setup](docs/setup.md). OpenRouter requests always disable provider fallback. `autoMerge` defaults to false and is requested only after review, fix verification, and isolated validation succeed; repository rules and required checks remain authoritative.

The consolidated project skill lives at `.agents/skills/reviewer-project/SKILL.md`, with focused references for architecture, tests, providers, GitHub Actions, Cloudflare, authentication, React, and security. Portable role prompts live in `runtime/skills/`. Upstream skill revisions, checksums, and license decisions are recorded in `skills-provenance.json`. See [setup](docs/setup.md), the [MIT license](LICENSE), and [third-party notices](THIRD_PARTY_NOTICES.md).

The separate hosted service is documented in [Cloud service and migration](docs/cloud-service.md). Hosted signup, review admission, and paid plans remain capacity-gated during prelaunch; the open-source Actions, CLI, and self-hosted modes continue to use your own credentials.
