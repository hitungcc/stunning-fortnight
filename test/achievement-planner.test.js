import { test } from "node:test";
import assert from "node:assert/strict";
import { planAchievements } from "../src/achievement-planner.js";

const HOUR = 3_600_000;

function game(count, { unlocked = 0 } = {}) {
  const achievements = [];
  const percentages = {};
  for (let i = 0; i < count; i++) {
    const apiName = `ACH_${i}`;
    achievements.push({ apiName, name: `Achievement ${i}`, unlocked: i < unlocked, protected: false, progressStat: null });
    percentages[apiName] = 90 - (i * 85) / count; // ACH_0 most common
  }
  return { achievements, percentages };
}

test("plans every locked achievement at 100% completion", () => {
  const plan = planAchievements({ ...game(29, { unlocked: 4 }), seed: 1 });
  assert.equal(plan.entries.length, 25);
  assert.ok(plan.entries.every((e, i) => i === 0 || e.atMs >= plan.entries[i - 1].atMs));
});

test("per-achievement pace is clamped to min/max hours", () => {
  const settings = { hoursEach: 3, minHours: 10, maxHours: 150, jitterPercent: 0 };
  assert.equal(planAchievements({ ...game(2), settings, seed: 1 }).budgetMs, 10 * HOUR);
  assert.equal(planAchievements({ ...game(20), settings, seed: 1 }).budgetMs, 60 * HOUR);
  assert.equal(planAchievements({ ...game(500), settings, seed: 1 }).budgetMs, 150 * HOUR);
});

test("jitter keeps the budget within ±N%", () => {
  for (let seed = 0; seed < 50; seed++) {
    const { budgetMs } = planAchievements({ ...game(20), settings: { jitterPercent: 20 }, seed });
    assert.ok(budgetMs >= 48 * HOUR && budgetMs <= 72 * HOUR, `seed ${seed}: ${budgetMs / HOUR}h`);
  }
});

test("last unlock lands on the budget", () => {
  const plan = planAchievements({ ...game(29), seed: 7 });
  const last = plan.entries.at(-1).atMs;
  assert.ok(Math.abs(last - plan.budgetMs) < 60_000, `${last} vs ${plan.budgetMs}`);
});

test("completion target stops short and leaves the rarest locked", () => {
  const plan = planAchievements({ ...game(20), settings: { completion: 80, order: "rarity" }, seed: 3 });
  assert.equal(plan.entries.length, 16);
  const planned = new Set(plan.entries.map((e) => e.apiName));
  assert.ok(!planned.has("ACH_19"), "rarest achievement should stay locked");
  assert.equal(plan.skipped.filter((s) => s.reason === "beyond completion target").length, 4);
});

test("completion counts achievements that are already unlocked", () => {
  const plan = planAchievements({ ...game(10, { unlocked: 9 }), settings: { completion: 80 }, seed: 1 });
  assert.equal(plan.entries.length, 0);
});

test("completion range rolls a target inside it", () => {
  for (let seed = 0; seed < 20; seed++) {
    const { completionTarget } = planAchievements({ ...game(20), settings: { completion: [80, 95] }, seed });
    assert.ok(completionTarget >= 80 && completionTarget <= 95);
  }
});

test("rarity order puts common achievements early", () => {
  const plan = planAchievements({ ...game(30), settings: { order: "rarity" }, seed: 5 });
  const firstHalf = plan.entries.slice(0, 15).reduce((s, e) => s + e.percent, 0);
  const secondHalf = plan.entries.slice(15).reduce((s, e) => s + e.percent, 0);
  assert.ok(firstHalf > secondHalf);
});

test("skips protected, stat-linked and excluded achievements", () => {
  const { achievements, percentages } = game(5);
  achievements[0].protected = true;
  achievements[1].progressStat = "kills";
  const plan = planAchievements({
    achievements,
    percentages,
    settings: { exclude: ["ACH_2"], includeProgress: false },
    seed: 1,
  });
  assert.deepEqual(plan.entries.map((e) => e.apiName).sort(), ["ACH_3", "ACH_4"]);

  const withProgress = planAchievements({ achievements, percentages, seed: 1 });
  assert.equal(withProgress.entries.length, 4, "stat-linked achievements are planned by default");
});

test("same seed gives the same plan", () => {
  const a = planAchievements({ ...game(29), seed: 42 });
  const b = planAchievements({ ...game(29), seed: 42 });
  assert.deepEqual(a, b);
});

test("missing global percentages fall back without breaking", () => {
  const { achievements } = game(10);
  const plan = planAchievements({ achievements, percentages: {}, seed: 1 });
  assert.equal(plan.entries.length, 10);
  assert.ok(plan.entries.every((e) => !e.percentKnown));
});
