# Context

## Domain Terms

- **Stack**: An ordered set of pull requests where each branch is based on the previous branch, ending at a trunk branch such as `dev`.
- **Stack link**: Persisted metadata that records a branch, its parent branch, the merge-base anchor, and the associated pull request number.
- **Stack block**: The generated markdown block in a pull request body that shows stack history and the current open path.
- **Repair**: The workflow that rehomes stack descendants after a squash merge, parent branch deletion, or parent branch rewrite.
- **Undo journal**: The saved snapshot of branch backups, pull request bases, and stack metadata used by `stack undo`.

## Architecture Notes

- Local Git behavior stays behind the `Git` seam.
- Pull request behavior stays behind the `GitHub` seam.
- Stack orchestration belongs in `Stack`; markdown rendering belongs in formatting modules such as `stackBlock` and `format`.
