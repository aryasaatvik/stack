---
"@aryasaatvik/stack": patch
---

Cache the worktree snapshot for the lifetime of a CLI run and bound per-worktree dirty checks to 4 concurrent `git status` processes instead of spawning them unbounded on every call. Deep-stack repairs call `worktrees()` once per branch during replay; replay's checkout dance is net-neutral on the worktree mapping, so the snapshot now stays valid across the whole repair loop and is only invalidated after `switch`, `release`, or `drop`, which actually change it.
