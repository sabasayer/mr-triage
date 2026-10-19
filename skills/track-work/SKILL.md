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

A task moves through these states: Working, MR review, Released, Verifying,
Done. Plus Paused. "Local test" and "Self-review" are two separate checks. They
run alongside the states, not in order. Most moves happen on their
own (an MR opens, an MR merges and releases) or by hand in the mr-triage UI.

This skill only creates a task and fills in metadata (title, Linear URL,
MR URL). It sets a check in two cases only, and only after the user said it
happened:

- `local_testing`: marks the "Local test" check as done. It does not move the
  task along the steps. Use it only when the user says *they themselves* ran the change and
  checked it (for example the dev server in the browser). "It works" or
  "tests pass" is not enough. If unclear, ask.
- `reviewing`: marks the "Self-review" check as done. It does not move the
  task along the steps. Use it only when the user says a review pass (for example `review-workspace`)
  has started or run on this work.

Never send `paused`, `released`, `testing` or `done` from here. Those are the
user's call. Never guess a state from an unrelated statement.

## Inputs

Take whatever's passed as args. For anything missing, derive or ask:

1. **Repo** — always the `group/project` path from the git remote, for example `founda/application/xds-viewer-demo`. Never a folder name like `xds-demo`. Run `git -C <worktree-or-repo-path> remote get-url origin`. Strip `git@gitlab.com:` or `https://gitlab.com/` and the trailing `.git`. If a caller passes a short name, ignore it and use the remote path. The banner and the Tasks tab match tasks by this exact path. A short name makes a task that never matches. If there is no git remote, ask.
2. **Branch** — `git -C <worktree-or-repo-path> rev-parse --abbrev-ref HEAD`. If detached or unavailable, ask.

3. **Title** — required. If not passed, ask for a short one-line description of the work.
4. **Linear URL** (optional) — if working from a Linear issue, pass its URL.
5. **MR URL** (optional) — pass this once an MR exists for the work (this is what flips the task from Working to In Review).

## Banner

The mr-triage banner shows the task for the branch of the session's working directory. It runs `git` there. The task must use the remote path for `repo` (see Inputs). The session must also work inside that repo or worktree. A session in a folder that is not a git repo shows no banner. Tell the user if the session is not in the worktree.

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

## Setting a state

Send `state` with the same `POST /api/tasks` call. The task id is always
`<repo>#<branch>`.

```bash
curl -s -X POST http://localhost:4931/api/tasks \
  -H 'Content-Type: application/json' \
  -d '{"repo":"<repo>","branch":"<branch>","state":"local_testing"}'
```

`local_testing` and `reviewing` set the `tested` and `reviewed` checks. The
current state stays the same. The user can also switch both checks in the web UI.

## Standalone usage

When a user runs this directly (not from `ship-work`), just gather the
inputs above from args or by asking, then make the request. No Linear issue
or MR is required — a task can exist in the Working state indefinitely.
