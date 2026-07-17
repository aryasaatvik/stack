# stack agent notes

## Intent

- `stack` is a small, local-first CLI for stacked PR/MR repair in squash-merge repos.
- Use the latest Effect v4 beta / effect-smol APIs throughout this project.
- Normal editing and commits stay plain git.
- Stack commands are only for stack inspection, intent, sync, merge, and undo workflows.

## Safety rules

- Bare `stack sync` may refresh remote-tracking refs (`git fetch`) but never mutates branches, requests, or stack metadata, including scoped and keep-going runs.
- Mutating commands need an explicit mode: `--apply`, or `merge --auto` for code-host auto-merge plus descendant repair.
- Never mutate configured trunk branches like `dev`, `main`, or `master`.
- Replays run in the branch's owning worktree, or in an isolated ephemeral worktree when no worktree owns the branch; the primary checkout is never used as a workbench. There is no repo-wide clean-checkout requirement, so an unrelated dirty primary checkout never blocks a run. Only worktrees that own a branch being repaired must be clean.
- Before rebasing a branch, create a local backup branch.
- Before repair mutates Git or a hosted change, save an undo checkpoint. Merge child retargets use a pre-merge recovery journal; after the root lands, descendant repair starts from a post-merge baseline that never retargets children back onto the landed branch.
- `stack undo` should restore the last applied mutation from the saved journal.

## Current commands

- `status` shows the relevant tracked stack, including open change titles when the code host is available.
- `skill` prints the stack skill (full agent instruction set) for AI agent discovery from the installed package.
- `doctor` checks Git, code-host access, stack metadata, trunks, and undo journal health without mutating anything.
- `track` records parentage for an existing branch only when change target branches do not already encode the stack.
- `sync [branch]` previews target-branch inference, stale metadata cleanup, and repairs without mutating branches, requests, or stack metadata using the tree summary output. Both dry-run and `--apply` first fetch and reconcile every in-scope branch and its non-trunk parent rebase targets against `origin/<branch>`, so drift is measured against origin's real tip rather than a stale local ref: a local ref strictly behind origin is fast-forwarded (previewed as `would fast-forward`), while a read-only parent target that has diverged fails loudly (a diverged in-scope branch is left to repair's replay + force-with-lease).
- `sync --apply [branch]` applies the common maintenance workflow: remove stale local links, infer clear target-branch stack links, repair branches, retarget requests, refresh links, and show a concise tree summary. During reconciliation, a link whose recorded change merged outside stack (e.g. squash-merged from the host UI with the head branch left undeleted) is treated as landed: the link is removed with a `merged` reason, children reparent past it onto its merge-time base (chasing chained landings) with their replay anchors preserved, and no replacement change is created for merged work; a recorded change that closed without merging keeps the existing replacement-request behavior. With a branch argument, sync scopes to that branch's subtree (the branch plus its descendants): ancestors are read-only rebase targets, so a lower-branch fix restacks only that subtree and sibling subtrees never move. Name the stack root to freshen the whole stack, including trunk-chase.
- `sync` with no branch scopes to the current branch's subtree when the current branch is stack-relevant. Off-stack (trunk checkout or detached HEAD) it auto-scopes to the single stack's root when exactly one stack exists, no-ops when none exist, and otherwise errors listing the stack roots and hinting `sync <branch>` or `sync --all`. Scope is resolved from a cheap membership graph (stored links plus open request bases, a request base winning over a stored parent) before any merge-base work, so scoped syncs never run stale-link cleanup, inference, or reads over out-of-scope branches (parent-ref reconciliation likewise stays within the subtree and its parent rebase targets). Branch mutations stay within the subtree; the read-only stack-block body refresh may span the whole stack so sibling and ancestor request widgets keep correct topology.
- `sync --all` opts into repo-wide sync across every tracked stack; it is the only mode that performs repo-wide stale-link cleanup and inference. `--all` is required for `--continue-on-failure` and cannot be combined with a branch argument.
- `sync --apply --all --continue-on-failure` / `sync --apply --all --keep-going` processes independent stacks, reports succeeded and failed stacks, preserves per-stack cleanup output, and exits nonzero if any stack failed.
- `sync` should not auto-track standalone trunk-root requests; infer a trunk-root request only when another open request is based on it.
- `merge` merges the oldest branch in a stack and immediately repairs descendants; when no branch is given, it infers the root from the current branch. It retargets immediate child requests before merge to preserve open work in auto-delete repos.
- `merge --auto` retargets immediate child requests, enables code-host auto-merge, waits for merge, then repairs descendants. A single `merge` (no `--through`) runs one full descendant repair pass, so nothing is left stale.
- `merge --auto --through <branch-or-change>` lands only the roots on the chain to the target; sibling subtrees that branch off the chain are never merged by `--through` (under lazy repair they are not rebased until the final pass). Repair is lazy: after a root lands, only the next root on the chain is rebased+pushed; grandchildren and off-chain siblings wait for their own turn (sound under squash — trunk's tree after landing P equals P's tip). One final full repair pass over whatever stays open runs when the through-target lands, so open requests end fresh. This keeps campaign churn O(n) instead of O(n²) force-pushes/re-reviews.
- `merge --auto --except <branch-or-change>` lands every root in the stack except the named branch and its descendants — the "land everything except X" intent for a forked stack. It reuses the campaign machinery: the excluded subtree is dropped from the landing chain and from the final repair pass's scope, so those branches are never rebased or pushed (a landed parent still retargets them to trunk pre-merge so their requests survive; their history waits for their own campaign). `--except` requires `--auto`, is mutually exclusive with `--through`, errors on an unknown branch, and errors when excluding the only root leaves nothing to merge. Like `--through`, an `--except` campaign persists and resumes with `--continue`.
- `merge --auto --through ... --eager` restores the pre-lazy behavior: full-chain descendant repair after every landing, for operators who want every open request's diff current while the campaign runs. `--eager` applies to `--except` campaigns too.
- `merge --continue` resumes a `--through` or `--except` campaign that stopped on a replay conflict. It re-reads the persisted campaign journal, verifies the recorded landed roots really merged, and continues from the recorded next root after the operator fixes and pushes the conflicted branch. It never re-repairs roots whose anchor already matches their parent's tip. `--continue` cannot be combined with a branch argument, `--through`, or `--except` (the campaign owns those); with no saved campaign it errors.
- On a replay conflict, the failure hint prints the surgical manual recipe: `git fetch origin`, then `git rebase --onto <new-parent> <backup-ref-just-created> <branch>` (the run's backup ref is the pre-rewrite parent tip / range base), resolve, `git push --force-with-lease origin <branch>`, then `stack merge --continue` (campaign) or `stack sync --apply <branch>`. It warns to rebase against freshly fetched refs, never a stale local trunk.
- `undo` restores the last landing's mutations while campaign state survives for `--continue`: they live in separate journals (`.git/stack/undo.json` vs `.git/stack/campaign.json`). After a conflict, `undo --apply` rolls back the most recent landing's branch/request/metadata changes; the campaign journal is untouched, so `--continue` still resumes. If you `undo` a landing you intend to re-land, run the campaign from scratch rather than `--continue`, since the journal still counts that root as landed.
- `history` explains the most recent applied mutation from the undo journal.
- `undo` restores the last applied mutation.

## Implementation notes

- Persist stack metadata in `.git/stack/state.json`. Each link's `anchor` is the parent tip the child was last verified/made consistent with (refreshed on every successful replay, on verification of an already-consistent link, and at track time). Repair prefers it as the replay-range base — after same-run rewrites (`replayAnchors`/`saved` backups) but before the merge-base fallback — whenever it is still an ancestor of the child, so a manual parent rewrite between runs replays exactly the child's own commits. Dry-run reads anchors but never writes them.
- Persist undo state in `.git/stack/undo.json`.
- Persist `--through`/`--except` campaign state in `.git/stack/campaign.json` (`CampaignState`: through-target, optional `except` subtree root (present for `--except` campaigns, driving the `merged all except: X` completion message and resume), `eager` flag, ordered `chain` of roots to land, full `stack` branch set for the final repair pass, and `landed` entries with each root's pr and backup name). It is written at every landing boundary — before a root merges (so a merge/pre-merge failure resumes there) and again in `landOne`'s `onLanded` hook once the root has merged (so a descendant-repair conflict leaves the journal pointing at the next root) — and cleared on successful completion. `merge --continue` reads it, confirms the recorded landings are no longer open changes, and resumes `runCampaign` from `chain[landed.length]`. This journal is independent of `undo.json`: `undo` restores the last landing while the campaign survives for `--continue`.
- User preferences live in `git config stack.*` (read at startup in the CLI `live` layer), not in `state.json`. Current keys: `stack.codeHost`, `stack.trunks`, and `stack.blockLink` (default true; set false to render a plain `### Stack` heading without the attribution link).
- Prefer `Context.Service`-based Effect services and test-first changes.
- Use OpenCode-style service modules for deep seams: export `Interface`, `Service`, adapters like `layer`, `live`, or `memory`, and a namespace self-reexport such as `export * as CodeHost from "./CodeHost.ts"`; consumers import that named namespace directly from the module file.
- Keep local Git behavior behind `Git` and pull/merge-request behavior behind `CodeHost`. Concrete backends live in `services/code-host/GitHub.ts` (via `gh`) and `services/code-host/GitLab.ts` (via `glab`), while their in-memory contract behavior is shared through `services/code-host/Memory.ts`; the CLI picks one backend at startup from `STACK_CODE_HOST`, `git config stack.codeHost`, or an unambiguous `origin` host. Stack orchestration depends on `CodeHost.Service` rather than shelling out to a host CLI directly.
- Check the local Effect source tree when available before changing Effect APIs or versions.
- Prefer `effect/Path`, `effect/FileSystem`, and `effect/unstable/process` instead of Node/Bun built-ins in app code.
- Keep logic literal and debuggable over clever abstractions.
- Default command output should be outcome-oriented: show the stack tree and changed/failed branches, not internal phases like fetch/inspect/reconcile.

## Verification

- Run `bun run typecheck`.
- Run `bun run test`.
- Run `bun run format:check` and `bun run lint` when formatting or lint config is present.
- When changing CLI docs or behavior, spot-check `bun src/cli.ts --help` and relevant subcommand help.
