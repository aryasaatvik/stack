---
"@aryasaatvik/stack": minor
---

`stack sync` no longer silently rebases and force-pushes every stack when run off-stack. Off-stack (trunk checkout or detached HEAD) it now auto-scopes when exactly one stack exists, no-ops when none exist, and otherwise errors listing the stack roots so you can pick one with `sync <branch>` or opt into repo-wide sync with the new `sync --all`. `--continue-on-failure` now requires `--all`. Scope is resolved from a cheap membership graph (stored links plus open request bases, a request base winning over a stored parent) before any merge-base work, so scoped syncs never reconcile out-of-scope stacks; repo-wide stale-link cleanup and inference now happen only under `--all`.
