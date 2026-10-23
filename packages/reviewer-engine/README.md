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
