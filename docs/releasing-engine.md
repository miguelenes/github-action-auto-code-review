# Releasing the reviewer engine

The engine is distributed as a versioned tarball attached to a GitHub Release. Build and publish it locally so release creation does not start a hosted Actions runner.

Run the release from the exact reviewed merge commit after its local checks pass:

```sh
git fetch origin main
git checkout --detach origin/main
pnpm install --frozen-lockfile
pnpm check
pnpm --filter @miguelenes/reviewer-engine build
npm pack ./packages/reviewer-engine --pack-destination /tmp
sha256sum /tmp/miguelenes-reviewer-engine-2.0.0.tgz
git tag reviewer-engine-v2.0.0
git push origin reviewer-engine-v2.0.0
gh release create reviewer-engine-v2.0.0 /tmp/miguelenes-reviewer-engine-2.0.0.tgz --verify-tag --title reviewer-engine-v2.0.0 --generate-notes
```

Confirm the remote release tag resolves to the reviewed `main` commit and the release contains exactly the tarball whose SHA-256 was recorded. The private cloud repository must pin the immutable release asset URL, lockfile integrity, and matching SHA-256 in its vendor lock file. Never publish an unmerged branch or replace an existing versioned asset.
