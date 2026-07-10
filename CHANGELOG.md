# @aryasaatvik/stack

## 0.5.0

### Minor Changes

- d1156c1: Off-stack `stack sync` no longer silently syncs every stack. It auto-scopes when exactly one stack exists, no-ops when none exist, and otherwise errors listing the stack roots; the new `sync --all` opts into repo-wide sync (and is now required for `--continue-on-failure`). Scope is resolved from a cheap membership graph before any merge-base work, so scoped syncs never touch out-of-scope stacks.
- f8b1f23: **Breaking:** `stack sync <branch>` now scopes to the branch's subtree (the branch plus its descendants), not the whole connected stack. Ancestors are read-only rebase targets and sibling subtrees are never read or moved — a dirty sibling worktree no longer blocks the run. Use `sync <root>` or `sync --all` to freshen a whole stack, including trunk-chase.
- 3f3b3c3: Replays of branches with no owning worktree now run in an ephemeral detached worktree instead of the primary checkout, and the repo-wide clean-checkout requirement is gone — only worktrees that own a branch being repaired must be clean. Stale worktree-ownership errors invalidate the snapshot and retry once.
- bf83181: `merge --auto --through` campaigns repair lazily: each landing rebases+pushes only the next root (O(n) instead of O(n²) force-pushes), with one full repair pass at the end; `--eager` restores the old behavior. Progress is journaled in `.git/stack/campaign.json`, so after a conflict fix `stack merge --continue` resumes from the recorded next root instead of re-running everything.
- b01e578: `merge --auto --except <branch-or-change>` lands every root except the named subtree, which is never rebased or pushed; like `--through` it persists and resumes with `--continue`. Replay-conflict failures now print the surgical recovery recipe (`git rebase --onto <new-parent> <backup-ref> <branch>` against freshly fetched refs), and the skill documents `--except`, `--through`'s chain-only sibling semantics, and `stack track` for pre-PR children.

### Patch Changes

- bf9ada2: Fix a correctness bug where a parent force-pushed from another worktree left the local ref stale: drift was measured against the stale tip, so sync reported success while doing nothing. Sync now fetches in dry-run too and reconciles in-scope refs against origin — fast-forwarding refs strictly behind, and failing loudly when a read-only parent target has diverged.
- cd3ef4b: Persist each link's `anchor` as the parent tip the child was last made consistent with, and prefer it over the merge-base for replay ranges — so a manual parent rewrite between runs replays only the child's own commits instead of conflicting on rewritten-parent commits.
- b77f636: Cache the worktree snapshot for the lifetime of a run and bound per-worktree dirty checks to 4 concurrent `git status` processes (previously unbounded on every call).
- 8cf2a12: Carry body and labels on listed changes so stack-block updates no longer fan out a per-request `gh pr view` / `glab mr view`, and skip the redundant post-merge list refetch when repair changed nothing host-side.
- de442cb: Heartbeat with exponential backoff (5s→30s) while waiting for a merge to land, plus coarse cold-start status lines during sync/merge reads — all on stderr; stdout is unchanged.

## 0.4.2

### Patch Changes

- ef789c8: Write `state.json` and `undo.json` atomically via tmp+rename so a crash mid-write cannot corrupt stack metadata. When a cherry-pick fails during repair, surface the conflicting file paths before aborting so the user knows which files need attention. Corrupt state files now include a recovery hint in the error message.

## 0.4.1

### Patch Changes

- 3b9322b: Recover stranded squash repair anchors: if `stack merge` persists state but aborts before descendant repair, a later `stack sync --apply` now uses the persisted anchor when it matches a `backup/landed-*` ref, so stranded descendants replay only their own commits instead of re-replaying the already-squashed parent.
- 3b9322b: Detach clean sibling worktrees that own a landed branch before deleting it during `stack merge --apply` and `stack merge --auto` cleanup. Fails before hosted mutation when the target worktree is dirty.

## 0.4.0

### Minor Changes

- f9652c5: Replace `stack guide` with `stack skill`, which prints the full `skills/stack/SKILL.md` agent instruction set. The skill content is embedded at build time via `with { type: "text" }` import, so it works from the installed package without a separate file lookup. The `guide` command is removed — `skill` supersedes it.

## 0.3.2

### Patch Changes

- 7aa7d11: Tolerate non-JSON warnings (e.g. auth expiry notices) emitted before `gh pr view` JSON output. The decoder now extracts the JSON payload from stdout instead of requiring the entire output to be valid JSON.

## 0.3.1

### Patch Changes

- 21d7334: Skip re-pushing branches that are already at the correct repaired tip during `stack sync --apply`. Previously, repairing a parent caused all descendants to be re-replayed and re-pushed even when their base already matched the parent's new tip, creating unnecessary CI/deploy churn on deep stacks. Dry-run previews and the pre-flight dirty-worktree gate remain conservative.

## 0.3.0

### Minor Changes

- c343c36: Standardize mutating command syntax: bare `stack sync` now previews changes and `stack sync --apply` performs repairs, matching the existing `merge` and `undo` workflows. Clarify the agent-first workflow in the README and bundled stack skill, preserve the ASCII stack logo, and keep the CLI reference as a concise final section.
- e023d11: Add `git config stack.blockLink false` to render a plain `### Stack` heading in the stack block without the attribution link. The linked heading remains the default.
- e023d11: Repair branches that are checked out in other worktrees by replaying them from their owning clean worktree instead of force-moving the ref. Sync and merge now fail before any mutation when a branch needing repair is checked out in a dirty worktree, and refuse to delete a local branch that is checked out elsewhere.

### Patch Changes

- e023d11: Support mixed linear and parallel stack shapes by separating merge path selection (`merge --auto --through`) from PR stack-block rendering, so auto-merge follows the selected branch and stack blocks no longer pull in an arbitrary sibling at a fork point.
- e023d11: Read raw configured remote URLs (`remote.origin.url`) instead of rewrite-expanded output, so repository and code-host detection stays correct under Git `insteadOf` rewrites and custom SSH host aliases.
- c90cf94: Allow repos to configure trunk branches with `git config stack.trunks`.

## 0.2.0

### Minor Changes

- c12b921: Introduce the internal `CodeHost` seam so stack orchestration can operate on
  GitHub pull requests and GitLab merge requests through provider adapters.

  The CLI now selects a provider at startup and uses host-neutral concurrency and
  polling configuration internally. Repair plumbing also records request source
  repositories and pushed remotes so fork-backed repairs can be recreated and
  undone safely. Provider adapters normalize missing historical changes before
  orchestration decides whether to recreate them, and enumerate open changes
  exhaustively so stale-metadata decisions never depend on arbitrary list caps.
  Provider adapters also share one in-memory contract implementation so additional
  hosts can reuse the same lifecycle behavior without copying adapter test seams.
  The new seam names hosted requests as changes internally while preserving the
  existing persisted `pr` keys and exported pull-shaped models for compatibility.
  GitLab source-project enrichment is cached per adapter layer, including concurrent
  lookups for fork-backed requests.

- c12b921: Add GitLab support. `stack` now talks to GitLab merge requests through the
  `glab` CLI alongside GitHub pull requests via `gh`.

  - New `CodeHostGitLab.layer` shells out to `glab mr ...` and `glab api` and
    maps GitLab's `iid`, `source_branch`,
    `target_branch`, `web_url`, `description`, and `opened|merged|closed|locked`
    state vocabulary onto the same `PullRef` / `PullMeta` shapes the rest of the
    tool already understands.
  - `CodeHostGitLab.memory` mirrors `CodeHostGitHub.memory` for tests.
  - `CodeHost` auto-detects exact `github.com` and `gitlab.com` remotes; an
    enterprise host is selected through `git config stack.codeHost`, with
    `STACK_CODE_HOST` available as a temporary override.
  - GitLab source projects are normalized for safe repair pushes from fork MRs.
  - GitLab MR enumeration decodes paginated API output as NDJSON, and immediate
    merge disables deferred auto-merge so descendant repair only starts after a landed MR.
  - GitLab MR target updates use `--yes`, while description replacement and
    auto-merge use `glab api` so repair never pauses for confirmation, can clear
    a description, and reliably requests server-side auto-merge.
  - `--admin` is rejected before mutation on GitLab because there is no `glab`
    equivalent of GitHub's admin merge.

  Stack orchestration remains code-host independent while preserving scoped repair,
  post-repair description refresh, and undo support for fork remote pushes.

### Patch Changes

- c12b921: User-facing polish for code-host-neutral wording.

  - CLI help text, the `guide` command, and the merge failure hint now talk about
    "changes" / "target branches" / "code-host auto-merge" instead of
    "PRs" / "PR bases" / "GitHub auto-merge". GitHub-specific behaviour (admin
    merge) is still called out where it applies.
  - `package.json` description and keywords mention GitLab and merge requests.
  - README, AGENTS.md (and the CLAUDE.md symlink), CONTEXT.md, and the
    `skills/stack/SKILL.md` agent guide document the `CodeHost` seam, the two
    backends (gh + glab), and code-host selection. The skill now shows
    GitLab equivalents in the Happy Path section and notes that `--admin` is
    GitHub-only.
  - Provider adapters normalize missing historical changes so GitLab `404 Not Found`
    responses and GitHub lookup failures trigger the same safe recreation path.

- c12b921: Fix three rendering quirks surfaced by the GitLab smoke test.

  - `stack sync` against a GitLab remote now writes `!1`, `!2`, `!3` in the stack
    block inside each MR description so they render as real merge-request links
    on gitlab.com. Previously the block always used GitHub's `#N` syntax, which
    on GitLab refers to _issues_ — so the references rendered as plain text or
    links to nonexistent issues. The completed-line parser in `stackBlock`
    accepts both `#N` and `!N` so blocks written by either code host are
    preserved on rewrite. The selected `CodeHost` adapter supplies native
    reference rendering, including for explicitly configured enterprise hosts.
  - GitLab stack blocks now include MR titles beside `!N` references, including
    completed history when the MR can still be read, because GitLab only exposes
    the title on hover for bare `!N` autolinks. GitHub keeps the compact `#N`
    format.
  - `stack status` now labels the displayed trunk as the trunk _actually used_
    by the stack (e.g. `main` when the stack lives off `main`) instead of always
    using `cfg.trunks[0]`. The inference falls back to `cfg.trunks[0]` when no
    trunk is referenced as a parent.
  - `stack merge` now reports `would switch to <actual trunk>` and switches to
    the right trunk on apply, instead of unconditionally using `cfg.trunks[0]`.
    Same fix in `stack undo`: the trunk to switch to is inferred from the
    saved `run.state.links`.

  The first item is genuinely GitLab-specific; the other two were pre-existing
  display bugs that affect any repo whose trunk is not `dev`.

- 1b4221c: Scope repair, final merge diagrams, and stack-block refreshes to the selected stack, update blocks for requests recreated during repair, keep sync dry-runs free of fetch mutations, use tracked change identities when fork heads share a branch name, and checkpoint repair mutations so failed merge and sync attempts can be undone safely.
- 1be576f: Limit the final merge repair diagram to the selected stack.
- 5510fb4: Upgrade toolchain: TypeScript 6.0, vitest 4.1, oxlint 1.66, oxfmt 0.51.

## 0.1.5

### Patch Changes

- Scope `stack sync` to the current or requested stack, and add keep-going sync for independent stacks.

## 0.1.4

### Patch Changes

- Improve sync output, remove the public repair command, and add oxlint/oxfmt checks.

## 0.1.3

### Patch Changes

- Add `stack merge --auto --through <branch-or-pr>` for bounded auto-merge ranges.

## 0.1.2

### Patch Changes

- Initial public release.
