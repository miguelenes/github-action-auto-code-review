---
name: review-app-node
description: Apply this project's Node 24 server, queue, and shutdown conventions when changing hosted webhook execution or process lifecycle behavior.
---

Use this skill for `src/server.ts`, hosted queueing, process lifecycle, SQLite use, or Node runtime behavior. Read the current server implementation and the Node-specific project guidance in `review-app-typescript` before changing those boundaries. For version-sensitive runtime APIs, follow `review-app-context7`.

The service runs on Node 24 using built-in `node:http` and `node:sqlite`. Keep webhook intake bounded: verify the raw-body GitHub signature before parsing, reject oversized bodies, persist eligible events before acknowledging them, and treat redelivery as normal. Queue state is durable because process memory is lost on restart; recover interrupted jobs without spending another review round or accepting stale heads.

Preserve the distinction between liveness and readiness. `/healthz` reports process health; `/readyz` must fail when storage is unavailable, startup recovery fails, or shutdown begins. On SIGINT/SIGTERM, stop accepting requests, drain active work, then close SQLite. A process restart must leave pending work recoverable. Keep provider and GitHub credentials out of PR content and model prompts.

This repository intentionally compiles TypeScript with `tsc` and runs ESM from `dist/`. Do not follow the upstream Node skill's generic type-stripping setup unless the package and build design are intentionally changed. Consult `vendor/skills/node/rules/` only for relevant async, error-handling, graceful-shutdown, or test lifecycle guidance; do not add dependencies merely to match an upstream example.

For runtime changes, run `pnpm check`, validate workflows when affected, and smoke-test the container's health endpoints and clean termination when changing server lifecycle behavior.
