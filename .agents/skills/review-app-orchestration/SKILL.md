---
name: review-app-orchestration
description: Coordinate evidence-based reviewer, challenger, fixer, and verifier roles for this project's pull request review workflow.
---
Use the portable role prompts in runtime/skills/. Keep review evidence bound to an immutable pull request head SHA. Count one complete review/challenge/fix/verification cycle as a round; persist the five-round limit across retries, bot commits, and bot-owned fork-remediation PRs. A maintainer must authorize fork remediation through the exact comment command and repository permission check; the bot PR must share the source PR journal budget. Incomplete evidence, unresolved validated findings, failed checks, or exhausted rounds block readiness. Enable GitHub auto-merge only when all findings are resolved and repository rules pass.
