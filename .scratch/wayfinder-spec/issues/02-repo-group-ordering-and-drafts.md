Type: grilling
Status: resolved
Blocked by:

## Question

Within each repo group in wayfinder's UI:

- How should MRs be sorted (e.g. by last-updated, or urgency like
  pipeline-failed-first)?
- Should a repo group with zero relevant MRs be hidden, or shown collapsed?
- How should draft MRs be treated — shown normally, visually de-emphasized,
  or hidden behind a toggle?

## Answer

- **Sort within a repo group**: urgency first — failed pipeline / needs-rebase
  / needs-re-review surfaced above healthy MRs — then by recency
  (last-updated) within each tier.
- **Empty repo groups**: hidden entirely. A quiet repo from the configured
  list produces no row at all.
- **Draft MRs**: shown normally, in the same urgency/recency sort as
  everything else, but visually de-emphasized with a "Draft" badge/dimmed
  styling — not hidden. A draft with a failing pipeline still needs to be
  seen.
