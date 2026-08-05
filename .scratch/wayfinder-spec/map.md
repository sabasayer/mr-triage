# Wayfinder v1 spec

## Destination

A written spec for wayfinder v1: a personal, local web app that surfaces
GitLab MRs relevant to Salih — grouped by repo — replacing manual checks of
GitLab's MR page. The spec, not the tool, is what this map delivers;
building v1 is a separate future effort.

## Notes

- A v0.1 hand-built prototype already exists at `~/Private/wayfinder`
  (plain Node http server, `glab api` calls, static HTML/JS polling every
  15s). Treat it as a rough reference to react to, not the spec itself.
- GitLab is the only surface involved, via the `glab` CLI (already
  authenticated as `salih.sayer`).
- Consult `/grilling` and `/domain-modeling` for tickets in this map.

**Settled while charting** (not tracked as tickets — bake directly into the
spec):

- Local web app, `glab` CLI, periodic poll (~15–30s) counts as "live" — no
  long-polling/webhooks needed.
- MR sources: authored by Salih, review-requested from Salih, and any MR
  opened in a repo listed in a config file (plain JSON/YAML list of GitLab
  project paths, next to the app). "Repos I'm responsible for" is a personal
  judgment call, not derived from GitLab roles/permissions.
- Primary grouping: by repo. Each MR carries a badge for its relationship
  (authored / review-requested / other activity).
- V1 actions: retry failed/canceled pipeline, copy MR link. Nothing else.

## Decisions so far

- [Stale-approval detection](.scratch/wayfinder-spec/issues/01-stale-approval-detection.md) — GitLab has no field for it; `need_rebase` covers rebase directly, but "needs re-review" must be derived by wayfinder itself from a poll-to-poll `approved` true→false transition (no new API call).
- [Repo-group ordering and drafts](.scratch/wayfinder-spec/issues/02-repo-group-ordering-and-drafts.md) — sort by urgency then recency; hide empty repo groups entirely; drafts shown normally with a de-emphasizing badge, not hidden.

## Not yet specified

## Out of scope

- AI-related automations — beyond this effort's destination (a spec for a
  read-mostly status dashboard only).
- "Fancy views" — same.
- Actions for ask-for-review, ask-for-re-review, and rebase — deferred to a
  future effort once the read-only dashboard is in daily use.
