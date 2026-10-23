# Local setup

The alpha can commit fixes for same-repository PRs when automaticFixes is enabled in trusted base configuration. It validates the exact fix commit in a GitHub-hosted workflow with no app/provider secrets, then asks a verifier model to confirm the change. Auto-merge is opt-in; when enabled, the app requests GitHub native auto-merge only after the verified fix and validation pass. GitHub's required reviews, checks, and repository rules still govern the merge.

## Local review

1. Add at least two providers to `providers` in the trusted `review-app.yml` and set their provider-specific keys: `OPENROUTER_API_KEY`, `NVIDIA_API_KEY`, `GROQ_API_KEY`, `GEMINI_API_KEY`, `CEREBRAS_API_KEY`, `MISTRAL_API_KEY`, or `CLOUDFLARE_API_TOKEN` plus `CLOUDFLARE_ACCOUNT_ID`.
2. For OpenRouter, use the exact `:free` variants shown by `pnpm dev discover`. A limited OpenRouter trial can be enabled only by adding an exact-model `verifiedTrialOffers` record to the trusted base configuration after confirming the available credit, expiry, and current terms. The app reads the live inference key's spend limit before selection and again before each trial inference; eligibility requires a positive finite limit no greater than the attested budget, a non-resetting limit, a positive remaining balance, BYOK spending included in the cap, and a key expiry no later than the trial expiry. Requests use the catalog's exact input/output price ceilings and disable provider fallbacks. If any evidence is missing or stale, trial inference is blocked. Direct-provider paid credits remain ineligible because those APIs do not expose an equivalent enforced per-request spend cap. For a direct provider's genuinely free account tier, add one `verifiedFreeOffers` record per exact model only after checking current price, quota behavior, account tier, and terms. The record is an owner attestation that must be refreshed within 24 hours. Do not use a direct-provider credential if its account is on a paid tier. Then run `pnpm dev discover --repo OWNER/NAME` and ensure it shows eligible models from at least two providers. Before any model is selected for a review, the app runs a fixed positive security-defect probe and a correct-code negative probe; only models that identify the anchored defect and return no false finding proceed. This check adds up to two zero-cost inference requests per candidate.
3. Set GH_TOKEN to a repository-scoped token with contents read/write, pull requests read/write, issues write, and Actions write access.
4. Run `pnpm install --frozen-lockfile && pnpm check`.
5. Run `pnpm dev config --file review-app.yml` to validate the local policy, then `pnpm dev review --repo OWNER/NAME --pr NUMBER`.

Review sends the pull request diff to the chosen model provider. Inspect provider terms and repository data policies before use.

Example trusted free-tier record (replace every URL, timestamp, claim, and model id with evidence you actually verified):

```yaml
providers: [openrouter, groq]
verifiedFreeOffers:
  - provider: groq
    modelId: exact-model-id-from-the-provider-catalog
    priceEvidence:
      sourceUrl: https://console.groq.com/docs/pricing
      observedAt: '2026-10-22T10:00:00.000Z'
      claim: This exact model has zero input and output price on the Groq Free tier.
    quotaEvidence:
      sourceUrl: https://console.groq.com/docs/rate-limits
      observedAt: '2026-10-22T10:00:00.000Z'
      description: The verified Free-tier account fails at its quota limit instead of using paid capacity.
      noChargeAfterLimit: true
    accountTierEvidence:
      sourceUrl: https://console.groq.com/docs/billing-faqs
      observedAt: '2026-10-22T10:00:00.000Z'
      claim: I verified the configured API key belongs to a Free-tier account without paid billing enabled.
    termsEvidence:
      sourceUrl: https://console.groq.com/docs/legal/services-agreement
      observedAt: '2026-10-22T10:00:00.000Z'
      claim: I reviewed the current terms and confirmed this use is permitted.
verifiedTrialOffers: []
```

OpenRouter trial credits require an exact model and fresh owner-supplied evidence. Example shape:

```yaml
verifiedTrialOffers:
  - provider: openrouter
    modelId: provider/model-id
    trialCreditBudgetUsd: 10
    trialExpiresAt: '2030-01-01T00:00:00.000Z'
    trialCreditEvidence:
      sourceUrl: https://provider.example/account/trial
      observedAt: '2026-10-22T10:00:00.000Z'
      claim: The review account has $10 of trial credit through the stated expiry.
    termsEvidence:
      sourceUrl: https://openrouter.ai/terms
      observedAt: '2026-10-22T10:00:00.000Z'
      claim: Current terms permit this repository review workload.
```

Use an OpenRouter API key dedicated to this app. Its finite hard cap must not reset and must be at most the attested trial amount. The app only reads key status; it never creates or changes provider keys. If OpenRouter stops returning the fields needed to prove these conditions, the offer is excluded.

The trusted base configuration is an auditable owner attestation; the app cannot independently inspect each provider account's billing tier. Refresh evidence at least daily, and remove an offer immediately if the account tier, price, quota behavior, or terms change. Provider-side API throttling stops requests after free-tier quotas; if that guarantee cannot be verified for an account, leave the model ineligible.

## Hosted webhook intake

Create a GitHub App with Contents: read/write, Pull requests: read/write, Issues: write, and Actions: write permissions; subscribe to pull_request and issue_comment. Install the app, then supply GITHUB_APP_ID, GITHUB_INSTALLATION_ID, GITHUB_PRIVATE_KEY, GITHUB_WEBHOOK_SECRET, and the keys for enabled providers. Set STATE_DB to a persistent local path. Expose POST /webhook over HTTPS and configure that URL in the app. The handler verifies the HMAC signature, deduplicates repository/PR/head SHA events, and enqueues reviews. A repository writer, maintainer, or admin can comment exactly `/review-app remediate` on an open fork PR to resume its latest needs-human round. The app creates a draft bot-owned PR from the validated fork head, records its PR number in the journal, then marks it ready; automated review events for that PR are skipped because it shares the source PR's existing round budget. The app-managed agent-review-state branch stores PR/head/round state, fix commit SHAs, remediation PR IDs, authorization, and lease data; its first commit contains only journal.json. Add review-app.yml to the trusted base branch; hosted deployments require mode: hosted and automaticFixes: true. Protect the SQLite file and private key.

Hosted execution is a single-process SQLite queue today. It does not yet support horizontal workers. The source-free GitHub journal stores PR/head/round state, fix commit SHAs, and a fencing lease; it contains no source diff or provider response. Failed tasks are marked needs-human.

## GitHub Action

The composite action builds itself and expects a caller workflow to provide repository, pull request number, GitHub App ID, installation ID, private key secret, and keys for each enabled provider. It requests a one-hour installation token scoped to that repository. The optional generic `github-token` input is for local/development workflows only.

For the automatic Actions adapter, use [review.yml](../.github/workflows/review.yml). Its `pull_request_target` and `issue_comment` entries run only trusted app source and never check out PR code. Enable it by setting repository variable `REVIEW_APP_ENABLED=true`; configure the App/provider secrets and trusted `review-app.yml` first. A maintainer can authorize fork remediation by commenting exactly `/review-app remediate`; the workflow checks the commenter's repository permission before creating a bot-owned remediation PR. The same workflow is callable by other workflows: pin the reusable workflow to a reviewed full commit SHA, set `enabled: true`, pass the caller PR number and app repository plus immutable app commit SHA, and pass the required App secrets. For repository-specific review settings, `mode` must be `actions`.

The [discovery workflow](../.github/workflows/discover.yml) refreshes provider catalogs daily and can be run manually. It only reads catalogs and trusted repository policy; its installation token has Contents: read permission and it never sends model inference requests. It reports eligible model evidence in the run log. Direct-provider offers still require a current owner attestation in `review-app.yml`.

Copy the companion validate-review.yml workflow into the target repository default branch before enabling automatic fixes. Grant the GitHub App Contents: write (used only for the app-managed state ref and same-repository fix commits), Pull requests: write, Issues: write, and Actions: write (to dispatch the trusted validation workflow). The validation workflow runs commands from trusted base configuration against the PR SHA with no app/provider secrets and a read-only GitHub token. It checks out the PR SHA into an isolated workspace and checks out trusted validation policy at the exact base SHA. The job receives no app or provider secrets; never add secret references to that workflow. Pin this repository's reusable workflow to a reviewed commit SHA when consuming it.
