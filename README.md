# Open Source Agent Reviewer

An early-stage, open-source GitHub pull request review app. It currently supports independent reviewer and challenger passes, with evidence-anchored review comments with OpenRouter models whose catalog reports zero input and output price, plus a hosted GitHub App webhook intake path backed by Node 24 SQLite. The composite GitHub Action invokes the same CLI review path.

## Current limitations

This alpha does **not** modify pull request branches, independently verify findings, persist cross-run review rounds, run repository validation, or enable auto-merge. A clean single-model review is not proof that a change is safe. Do not configure auto-merge based on this app's comment. Review/fix orchestration, fork remediation, shared durable state, and the other seven providers remain future work. The provider discovery command reads catalogs; only OpenRouter inference is implemented, and reviews require at least three zero-priced catalog models.

## Development

Requires Node.js 24 and pnpm 10.

    pnpm install
    pnpm build
    pnpm test
    pnpm dev check

## Commands

- check — report runtime and adapter identifiers.
- discover — query configured provider catalogs. Missing credentials and catalog errors are reported per provider. Catalog entries with unknown prices are not considered free.
- review --repo OWNER/NAME --pr NUMBER — review a PR using a verified zero-priced OpenRouter model, then post one summary comment. Needs GH_TOKEN or GitHub App credentials and OPENROUTER_API_KEY.
- serve — listen for signed GitHub pull_request webhooks on /webhook; health endpoints are /healthz and /readyz. Needs GitHub App and webhook settings.

The composite action is defined in action.yml. The hosted service can run with Docker Compose. See docs/setup.md before connecting a GitHub App.

## Skills and license

Project skills live in .agents/skills/ and role prompts in runtime/skills/. Original app code is MIT licensed. Vendored skills retain separate notices in THIRD_PARTY_NOTICES.md.
