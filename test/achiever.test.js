import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { AchievementRunner, parseQuietHours, inQuietHours } from "../src/achiever.js";
import { buildUnlock } from "../src/steam-stats.js";

// Keep runner logs out of the test report
console.log = () => {};
console.warn = () => {};

const HOUR = 3_600_000;
const MINUTE = 60_000;
const APP = 480;

let statePath;
beforeEach(() => {
  statePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "achiever-")), "state.json");
});

function snapshot(unlocked = []) {
  return {
    appId: APP,
    crcStats: 1,
    blocks: { 1: 0 },
    stats: [],
    achievements: ["ACH_A", "ACH_B"].map((apiName, bit) => ({
      apiName,
      name: apiName,
      blockId: 1,
      bit,
      protected: false,
      progressStat: null,
      unlocked: unlocked.includes(apiName),
      unlockTime: unlocked.includes(apiName) ? 1 : 0,
    })),
  };
}

/** Runner wired to fakes; `world` exposes the knobs tests turn. */
function setup(overrides = {}) {
  const world = {
    now: new Date(2026, 0, 1, 12, 0).getTime(), // local noon
    played: 0,
    unlocked: [],
    stores: [],
    readError: null,
    storeError: null,
  };
  const api = {
    getUserStats: async () => {
      if (world.readError) throw new Error(world.readError);
      return snapshot(world.unlocked);
    },
    fetchGlobalPercentages: async () => ({ ACH_A: 80, ACH_B: 20 }),
    buildUnlock,
    storeStats: async (client, snap, writes) => {
      if (world.storeError) throw new Error(world.storeError);
      world.stores.push(writes);
      return { failedValidation: [], outOfDate: false };
    },
  };
  const scheduler = { playedNow: () => world.played };
  const settings = {
    enabled: true,
    dryRun: false,
    hoursEach: 1,
    minHours: 0,
    maxHours: 100,
    jitterPercent: 0,
    order: "rarity",
    completion: 100,
    burstChance: 0,
    includeProgress: true,
    quietHours: "off",
    warmupMinutes: 15,
    exclude: [],
    skipGames: [],
    stateFile: statePath,
    ...overrides,
  };
  const make = () =>
    new AchievementRunner({ client: { steamID: {} }, scheduler, settings, api, now: () => world.now });
  return { world, settings, make, runner: make() };
}

/** Start a session, let warm-up pass and idle well past the whole plan. */
function idleThroughPlan(world, runner) {
  runner.onActive([APP]);
  world.now += 20 * MINUTE;
  world.played += 10 * HOUR;
}

test("plan is anchored at the game's idle total when created", async () => {
  const { world, runner } = setup();
  world.played = 5 * HOUR;
  await runner.prepare([APP]);
  const plan = runner.state.games[APP];
  assert.equal(plan.status, "planned");
  assert.equal(plan.baselineMs, 5 * HOUR);
  assert.equal(plan.entries.length, 2);
  assert.ok(fs.existsSync(statePath));
});

test("nothing unlocks before the entry is due", async () => {
  const { world, runner } = setup();
  await runner.prepare([APP]);
  runner.onActive([APP]);
  world.now += 20 * MINUTE;
  await runner.tick();
  assert.equal(world.stores.length, 0);
});

test("unlocks one achievement per tick once due, common one first", async () => {
  const { world, runner } = setup();
  await runner.prepare([APP]);
  idleThroughPlan(world, runner);

  await runner.tick();
  assert.equal(world.stores.length, 1);
  assert.deepEqual(world.stores[0][0], { kind: "achievement", id: 1, name: "block 1 bit 0", from: 0, to: 1 });

  await runner.tick();
  assert.equal(world.stores.length, 2);
  assert.equal(runner.state.games[APP].status, "complete");
});

test("warm-up holds unlocks at the start of a session", async () => {
  const { world, runner } = setup();
  await runner.prepare([APP]);
  runner.onActive([APP]);
  world.played += 10 * HOUR;
  world.now += 5 * MINUTE;
  await runner.tick();
  assert.equal(world.stores.length, 0);

  world.now += 11 * MINUTE;
  await runner.tick();
  assert.equal(world.stores.length, 1);
});

test("only games idling right now progress", async () => {
  const { world, runner } = setup();
  await runner.prepare([APP]);
  idleThroughPlan(world, runner);
  runner.pause(); // e.g. disconnected
  await runner.tick();
  assert.equal(world.stores.length, 0);
});

test("quiet hours hold unlocks", async () => {
  const { world, runner } = setup({ quietHours: "02-08" });
  await runner.prepare([APP]);
  world.now = new Date(2026, 0, 1, 3, 0).getTime();
  idleThroughPlan(world, runner);
  await runner.tick();
  assert.equal(world.stores.length, 0);
  assert.match(runner.status(APP), /quiet hours/);
});

test("dry-run logs instead of writing", async () => {
  const { world, runner } = setup({ dryRun: true });
  await runner.prepare([APP]);
  idleThroughPlan(world, runner);
  await runner.tick();
  await runner.tick();
  assert.equal(world.stores.length, 0);
  assert.deepEqual(
    runner.state.games[APP].entries.map((e) => e.result),
    ["dry-run", "dry-run"]
  );
});

test("turning dry-run off rebuilds the plan from Steam's state", async () => {
  const dry = setup({ dryRun: true });
  await dry.runner.prepare([APP]);

  const live = setup({ dryRun: false });
  fs.copyFileSync(statePath, live.settings.stateFile);
  live.world.played = 7 * HOUR;
  await live.runner.prepare([APP]);
  const plan = live.runner.state.games[APP];
  assert.equal(plan.dryRun, false);
  assert.equal(plan.baselineMs, 7 * HOUR);
});

test("a plan survives restart and is not rebuilt", async () => {
  const { world, make, runner } = setup();
  await runner.prepare([APP]);
  const seed = runner.state.games[APP].seed;
  world.played = 3 * HOUR;
  const restarted = make();
  await restarted.prepare([APP]);
  assert.equal(restarted.state.games[APP].seed, seed);
});

test("skips achievements the player unlocked in the meantime", async () => {
  const { world, runner } = setup();
  await runner.prepare([APP]);
  world.unlocked = ["ACH_A"];
  idleThroughPlan(world, runner);
  await runner.tick();
  assert.equal(world.stores.length, 0);
  assert.equal(runner.state.games[APP].entries[0].result, "already unlocked");
});

test("games without achievements are marked unsupported", async () => {
  const { world, runner } = setup();
  world.readError = "Steam returned no stats schema for 480 (game may have no achievements)";
  await runner.prepare([APP]);
  assert.equal(runner.state.games[APP].status, "unsupported");
  assert.equal(runner.status(APP), null);
});

test("transient read errors leave no plan so the next login retries", async () => {
  const { world, runner } = setup();
  world.readError = "No response to ClientGetUserStats within 15s";
  await runner.prepare([APP]);
  assert.equal(runner.state.games[APP], undefined);
});

test("write failures retry, then give up after three tries", async () => {
  const { world, runner } = setup();
  await runner.prepare([APP]);
  idleThroughPlan(world, runner);
  world.storeError = "boom";
  await runner.tick();
  await runner.tick();
  assert.equal(runner.state.games[APP].entries[0].done, undefined);
  await runner.tick();
  assert.match(runner.state.games[APP].entries[0].result, /^failed: boom/);
});

test("skip list keeps games out of planning", async () => {
  const { runner } = setup({ skipGames: [APP] });
  await runner.prepare([APP]);
  assert.equal(runner.state.games[APP], undefined);
});

test("status reports progress and time to the next unlock", async () => {
  const { world, runner } = setup();
  await runner.prepare([APP]);
  assert.match(runner.status(APP), /^0\/2 achievements, next in ~\d+m of idle$/);
  idleThroughPlan(world, runner);
  await runner.tick();
  await runner.tick();
  assert.equal(runner.status(APP), "2/2 achievements, done");
});

test("quiet hours parse and wrap past midnight", () => {
  assert.deepEqual(parseQuietHours("02-08"), { start: 2, end: 8 });
  assert.equal(parseQuietHours("off"), null);
  assert.equal(parseQuietHours(""), null);
  const night = parseQuietHours("22-06");
  assert.equal(inQuietHours(new Date(2026, 0, 1, 23), night), true);
  assert.equal(inQuietHours(new Date(2026, 0, 1, 5), night), true);
  assert.equal(inQuietHours(new Date(2026, 0, 1, 6), night), false);
  assert.equal(inQuietHours(new Date(2026, 0, 1, 12), night), false);
});
