import { test } from "node:test";
import assert from "node:assert/strict";
import { repoKey, groupByRepo, isStringList } from "../view.mjs";

test("repoKey separates hosts and defaults to GitLab", () => {
  assert.equal(repoKey("github", "acme/app"), "github:acme/app");
  assert.equal(repoKey(undefined, "acme/app"), "gitlab:acme/app");
  assert.notEqual(repoKey("github", "acme/app"), repoKey("gitlab", "acme/app"));
});

test("groupByRepo keeps same-path repos from different hosts apart", () => {
  const groups = groupByRepo([
    { project: "acme/app", iid: 1 },
    { project: "acme/app", iid: 2, host: "github" },
    { project: "acme/app", iid: 3 },
  ]);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map((g) => [g.host, g.mrs.length]), [["gitlab", 2], ["github", 1]]);
});

test("isStringList accepts only string arrays", () => {
  assert.equal(isStringList(["a", "b"]), true);
  assert.equal(isStringList([]), true);
  assert.equal(isStringList(["a", 1]), false);
  assert.equal(isStringList("a"), false);
});
