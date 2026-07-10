---
"@aryasaatvik/stack": minor
---

`stack sync <branch>` now scopes to the branch's **subtree** — the named branch plus its descendants — instead of the whole connected stack. This is a breaking change to scope semantics: a lower-branch fix restacks only that branch's subtree, so sibling subtrees never move and are never even read (no merge-base or worktree inspection, and a dirty out-of-scope worktree no longer blocks the run). Ancestors are read-only rebase targets: each in-scope branch rebases onto its parent's current tip as-is, with no trunk-chase of ancestors. Name the stack root (`sync <root>`) or use `sync --all` to freshen the whole stack, including trunk-chase. Bare `sync` scopes to the current branch's subtree; off-stack single-stack auto-scope resolves to that stack's root. Branch mutations stay within the subtree, but the read-only stack-block body refresh may span the whole stack so sibling and ancestor request widgets keep correct topology.
