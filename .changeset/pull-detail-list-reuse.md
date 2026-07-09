---
"@aryasaatvik/stack": patch
---

Reuse listed change details instead of re-fetching each request. `PullRef` now carries the body and labels already returned by the `gh`/`glab` list endpoints, so stack-block updates no longer fan out a per-request `gh pr view` / `glab mr view` for every open change, and post-merge descendant repair skips its redundant second list fetch when the repair changed nothing host-side.
