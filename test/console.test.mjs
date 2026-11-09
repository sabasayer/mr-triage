import { test } from "node:test";
import assert from "node:assert/strict";
import { consoleFeed, mrKey } from "../view.mjs";

const mr = (over) => ({
  iid: 1, title: "t", web_url: "https://x/1", author: "salih", updated_at: "2026-11-05T08:00:00Z",
  relationship: "other", urgent: false, draft: false, approved: false, pipeline: { status: "success" }, ...over,
});

const cache = (mrs, dataAt = "2026-11-05T09:00:00Z") => ({
  dataAt,
  fetchedAt: "2026-11-05T09:30:00Z",
  groups: [{ host: "gitlab", project: "acme/viewer", short: "VW", mrs }],
});

test("mrKey uses the repo short, else the last path segment", () => {
  assert.equal(mrKey({ host: "gitlab", project: "acme/viewer", short: "VW" }, { iid: 5 }), "VW!5");
  assert.equal(mrKey({ host: "gitlab", project: "acme/viewer", short: null }, { iid: 5 }), "viewer!5");
  assert.equal(mrKey({ host: "github", project: "acme/api", short: null }, { iid: 5 }), "api#5");
});

test("feed has the panel shape and uses the data time", () => {
  const feed = consoleFeed(cache([mr({ relationship: "reviewing" }), mr({ iid: 2, relationship: "authored" }), mr({ iid: 3 })]), "http://127.0.0.1:4931");
  assert.equal(feed.version, 1);
  assert.equal(feed.id, "mrs");
  assert.equal(feed.name, "MRs");
  assert.equal(feed.size, "l");
  assert.match(feed.color, /^#[0-9a-f]{6}$/i);
  assert.equal(feed.updatedAt, "2026-11-05T09:00:00Z");
  assert.deepEqual(feed.app, { url: "http://127.0.0.1:4931/", open: "http://127.0.0.1:4931/?q={key}" });
  assert.deepEqual(feed.groups.map((g) => g.title), ["To review", "Mine", "Team"]);
});

test("item levels, icons, marks and bot hiding", () => {
  const feed = consoleFeed(cache([
    mr({ iid: 1, relationship: "reviewing", author: "ann", pipeline: { status: "running" } }),
    mr({ iid: 2, relationship: "authored", urgent: true, has_conflicts: true, pipeline: { status: "failed" } }),
    mr({ iid: 3, relationship: "authored", approved: true, draft: true, pipeline: null, updated_at: "2026-11-05T08:30:00Z" }),
    mr({ iid: 4, author: "bob", has_unresolved_threads: true }),
    mr({ iid: 5, author: "project_12_bot_abc" }),
    mr({ iid: 6, author: "group_9_bot_xyz", relationship: "reviewing" }),
  ]), "http://127.0.0.1:4931");
  const [review, mine, team] = feed.groups;

  assert.deepEqual(review.items.map((i) => [i.key, i.level, i.icon]), [["VW!1", "soon", "run"]]);
  assert.deepEqual(mine.items.map((i) => [i.key, i.level, i.icon]), [["VW!3", "fyi", "idle"], ["VW!2", "now", "fail"]]);
  assert.deepEqual(mine.items[1].marks, [{ text: "conflicts", tone: "amber" }]);
  assert.deepEqual(mine.items[0].marks, [{ text: "approved", tone: "green" }, { text: "draft", tone: "mute" }]);
  assert.deepEqual(team.items.map((i) => [i.key, i.level, i.icon]), [["VW!4", "fyi", "ok"]]);
  assert.deepEqual(team.items[0].marks, [{ text: "threads", tone: "amber" }]);
  assert.equal(team.items[0].since, "2026-11-05T08:00:00Z");
  assert.equal(team.items[0].url, "https://x/1");
  assert.equal(feed.footer, "2 bot MRs hidden");

  assert.deepEqual(feed.tile, { value: 2, label: "MRs need you", detail: "2 mine · 1 to review · 1 team", level: "now" });
});

test("tile level is soon with only reviews, calm with neither", () => {
  const soon = consoleFeed(cache([mr({ relationship: "reviewing" }), mr({ iid: 2, relationship: "authored" })]), "http://h");
  assert.equal(soon.tile.level, "soon");
  assert.equal(soon.tile.value, 1);
  const calm = consoleFeed(cache([mr({ relationship: "authored" })]), "http://h");
  assert.equal(calm.tile.level, "calm");
  assert.equal(calm.tile.value, 0);
  assert.equal(calm.footer, undefined);
  assert.deepEqual(calm.groups.map((g) => g.title), ["Mine"]);
});

test("hidden authors and hidden repos are left out of items, tile and footer", () => {
  const two = {
    dataAt: "2026-11-05T09:00:00Z",
    groups: [
      { host: "gitlab", project: "acme/viewer", short: "VW", mrs: [
        mr({ iid: 1, relationship: "reviewing", author: "ann" }),
        mr({ iid: 2, relationship: "reviewing", author: "group_9_bot_xyz" }),
        mr({ iid: 3, relationship: "authored", urgent: true }),
      ] },
      { host: "gitlab", project: "acme/noisy", short: "NZ", mrs: [
        mr({ iid: 4, relationship: "reviewing", author: "ann" }),
        mr({ iid: 5, relationship: "other", author: "bob" }),
      ] },
    ],
  };
  const feed = consoleFeed(two, "http://h", { authors: ["group_9_bot_xyz"], repos: ["gitlab:acme/noisy"] });
  const keys = feed.groups.flatMap((g) => g.items.map((i) => i.key));
  assert.deepEqual(keys.sort(), ["VW!1", "VW!3"]);
  assert.equal(feed.tile.value, 2);
  assert.equal(feed.tile.detail, "1 mine · 1 to review · 0 team");
  assert.equal(feed.footer, undefined);

  const unhidden = consoleFeed(two, "http://h");
  assert.equal(unhidden.groups.flatMap((g) => g.items).length, 4);
});

test("priority follows the console rubric bands", () => {
  const feed = consoleFeed(cache([
    mr({ iid: 1, relationship: "reviewing", author: "ann" }),
    mr({ iid: 2, relationship: "authored", urgent: true, pipeline: { status: "failed" } }),
    mr({ iid: 3, relationship: "authored" }),
    mr({ iid: 4, author: "bob" }),
    mr({ iid: 5, relationship: "authored", has_unresolved_threads: true }),
    mr({ iid: 6, relationship: "authored", draft: true }),
    mr({ iid: 7, author: "bob", draft: true }),
  ]), "http://h");
  const byKey = Object.fromEntries(feed.groups.flatMap((g) => g.items).map((i) => [i.key, i]));
  const within = (key, min, max) =>
    assert.ok(byKey[key].priority >= min && byKey[key].priority <= max, `${key} scored ${byKey[key].priority}`);
  within("VW!1", 70, 89);
  within("VW!5", 70, 89);
  within("VW!2", 50, 69);
  within("VW!3", 30, 49);
  within("VW!4", 0, 29);
  within("VW!6", 0, 29);
  within("VW!7", 0, 29);
  assert.equal(byKey["VW!1"].level, "soon");
});

test("an older MR in the same band scores higher, and stays in its band", () => {
  const feed = consoleFeed(cache([
    mr({ iid: 1, relationship: "reviewing", updated_at: "2026-11-05T08:00:00Z" }),
    mr({ iid: 2, relationship: "reviewing", updated_at: "2026-11-03T08:00:00Z" }),
    mr({ iid: 3, relationship: "reviewing", updated_at: "2025-01-01T08:00:00Z" }),
  ]), "http://h");
  const score = Object.fromEntries(feed.groups[0].items.map((i) => [i.key, i.priority]));
  assert.ok(score["VW!2"] > score["VW!1"]);
  assert.ok(score["VW!3"] > score["VW!2"]);
  assert.ok(score["VW!3"] <= 89);
});

test("next step follows the MR state", () => {
  const feed = consoleFeed(cache([
    mr({ iid: 1, relationship: "reviewing", author: "ann" }),
    mr({ iid: 2, relationship: "authored", pipeline: { status: "failed" }, urgent: true }),
    mr({ iid: 3, relationship: "authored", has_reviewer: false }),
    mr({ iid: 4, author: "bob" }),
  ]), "http://h");
  const next = Object.fromEntries(feed.groups.flatMap((g) => g.items).map((i) => [i.key, i.next]));
  assert.equal(next["VW!1"], "Review the MR");
  assert.equal(next["VW!2"], "Fix the failed pipeline");
  assert.equal(next["VW!3"], "Assign a reviewer");
  assert.equal(next["VW!4"], undefined);
});
