# Local setup

The alpha can commit fixes for same-repository PRs when automaticFixes is enabled in trusted base configuration. It validates the exact fix commit in a GitHub-hosted workflow with no app/provider secrets, then asks a verifier model to confirm the change. Auto-merge is opt-in; when enabled, the app requests GitHub native auto-merge only after the verified fix and validation pass. GitHub's required reviews, checks, and repository rules still govern the merge.

## Local review

1. Create an OpenRouter key and set OPENROUTER_API_KEY.
2. Set GH_TOKEN to a repository-scoped token with contents read/write, pull requests read/write, issues write, and Actions write access.
3. Run pnpm install && pnpm build.
4. Run pnpm dev review --repo OWNER/NAME --pr NUMBER.

Review sends the pull request diff to the chosen model provider. Inspect provider terms and repository data policies before use.

## Hosted webhook intake

Create a GitHub App with Contents: read/write, Pull requests: read/write, Issues: write, and Actions: write permissions; subscribe to pull_request. Install the app, then supply GITHUB_APP_ID, GITHUB_INSTALLATION_ID, GITHUB_PRIVATE_KEY, GITHUB_WEBHOOK_SECRET, and OPENROUTER_API_KEY. Set STATE_DB to a persistent local path. Expose POST /webhook over HTTPS and configure that URL in the app. The handler verifies the HMAC signature, deduplicates repository/PR/head SHA events, and enqueues reviews. The app-managed agent-review-state branch stores only PR number, head SHA, round number, status, and timestamp; CLI and hosted review attempts use it to share the five-round budget. Its first commit contains only journal.json. Add review-app.yml to the trusted base branch; hosted deployments require mode: hosted. Protect the SQLite file and private key.

Hosted execution is a single-process queue today. It does not yet support horizontal workers or GitHub-backed shared state. Failed tasks are marked needs-human; no source diff or provider error is persisted.

## GitHub Action

The composite action builds itself and expects a caller workflow to provide repository, pull request number, a token, and an OpenRouter key. Copy the companion validate-review.yml workflow into the target repository default branch before enabling automatic fixes. Grant contents: write (used only for the app-managed state ref and same-repository fix commits), pull-requests: write, issues: write, and actions: write (to dispatch the trusted validation workflow) permissions. The validation workflow runs commands from trusted base configuration against the PR SHA with no app/provider secrets and a read-only GitHub token. The trusted validation workflow checks out the PR SHA into an isolated workspace and runs validation commands from the trusted base policy. The job receives no app or provider secrets and has contents read only; never add secret references to that workflow. Pin this repository action to a reviewed commit SHA when consuming it.
