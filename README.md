# MR Triage

Local GitLab and GitHub MR dashboard — replaces manually checking the MR pages.

- `server.mjs` — Node http server, shells out to `glab api` for GitLab data and `gh api graphql` for GitHub data
- `github.mjs` — turns GitHub pull request JSON into the MR objects the UI uses
- `view.mjs` — repo keys and repo grouping, shared by the server
- `public/` — static UI, polls the server every 15s
- `SPEC.md` — the v1 spec this implementation follows
- `.scratch/wayfinder-spec/` — the planning map that produced that spec, built with the `/wayfinder` skill (named for the skill, not the app — the app was renamed from its original "wayfinder" working title to avoid confusion with the skill)

## Run

```sh
npx mr-triage   # http://localhost:4931
```

No local clone needed — `npx` fetches and caches it on first use. Requires
**Node ≥20**, and at least one of these, installed and logged in:

- `glab` for GitLab
- `gh` for GitHub (private repos work with your `gh` login)

Each source is optional. If one is missing or not logged in, the app skips it
and shows a warning. If both fail, it shows an error.

Config lives in `~/.mr-triage/`, created on first run:

- `repos.json` — the repos you're responsible for (every open MR in these
  shows up, not just ones you authored or are reviewing). A flat JSON list;
  copy [`repos.json.example`](repos.json.example) to get started. Entries
  can be a plain project path, or `{ "path": "...", "short": "XX" }` to
  override the group's avatar letter(s) — handy when several repos share a
  prefix (e.g. everything starting with `webapp-`) and the auto-derived initial
  collides.

  To read GitHub repos, use `github:owner/repo`, or an object with
  `"host": "github"`. Plain strings and objects without `host` mean GitLab.

  ```json
  [
    "acme/webapp-widgets",
    "github:acme/api",
    { "path": "acme/web", "host": "github", "short": "WB" }
  ]
  ```

  GitHub PRs also show up when you wrote them or when your review is
  requested, even if the repo is not in `repos.json`.

GitHub PRs show a `#` before the number, GitLab MRs show a `!`. GitHub has
no job list or retry button here. Clicking a check tag opens the checks page.

Two view settings sit in the dashboard:

- **Source** — `All · GitLab · GitHub` in the header. It shows only when you
  have both GitLab MRs and GitHub PRs. Your choice is kept in the browser. The
  attention count and group counts follow it. Notifications do not.
- **Hidden repos** — the 🙈 button on a repo header hides that repo. A chip
  under the header brings it back with ✕. The list is kept in
  `~/.mr-triage/hidden-repos.json`, next to `hidden-authors.json`. A GitLab and
  a GitHub repo with the same path are hidden separately.

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
  skipping authors and repos you've hidden in the dashboard. A button in the pane
  collapses it to one line. Only polls after `/mrs` has been run in the
  session.

## Development

```sh
git clone https://github.com/sabasayer/mr-triage.git && cd mr-triage
npm start       # http://localhost:4931
```
