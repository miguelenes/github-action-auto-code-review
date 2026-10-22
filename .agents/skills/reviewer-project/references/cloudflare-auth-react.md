# Cloudflare, authentication, and React

The hosted adapter is maintained in the separate private repository `miguelenes/github-action-auto-code-review-cloud`. Keep its customer data, billing configuration, credentials, and operational details private. This public engine repository may document the public integration contract and setup paths, not private customer data.

- Use Astro server-rendered pages by default; add React islands only for interactions that require client-side state. Keep landing-page JavaScript and hydration small.
- Use the project's installed Astro and Cloudflare adapter versions. Validate bindings from generated Wrangler types; do not hide type mismatches with `as unknown as` casts.
- Identify the target account, Worker, environment, and D1/Queue resources before a remote Wrangler operation. Preview and sandbox bindings must be isolated from production data. Never infer isolation from a deployment label.
- Use Wrangler secrets for credentials. Secret operations create deployed versions; stage or deploy only to the explicitly selected non-production target.
- Better Auth owns the GitHub login/session flow; GitHub App installation remains a separate permission and ownership flow. Keep CSRF/origin checks, secure HTTP-only cookies, database-backed sessions/rate limits, and account deletion semantics enabled.
- React controls must keep semantic HTML, keyboard operation, focus visibility, accessible labels/errors, and responsive layouts. Test the rendered desktop and narrow mobile layout in a real browser when changing site behavior.
- Consult Context7 for the installed Astro, React, Better Auth, and Cloudflare APIs. The source revisions are recorded in `skills-provenance.json`; upstream text is not copied into this project reference.
