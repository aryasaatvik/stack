---
"@aryasaatvik/stack": patch
---

Treat a root whose recorded change was merged outside stack (e.g. squash-merged from the host UI with the head branch left undeleted) as landed during sync reconciliation: remove its link, reparent children past it onto the merge-time base with replay anchors preserved, and never create a replacement change for merged work. Previously sync previewed recreating a PR for the already-merged branch because an open child change kept its stale link alive.
