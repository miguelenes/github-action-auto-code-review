# Open Source Agent Reviewer

An early-stage GitHub pull request review app. It runs independent reviewer and challenger passes over a bounded diff, anchors confirmed findings to added lines, and posts inline `REQUEST_CHANGES` reviews. For same-repository pull requests, it can generate bounded file edits, commit them through GitHub's Git API, dispatch an isolated validation workflow, and ask a verifier model to confirm the fixes. Hosted review intake uses signed webhooks, SQLite queueing, and a shared source-free GitHub round journal.

## Status and limits

This is an alpha. OpenRouter is the only inference adapter; the other seven providers currently support catalog discovery only. Inference requires at least three catalog-listed zero-priced models. Fix validation only supports configured commands in the trusted base policy, runs them in a disposable GitHub-hosted job with no app/provider secrets, and currently assumes a Node/pnpm toolchain. Fork PRs are reviewed but not patched automatically. Auto-merge is opt-in and uses GitHub's native merge protections; unresolved findings, failed validation, incomplete coverage, or an exhausted five-round budget require human handling. Do not treat an empty model result as proof that a change is safe.

## Development

Requires Node.js 24 and the project-pinned pnpm 12.14.0.

    pnpm install
    pnpm build
    pnpm test
    pnpm dev check

## Commands

- `check` reports runtime and provider identifiers.
- `discover` queries configured provider catalogs and shows models only when both catalog prices are zero.
- `review --repo OWNER/NAME --pr NUMBER` runs review, then applies and validates eligible same-repository fixes under trusted base policy. It needs a GitHub token with contents, pull requests, issues, and Actions write access plus `OPENROUTER_API_KEY`.
- `serve` listens for signed GitHub pull request webhooks at `/webhook`; `/healthz` and `/readyz` expose process health.

Create `review-app.yml` from [the example](review-app.example.yml). The configuration is read from the trusted base commit. `autoMerge` defaults to false and is requested only after review, fix verification, and isolated validation succeed; repository rules and required checks remain authoritative.

Project skills live in `.agents/skills/`; portable role prompts live in `runtime/skills/`. See [setup](docs/setup.md), the [MIT license](LICENSE), and [third-party notices](THIRD_PARTY_NOTICES.md).
