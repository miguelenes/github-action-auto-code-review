# Open Source Agent Reviewer

An early-stage, open-source foundation for a GitHub pull request review and repair app. The repository currently contains typed review/provider contracts, eligibility and round-limit helpers, portable agent role prompts, and vendored workflow/review guidance.

**This is not yet a working GitHub App.** Provider adapters, authenticated GitHub operations, webhook server, durable queue, isolated patch executor, and Actions workflows remain unimplemented. The CLI reports this honestly and does not claim to review or merge pull requests.

## Requirements
- Node.js 24+
- pnpm 10+

## Development
    pnpm install
    pnpm build
    pnpm dev check

Commands for provider discovery, PR review, and hosted serving are placeholders until their integrations are implemented.

## Current behavior
- check: reports supported provider identifiers and runtime version.
- discover: lists provider identifiers; it does not call provider APIs.
- review and serve: exit with a configuration error.
- src/core.ts: model schema, zero-cost model eligibility, five-round guard, and merge-readiness predicate.

The four reviewer role prompts are in runtime/skills/. Vendored upstream skills and their sources are documented in THIRD_PARTY_NOTICES.md.

## License
Original project code is MIT licensed. See LICENSE and THIRD_PARTY_NOTICES.md for upstream material.
