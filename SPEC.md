# Wayfinder v1 — Spec

A personal, local web app that replaces manually checking GitLab's MR page.
It surfaces every MR relevant to Salih, grouped by repo, with live-ish
status and two quick actions. This is a spec for a future implementation
effort — a v0.1 prototype already exists at the repo root as a rough
reference, not as the implementation of this spec.

## Data sources

Three GitLab queries, deduplicated by `(project_id, iid)`:

1. MRs authored by Salih (`scope=created_by_me`)
2. MRs where Salih is requested reviewer (`reviewer_username=<me>`)
3. Every open MR in any repo listed in a config file — a flat JSON/YAML
   list of GitLab project paths, living next to the app. This list is
   maintained by hand; "repos I'm responsible for" is Salih's own judgment
   call, not derived from GitLab role/permissions.

Each MR carries a relationship badge (authored / review-requested / other
activity in one of Salih's repos) so the three sources stay visually
distinguishable even once grouped.

All GitLab access goes through the `glab` CLI (already authenticated),
polled every 15–30s. A periodic poll counts as "live" for this use case —
no long-polling or webhooks needed.

## Layout

Grouped **by repo** (not by relationship). Within a repo group:

- **Sort**: urgency first — failed pipeline, needs-rebase, or
  needs-re-review MRs surface above healthy ones — then by last-updated
  within each tier.
- **Empty groups**: a repo from the configured list with zero relevant MRs
  produces no row at all.
- **Drafts**: shown in the normal sort, not hidden, but visually
  de-emphasized (e.g. a dimmed "Draft" badge) so they don't compete with
  MRs that are ready for action.

## Status signals

- **Pipeline status** — from the MR's `head_pipeline.status`.
- **Needs rebase** — `detailed_merge_status === 'need_rebase'`, direct from
  the GitLab API.
- **Needs re-review** — GitLab exposes no field for "was approved, a push
  invalidated it." Wayfinder derives it itself: keep the previous poll's
  `approved` boolean per MR (from `GET
  projects/:id/merge_requests/:iid/approvals`, already fetched for the
  approval badge) and flag a true→false transition between polls. No extra
  API call. Known limitation: this memory resets on app restart, so a
  stale-approval transition that happened while the app was down won't be
  caught — acceptable for v1 since the app is meant to run continuously.

## Actions

Exactly two, both already proven in the v0.1 prototype:

- **Retry pipeline** — shown only when pipeline status is failed/canceled;
  calls `POST projects/:id/pipelines/:id/retry`.
- **Copy link** — copies the MR's `web_url`, client-side only.

## Explicitly out of scope for v1

- Ask-for-review / ask-for-re-review actions (no clean GitLab API for a
  "nudge"; social, not mechanical).
- A rebase action (mechanically simple, but deferred with the above so v1's
  action surface stays minimal — revisit once the dashboard is in daily
  use).
- AI-related automations.
- "Fancy views."

---

Planning history for this spec: [`.scratch/wayfinder-spec/`](.scratch/wayfinder-spec/map.md).
