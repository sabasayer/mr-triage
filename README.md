# wayfinder

Personal, local GitLab MR dashboard — replaces manually checking GitLab's MR
page. Groups MRs by repo, surfaces pipeline/approval/rebase status, and
gives quick actions (retry pipeline, copy link).

- `server.mjs` — Node http server, shells out to `glab api` for GitLab data
- `public/` — static UI, polls the server every 15s
- `SPEC.md` — the v1 spec this implementation follows
- `.scratch/wayfinder-spec/` — the wayfinder planning map that produced the spec (see the `/wayfinder` skill)

## Run

```sh
cp repos.json.example repos.json   # list the repos you're responsible for
npm start                          # http://localhost:4931
```

Requires `glab` installed and authenticated. `repos.json` is gitignored — it's
personal, edit it directly.
