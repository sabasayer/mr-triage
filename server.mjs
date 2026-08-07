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

// ponytail: entries can be a plain path string, or {path, short} when the
// auto-derived avatar letter collides (e.g. everything starting with "xds-")
async function myRepos() {
  try {
    const raw = await readFile(join(__dirname, "repos.json"), "utf8");
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
// ourselves. Lost on restart; acceptable since wayfinder is meant to stay running.
const lastApproved = new Map();

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
    approved: approvals.approved,
    approvals_left: approvals.approvals_left,
    needs_rebase: needsRebase,
    needs_re_review: needsReReview,
    pipeline,
    urgent: Boolean(pipelineFailed || needsRebase || needsReReview),
  };
}

async function loadMrs() {
  console.log("[wayfinder] refresh: fetching MR lists…");
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
  if (repoErrors.length) console.error(`[wayfinder] ${repoErrors.length} repos.json entr(ies) failed:`, repoErrors);

  const authoredKeys = new Set(authored.map((m) => `${m.project_id}!${m.iid}`));
  const reviewingKeys = new Set(reviewing.map((m) => `${m.project_id}!${m.iid}`));

  const byKey = new Map();
  for (const mr of [...authored, ...reviewing, ...repoLists.flat()]) {
    byKey.set(`${mr.project_id}!${mr.iid}`, mr);
  }
  console.log(`[wayfinder] refresh: ${byKey.size} MR(s) across ${repos.length} configured repo(s), fetching detail…`);

  const detailResults = await Promise.all(
    [...byKey.values()].map((mr) => fetchDetail(mr).then(
      (d) => ({ ok: true, d }),
      (err) => ({ ok: false, mr, error: err.message }),
    )),
  );
  const detailErrors = detailResults.filter((r) => !r.ok);
  if (detailErrors.length) {
    console.error(
      `[wayfinder] ${detailErrors.length} MR detail fetch(es) failed:`,
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

  console.log(`[wayfinder] refresh done: ${sortedGroups.length} group(s), ${details.length} MR(s) shown`);
  return { groups: sortedGroups, warnings: [...repoErrors, ...detailErrors.map((r) => `${r.mr.web_url}: ${r.error}`)] };
}

// ponytail: single shared cache refreshed on a timer, all clients just poll it — no per-client state
let cache = { groups: [], warnings: [], fetchedAt: null, error: null };
async function refresh() {
  try {
    const { groups, warnings } = await loadMrs();
    cache = { groups, warnings, fetchedAt: new Date().toISOString(), error: null };
  } catch (err) {
    console.error("[wayfinder] refresh failed:", err);
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
