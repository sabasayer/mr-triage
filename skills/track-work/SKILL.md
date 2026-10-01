---
name: track-work
description: Create or update a tracked task in mr-triage's Tasks tab, so a piece of work started here shows up as a todo item from "working" through to "done". Use standalone when starting ad hoc work, or invoked by ship-work at task creation and MR-creation time.
---

# /track-work

Creates or updates one row in [mr-triage](https://github.com/sabasayer/mr-triage)'s
Tasks tab by writing to `~/.mr-triage/tasks.json` through the local mr-triage
server's API. A task is keyed by `repo + branch` — invoking this again for
the same repo/branch updates the existing task instead of creating a
duplicate.

This skill never changes a task's workflow state (Working → In Review →
Released → Testing → Done). It only creates a task and fills in metadata
(title, Linear URL, MR URL). State moves forward automatically (MR opens,
MR merges + releases) or manually in the mr-triage UI — never from here.

## Inputs

Take whatever's passed as args. For anything missing, derive or ask:

1. **Repo** — derive from `git remote get-url origin` in the current directory: strip `git@gitlab.com:`/`https://gitlab.com/` and a trailing `.git` to get the `group/project` path. If there's no git remote, ask.
2. **Branch** — `git rev-parse --abbrev-ref HEAD` in the current directory. If detached or unavailable, ask.
3. **Title** — required. If not passed, ask for a short one-line description of the work.
4. **Linear URL** (optional) — if working from a Linear issue, pass its URL.
5. **MR URL** (optional) — pass this once an MR exists for the work (this is what flips the task from Working to In Review).

## Server

The mr-triage server runs locally, default `http://localhost:4931` (or
whatever `PORT` it was started with — ask if the default doesn't respond
and the user hasn't said otherwise).

POST to `/api/tasks` with a JSON body of whichever fields are known:

```bash
curl -s -X POST http://localhost:4931/api/tasks \
  -H 'Content-Type: application/json' \
  -d '{"repo":"<group/project>","branch":"<branch>","title":"<title>","linear_url":"<url or omit>","mr_url":"<url or omit>"}'
```

Omit `linear_url`/`mr_url` keys entirely when not known — sending `null` or
an empty string would overwrite a value the task might already have from an
earlier invocation.

If the request fails to connect, mr-triage isn't running locally. Say so
once — "mr-triage isn't running, so this task wasn't tracked — start it
with `npx mr-triage`" — and move on; don't treat this as fatal to whatever
larger flow invoked it, and don't start the server yourself.

## Standalone usage

When a user runs this directly (not from `ship-work`), just gather the
inputs above from args or by asking, then make the request. No Linear issue
or MR is required — a task can exist in the Working state indefinitely.
