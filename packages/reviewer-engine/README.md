# `@miguelenes/reviewer-engine`

The MIT-licensed, runtime-neutral contracts and review stages used by Open Source Agent Reviewer. Provider credentials, GitHub access, persistence, clocks, role prompts, and publication remain adapters supplied by the host application.

The package has no filesystem or environment access. `independentReview` requires role prompts and an inference callback from its caller. Hosts must continue to enforce trusted-base selection, current-head checks, maintainer authorization, and merge protections around the engine.

```ts
import { independentReview } from '@miguelenes/reviewer-engine';

const result = await independentReview({
	diff,
	models,
	rolePrompts: { reviewer, challenger, fixer, verifier },
	complete: (model, system, prompt) => provider.complete(model, system, prompt),
	clock: { now: () => new Date() },
});
```

Each release is immutable. Cloud deployments should pin the exact released package version.

## Resumable hosts

Queue-backed hosts can resume every model and publication stage with `resumableIndependentReview`, `resumableProposeFixes`, `resumableVerifyFixes`, and `resumablePublishReview`. Supply a durable `ReviewPersistence` implementation, an injected SHA-256 `ReviewDigest`, and a clock. Persist checkpoints encrypted and fence every write by the active job lease; checkpoints can contain findings, source text, and proposed patches. The helpers bind results to the immutable pull request head and fingerprint each stage's inputs, so changed inputs invalidate cached results.

`resumablePublishReview` rechecks the current pull request head before publishing and passes a stable idempotency key to the GitHub adapter. The adapter must upsert by that key because a process can fail after GitHub accepts a publication but before the checkpoint write completes. Hosts remain responsible for lease ownership, trusted-base selection, maintainer authorization, and merge protections.
