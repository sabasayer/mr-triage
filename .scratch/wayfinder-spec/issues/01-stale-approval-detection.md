Type: research
Status: resolved
Blocked by:

## Question

GitLab's merge request `detailed_merge_status` field cleanly reports
`need_rebase`, but does it (or another endpoint) let wayfinder distinguish
"this MR was approved, then a new commit reset/invalidated that approval"
from "this MR was simply never approved"?

Investigate `detailed_merge_status`'s possible values, the approvals API
(`GET /projects/:id/merge_requests/:iid/approvals`), and any
approval-reset-on-push project setting. Recommend which field(s) wayfinder's
spec should use to render a "needs re-review" signal distinct from
"never reviewed."

## Answer

GitLab exposes no discrete field for "was approved, now isn't":

- **Rebase** is a solved case — `detailed_merge_status` on the MR detail
  endpoint returns `need_rebase` directly. Use it as-is.
- **Stale approval** is not directly exposed. `GET
  projects/:id/merge_requests/:iid/approvals` returns `approved`,
  `approvals_left`, `approved_by` — but when a push resets approvals (per
  the project's "remove approvals on push" setting), these fields return to
  the exact same values as an MR that was never approved. A single
  snapshot can't tell the two apart.
- The project-level setting that controls this (`reset_approvals_on_push`,
  via `GET projects/:id/approvals`) requires Maintainer/Owner access —
  confirmed 403 even on one of Salih's own repos — so it's not a reliable
  signal source across an arbitrary "repos I'm responsible for" list anyway.

**Recommendation for the spec**: wayfinder derives "needs re-review" itself,
by keeping the previous poll's `approved` boolean per MR in its existing
in-memory cache (already fetching this field for the approvals badge) and
flagging a true→false transition between polls. No new API call. Accepted
limitation: this memory resets on app restart, losing a stale-approval
signal that occurred while the app was down — fine for v1 since wayfinder is
meant to run continuously.
