#!/usr/bin/env node
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";
import { homedir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 4931;
const POLL_MS = 20_000;

// Personal config/state lives outside the package install dir — required
// once this runs via `npx mr-triage` (a fresh, throwaway cache dir each
// time) rather than a local clone.
const CONFIG_DIR = join(homedir(), ".mr-triage");
const REPOS_FILE = join(CONFIG_DIR, "repos.json");

function glabOnce(args) {
  return new Promise((resolve, reject) => {
    execFile("glab", args, { maxBuffer: 1024 * 1024 * 32 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve(stdout);
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ponytail: retry only errors that look like a network blip (timeout, DNS,
// connection reset) — a 404/403/422 is a real answer from GitLab, retrying
// it just delays the same failure.
const TRANSIENT = /i\/o timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|dial tcp/i;
async function glab(args, attempt = 1) {
  try {
    return await glabOnce(args);
  } catch (err) {
    if (attempt < 3 && TRANSIENT.test(err.message)) {
      await sleep(300 * attempt);
      return glab(args, attempt + 1);
    }
    throw err;
  }
}

async function glabApi(path, method = "GET") {
  const args = method === "GET" ? ["api", path] : ["api", "-X", method, path];
  const out = await glab(args);
  return out.trim() ? JSON.parse(out) : null;
}

let me = null;
async function whoami() {
  if (!me) me = (await glabApi("user")).username;
  return me;
}

// One-time carry-over for anyone already running this from a local clone
// with a repos.json next to server.mjs — after this, REPOS_FILE is the only
// place it's read from.
async function migrateLegacyReposFile() {
  try {
    await readFile(REPOS_FILE, "utf8");
    return; // already migrated
  } catch {
    // fall through — no file at the new location yet
  }
  try {
    const legacy = await readFile(join(__dirname, "repos.json"), "utf8");
    await mkdir(CONFIG_DIR, { recursive: true });
    await writeFile(REPOS_FILE, legacy);
    console.log(`[mr-triage] migrated repos.json to ${REPOS_FILE}`);
  } catch {
    // no legacy file either — nothing to migrate
  }
}

// ponytail: entries can be a plain path string, or {path, short} when the
// auto-derived avatar letter collides (e.g. everything starting with "xds-")
async function myRepos() {
  try {
    const raw = await readFile(REPOS_FILE, "utf8");
    const entries = JSON.parse(raw);
    return entries.map((e) => (typeof e === "string" ? { path: e, short: null } : { path: e.path, short: e.short ?? null }));
  } catch {
    return [];
  }
}

async function fetchMrList(scopeQuery) {
  return glabApi(`merge_requests?state=opened&per_page=50&${scopeQuery}`);
}

async function fetchProjectMrList(projectPath) {
  return glabApi(`projects/${encodeURIComponent(projectPath)}/merge_requests?state=opened&per_page=50`);
}

// ponytail: in-memory only — an "approved, then push reset it" signal needs no
// endpoint GitLab exposes, so we remember the last poll's `approved` bit per MR
// ourselves. Lost on restart; acceptable since the app is meant to stay running.
const lastApproved = new Map();

// ponytail: same trick as lastApproved — remember each MR's note count so we
// can flag "new comment since last poll" instead of just "has comments".
const lastNoteCount = new Map();

// ponytail: per-refresh cache — several MRs usually share a project, no need
// to ask GitLab "is this archived?" once per MR when once per project will do.
const archivedCache = new Map();
async function isArchived(projectId) {
  if (!archivedCache.has(projectId)) {
    const project = await glabApi(`projects/${projectId}`);
    archivedCache.set(projectId, Boolean(project.archived));
  }
  return archivedCache.get(projectId);
}

async function fetchDetail(mr) {
  if (await isArchived(mr.project_id)) return null;

  const key = `${mr.project_id}!${mr.iid}`;
  const [detail, approvals] = await Promise.all([
    glabApi(`projects/${mr.project_id}/merge_requests/${mr.iid}`),
    glabApi(`projects/${mr.project_id}/merge_requests/${mr.iid}/approvals`),
  ]);

  const wasApproved = lastApproved.get(key);
  const needsReReview = wasApproved === true && approvals.approved === false;
  lastApproved.set(key, approvals.approved);

  const prevNoteCount = lastNoteCount.get(key);
  const newComment = prevNoteCount !== undefined && detail.user_notes_count > prevNoteCount;
  lastNoteCount.set(key, detail.user_notes_count);

  const needsRebase = detail.detailed_merge_status === "need_rebase";
  const pipeline = detail.head_pipeline
    ? { id: detail.head_pipeline.id, status: detail.head_pipeline.status, web_url: detail.head_pipeline.web_url }
    : null;
  const pipelineFailed = pipeline && ["failed", "canceled"].includes(pipeline.status);

  return {
    project_id: mr.project_id,
    project: detail.references?.full?.split("!")[0] ?? String(mr.project_id),
    iid: mr.iid,
    title: mr.title,
    web_url: mr.web_url,
    source_branch: detail.source_branch,
    author: mr.author?.username,
    draft: mr.draft,
    updated_at: mr.updated_at,
    merge_status: detail.detailed_merge_status,
    approved: approvals.approved,
    approvals_left: approvals.approvals_left,
    needs_rebase: needsRebase,
    needs_re_review: needsReReview,
    new_comment: newComment,
    comment_count: detail.user_notes_count,
    pipeline,
    urgent: Boolean(pipelineFailed || needsRebase || needsReReview || newComment),
  };
}

async function loadMrs() {
  console.log("[mr-triage] refresh: fetching MR lists…");
  archivedCache.clear();
  const user = await whoami();
  const repos = await myRepos();

  const shortByPath = new Map(repos.filter((r) => r.short).map((r) => [r.path, r.short]));

  const [authored, reviewing, ...repoResults] = await Promise.all([
    fetchMrList("scope=created_by_me"),
    fetchMrList(`reviewer_username=${user}`),
    ...repos.map(({ path }) => fetchProjectMrList(path).then(
      (mrs) => ({ ok: true, mrs }),
      (err) => ({ ok: false, path, error: err.message }),
    )),
  ]);

  const repoErrors = repoResults.filter((r) => !r.ok).map((r) => `${r.path}: ${r.error.trim()}`);
  const repoLists = repoResults.filter((r) => r.ok).map((r) => r.mrs);
  if (repoErrors.length) console.error(`[mr-triage] ${repoErrors.length} repos.json entr(ies) failed:`, repoErrors);

  const authoredKeys = new Set(authored.map((m) => `${m.project_id}!${m.iid}`));
  const reviewingKeys = new Set(reviewing.map((m) => `${m.project_id}!${m.iid}`));

  const byKey = new Map();
  for (const mr of [...authored, ...reviewing, ...repoLists.flat()]) {
    byKey.set(`${mr.project_id}!${mr.iid}`, mr);
  }
  console.log(`[mr-triage] refresh: ${byKey.size} MR(s) across ${repos.length} configured repo(s), fetching detail…`);

  const detailResults = await Promise.all(
    [...byKey.values()].map((mr) => fetchDetail(mr).then(
      (d) => ({ ok: true, d }),
      (err) => ({ ok: false, mr, error: err.message }),
    )),
  );
  const detailErrors = detailResults.filter((r) => !r.ok);
  if (detailErrors.length) {
    console.error(
      `[mr-triage] ${detailErrors.length} MR detail fetch(es) failed:`,
      detailErrors.map((r) => `${r.mr.references?.full ?? r.mr.web_url}: ${r.error}`),
    );
  }
  const details = detailResults.filter((r) => r.ok && r.d !== null).map((r) => r.d);

  for (const d of details) {
    const key = `${d.project_id}!${d.iid}`;
    d.relationship = authoredKeys.has(key) ? "authored" : reviewingKeys.has(key) ? "reviewing" : "other";
  }

  const groups = new Map();
  for (const d of details) {
    if (!groups.has(d.project)) groups.set(d.project, []);
    groups.get(d.project).push(d);
  }

  const byUrgencyThenRecency = (a, b) =>
    Number(b.urgent) - Number(a.urgent) || new Date(b.updated_at) - new Date(a.updated_at);

  const sortedGroups = [...groups.entries()]
    .map(([project, mrs]) => ({ project, short: shortByPath.get(project) ?? null, mrs: mrs.sort(byUrgencyThenRecency) }))
    .sort((a, b) => Number(b.mrs.some((m) => m.urgent)) - Number(a.mrs.some((m) => m.urgent)) || a.project.localeCompare(b.project));

  console.log(`[mr-triage] refresh done: ${sortedGroups.length} group(s), ${details.length} MR(s) shown`);
  return { groups: sortedGroups, warnings: [...repoErrors, ...detailErrors.map((r) => `${r.mr.web_url}: ${r.error}`)] };
}

// ponytail: single shared cache refreshed on a timer, all clients just poll it — no per-client state
let cache = { groups: [], warnings: [], fetchedAt: null, error: null };
async function refresh() {
  try {
    const { groups, warnings } = await loadMrs();
    cache = { groups, warnings, fetchedAt: new Date().toISOString(), error: null };
  } catch (err) {
    console.error("[mr-triage] refresh failed:", err);
    cache = { ...cache, error: err.message, fetchedAt: new Date().toISOString() };
  }
}

function parseMrUrl(mrUrl) {
  const m = /^https:\/\/gitlab\.com\/(.+)\/-\/merge_requests\/(\d+)/.exec(mrUrl);
  return m ? { path: m[1], iid: m[2] } : null;
}

// A tracked task's MR can be open, merged, or closed. Open: just the normal
// review-status badges (pipeline/approval/rebase). Merged: find the pipeline
// GitLab ran against the merge commit on the target branch — that's the
// deploy/release pipeline, not the MR's own (now-irrelevant) CI pipeline —
// its success is what "Released" means for the task.
async function fetchTaskMrStatus(mrUrl) {
  const parsed = parseMrUrl(mrUrl);
  if (!parsed) throw new Error("unrecognized MR URL");

  const detail = await glabApi(`projects/${encodeURIComponent(parsed.path)}/merge_requests/${parsed.iid}`);
  const base = { web_url: detail.web_url, title: detail.title, iid: detail.iid };

  if (detail.state === "opened") {
    const approvals = await glabApi(`projects/${detail.project_id}/merge_requests/${detail.iid}/approvals`);
    const pipeline = detail.head_pipeline
      ? { id: detail.head_pipeline.id, status: detail.head_pipeline.status, web_url: detail.head_pipeline.web_url }
      : null;
    return {
      ...base,
      merged: false,
      pipeline,
      approved: approvals.approved,
      approvals_left: approvals.approvals_left,
      needs_rebase: detail.detailed_merge_status === "need_rebase",
    };
  }

  if (detail.state !== "merged") return { ...base, merged: false, closed: true };

  let pipeline = null;
  const sha = detail.merge_commit_sha || detail.squash_commit_sha || detail.sha;
  if (sha) {
    const pipelines = await glabApi(`projects/${detail.project_id}/pipelines?sha=${sha}&per_page=5`);
    const match = (pipelines || []).find((p) => p.ref === detail.target_branch) ?? (pipelines || [])[0];
    if (match) pipeline = { id: match.id, status: match.status, web_url: match.web_url };
  }
  return { ...base, merged: true, pipeline };
}

// ── task tracking ──────────────────────────────────────────
// Tasks live outside the repo, keyed by an install-independent path, so a
// globally-installed `track-work` skill can find them regardless of where
// mr-triage itself is checked out.
const TASKS_FILE = join(CONFIG_DIR, "tasks.json");

async function loadTasks() {
  try {
    return JSON.parse(await readFile(TASKS_FILE, "utf8"));
  } catch {
    return [];
  }
}

async function saveTasks(tasks) {
  await mkdir(dirname(TASKS_FILE), { recursive: true });
  await writeFile(TASKS_FILE, JSON.stringify(tasks, null, 2));
}

function taskId(repo, branch) {
  return `${repo}#${branch}`;
}

async function upsertTask({ repo, branch, title, linear_url, mr_url }) {
  if (!repo || !branch) throw new Error("repo and branch are required");
  const tasks = await loadTasks();
  const id = taskId(repo, branch);
  const now = new Date().toISOString();
  let task = tasks.find((t) => t.id === id);
  if (!task) {
    task = {
      id, repo, branch,
      title: title || branch,
      linear_url: linear_url || null,
      mr_url: mr_url || null,
      state: mr_url ? "in_review" : "working",
      created_at: now, updated_at: now,
    };
    tasks.push(task);
  } else {
    if (title) task.title = title;
    if (linear_url) task.linear_url = linear_url;
    if (mr_url) {
      task.mr_url = mr_url;
      if (task.state === "working") task.state = "in_review";
    }
    task.updated_at = now;
  }
  await saveTasks(tasks);
  return task;
}

const TASK_STATES = ["working", "in_review", "released", "testing", "done"];
async function transitionTask(id, state) {
  if (!TASK_STATES.includes(state)) throw new Error(`unknown state: ${state}`);
  const tasks = await loadTasks();
  const task = tasks.find((t) => t.id === id);
  if (!task) throw new Error("task not found");
  task.state = state;
  task.updated_at = new Date().toISOString();
  await saveTasks(tasks);
  return task;
}

// ponytail: live GitLab status per in-review task (pipeline/approval, plus
// the merge+release check) is too slow to compute inside a request — each
// task costs a couple of sequential `glab` process spawns. Same fix as the
// MR list: a background timer refreshes a cache; GET /api/tasks just reads
// tasks.json (fast) and re-attaches whatever the cache last found.
const taskLiveStatus = new Map(); // task id -> mr_status

async function refreshTaskLiveStatus() {
  const tasks = await loadTasks();
  const inReview = tasks.filter((t) => t.state === "in_review" && t.mr_url);
  const statuses = await Promise.all(
    inReview.map((t) => fetchTaskMrStatus(t.mr_url).then(
      (status) => ({ ok: true, status }),
      () => ({ ok: false }),
    )),
  );

  const releasedIds = [];
  inReview.forEach((t, i) => {
    const s = statuses[i];
    if (!s.ok) return;
    taskLiveStatus.set(t.id, s.status);
    if (s.status.merged && s.status.pipeline && s.status.pipeline.status === "success") releasedIds.push(t.id);
  });

  if (releasedIds.length) {
    const now = new Date().toISOString();
    tasks.forEach((t) => { if (releasedIds.includes(t.id)) { t.state = "released"; t.updated_at = now; } });
    await saveTasks(tasks);
  }
}

async function tasksWithLiveStatus() {
  const tasks = await loadTasks();
  return tasks.map((t) => (taskLiveStatus.has(t.id) ? { ...t, mr_status: taskLiveStatus.get(t.id) } : t));
}

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");

  if (url.pathname === "/api/mrs") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(cache));
    return;
  }

  if (url.pathname === "/api/tasks" && req.method === "GET") {
    try {
      const tasks = await tasksWithLiveStatus();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ tasks }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (url.pathname === "/api/tasks" && req.method === "POST") {
    let body = "";
    for await (const chunk of req) body += chunk;
    try {
      const task = await upsertTask(JSON.parse(body || "{}"));
      refreshTaskLiveStatus();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(task));
    } catch (err) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  const taskStateMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/state$/);
  if (taskStateMatch && req.method === "POST") {
    let body = "";
    for await (const chunk of req) body += chunk;
    try {
      const { state } = JSON.parse(body || "{}");
      const task = await transitionTask(decodeURIComponent(taskStateMatch[1]), state);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(task));
    } catch (err) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  const jobsMatch = url.pathname.match(/^\/api\/pipelines\/(\d+)\/(\d+)\/jobs$/);
  if (jobsMatch && req.method === "GET") {
    const [, projectId, pipelineId] = jobsMatch;
    const scopes = (url.searchParams.get("scope") || "failed").split(",");
    const scopeQuery = scopes.map((s) => `scope[]=${s}`).join("&");
    try {
      const jobs = await glabApi(`projects/${projectId}/pipelines/${pipelineId}/jobs?${scopeQuery}&per_page=50`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify(
          (jobs || []).map((j) => ({
            name: j.name,
            web_url: j.web_url,
            status: j.status,
            started_at: j.started_at,
            duration: j.duration,
          })),
        ),
      );
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  const retryMatch = url.pathname.match(/^\/api\/pipelines\/(\d+)\/(\d+)\/retry$/);
  if (retryMatch && req.method === "POST") {
    const [, projectId, pipelineId] = retryMatch;
    try {
      await glabApi(`projects/${projectId}/pipelines/${pipelineId}/retry`, "POST");
      refresh();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return;
  }

  const filePath = join(__dirname, "public", url.pathname === "/" ? "index.html" : url.pathname);
  try {
    const body = await readFile(filePath);
    res.writeHead(200, { "Content-Type": MIME[extname(filePath)] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
});

await migrateLegacyReposFile();
refresh();
setInterval(refresh, POLL_MS);
refreshTaskLiveStatus();
setInterval(refreshTaskLiveStatus, POLL_MS);
server.listen(PORT, () => console.log(`mr-triage → http://localhost:${PORT}`));
