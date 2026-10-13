# Releasing

The machinery is @rig-c/parts' (its `RELEASING.md` is the long version, with
the measurements behind each step); this file says what is the same and what
differs here.

## The loop

Every push to `main` runs [`release.yml`](.github/workflows/release.yml), which
hands the new commits to release-please:

- **Nothing releasable since the last tag** → nothing happens. `docs`, `test`,
  `ci`, `build`, `chore`, `refactor` and `style` are hidden and do not open a
  release on their own; `release-please-config.json` writes the whole
  `changelog-sections` list out, with `check` → *Instrument* visible.
- **Something releasable** → it opens or updates a pull request titled
  `release: vX.Y.Z` that bumps `package.json`, `CHANGELOG.md` and
  `.release-please-manifest.json`. `feat` bumps the minor; `fix`, `perf` and
  `check` the patch; a breaking marker bumps the minor while the package is
  pre-1.0. `Release-As: X.Y.Z` in a commit footer forces a version.
- **That pull request is merged** (squash, so the subject stays
  `release: vX.Y.Z`) → release-please tags `vX.Y.Z`, cuts the GitHub release,
  and the same run publishes and confirms.

⚠️ A shipped file can change under a hidden type: the package is the `files`
allowlist plus `package.json`, `README.md` and `LICENSE`. CI's `ships` job
refuses that landing; the remedy is a visible type or a `Release-As:` footer in
a commit message on the branch.

## Cutting a release

1. Land the work on `main` with conventional-commit subjects.
2. Read the `release: vX.Y.Z` pull request's diff — the version and the
   changelog are the review.
3. Approve its `ci` run (a run started by `GITHUB_TOKEN` lands in
   `action_required`): **Approve and run** in the Actions tab, or
   `gh api -X POST repos/rig-c/pose/actions/runs/<id>/approve`.
4. Merge it. That is the cut.
5. Watch the second `release` run: tag, release, publish, then
   `scripts/confirm_registry.sh`, which installs the published version into an
   empty directory and runs `rig-pose --version` (exit 3 = the registry did not
   serve it in time; re-run with Actions → release → Run workflow).

## The first publish, and trusted publishing (owner)

npm trusted publishing is configured on a package's settings page, which does
not exist until the package does. So either the first version goes up by hand
from the tagged tree —

```sh
npm whoami                       # a member of the rig-c organisation on npmjs.com
git checkout v0.1.0
bun install --frozen-lockfile
npm publish                      # runs prepublishOnly, then asks for the OTP
```

— or the owner sets up the trusted publisher first where npm allows it for a
package not yet published. Either way the form, on npmjs.com → `@rig-c/pose` →
Settings → Trusted Publisher → GitHub Actions, reads:

- Organization or user: `rig-c`
- Repository: `pose`
- Workflow filename: `release.yml`
- Environment name: *blank*

Then Settings → Publishing access → *Require two-factor authentication and
disallow tokens*. The fields are case-sensitive and not validated on save; a
typo surfaces only as a refused publish.

**One-time GitHub setting (owner):** Settings → Actions → General → Workflow
permissions → tick *Allow GitHub Actions to create and approve pull requests*,
or release-please cannot open the release pull request.
