# MR Triage

Local GitLab MR dashboard — replaces manually checking GitLab's MR page.

- `server.mjs` — Node http server, shells out to `glab api` for GitLab data
- `public/` — static UI, polls the server every 15s
- `SPEC.md` — the v1 spec this implementation follows
- `.scratch/wayfinder-spec/` — the planning map that produced that spec, built with the `/wayfinder` skill (named for the skill, not the app — the app was renamed from its original "wayfinder" working title to avoid confusion with the skill)

## Run

```sh
npx mr-triage   # http://localhost:4931
```

No local clone needed — `npx` fetches and caches it on first use. Requires
`glab` installed and authenticated, and **Node ≥20**.

Config lives in `~/.mr-triage/`, created on first run:

- `repos.json` — the repos you're responsible for (every open MR in these
  shows up, not just ones you authored or are reviewing). A flat JSON list;
  copy [`repos.json.example`](repos.json.example) to get started. Entries
  can be a plain project path, or `{ "path": "...", "short": "XX" }` to
  override the group's avatar letter(s) — handy when several repos share a
  prefix (e.g. everything starting with `webapp-`) and the auto-derived initial
  collides.

The old Tasks feature is gone (removed in 2.0.0). A leftover `tasks.json` in
this folder is no longer read. You can delete it.

## Claude Code mods

One Claude Code plugin in [`mods/`](mods/). It reads this server (default
port 4931), so `mr-triage` must be running. Install it from a Claude Code
terminal session:

```
/plugin install mr-triage-mrs --marketplace sabasayer/mr-triage
```

Answer `y` to add the marketplace and pick a scope.

- **`mr-triage-mrs`** — `/mrs` opens a pane of open MRs: pipeline status,
  conflicts/approved flags, MR number and Linear issue, grouped by repo,
  skipping authors you've hidden in the dashboard. A button in the pane
  collapses it to one line. Only polls after `/mrs` has been run in the
  session.

## Development

```sh
git clone https://github.com/sabasayer/mr-triage.git && cd mr-triage
npm start       # http://localhost:4931
```
