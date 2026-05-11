# stack

```ts
╭───STACK───╮
dev
└─ #101
   └─ #102
      └─ #103
╰───────────╯
```

Squash-safe stacked PRs for GitHub repos that squash-merge and delete branches.

`stack` preserves stack intent locally, infers obvious relationships from PR
bases, and repairs descendants after each merge so open PRs keep their comments,
reviews, and context.

## Install

```bash
npm install -g @kitlangton/stack
```

Install the agent skill too, so coding agents know the safe workflow:

```bash
npx skills add kitlangton/stack --skill stack
```

## Example Workflow

An agent splits one cleanup into two PRs. The second PR is based on the first, so
GitHub knows the stack but Git will forget that relationship after squash merge.

```bash
gh pr create --base dev --head cleanup/schema-source
gh pr create --base cleanup/schema-source --head cleanup/openapi-output

stack sync --dry-run
```

The preview shows what `stack` will infer and update:

```text
→ fetch origin --prune
→ inspect open PRs and local refs
→ reconcile local stack metadata
→ infer PR-base stack links
→ preview repairs
→ preview stack block updates
infer link: cleanup/schema-source -> dev @ abc123
infer link: cleanup/openapi-output -> cleanup/schema-source @ def456
would update PR body: #101 Stack block
would update PR body: #102 Stack block
```

Then sync it:

```bash
stack sync
```

`stack sync` records the inferred links, refreshes each PR body, and prints the
local stack:

```text
dev
└─ cleanup/schema-source
   PR: #101
   └─ cleanup/openapi-output 👈 current
      PR: #102
```

Each PR gets a compact GitHub-native stack block:

```md
### Stack

1. #101
2. **#102** 👈 current
```

When the first PR is ready, the agent previews and merges the root:

```bash
stack merge
stack merge --apply
```

Before merging, `stack` retargets child PRs away from the root branch. That keeps
GitHub auto-delete from closing descendants, then `stack` rebases/pushes the
remaining branches and refreshes stack blocks.

```text
→ retarget #102 (cleanup/openapi-output) to dev before merge
→ merge #101 (cleanup/schema-source)
→ rebase cleanup/openapi-output onto dev
→ push cleanup/openapi-output
→ update #102 stack block
```

The child PR keeps its comments and reviews. Its stack block becomes history plus
the current PR:

```md
### Stack

1. #101
2. **#102** 👈 current
```

## Commands

```bash
stack status             # local tracked stack, no GitHub API call
stack sync --dry-run     # preview GitHub PR-base inference and repairs
stack sync               # record inferred links, repair, and refresh PR bodies
stack merge              # dry-run the next root merge
stack merge --apply      # merge root and repair descendants
stack merge --auto       # wait for GitHub requirements, then merge and repair
```

Do not run `stack track` defensively when PR bases are already correct. Use it
only when GitHub PR bases do not encode the stack or when correcting explicit
local metadata.
