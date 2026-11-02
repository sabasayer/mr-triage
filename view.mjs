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
