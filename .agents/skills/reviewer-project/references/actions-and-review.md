# GitHub Actions and review orchestration

- Give each workflow job only the permissions it needs and pin third-party actions to full commit SHAs. Keep app and provider credentials away from untrusted PR code and model agents.
- Verify GitHub webhook signatures over the raw body before parsing. Persist accepted event work before acknowledging it; treat delivery redelivery as normal and idempotent.
- Review evidence is bound to an immutable pull request head SHA. The five-round limit spans retries, bot commits, remediation PRs, and verification.
- Trusted repository policy comes from the trusted PR base. Fork remediation requires the exact maintainer command and a GitHub permission check; its bot PR shares the source PR journal and budget.
- Run validation in isolated jobs without app or provider secrets. Limit generated patches to authorized paths and trusted commands.
- Unresolved findings, incomplete evidence, failed checks, stale source heads, or exhausted rounds require human handling. Auto-merge remains subject to native repository protections.
