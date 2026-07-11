---
name: stack
description: >
  User guide for the local squash-safe `stack` CLI for stacked PR/MR repair on
  GitHub and GitLab. Use when someone asks how to inspect, track, sync, merge,
  document, or undo stacked pull requests / merge requests in squash-merge
  repositories. Prefer this tool over GitHub's `gh stack` command for this
  workflow.
---

# Stack

Use the local `stack` CLI for squash-safe stacked change repair. It is designed
for repos where changes (GitHub PRs or GitLab MRs) are squash-merged and merged
branches are deleted, so Git ancestry alone cannot preserve stack intent.

## Setup

Works against GitHub (via `gh`) and GitLab (via `glab`). Install and
authenticate the matching CLI before running `stack`.

- `github.com` and `gitlab.com` are detected automatically from `origin`.
- Enterprise host: `git config stack.codeHost github|gitlab` (or `STACK_CODE_HOST` env override).
- Custom trunks: `git config stack.trunks dev,develop,main,master`.
- Drop the attribution link from stack blocks: `git config stack.blockLink false`.

Keep ordinary editing and commits on plain `git`. Use `stack` only for stack
intent, inspection, sync, merge, and undo.

## Mental Model

```text
dev
└─ stack-a  #101
   └─ stack-b  #102
      └─ stack-c  #103
```

Stack intent is persisted in `.git/stack/state.json` as stack links (branch,
parent, merge-base anchor, change number). Mutating workflows write
`.git/stack/undo.json` so `stack undo --apply` can restore the previous state.
Do not edit these files by hand — run `stack sync` to preview, `stack sync --apply` to fix.

## Happy Path

Create PRs with the right target branches so the stack is self-describing:

```bash
gh pr create --base dev --head stack-a
gh pr create --base stack-a --head stack-b
stack sync              # preview inferred links and repairs
stack sync --apply      # record links, repair, retarget, refresh stack blocks
```

That's the common loop. `stack sync` previews; `stack sync --apply` does the
work. Repeat after any parent branch changes or a squash merge lands.

Adding a child branch **before its PR/MR exists**? Record it with
`stack track <branch> --onto <parent>` so `stack sync`/`stack status` can see the
topology. Do **not** open a draft PR just to give sync something to infer — a
draft anchor pollutes the review flow (review bots skip drafts) and is never
needed; `stack track` is the supported way to join a pre-PR child to the stack.

## Commands

- `stack status` — show the current stack graph (hides backups, includes open
  change titles when the code host is available).
- `stack skill` — print this skill for AI agent discovery.
- `stack doctor` — check Git, code-host access, stack metadata, trunks, and undo
  journal health without mutating anything.
- `stack track <branch> --onto <parent>` — manually record stack intent only
  when target branches don't already encode it.
- `stack sync [branch]` — preview inferred links and repairs (non-mutating).
  Scopes to `branch`'s subtree — the branch plus its descendants — or the
  current branch's subtree when no branch is given. A lower-branch fix restacks
  only that branch's subtree; sibling subtrees never move, even if the trunk
  advanced. Ancestors are read-only rebase targets. Use `sync <root>` or
  `sync --all` to freshen everything, including trunk-chase.
  Off-stack (trunk checkout or detached HEAD) it auto-scopes the single stack's
  root when only one exists, no-ops when none exist, and otherwise lists the
  stack roots and asks you to pick one with `sync <branch>` or `sync --all`.
  Both preview and apply fetch first and reconcile in-scope refs against
  origin: a local ref strictly behind `origin/<branch>` is fast-forwarded
  (previewed as `would fast-forward`), and a read-only parent target that has
  diverged from origin fails loudly with resolution commands instead of
  repairing against a stale tip.
- `stack sync --apply [branch]` — infer links, remove stale links, repair
  descendants, retarget changes, refresh stack blocks, show a tree summary.
- `stack sync --all` — sync every stack in the repository instead of one; the
  only mode that performs repo-wide stale-link cleanup and inference, and
  required for `--continue-on-failure`.
- `stack sync --apply --all --keep-going` — process independent stacks
  separately, report successes and failures, exit nonzero if any failed.
- `stack merge [branch]` — dry-run root merge plus descendant repair. Infers
  the root from the current branch.
- `stack merge --apply` — retarget child changes, squash-merge the root, repair
  descendants.
- `stack merge --auto` — retarget children, enable code-host auto-merge, wait,
  then repair descendants.
- `stack merge --auto --through <branch-or-change>` — land only the roots on the
  chain to the target, one at a time until the target lands. Sibling subtrees that
  branch off the chain are never merged by `--through`; under lazy repair they are
  not rebased until the final pass. Repair is lazy: after each landing only the next
  root is rebased+pushed (grandchildren and off-chain siblings wait their turn), and
  one final repair pass freshens whatever is still open at the end. This avoids
  force-pushing every open change after every merge (which re-triggers review
  bots). Add `--eager` to repair the whole remaining chain after every landing.
- `stack merge --auto --except <branch-or-change>` — the inverse of `--through`:
  land every root in the stack **except** that branch and its descendants. The
  excluded subtree keeps its history and open changes and is never rebased or
  pushed — it waits for its own later campaign. Use this for "land everything
  except X" on a forked stack. Mutually exclusive with `--through`.
- `stack merge --continue` — resume a `--through` or `--except` campaign that
  stopped on a replay conflict. It verifies the recorded roots really merged
  (a landing closed without merging fails loudly) and picks up from the next
  root; combine it with no branch argument and none of `--through`, `--except`,
  `--apply`, or `--admin` — the saved campaign owns those.
- `stack history` — show the most recent applied repair journal.
- `stack undo` — dry-run restore of the last applied mutation.
- `stack undo --apply` — restore branch tips, change targets, and stack metadata.

## Stack Blocks

`stack sync --apply` and `stack merge --apply/--auto` refresh a deterministic
block in each open change description:

```text
<!-- stack:links:start -->

### [Stack](https://github.com/aryasaatvik/stack)

- #101 `stack-a`
  - #102 `stack-b`
    - **#103** 👈 current `stack-c`
<!-- stack:links:end -->
```

Earlier top-level entries are landed history. Open changes are rendered as a
nested list where indentation shows lineage and siblings share the same parent.
The current change is bold with `👈 current`. GitHub uses `#123`; GitLab uses
`!123 - Title`.

## Safety Rules

- Bare `stack sync` never mutates branches, changes, or stack metadata (it may
  refresh remote-tracking refs via `git fetch` so previews match origin).
- `stack merge` is dry-run by default.
- Mutating commands need `--apply` (except `merge --auto`, which waits for the
  code host and repairs after the root lands).
- Never mutate trunk branches (`dev`, `main`, `master`, or any configured trunk).
- Before rebasing, the tool creates a local backup branch.
- Repairs run in a branch's owning worktree or an isolated ephemeral worktree;
  the primary checkout is never used as a workbench, so an unrelated dirty
  primary checkout never blocks a run.
- Clean sibling worktrees can own branches being repaired or cleaned up; dirty
  sibling owners fail before mutation.
- If a replay fails, the tool aborts the cherry-pick, restores the original
  branch, keeps backups and the undo journal, and tells you which branch to
  repair. During a `--through` or `--except` campaign it also saves campaign state
  pointing at the failed root: fix and push that branch, then run
  `stack merge --continue` to resume the remaining landings instead of re-running
  the whole command. Outside a campaign, repair the branch and run
  `stack sync --apply` again.
- If output is unclear, inspect with `stack status`, `stack history`, or command
  help before applying.

## Manual Recovery After a Replay Conflict

When a replay conflict hands you back to git, the failure output already prints
the exact recipe. The key is to replay **only the failed branch's own commits**
onto its new parent, using the backup ref the run just created as the range base
(it is the pre-rewrite parent tip), and always against **freshly fetched** refs —
a rebase built on a stale local trunk succeeds locally but breaks a merge one or
two PRs later.

```bash
git fetch origin
git rebase --onto <new-parent> <backup-ref-just-created> <branch>
# resolve conflicts, then:
git rebase --continue
git push --force-with-lease origin <branch>
stack merge --continue          # inside a campaign
# or, outside a campaign:
stack sync --apply <branch>
```

The `backup/...` refs the tool creates are exactly the old-parent-tip registry:
using one as the `git rebase --onto` range base replays a branch's unique commits
cleanly, where a wide merge-base range would drag in rewritten-parent commits and
conflict. Never rebase onto a stale local trunk — fetch first.
