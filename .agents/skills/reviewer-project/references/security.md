# Security and privacy

- Never commit secrets or expose them in command output, logs, prompts, Actions artifacts, or browser-visible props. Use synthetic credentials in local tests and configure live values through the owning provider's secret manager.
- Keep customer GitHub login scopes separate from GitHub App installation permissions. Bind installations to a workspace only after verifying ownership and granted permissions server-side.
- Authenticate Stripe and GitHub webhooks independently; verify signatures and freshness, deduplicate event IDs, and reconcile reordered deliveries against current provider state.
- Reserve usage atomically before work starts. Consume only after a substantive review is published; release blocked or failed reservations after publication reconciliation.
- Encrypt source-bearing artifacts with versioned keys, bound complete evidence to 1 MiB per review, and enforce the disclosed 30/90-day retention and deletion rules. Do not silently truncate evidence or claim complete review coverage after truncation.
- Exclude source and credentials from logs. Do not claim provider-wide zero retention or no training without verified account and provider terms.
- Keep hosted admissions and checkout closed until authenticated account-backed tests, representative queue/inference capacity, provider eligibility, and billing lifecycle tests pass.
