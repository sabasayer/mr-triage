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

async function fetchMrList(scopeQuery) {
  return glabApi(`merge_requests?state=opened&per_page=50&${scopeQuery}`);
}

async function fetchDetail(mr) {
  const detail = await glabApi(`projects/${mr.project_id}/merge_requests/${mr.iid}`);
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
    pipeline: detail.head_pipeline
      ? { id: detail.head_pipeline.id, status: detail.head_pipeline.status, web_url: detail.head_pipeline.web_url }
      : null,
  };
}

async function loadMrs() {
  const user = await whoami();
  const [authored, reviewing, assigned] = await Promise.all([
    fetchMrList("scope=created_by_me"),
    fetchMrList(`reviewer_username=${user}`),
    fetchMrList("scope=assigned_to_me"),
  ]);

  const byKey = new Map();
  for (const mr of [...authored, ...reviewing, ...assigned]) {
    byKey.set(`${mr.project_id}!${mr.iid}`, mr);
  }

  const details = await Promise.all([...byKey.values()].map(fetchDetail));
  const authoredKeys = new Set(authored.map((m) => `${m.project_id}!${m.iid}`));

  const mine = [];
  const toReview = [];
  for (const d of details) {
    (authoredKeys.has(`${d.project_id}!${d.iid}`) ? mine : toReview).push(d);
  }
  const byUpdated = (a, b) => new Date(b.updated_at) - new Date(a.updated_at);
  return { mine: mine.sort(byUpdated), toReview: toReview.sort(byUpdated) };
}

// ponytail: single shared cache refreshed on a timer, all clients just poll it — no per-client state
let cache = { mine: [], toReview: [], fetchedAt: null, error: null };
async function refresh() {
  try {
    cache = { ...(await loadMrs()), fetchedAt: new Date().toISOString(), error: null };
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
