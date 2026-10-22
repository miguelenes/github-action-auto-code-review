---
name: review-app-orchestration
description: Coordinate evidence-based reviewer, challenger, fixer, and verifier roles for this project's pull request review workflow.
---
Use the portable role prompts in runtime/skills/. Keep review evidence bound to an immutable pull request head SHA. Count one complete review/challenge/fix/verification cycle as a round; persist the five-round limit across retries and commits. Incomplete evidence, unresolved validated findings, failed checks, or exhausted rounds block readiness. Enable GitHub auto-merge only when all findings are resolved and repository rules pass.
