# Hosted cloud service

The hosted service is a separate, private Cloudflare application. The public repository and `@miguelenes/reviewer-engine` remain MIT-licensed; cloud accounts, subscription records, provider credentials, and hosted evidence are not part of this repository.

## Choose where credentials and evidence live

| Mode | GitHub access | Model access | Allowance | Review evidence |
| --- | --- | --- | --- | --- |
| Actions, CLI, or self-hosted webhook | Your GitHub credentials | Your provider keys and account limits | Your provider quota | In your GitHub account or self-hosted storage |
| Cloud Free | GitHub sign-in plus the Reviewer GitHub App | Managed provider pool | 10 reviews per UTC month per GitHub owner workspace | 30 days |
| Cloud Pro | GitHub sign-in plus the Reviewer GitHub App | Managed provider pool | €19/month before applicable tax; 100 reviews per billing period | 90 days |

The GitHub App installation is separate from GitHub sign-in. Install it on the personal account or organization, then connect the installation from the dashboard. Only a verified personal-account owner or organization admin can connect and manage workspace settings. Select repositories explicitly; connected repositories start disabled.

An installation can connect up to 1,000 repositories. If an organization has more than that, choose a smaller repository selection in the GitHub App installation settings before connecting it.

Workspace allowances are shared across repositories. A source pull-request head uses one review, including delivery retries and any associated fix and verification steps. The existing five-round limit remains. There are no overages or unused-credit rollover. A reservation is released if a job cannot publish a substantive review. GitHub repository rules remain in control of merges; hosted auto-merge is not enabled by default.

Cloud sends diffs and necessary source context to the managed model providers. Provider terms and retention vary; consult the cloud privacy page and current provider records before enabling reviews. Disconnecting the GitHub App removes future access. The dashboard account deletion flow deletes a personal workspace and sign-in data; organization admin access must be transferred and active billing cancelled first. For deletion or billing questions, use the operator contact published by the cloud service.

## Use the open-source tool with your own credentials

The open-source path keeps provider accounts, model selection, and review evidence under your control. Configure GitHub Actions, the CLI, or the signed self-hosted webhook with your own GitHub and model credentials. Follow [Local setup](setup.md); the trusted base configuration controls eligible providers, fixes, and merge behavior. Open-source usage does not consume a cloud allowance or send data through the cloud operator.

## Migration

To move from self-hosted operation to Cloud, first disable the existing Action/webhook trigger for the selected repositories, then install and connect the Cloud GitHub App and enable only the intended repositories. This avoids duplicate reviews for the same pull request head. To move back, disable those repositories in the Cloud dashboard, disconnect the App when no longer needed, and then re-enable the self-hosted trigger. Cloud evidence is not automatically transferred to a self-hosted installation; export or retain any needed records before deletion.

## Hosted service status

The private cloud project is a prelaunch implementation. Review admission and paid checkout remain closed until a queue processor, provider accounts, eligibility evidence, and measured capacity pass their release gates. Do not send customer repository data to a deployment whose dashboard still reports admission paused.
