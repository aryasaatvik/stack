---
packages:
  "@aryasaatvik/stack": patch
---

## Preserve externally merged root reconciliation

Treat a root whose recorded change was merged outside Stack (for example, squash-merged from the host UI with its head branch left undeleted) as landed during sync reconciliation. Remove its link, reparent children past it onto the merge-time base with replay anchors preserved, and never create a replacement change for merged work. Previously sync previewed recreating a PR for the already-merged branch because an open child change kept its stale link alive.
