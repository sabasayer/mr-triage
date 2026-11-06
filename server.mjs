#!/usr/bin/env node
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";
import { homedir } from "node:os";
import { buildQuery, mapPullRequest, prKey } from "./github.mjs";
import { repoKey, groupByRepo, isStringList, mrKey, consoleFeed } from "./view.mjs";

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

function ghExec(args, stdin) {
  return new Promise((resolve, reject) => {
    const child = execFile("gh", args, { maxBuffer: 1024 * 1024 * 32 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(err.code === "ENOENT" ? "gh is not installed" : stderr || err.message));
      resolve(stdout);
    });
    if (stdin) child.stdin.end(stdin);
  });
}

async function ghGraphql(query) {
  const out = await ghExec(["api", "graphql", "--input", "-"], JSON.stringify({ query }));
  const { data, errors } = JSON.parse(out);
  if (!data) throw new Error(errors?.[0]?.message ?? "empty GraphQL answer");
  return data;
}

let me = null;
async function whoami() {
  if (!me) me = (await glabApi("user")).username;
  return me;
}

async function checkGitlab() {
  try {
    await whoami();
    return null;
  } catch (err) {
    return /ENOENT/.test(err.message) ? "glab is not installed" : err.message.trim();
  }
}

async function checkGithub() {
  try {
    await ghExec(["api", "user", "--jq", ".login"]);
    return null;
  } catch (err) {
    return err.message.trim();
  }
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
// auto-derived avatar letter collides (e.g. everything starting with "webapp-").
// GitHub repos: "github:owner/repo" or {path, host: "github"}. Anything else is GitLab.
function parseRepoEntry(e) {
  const entry = typeof e === "string" ? { path: e } : e;
  const prefixed = entry.path.startsWith("github:");
  return {
    path: prefixed ? entry.path.slice("github:".length) : entry.path,
    short: entry.short ?? null,
    host: prefixed || entry.host === "github" ? "github" : "gitlab",
  };
}

async function myRepos() {
  try {
    const raw = await readFile(REPOS_FILE, "utf8");
    return JSON.parse(raw).map(parseRepoEntry);
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
  const hasConflicts = Boolean(detail.has_conflicts);
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
    has_reviewer: Boolean(detail.reviewers?.length),
    needs_rebase: needsRebase,
    has_conflicts: hasConflicts,
    needs_re_review: needsReReview,
    has_unresolved_threads: detail.blocking_discussions_resolved === false,
    comment_count: detail.user_notes_count,
    pipeline,
    urgent: Boolean(pipelineFailed || needsRebase || hasConflicts || needsReReview),
  };
}

async function loadGitlab(repos) {
  const user = await whoami();

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

  return { details, warnings: [...repoErrors, ...detailErrors.map((r) => `${r.mr.web_url}: ${r.error}`)] };
}

// ponytail: same idea as lastApproved above, for GitHub PRs
const lastApprovedGithub = new Map();

async function loadGithub(repos) {
  const data = await ghGraphql(buildQuery(repos.map((r) => r.path)));
  const nodes = (alias) => data[alias].nodes.filter((pr) => pr?.number);

  const authoredKeys = new Set(nodes("authored").map(prKey));
  const reviewingKeys = new Set(nodes("reviewing").map(prKey));

  const byKey = new Map();
  for (const pr of [...nodes("authored"), ...nodes("reviewing"), ...repos.flatMap((_, i) => nodes(`repo${i}`))]) {
    byKey.set(prKey(pr), pr);
  }
  console.log(`[mr-triage] refresh: ${byKey.size} GitHub PR(s) across ${repos.length} configured repo(s)`);

  const details = [...byKey.entries()].map(([key, pr]) => {
    const d = mapPullRequest(pr, {
      wasApproved: lastApprovedGithub.get(key) === true,
      relationship: authoredKeys.has(key) ? "authored" : reviewingKeys.has(key) ? "reviewing" : "other",
    });
    lastApprovedGithub.set(key, d.approved);
    return d;
  });
  return { details, warnings: [] };
}

async function loadMrs() {
  console.log("[mr-triage] refresh: fetching MR lists…");
  archivedCache.clear();
  const repos = await myRepos();
  const repoPaths = (host) => repos.filter((r) => r.host === host);

  const [gitlabError, githubError] = await Promise.all([checkGitlab(), checkGithub()]);
  if (gitlabError && githubError) {
    throw new Error(`Neither source works. GitLab (glab): ${gitlabError} GitHub (gh): ${githubError}`);
  }

  const warnings = [];
  const details = [];
  const sources = [
    [gitlabError, "GitLab (glab)", () => loadGitlab(repoPaths("gitlab"))],
    [githubError, "GitHub (gh)", () => loadGithub(repoPaths("github"))],
  ];
  for (const [error, label, load] of sources) {
    if (error) {
      warnings.push(`${label} skipped: ${error}`);
      continue;
    }
    try {
      const result = await load();
      details.push(...result.details);
      warnings.push(...result.warnings);
    } catch (err) {
      console.error(`[mr-triage] ${label} failed:`, err);
      warnings.push(`${label} failed: ${err.message.trim()}`);
    }
  }

  const shortByRepo = new Map(repos.filter((r) => r.short).map((r) => [repoKey(r.host, r.path), r.short]));

  const byUrgencyThenRecency = (a, b) =>
    Number(b.urgent) - Number(a.urgent) || new Date(b.updated_at) - new Date(a.updated_at);

  const sortedGroups = groupByRepo(details)
    .map(({ host, project, mrs }) => ({ host, project, short: shortByRepo.get(repoKey(host, project)) ?? null, mrs: mrs.sort(byUrgencyThenRecency) }))
    .map((g) => ({ ...g, mrs: g.mrs.map((mr) => ({ ...mr, key: mrKey(g, mr) })) }))
    .sort((a, b) => Number(b.mrs.some((m) => m.urgent)) - Number(a.mrs.some((m) => m.urgent)) || a.project.localeCompare(b.project));

  console.log(`[mr-triage] refresh done: ${sortedGroups.length} group(s), ${details.length} MR(s) shown`);
  return { groups: sortedGroups, warnings };
}

// ponytail: single shared cache refreshed on a timer, all clients just poll it — no per-client state
let cache = { groups: [], warnings: [], fetchedAt: null, dataAt: null, error: null };
async function refresh() {
  try {
    const { groups, warnings } = await loadMrs();
    const now = new Date().toISOString();
    cache = { groups, warnings, fetchedAt: now, dataAt: now, error: null };
  } catch (err) {
    console.error("[mr-triage] refresh failed:", err);
    cache = { ...cache, error: err.message, fetchedAt: new Date().toISOString() };
  }
}

const HIDDEN_FILE = join(CONFIG_DIR, "hidden-authors.json");
const HIDDEN_REPOS_FILE = join(CONFIG_DIR, "hidden-repos.json");

async function loadStringList(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return [];
  }
}

async function serveStringList(req, res, file) {
  if (req.method === "PUT") {
    let body = "";
    for await (const chunk of req) body += chunk;
    try {
      const list = JSON.parse(body || "[]");
      if (!isStringList(list)) throw new Error("expected string[]");
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify(list));
    } catch (err) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
      return;
    }
  }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(await loadStringList(file)));
}

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");

  if (url.pathname === "/api/mrs") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(cache));
    return;
  }

  if (url.pathname === "/console.json") {
    if (!cache.dataAt) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: cache.error ?? "first refresh still running" }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    const hidden = { authors: await loadStringList(HIDDEN_FILE), repos: await loadStringList(HIDDEN_REPOS_FILE) };
    res.end(JSON.stringify(consoleFeed(cache, `http://127.0.0.1:${PORT}`, hidden)));
    return;
  }

  if (url.pathname === "/api/hidden-authors") return serveStringList(req, res, HIDDEN_FILE);
  if (url.pathname === "/api/hidden-repos") return serveStringList(req, res, HIDDEN_REPOS_FILE);

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
server.listen(PORT, () => console.log(`mr-triage → http://localhost:${PORT}`));
