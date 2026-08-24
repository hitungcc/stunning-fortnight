import fs from "fs";
import path from "path";
import { log } from "./logger.js";

/**
 * Idle scheduling modes — they differ only in how the game pool is split
 * between games that are always on and games that take turns:
 *
 *   all         every game idles together, nothing rotates (Steam's ~32 cap applies)
 *   continuous  a fixed subset idles forever; the rest are never played
 *   hybrid      a fixed subset idles forever; the rest rotate through the free slots
 *   rotate      nothing is pinned, every game takes turns (full round-robin)
 */
export const MODES = ["all", "continuous", "hybrid", "rotate"];

/** Where a game sits in the schedule — used for logging. */
export const ROLE = { PINNED: "pinned", ROTATING: "rotating", PARKED: "parked" };

export class IdleScheduler {
  /**
   * @param {object}   opts
   * @param {string}   opts.mode            One of MODES
   * @param {number[]} opts.gameIds         Full pool of App IDs
   * @param {number[]} opts.pinnedIds       Always-on App IDs (continuous/hybrid)
   * @param {number}   opts.batchSize       How many games idle at any one moment
   * @param {number}   opts.intervalMinutes Slot length for rotating modes
   * @param {number}   opts.jitterPercent   Randomises slot length by ±N%
   * @param {string}   opts.statePath       Where accumulated playtime is persisted
   */
  constructor({
    mode,
    gameIds,
    pinnedIds = [],
    batchSize,
    intervalMinutes,
    jitterPercent,
    statePath,
  }) {
    this.mode = mode;
    this.gameIds = [...gameIds];
    this.statePath = statePath;
    this.intervalMs = intervalMinutes * 60 * 1000;
    this.jitterPercent = Math.max(0, Math.min(jitterPercent, 90));

    // ── Split the pool: always-on vs takes-turns ──────────────
    switch (mode) {
      case "all":
        this.pinned = [...this.gameIds];
        this.pool = [];
        break;
      case "continuous":
        this.pinned = [...pinnedIds];
        this.pool = [];
        break;
      case "hybrid":
        this.pinned = [...pinnedIds];
        this.pool = this.gameIds.filter((id) => !this.pinned.includes(id));
        break;
      default: // "rotate"
        this.pinned = [];
        this.pool = [...this.gameIds];
    }

    // Free slots left for rotating games once the pinned ones have their seats
    this.slots = Math.max(0, Math.min(batchSize - this.pinned.length, this.pool.length));

    // Only worth running a clock if more games want slots than there are slots
    this.rotates = this.slots > 0 && this.pool.length > this.slots;

    // Games in the config that this mode will never play
    this.parked = this.gameIds.filter(
      (id) => !this.pinned.includes(id) && !this.pool.includes(id)
    );

    /** @type {Record<number, number>} accumulated idle milliseconds per App ID */
    this.played = {};
    /** @type {number[]} currently active App IDs (pinned + current batch) */
    this.active = [];
    /** timestamp of the last credit() call, or null while paused */
    this.since = null;
    this.timer = null;
    this.onChange = null;
    this.cycle = 0;

    this.#load();
  }

  /** How many games are idling at once when running. */
  get concurrent() {
    return this.pinned.length + this.slots;
  }

  // ── Persistence ─────────────────────────────────────────────
  #load() {
    let saved = {};
    try {
      if (fs.existsSync(this.statePath)) {
        const raw = JSON.parse(fs.readFileSync(this.statePath, "utf-8"));
        saved = raw.played || {};
        this.cycle = raw.cycle || 0;
      }
    } catch (err) {
      log.warn(`Could not read idle state (${err.message}); starting fresh.`);
    }

    // Seed every configured game; drop entries for games no longer configured.
    for (const id of this.gameIds) {
      this.played[id] = Number(saved[id]) || 0;
    }
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
      fs.writeFileSync(
        this.statePath,
        JSON.stringify(
          {
            updatedAt: new Date().toISOString(),
            mode: this.mode,
            cycle: this.cycle,
            played: this.played,
          },
          null,
          2
        )
      );
    } catch (err) {
      log.warn(`Could not persist idle state: ${err.message}`);
    }
  }

  // ── Accounting ──────────────────────────────────────────────
  /** Credit elapsed wall-clock time to whatever is currently active. */
  credit() {
    if (this.since === null) return;
    const elapsed = Date.now() - this.since;
    this.since = Date.now();
    if (elapsed <= 0) return;

    for (const id of this.active) {
      this.played[id] = (this.played[id] || 0) + elapsed;
    }
  }

  /** Least-idled pool games first; ties broken by cycle offset so they take turns. */
  #pick() {
    if (this.pool.length === 0 || this.slots === 0) return [];

    const offset = this.cycle % this.pool.length;
    const ordered = [...this.pool.slice(offset), ...this.pool.slice(0, offset)];

    return ordered
      .map((id, order) => ({ id, order, ms: this.played[id] || 0 }))
      .sort((a, b) => a.ms - b.ms || a.order - b.order)
      .slice(0, this.slots)
      .map((g) => g.id);
  }

  #nextDelay() {
    if (this.jitterPercent === 0) return this.intervalMs;
    const spread = (Math.random() * 2 - 1) * (this.jitterPercent / 100);
    return Math.max(60_000, Math.round(this.intervalMs * (1 + spread)));
  }

  #schedule() {
    if (!this.rotates) return;
    const delay = this.#nextDelay();
    this.timer = setTimeout(() => this.#advance(), delay);
    if (this.timer.unref) this.timer.unref();
    log.debug(`Next rotation in ${Math.round(delay / 60000)}m`);
  }

  // ── Lifecycle ───────────────────────────────────────────────
  /**
   * @param {(activeIds: number[]) => void} onChange called with each active set.
   *   Fires once for non-rotating modes, then on every slot change.
   */
  start(onChange) {
    this.onChange = onChange;
    this.stop();
    this.#advance();
  }

  #advance() {
    this.credit();
    this.cycle++;
    this.active = [...this.pinned, ...this.#pick()];
    this.since = Date.now();
    this.save();

    this.onChange?.(this.active);
    this.#schedule();
  }

  /** Stop the clock and bank the time played so far (disconnect, blocked, shutdown). */
  pause() {
    this.credit();
    this.since = null;
    this.save();
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** Resume the current set without re-picking; returns the active games. */
  resume() {
    // Nothing picked yet (start() hasn't run) — let start() drive instead.
    if (this.timer || this.active.length === 0) return this.active;
    this.since = Date.now();
    this.#schedule();
    return this.active;
  }

  stop() {
    this.pause();
  }

  /** Snapshot for logging: [{ id, ms, role }] sorted by most-idled first. */
  stats() {
    return this.gameIds
      .map((id) => ({
        id,
        ms: this.played[id] || 0,
        role: this.pinned.includes(id)
          ? ROLE.PINNED
          : this.pool.includes(id)
            ? ROLE.ROTATING
            : ROLE.PARKED,
      }))
      .sort((a, b) => b.ms - a.ms);
  }

  /** One-line description of what this mode will actually do. */
  describe() {
    switch (this.mode) {
      case "all":
        return `all ${this.gameIds.length} game(s) idling together, no rotation`;
      case "continuous":
        return (
          `${this.pinned.length} game(s) idling continuously` +
          (this.parked.length ? `, ${this.parked.length} parked (never played)` : "")
        );
      case "hybrid":
        return (
          `${this.pinned.length} pinned + ${this.slots} of ${this.pool.length} ` +
          `rotating (${this.concurrent} idling at once)`
        );
      default:
        return `${this.slots} of ${this.pool.length} game(s) rotating`;
    }
  }
}

/** Human-readable duration for idle stats: "12h 34m". */
export function formatDuration(ms) {
  const minutes = Math.floor(ms / 60000);
  const hours = Math.floor(minutes / 60);
  if (hours === 0) return `${minutes}m`;
  return `${hours}h ${minutes % 60}m`;
}
