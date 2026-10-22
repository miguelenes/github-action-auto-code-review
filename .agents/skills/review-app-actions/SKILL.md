---
name: review-app-actions
description: Design and review this project's GitHub Actions workflows and secure GitHub App event handling.
---
Use least-privilege job permissions, pin third-party actions to full commit SHAs, verify webhook signatures, and keep credentials away from untrusted pull request code and model agents. Never interpolate contributor-controlled fields into shell scripts. The `/review-app remediate` `issue_comment` path must compare the exact command, authenticate the actor's repository permission through GitHub, and load policy from the trusted PR base. Bot remediation PRs stay draft until their original-round journal mapping is durable; then ready events are skipped through that mapping. Run repository validation without app/provider write credentials. Review `vendor/skills/github-actions-hardening/` for detailed threat patterns.
