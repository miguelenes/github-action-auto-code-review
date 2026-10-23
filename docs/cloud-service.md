# Hosted cloud service

The hosted service is a separate, private Cloudflare application. The public repository and `@miguelenes/reviewer-engine` remain MIT-licensed; cloud accounts, subscription records, provider credentials, and hosted evidence are not part of this repository.

## Choose where credentials and evidence live

| Mode                                 | GitHub access                               | Model access                          | Allowance                                                       | Review evidence                               |
| ------------------------------------ | ------------------------------------------- | ------------------------------------- | --------------------------------------------------------------- | --------------------------------------------- |
| Actions, CLI, or self-hosted webhook | Your GitHub credentials                     | Your provider keys and account limits | Your provider quota                                             | In your GitHub account or self-hosted storage |
| Cloud Free                           | GitHub sign-in plus the Reviewer GitHub App | Managed provider pool                 | 10 reviews per UTC month per GitHub owner workspace             | 30 days                                       |
| Cloud Pro                            | GitHub sign-in plus the Reviewer GitHub App | Managed provider pool                 | €19/month before applicable tax; 100 reviews per billing period | 90 days                                       |

The GitHub App installation is separate from GitHub sign-in. Install it on the personal account or organization, then connect the installation from the dashboard. Only a verified personal-account owner or organization admin can connect and manage workspace settings. Select repositories explicitly; connected repositories start disabled.

An installation can connect up to 1,000 repositories. If an organization has more than that, choose a smaller repository selection in the GitHub App installation settings before connecting it.

Workspace allowances are shared across repositories. A source pull-request head uses one review, including delivery retries and any associated fix and verification steps. The existing five-round limit remains. There are no overages or unused-credit rollover. A reservation is released if a job cannot publish a substantive review. GitHub repository rules remain in control of merges; hosted auto-merge is not enabled by default.

Cloud sends diffs and necessary source context to the managed model providers. Provider terms and retention vary; consult the cloud privacy page and current provider records before enabling reviews. Disconnecting the GitHub App removes future access. The dashboard account deletion flow deletes a personal workspace and sign-in data; organization admin access must be transferred and active billing cancelled first. For deletion or billing questions, use the operator contact published by the cloud service.

## Use the open-source tool with your own credentials

The open-source path keeps provider accounts, model selection, and review evidence under your control. Configure GitHub Actions, the CLI, or the signed self-hosted webhook with your own GitHub and model credentials. Follow [Local setup](setup.md); the trusted base configuration controls eligible providers, fixes, and merge behavior. Open-source usage does not consume a cloud allowance or send data through the cloud operator.

## Migration

Self-hosted and Cloud deployments keep separate job and idempotency records. They do not deduplicate reviews across modes, so overlapping triggers can review the same pull-request head twice.

For a self-hosted-to-Cloud cutover:

1. Choose a quiet cutover window and stop new self-hosted triggers for the repositories being moved. Disable every configured Action, webhook, or scheduled invocation that can start a review.
2. Let already-started reviews finish. Check the self-hosted run or job state for each one; do not enable Cloud while a run is still retrying, fixing, or verifying a head. Cancel or resolve stuck work before proceeding.
3. Install and connect the Cloud GitHub App, then enable only the selected repositories in the dashboard. Keep the old self-hosted triggers disabled.
4. Confirm one subsequent pull-request event creates one Cloud job and one published review before expanding the repository selection.

For a Cloud-to-self-hosted cutover, first disable the repositories in the Cloud dashboard and stop or let existing Cloud jobs reach a terminal state. Then disconnect the App if it is no longer needed, configure the self-hosted credentials and trusted base, and enable its triggers. Confirm one subsequent event produces one self-hosted review before restoring other triggers.

Review history, provider credentials, billing allowances, and in-flight jobs are not transferred between modes. Export or retain evidence you need before deleting the Cloud account; account deletion removes hosted evidence according to the published deletion behavior. Do not cut over while a review for the same open pull request is active in either mode.

## Hosted service status

The private cloud project is a prelaunch sandbox. Its queue processor is implemented and deployed, but sign-in, review admission, and paid checkout remain closed until live GitHub OAuth and App configuration, Stripe test-mode lifecycle checks, verified provider accounts and terms, and representative Workers/D1 capacity evidence pass their release gates. Do not send customer repository data to a deployment whose dashboard still reports admission paused.
