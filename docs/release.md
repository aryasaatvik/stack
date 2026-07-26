# Releasing Stack

Stack uses Tegami for changelogs, versioning, npm publication, Git tags, and GitHub Releases. Releases are run from an attended local session; GitHub Actions only validates pull requests.

## Queue a change

Run `bun run tegami` to create a file under `.tegami/`, or write one directly:

```md
---
packages:
  "@aryasaatvik/stack": patch
---

## Describe the change

Describe the user-visible result.
```

Commit the release note with the implementation it describes.

## Prepare a version pull request

Start from a clean, current `dev` branch with GitHub CLI authentication:

```sh
bun install --frozen-lockfile
GH_TOKEN="$(gh auth token)" bun run version:packages
```

Tegami consumes pending release notes, updates `package.json` and `CHANGELOG.md`, writes `.tegami/publish-lock.yaml`, pushes `tegami/version-packages`, and opens or updates a pull request against `dev`. Review and merge that pull request before publishing. The publish lock is committed with the version changes.

## Publish

From the clean, current merged `dev` branch, authenticate npm interactively if needed, then run:

```sh
npm whoami
GH_TOKEN="$(gh auth token)" bun run release
```

`bun run release` runs formatting, lint, typecheck, tests, and the package smoke check before Tegami publishes through Bun, pushes the `v<version>` tag, and creates the matching GitHub Release.

Verify the result:

```sh
npm view @aryasaatvik/stack version
npm view @aryasaatvik/stack dist-tags --json
gh release view "v$(bun -e 'console.log(require("./package.json").version)')"
```

Do not publish from a dirty worktree or rerun a partially completed release without first checking npm, the Git tag, GitHub Release, and Tegami publish status. This migration does not publish a package, create a version pull request, or change npm state.
