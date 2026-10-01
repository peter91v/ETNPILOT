# Releasing

There is no automated release yet; this is the manual process, so a release is the same every time.

1. `main` is green: `npm run check` and `npm run test:ui` locally, CI green on `main`.
2. Move the `[Unreleased]` entries in `CHANGELOG.md` under a heading `## [x.y.z] — date`. Pre-1.0, a breaking
   change raises the minor number.
3. Set `version` in `package.json` to the same number (`npm version --no-git-tag-version x.y.z`).
4. Commit as `Release x.y.z`, merge through a pull request like any other change.
5. Tag the merge commit: `git tag -s vx.y.z -m "x.y.z"` (a signed tag if you have a key) and push the tag.
6. If receipts are signed with a project key, nothing changes; a release does not touch keys.
7. Run `etnpilot smoke` against the providers you use before announcing it (`.github/workflows/live.yml` does it
   from the Actions tab with your keys as secrets).

`package.json` has `"private": true`, so nothing is published to npm. Remove it only when that is intended, and
publish with provenance (`npm publish --provenance`) from CI.
