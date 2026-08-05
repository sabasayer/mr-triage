# wayfinder

Personal, local GitLab MR dashboard — replaces manually checking GitLab's MR
page. Groups MRs by repo, surfaces pipeline/approval/rebase status, and
gives quick actions (retry pipeline, copy link).

- `server.mjs` — Node http server, shells out to `glab api` for GitLab data
- `public/` — static UI, polls the server every 15s
- `.scratch/wayfinder-spec/` — the wayfinder planning map for the v1 spec (see the `/wayfinder` skill)

## Run

```sh
npm start   # http://localhost:4931
```

Requires `glab` installed and authenticated.
