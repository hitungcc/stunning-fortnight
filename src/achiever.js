import fs from "fs";
import path from "path";
import { log } from "./logger.js";
import { planAchievements } from "./achievement-planner.js";
import { formatDuration } from "./scheduler.js";
import * as steamStats from "./steam-stats.js";

/**
 * Unlocks achievements on a schedule driven by each game's idle time.
 *
 * Every configured game gets a plan (see achievement-planner.js) anchored at
 * its idle total when the plan was made. Once a minute, for each game that is
 * idling right now, the next entry fires when:
 *   - the game has idled past the entry's time,
 *   - the current session is older than the warm-up,
 *   - and we're outside quiet hours.
 *
 * Plans are persisted, so restarts pick up where they left off. A plan is
 * rebuilt from Steam's current state when the settings or dry-run flag change.
 */

const TICK_MS = 60_000;
const MAX_FAILURES = 3;
const UNSUPPORTED_RETRY_MS = 7 * 24 * 3_600_000;
const PLAN_KEYS = [
  "hoursEach",
  "minHours",
  "maxHours",
  "jitterPercent",
  "order",
  "completion",
  "burstChance",
  "includeProgress",
  "exclude",
];

/** "02-08" → { start: 2, end: 8 }; "", "off" or invalid → null. Wraps past midnight ("22-06"). */
export function parseQuietHours(raw) {
  const match = /^\s*(\d{1,2})\s*-\s*(\d{1,2})\s*$/.exec(raw || "");
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (start > 23 || end > 24 || start === end) return null;
  return { start, end };
}

export function inQuietHours(date, quiet) {
  if (!quiet) return false;
  const hour = date.getHours();
  return quiet.start < quiet.end
    ? hour >= quiet.start && hour < quiet.end
    : hour >= quiet.start || hour < quiet.end;
}

export class AchievementRunner {
  /**
   * @param {object}   opts
   * @param {object}   opts.client     logged-in steam-user client
   * @param {object}   opts.scheduler  IdleScheduler (active games + idle totals)
   * @param {object}   opts.settings   config.achievements
   * @param {(id: number) => string} [opts.nameOf]
   * @param {object}   [opts.api]      Steam calls; replaced in tests
   * @param {() => number} [opts.now]
   */
  constructor({ client, scheduler, settings, nameOf = String, api = steamStats, now = Date.now }) {
    this.client = client;
    this.scheduler = scheduler;
    this.settings = settings;
    this.nameOf = nameOf;
    this.api = api;
    this.now = now;
    this.statePath = settings.stateFile;
    this.quiet = parseQuietHours(settings.quietHours);
    this.settingsKey = JSON.stringify(PLAN_KEYS.map((k) => settings[k]));

    /** @type {Map<number, number>} appId → when its current idle session began */
    this.sessions = new Map();
    this.timer = null;
    this.busy = false;
    this.state = { games: {} };
    this.#load();
  }

  // ── Persistence ─────────────────────────────────────────────
  #load() {
    try {
      if (fs.existsSync(this.statePath)) {
        const raw = JSON.parse(fs.readFileSync(this.statePath, "utf-8"));
        this.state.games = raw.games || {};
      }
    } catch (err) {
      log.warn(`Could not read achievement state (${err.message}); starting fresh.`);
    }
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
      fs.writeFileSync(
        this.statePath,
        JSON.stringify({ updatedAt: new Date(this.now()).toISOString(), games: this.state.games }, null, 2)
      );
    } catch (err) {
      log.warn(`Could not persist achievement state: ${err.message}`);
    }
  }

  // ── Planning ────────────────────────────────────────────────
  #needsPlan(plan) {
    if (!plan) return true;
    if (plan.status === "unsupported") return this.now() - plan.checkedAt > UNSUPPORTED_RETRY_MS;
    return plan.settingsKey !== this.settingsKey || plan.dryRun !== this.settings.dryRun;
  }

  /** Build or refresh plans for the given games. Call after login. */
  async prepare(appIds) {
    for (const id of appIds) {
      if (this.settings.skipGames.includes(id)) continue;
      if (!this.#needsPlan(this.state.games[id])) continue;
      await this.#plan(id);
    }
    this.save();
  }

  async #plan(id) {
    const name = this.nameOf(id);
    let snapshot;
    try {
      snapshot = await this.api.getUserStats(this.client, id);
    } catch (err) {
      // No schema / refused = the game has nothing we can unlock; anything
      // else (timeout, disconnect) is retried on the next login.
      if (/no stats schema|refused/i.test(err.message)) {
        this.state.games[id] = { status: "unsupported", reason: err.message, checkedAt: this.now() };
        log.info(`Achievements: ${name} skipped (${err.message})`);
      } else {
        log.warn(`Achievements: could not read ${name} (${err.message}); will retry on next login.`);
      }
      return;
    }

    const percentages = await this.api.fetchGlobalPercentages(id);
    const seed = Math.floor(Math.random() * 2 ** 31);
    const plan = planAchievements({ achievements: snapshot.achievements, percentages, settings: this.settings, seed });
    const total = snapshot.achievements.length;
    const unlockedAtStart = snapshot.achievements.filter((a) => a.unlocked).length;

    this.state.games[id] = {
      status: plan.entries.length > 0 ? "planned" : "complete",
      createdAt: new Date(this.now()).toISOString(),
      settingsKey: this.settingsKey,
      dryRun: this.settings.dryRun,
      seed,
      baselineMs: this.scheduler.playedNow(id),
      budgetMs: plan.budgetMs,
      completionTarget: plan.completionTarget,
      total,
      unlockedAtStart,
      entries: plan.entries.map(({ apiName, name: title, atMs, burst }) => ({ apiName, name: title, atMs, burst })),
    };

    const mode = this.settings.dryRun ? " [dry-run]" : "";
    if (plan.entries.length === 0) {
      log.achievement(`${name}: nothing to unlock (${unlockedAtStart}/${total})${mode}`);
    } else {
      log.achievement(
        `${name}: planned ${plan.entries.length} unlock(s) over ${formatDuration(plan.budgetMs)} ` +
          `of idle (${unlockedAtStart}/${total} → ${unlockedAtStart + plan.entries.length}/${total})${mode}`
      );
    }
  }

  // ── Sessions ────────────────────────────────────────────────
  /** Record which games are idling; newly active ones start a warm-up. */
  onActive(activeIds) {
    const now = this.now();
    for (const id of [...this.sessions.keys()]) {
      if (!activeIds.includes(id)) this.sessions.delete(id);
    }
    for (const id of activeIds) {
      if (!this.sessions.has(id)) this.sessions.set(id, now);
    }
  }

  /** Idling stopped (disconnect, playing elsewhere): every session ends. */
  pause() {
    this.sessions.clear();
  }

  start() {
    this.stop();
    this.timer = setInterval(() => this.tick(), TICK_MS);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  // ── Unlocking ───────────────────────────────────────────────
  #nextEntry(plan) {
    return plan.entries.find((e) => !e.done);
  }

  /** Check every idling game once; at most one unlock per game per tick. */
  async tick() {
    if (this.busy || !this.client.steamID) return;
    if (inQuietHours(new Date(this.now()), this.quiet)) return;

    this.busy = true;
    try {
      for (const [id, since] of this.sessions) {
        const plan = this.state.games[id];
        if (plan?.status !== "planned") continue;
        if (this.now() - since < this.settings.warmupMinutes * 60_000) continue;

        const entry = this.#nextEntry(plan);
        if (!entry) continue;
        if (this.scheduler.playedNow(id) < plan.baselineMs + entry.atMs) continue;

        await this.#unlock(id, plan, entry);
        if (!this.#nextEntry(plan)) {
          plan.status = "complete";
          log.achievement(`${this.nameOf(id)}: plan complete (${this.status(id)})`);
        }
        this.save();
      }
    } finally {
      this.busy = false;
    }
  }

  async #unlock(id, plan, entry) {
    const label = `${this.nameOf(id)}: ${entry.name}`;
    const stamp = () => new Date(this.now()).toISOString();

    if (plan.dryRun) {
      log.achievement(`[dry-run] would unlock ${label}`);
      Object.assign(entry, { done: stamp(), result: "dry-run" });
      return;
    }

    try {
      // Fresh read: the CRC must be current, and the player may have
      // unlocked it themselves since the plan was made.
      const snapshot = await this.api.getUserStats(this.client, id);
      const current = snapshot.achievements.find((a) => a.apiName === entry.apiName);
      if (!current) {
        Object.assign(entry, { done: stamp(), result: "no longer in schema" });
        log.warn(`Achievements: ${label} no longer exists; skipping.`);
        return;
      }
      if (current.unlocked) {
        Object.assign(entry, { done: stamp(), result: "already unlocked" });
        log.achievement(`${label} was already unlocked`);
        return;
      }

      const { writes, notes } = this.api.buildUnlock(snapshot, entry.apiName, {
        raiseStat: this.settings.includeProgress,
      });
      const result = await this.api.storeStats(this.client, snapshot, writes);

      Object.assign(entry, { done: stamp(), result: "unlocked" });
      const stats = writes.filter((w) => w.kind === "stat").map((w) => `${w.name} ${w.from} → ${w.to}`);
      log.achievement(`Unlocked ${label}` + (stats.length ? ` (${stats.join(", ")})` : ""));
      for (const note of notes) log.debug(`Achievements: ${note}`);
      for (const f of result.failedValidation) {
        log.warn(`Achievements: Steam reverted stat ${f.id} to ${f.reverted} for ${label}`);
      }
    } catch (err) {
      entry.failures = (entry.failures || 0) + 1;
      if (entry.failures >= MAX_FAILURES) {
        Object.assign(entry, { done: stamp(), result: `failed: ${err.message}` });
        log.warn(`Achievements: giving up on ${label} after ${MAX_FAILURES} tries (${err.message})`);
      } else {
        log.warn(`Achievements: ${label} failed (${err.message}); will retry.`);
      }
    }
  }

  // ── Reporting ───────────────────────────────────────────────
  /** Heartbeat text, e.g. "12/65, next in ~2h 10m of idle"; null if no plan. */
  status(id) {
    const plan = this.state.games[id];
    if (!plan || plan.status === "unsupported") return null;

    const reached = plan.entries.filter((e) => e.done && !e.result.startsWith("failed")).length;
    const progress = `${plan.unlockedAtStart + reached}/${plan.total}`;
    const suffix = plan.dryRun ? " [dry-run]" : "";

    const next = this.#nextEntry(plan);
    if (plan.status === "complete" || !next) return `${progress} achievements, done${suffix}`;

    const remaining = plan.baselineMs + next.atMs - this.scheduler.playedNow(id);
    const when = remaining > 0 ? `next in ~${formatDuration(remaining)} of idle` : "next due now";
    const quiet = inQuietHours(new Date(this.now()), this.quiet) ? ", quiet hours" : "";
    return `${progress} achievements, ${when}${quiet}${suffix}`;
  }
}
