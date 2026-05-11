# stack agent notes

## Intent

- `stack` is a small, local-first CLI for stacked PR repair in squash-merge repos.
- Use the latest Effect v4 beta / effect-smol APIs throughout this project.
- Normal editing and commits stay plain git.
- Stack commands are only for stack intent and repair.

## Safety rules

- `stack sync` must default to dry-run.
- History-rewriting commands need an explicit mutating mode: `--apply`, or `merge --auto` for GitHub auto-merge plus descendant repair.
- Never mutate trunk branches like `dev`, `main`, or `master`.
- Before rebasing a branch, create a local backup branch.
- `stack undo` should restore the last applied mutation from the saved journal.

## Current commands

- `status` shows the local tracked stack without calling GitHub.
- `guide` prints the opinionated happy path for agents and humans.
- `track` records parentage for an existing branch only when PR bases do not already encode the stack.
- `sync --dry-run` previews GitHub PR-base inference, stale metadata cleanup, and repairs without mutating branches, PRs, or stack metadata.
- `sync` runs the common safe workflow: remove stale local links, infer clear PR-base stack links, repair branches, retarget PRs, and refresh links.
- `sync` should not auto-track standalone trunk-root PRs; infer a trunk-root PR only when another open PR is based on it.
- `merge` merges the oldest branch in a stack and immediately repairs descendants; when no branch is given, it infers the root from the current branch. It retargets immediate child PRs before merge to preserve open PRs in auto-delete repos.
- `merge --auto` retargets immediate child PRs, enables GitHub auto-merge, waits for merge, then repairs descendants.
- `repair` repairs missing parents, rebases descendants, and repairs PR bases from existing local stack metadata.
- `history` explains the most recent applied sync from the undo journal.
- `undo` restores the last applied sync.

## Implementation notes

- Persist stack metadata in `.git/stack/state.json`.
- Persist undo state in `.git/stack/undo.json`.
- Prefer `Context.Service`-based Effect services and test-first changes.
- Use OpenCode-style service modules for deep seams: export `Interface`, `Service`, and adapters like `layer`, `live`, or `memory`, then import them as namespaces.
- Keep local Git behavior behind `Git` and pull-request behavior behind `GitHub`; stack orchestration should depend on both services rather than shelling out to `gh` directly.
- Check the local Effect source tree when available before changing Effect APIs or versions.
- Prefer `effect/Path`, `effect/FileSystem`, and `effect/unstable/process` instead of Node/Bun built-ins in app code.
- Keep logic literal and debuggable over clever abstractions.

## Verification

- Run `bun run typecheck`.
- Run `bun run test`.
- When changing CLI docs or behavior, spot-check `bun src/cli.ts --help` and relevant subcommand help.
