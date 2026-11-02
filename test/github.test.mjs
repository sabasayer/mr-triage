import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildQuery, mapPullRequest, prKey } from "../github.mjs";

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));

test("approved and green", () => {
  const mr = mapPullRequest(fixture("approved-green"), { relationship: "authored" });
  assert.equal(mr.host, "github");
  assert.equal(mr.project, "acme/app");
  assert.equal(mr.iid, 7);
  assert.equal(mr.author, "alice");
  assert.equal(mr.source_branch, "feat/thing");
  assert.equal(mr.approved, true);
  assert.equal(mr.approvals_left, 0);
  assert.equal(mr.merge_status, "mergeable");
  assert.equal(mr.pipeline.status, "success");
  assert.equal(mr.pipeline.web_url, "https://github.com/acme/app/pull/7/checks");
  assert.equal(mr.relationship, "authored");
  assert.equal(mr.urgent, false);
});

test("failing checks are urgent and show unresolved threads", () => {
  const mr = mapPullRequest(fixture("failing-checks"));
  assert.equal(mr.pipeline.status, "failed");
  assert.equal(mr.has_unresolved_threads, true);
  assert.equal(mr.urgent, true);
});

test("checks in progress count as running, queued only as pending", () => {
  assert.equal(mapPullRequest(fixture("running-checks")).pipeline.status, "running");
  const queued = fixture("running-checks");
  queued.commits.nodes[0].commit.statusCheckRollup.contexts.nodes = [{ __typename: "CheckRun", status: "QUEUED" }];
  assert.equal(mapPullRequest(queued).pipeline.status, "pending");
});

test("draft without checks has no pipeline", () => {
  const mr = mapPullRequest(fixture("draft"));
  assert.equal(mr.draft, true);
  assert.equal(mr.pipeline, null);
  assert.equal(mr.urgent, false);
});

test("conflicts and behind branch", () => {
  const conflict = mapPullRequest(fixture("conflicts"));
  assert.equal(conflict.has_conflicts, true);
  assert.equal(conflict.merge_status, "conflict");
  assert.equal(conflict.urgent, true);
  const behind = mapPullRequest(fixture("behind"));
  assert.equal(behind.needs_rebase, true);
  assert.equal(behind.has_conflicts, false);
});

test("review requested", () => {
  const mr = mapPullRequest(fixture("review-requested"), { relationship: "reviewing" });
  assert.equal(mr.relationship, "reviewing");
  assert.equal(mr.author, "bob");
  assert.equal(mr.has_reviewer, true);
  assert.equal(mr.approved, false);
  assert.equal(mr.approvals_left, 1);
});

test("approval that disappeared needs re-review", () => {
  const mr = mapPullRequest(fixture("review-requested"), { wasApproved: true });
  assert.equal(mr.needs_re_review, true);
  assert.equal(mr.urgent, true);
});

test("prKey and buildQuery", () => {
  assert.equal(prKey(fixture("draft")), "github:acme/app#10");
  const query = buildQuery(["acme/app", "acme/other"]);
  assert.match(query, /repo0: search/);
  assert.match(query, /repo:acme\/other/);
  assert.match(query, /author:@me/);
  assert.match(query, /review-requested:@me/);
});
