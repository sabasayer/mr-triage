# MR Triage

Personal, local GitLab MR dashboard — replaces manually checking GitLab's MR
page. Groups MRs by repo, surfaces pipeline/approval/rebase status, and
gives quick actions (retry pipeline, copy link).

- `server.mjs` — Node http server, shells out to `glab api` for GitLab data
- `public/` — static UI, polls the server every 15s
- `SPEC.md` — the v1 spec this implementation follows
- `.scratch/wayfinder-spec/` — the planning map that produced the spec, built with the `/wayfinder` skill (named for the skill, not the app — the app was renamed from its original "wayfinder" working title to avoid confusion with the skill)

## Run

```sh
cp repos.json.example repos.json   # list the repos you're responsible for
npm start                          # http://localhost:4931
```

Requires `glab` installed and authenticated. `repos.json` is gitignored — it's
personal, edit it directly.

Entries can be a plain project path, or `{ "path": "...", "short": "XX" }` to
override the group's avatar letter(s) — handy when several repos share a
prefix (e.g. everything starting with `xds-`) and the auto-derived initial
collides.
