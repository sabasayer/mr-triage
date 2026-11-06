export const repoKey = (host, project) => `${host ?? "gitlab"}:${project}`;

export function groupByRepo(details) {
  const groups = new Map();
  for (const d of details) {
    const key = repoKey(d.host, d.project);
    if (!groups.has(key)) groups.set(key, { host: d.host ?? "gitlab", project: d.project, mrs: [] });
    groups.get(key).mrs.push(d);
  }
  return [...groups.values()];
}

export const isStringList = (v) => Array.isArray(v) && v.every((s) => typeof s === "string");

export const mrKey = (group, mr) =>
  `${group.short ?? group.project.split("/").pop()}${group.host === "github" ? "#" : "!"}${mr.iid}`;

const PIPELINE_ICON = { success: "ok", failed: "fail", running: "run" };
const isBot = (mr) => /_bot_/.test(mr.author ?? "");

function marks(mr) {
  const blockers = [
    [mr.has_conflicts, "conflicts"],
    [mr.needs_rebase, "rebase"],
    [mr.has_unresolved_threads, "threads"],
    [mr.needs_re_review, "re-review"],
  ].filter(([on]) => on).map(([, text]) => ({ text, tone: "amber" }));
  if (mr.approved) blockers.push({ text: "approved", tone: "green" });
  if (mr.draft) blockers.push({ text: "draft", tone: "mute" });
  return blockers;
}

export function consoleFeed(cache, origin, hidden = {}) {
  const hiddenAuthors = new Set(hidden.authors);
  const hiddenRepos = new Set(hidden.repos);
  const all = cache.groups
    .filter((g) => !hiddenRepos.has(repoKey(g.host, g.project)))
    .flatMap((g) => g.mrs.map((mr) => ({ ...mr, key: mrKey(g, mr) })))
    .filter((mr) => !hiddenAuthors.has(mr.author));
  const mrs = all.filter((mr) => !isBot(mr)).sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
  const item = (mr, level) => ({
    key: mr.key,
    title: mr.title,
    detail: mr.relationship === "authored" ? mr.key : `${mr.key} · ${mr.author}`,
    level,
    since: mr.updated_at,
    icon: PIPELINE_ICON[mr.pipeline?.status] ?? "idle",
    marks: marks(mr),
    url: mr.web_url,
  });
  const byRelationship = (rel) => mrs.filter((mr) => mr.relationship === rel);
  const review = byRelationship("reviewing").map((mr) => item(mr, "soon"));
  const mine = byRelationship("authored").map((mr) => item(mr, mr.urgent ? "now" : "fyi"));
  const team = byRelationship("other").map((mr) => item(mr, "fyi"));
  const urgentMine = mine.filter((i) => i.level === "now").length;
  const bots = all.length - mrs.length;

  return {
    version: 1,
    id: "mrs",
    name: "MRs",
    color: "#9b6ae0",
    size: "l",
    updatedAt: cache.dataAt,
    app: { url: `${origin}/`, open: `${origin}/?q={key}` },
    tile: {
      value: urgentMine + review.length,
      label: "MRs need you",
      detail: `${mine.length} mine · ${review.length} to review · ${team.length} team`,
      level: urgentMine ? "now" : review.length ? "soon" : "calm",
    },
    groups: [
      { title: "To review", items: review },
      { title: "Mine", items: mine },
      { title: "Team", items: team },
    ].filter((g) => g.items.length),
    empty: "No open MRs.",
    ...(bots && { footer: `${bots} bot MRs hidden` }),
  };
}
