import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 4931;
const POLL_MS = 20_000;

function glab(args) {
  return new Promise((resolve, reject) => {
    execFile("glab", args, { maxBuffer: 1024 * 1024 * 32 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve(stdout);
    });
  });
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

async function myRepos() {
  try {
    const raw = await readFile(join(__dirname, "repos.json"), "utf8");
    return JSON.parse(raw);
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
// ourselves. Lost on restart; acceptable since wayfinder is meant to stay running.
const lastApproved = new Map();

async function fetchDetail(mr) {
  const key = `${mr.project_id}!${mr.iid}`;
  const [detail, approvals] = await Promise.all([
    glabApi(`projects/${mr.project_id}/merge_requests/${mr.iid}`),
    glabApi(`projects/${mr.project_id}/merge_requests/${mr.iid}/approvals`),
  ]);

  const wasApproved = lastApproved.get(key);
  const needsReReview = wasApproved === true && approvals.approved === false;
  lastApproved.set(key, approvals.approved);

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
    author: mr.author?.username,
    draft: mr.draft,
    updated_at: mr.updated_at,
    merge_status: detail.detailed_merge_status,
    needs_rebase: needsRebase,
    needs_re_review: needsReReview,
    pipeline,
    urgent: Boolean(pipelineFailed || needsRebase || needsReReview),
  };
}

async function loadMrs() {
  const user = await whoami();
  const repos = await myRepos();

  const [authored, reviewing, ...repoLists] = await Promise.all([
    fetchMrList("scope=created_by_me"),
    fetchMrList(`reviewer_username=${user}`),
    ...repos.map(fetchProjectMrList),
  ]);

  const authoredKeys = new Set(authored.map((m) => `${m.project_id}!${m.iid}`));
  const reviewingKeys = new Set(reviewing.map((m) => `${m.project_id}!${m.iid}`));

  const byKey = new Map();
  for (const mr of [...authored, ...reviewing, ...repoLists.flat()]) {
    byKey.set(`${mr.project_id}!${mr.iid}`, mr);
  }

  const details = await Promise.all([...byKey.values()].map(fetchDetail));
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

  return [...groups.entries()]
    .map(([project, mrs]) => ({ project, mrs: mrs.sort(byUrgencyThenRecency) }))
    .sort((a, b) => Number(b.mrs.some((m) => m.urgent)) - Number(a.mrs.some((m) => m.urgent)) || a.project.localeCompare(b.project));
}

// ponytail: single shared cache refreshed on a timer, all clients just poll it — no per-client state
let cache = { groups: [], fetchedAt: null, error: null };
async function refresh() {
  try {
    cache = { groups: await loadMrs(), fetchedAt: new Date().toISOString(), error: null };
  } catch (err) {
    cache = { ...cache, error: err.message, fetchedAt: new Date().toISOString() };
  }
}

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");

  if (url.pathname === "/api/mrs") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(cache));
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

refresh();
setInterval(refresh, POLL_MS);
server.listen(PORT, () => console.log(`wayfinder → http://localhost:${PORT}`));
