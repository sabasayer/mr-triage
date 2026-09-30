// Self-check for the task-tracking endpoints (/api/tasks). Spawns the real
// server against a throwaway $HOME so it never touches ~/.mr-triage, and
// only exercises tasks with no mr_url — that path never calls out to glab.
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const home = await mkdtemp(join(tmpdir(), "mr-triage-test-"));
const port = 40000 + Math.floor(Math.random() * 10000);
const base = `http://localhost:${port}`;

const server = spawn("node", ["server.mjs"], {
  env: { ...process.env, HOME: home, PORT: String(port) },
  stdio: ["ignore", "ignore", "ignore"],
});

try {
  for (let i = 0; i < 50; i++) {
    try { await fetch(base + "/api/tasks"); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }

  const created = await fetch(base + "/api/tasks", {
    method: "POST",
    body: JSON.stringify({ repo: "org/proj", branch: "feat/x", title: "Do the thing" }),
  }).then((r) => r.json());
  assert.equal(created.state, "working", "task with no MR starts Working");
  assert.equal(created.id, "org/proj#feat/x");

  const withMr = await fetch(base + "/api/tasks", {
    method: "POST",
    body: JSON.stringify({ repo: "org/proj", branch: "feat/x", mr_url: "https://gitlab.com/org/proj/-/merge_requests/1" }),
  }).then((r) => r.json());
  assert.equal(withMr.state, "in_review", "attaching an MR flips Working to In Review");
  assert.equal(withMr.title, "Do the thing", "existing title is preserved on update");

  const testing = await fetch(base + `/api/tasks/${encodeURIComponent(withMr.id)}/state`, {
    method: "POST", body: JSON.stringify({ state: "testing" }),
  }).then((r) => r.json());
  assert.equal(testing.state, "testing");

  await fetch(base + `/api/tasks/${encodeURIComponent(withMr.id)}/state`, {
    method: "POST", body: JSON.stringify({ state: "bogus" }),
  }).then((r) => assert.equal(r.status, 400, "unknown state is rejected"));

  const stored = JSON.parse(await readFile(join(home, ".mr-triage", "tasks.json"), "utf8"));
  assert.equal(stored.length, 1, "one task on disk, upserted not duplicated");
  assert.equal(stored[0].state, "testing");

  console.log("ok — tasks endpoints behave");
} finally {
  server.kill();
  await rm(home, { recursive: true, force: true });
}
