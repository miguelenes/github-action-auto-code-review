# Local setup

The app is not ready for unattended merging. It posts inline REQUEST_CHANGES reviews for findings confirmed by the reviewer and challenger. No code changes or auto-merge are performed.

## Local review

1. Create an OpenRouter key and set OPENROUTER_API_KEY.
2. Set GH_TOKEN to a repository-scoped token with pull request read and issue comment write access.
3. Run pnpm install && pnpm build.
4. Run pnpm dev review --repo OWNER/NAME --pr NUMBER.

Review sends the pull request diff to the chosen model provider. Inspect provider terms and repository data policies before use.

## Hosted webhook intake

Create a GitHub App with Contents: read/write, Pull requests: read/write, and Issues: write permissions; subscribe to pull_request. Install the app, then supply GITHUB_APP_ID, GITHUB_INSTALLATION_ID, GITHUB_PRIVATE_KEY, GITHUB_WEBHOOK_SECRET, and OPENROUTER_API_KEY. Set STATE_DB to a persistent local path. Expose POST /webhook over HTTPS and configure that URL in the app. The handler verifies the HMAC signature, deduplicates repository/PR/head SHA events, and enqueues reviews. The app-managed agent-review-state branch stores only PR number, head SHA, round number, status, and timestamp; CLI and hosted review attempts use it to share the five-round budget. Its first commit contains only journal.json. Protect the SQLite file and private key.

Hosted execution is a single-process queue today. It does not yet support horizontal workers or GitHub-backed shared state. Failed tasks are marked needs-human; no source diff or provider error is persisted.

## GitHub Action

The composite action expects a caller workflow to build this project first and provide repository, pull request number, a token, and an OpenRouter key. Grant contents: write (used only for the app-managed state ref), pull-requests: read, and issues: write permissions. It never checks out or executes contributor code. Pin this repository action to a reviewed commit SHA when consuming it.
