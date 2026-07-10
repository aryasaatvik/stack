---
"@aryasaatvik/stack": patch
---

Add a heartbeat and exponential backoff (5s floor, 30s cap) while `merge --auto` waits for a
change to land on GitHub or GitLab, and coarse "reading open changes…" / "inspecting N branches…"
status lines during `sync` and `merge` cold-start reads. All of this goes to stderr as transient
status; stdout output is unchanged.
