---
"@aryasaatvik/stack": minor
---

Replays now run in an isolated ephemeral worktree when no worktree owns the branch: the tool creates a detached `git worktree add`, cherry-picks there, moves the branch ref to the new tip, and removes the workbench on success, conflict, or defect. The primary checkout's HEAD and working tree are never used as a workbench. The repo-wide clean-checkout requirement is gone — an unrelated dirty primary checkout no longer blocks `sync --apply`, `merge`, or `undo`. Only worktrees that own a branch being repaired must be clean. A stale worktree-ownership snapshot that triggers `already used by worktree` now invalidates and retries the replay once.
