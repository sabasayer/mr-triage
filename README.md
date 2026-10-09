# MR Triage

Local GitLab MR dashboard and task tracker — replaces manually checking
GitLab's MR page, and doubles as a todo list for work in progress, from
"just started" through to shipped and released.

- `server.mjs` — Node http server, shells out to `glab api` for GitLab data
- `public/` — static UI, polls the server every 15s
- `SPEC.md` — the v1 spec the MR-dashboard half of this implementation follows
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
- `tasks.json` — the Tasks tab's data. Written by starring an MR in the UI,
  or by the `track-work` skill below; you shouldn't need to hand-edit it.

## Tracking work end-to-end (Tasks tab)

Star an MR to track it from wherever it currently is. To track a piece of
work *before* an MR exists — right when you start it — install the
`track-work` skill (one-time, requires [Claude Code](https://claude.com/claude-code)):

```sh
npx skills add sabasayer/mr-triage --global --agent claude-code -y
```

(Uses [vercel-labs/skills](https://github.com/vercel-labs/skills). Later,
`npx skills update mr-triage` picks up any changes to the skill.)

Then just ask Claude Code to track what you're working on, or wire it into
a delivery skill like `ship-work` — see [`skills/track-work/SKILL.md`](skills/track-work/SKILL.md).

## Claude Code mods

Two independent Claude Code plugins in [`mods/`](mods/). Both read this
server (default port 4931), so `mr-triage` must be running. Install from a
Claude Code terminal session, either or both:

```
/plugin install mr-triage-mrs --marketplace sabasayer/mr-triage
/plugin install mr-triage-banner --marketplace sabasayer/mr-triage
```

Answer `y` to add the marketplace and pick a scope.

- **`mr-triage-mrs`** — `/mrs` opens a pane of open MRs: pipeline status,
  conflicts/approved flags, MR number and Linear issue, grouped by repo,
  skipping authors you've hidden in the dashboard. Only polls after `/mrs`
  has been run in the session.
- **`mr-triage-banner`** — a banner above the prompt showing the tracked task
  (see `track-work`) for the session's git repo and branch: state, Linear
  issue, MR, pipeline, tested/reviewed. Hidden when the branch has no task.

## Development

```sh
git clone https://github.com/sabasayer/mr-triage.git && cd mr-triage
npm start       # http://localhost:4931
npm test        # self-check for the Tasks API
```
