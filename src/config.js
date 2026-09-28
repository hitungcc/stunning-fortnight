import { MODES } from "./scheduler.js";
import dotenv from "dotenv";

dotenv.config();

/**
 * Loads and validates configuration from environment variables.
 * @returns {object} Validated config object
 */
export function loadConfig() {
  const username = process.env.STEAM_USERNAME;
  const password = process.env.STEAM_PASSWORD;
  const sharedSecret = process.env.STEAM_SHARED_SECRET || "";
  const identitySecret = process.env.STEAM_IDENTITY_SECRET || "";
  const gameIdsRaw = process.env.STEAM_GAME_IDS || "";
  const personaState = parseInt(process.env.STEAM_PERSONA_STATE ?? "0", 10);
  const heartbeatInterval = parseInt(process.env.HEARTBEAT_INTERVAL ?? "30", 10);
  const reconnectDelay = parseInt(process.env.RECONNECT_DELAY ?? "30", 10);
  const maxReconnectAttempts = parseInt(process.env.MAX_RECONNECT_ATTEMPTS ?? "0", 10);
  const machineName = process.env.STEAM_MACHINE_NAME || "stunning-fortnight";

  // ── Idle scheduling ───────────────────────────────────────
  const idleMode = (process.env.IDLE_MODE || "rotate").trim().toLowerCase();
  const idleBatchSize = parseInt(process.env.IDLE_BATCH_SIZE ?? "1", 10);
  const idleInterval = parseInt(process.env.IDLE_INTERVAL ?? "30", 10);
  const idleJitter = parseInt(process.env.IDLE_JITTER ?? "15", 10);
  const idleStateFile = process.env.IDLE_STATE_FILE || "./data/idle-state.json";
  const idlePinnedRaw = process.env.IDLE_PINNED || "";

  // ── Validate required fields ──────────────────────────────
  if (!username || !password) {
    throw new Error(
      "Missing STEAM_USERNAME or STEAM_PASSWORD in .env file.\n" +
      "Copy .env.example to .env and fill in your credentials."
    );
  }

  // ── Parse game IDs ────────────────────────────────────────
  const gameIds = gameIdsRaw
    .split(",")
    .map((id) => parseInt(id.trim(), 10))
    .filter((id) => !isNaN(id) && id > 0);

  if (gameIds.length === 0) {
    throw new Error(
      "No valid game IDs found in STEAM_GAME_IDS.\n" +
      "Provide comma-separated App IDs, e.g.: STEAM_GAME_IDS=730,440,570"
    );
  }

  if (gameIds.length > 32) {
    console.warn(
      "⚠️  Steam allows max ~32 simultaneous games. " +
      `You listed ${gameIds.length}. Only the first 32 will be used.`
    );
    gameIds.length = 32;
  }

  // ── Validate idle scheduling ──────────────────────────────
  if (!MODES.includes(idleMode)) {
    throw new Error(
      `Unknown IDLE_MODE "${idleMode}".\n` +
      `Valid modes: ${MODES.join(", ")}\n` +
      "  all         — every game idles together, nothing rotates\n" +
      "  continuous  — a fixed set idles forever, the rest are never played\n" +
      "  hybrid      — a fixed set idles forever, the rest rotate through free slots\n" +
      "  rotate      — every game takes turns (full round-robin)"
    );
  }

  const idle = {
    mode: idleMode,
    batchSize: Number.isNaN(idleBatchSize) || idleBatchSize < 1 ? 1 : idleBatchSize,
    intervalMinutes: Number.isNaN(idleInterval) || idleInterval < 1 ? 30 : idleInterval,
    jitterPercent: Number.isNaN(idleJitter) ? 15 : Math.max(0, Math.min(idleJitter, 90)),
    stateFile: idleStateFile,
    pinnedIds: [],
  };

  // ── Pinned games (continuous / hybrid) ────────────────────
  if (idleMode === "continuous" || idleMode === "hybrid") {
    const explicit = idlePinnedRaw
      .split(",")
      .map((id) => parseInt(id.trim(), 10))
      .filter((id) => !isNaN(id) && id > 0);

    const unknown = explicit.filter((id) => !gameIds.includes(id));
    if (unknown.length > 0) {
      console.warn(
        `⚠️  IDLE_PINNED contains App ID(s) not in STEAM_GAME_IDS: ${unknown.join(", ")}. ` +
        "Adding them to the pool — remove them from IDLE_PINNED if that was a typo."
      );
      gameIds.push(...unknown);
    }

    if (explicit.length > 0) {
      idle.pinnedIds = explicit;
    } else {
      // No explicit pins: take them off the top of STEAM_GAME_IDS.
      // continuous fills every slot; hybrid pins one and rotates the rest.
      const defaultCount = idleMode === "continuous" ? idle.batchSize : 1;
      idle.pinnedIds = gameIds.slice(0, Math.min(defaultCount, gameIds.length));
      console.warn(
        `ℹ️  IDLE_PINNED not set — pinning the first ${idle.pinnedIds.length} game(s) ` +
        `from STEAM_GAME_IDS: ${idle.pinnedIds.join(", ")}`
      );
    }
  }

  // ── Degenerate configurations fall back to a mode that works ──
  const rotatable = gameIds.filter((id) => !idle.pinnedIds.includes(id)).length;
  const freeSlots = idle.batchSize - idle.pinnedIds.length;

  if (idleMode === "hybrid" && freeSlots < 1) {
    console.warn(
      `⚠️  IDLE_BATCH_SIZE (${idle.batchSize}) leaves no free slot after ` +
      `${idle.pinnedIds.length} pinned game(s). Falling back to "continuous".`
    );
    idle.mode = "continuous";
  } else if (idleMode === "hybrid" && rotatable <= freeSlots) {
    console.warn(
      `⚠️  Only ${rotatable} unpinned game(s) for ${freeSlots} free slot(s) — ` +
      'nothing would rotate. Falling back to "all".'
    );
    idle.mode = "all";
  } else if (idleMode === "rotate" && idle.batchSize >= gameIds.length) {
    console.warn(
      `⚠️  IDLE_BATCH_SIZE (${idle.batchSize}) covers every configured game ` +
      `(${gameIds.length}). Nothing would rotate — falling back to "all".`
    );
    idle.mode = "all";
  }

  if (idle.mode === "all" && gameIds.length > 32) {
    console.warn('⚠️  Mode "all" idles every game at once, but Steam caps this at ~32.');
  }

  const achievements = loadAchievementConfig();

  return {
    username,
    password,
    sharedSecret,
    identitySecret,
    gameIds,
    personaState,
    heartbeatInterval,
    reconnectDelay,
    maxReconnectAttempts,
    machineName,
    idle,
    achievements,
  };
}

// ── Achievement unlocking ───────────────────────────────────
function flag(name, fallback) {
  const raw = (process.env[name] ?? "").trim().toLowerCase();
  if (raw === "") return fallback;
  return ["1", "true", "yes", "on"].includes(raw);
}

function number(name, fallback, { min = 0, max = Infinity } = {}) {
  const n = Number(process.env[name]);
  if (process.env[name] === undefined || process.env[name].trim() === "" || !Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(n, max));
}

function list(name) {
  return (process.env[name] || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Parses "100" → 100 and "80-95" → [80, 95]; anything else → 100. */
function parseCompletion(raw) {
  const match = /^\s*(\d+(?:\.\d+)?)\s*(?:-\s*(\d+(?:\.\d+)?))?\s*$/.exec(raw || "");
  if (!match) return 100;
  const a = Math.min(100, Math.max(1, Number(match[1])));
  if (match[2] === undefined) return a;
  const b = Math.min(100, Math.max(1, Number(match[2])));
  return [Math.min(a, b), Math.max(a, b)];
}

function loadAchievementConfig() {
  const order = (process.env.ACH_ORDER || "rarity").trim().toLowerCase();
  if (!["rarity", "random"].includes(order)) {
    throw new Error(`Unknown ACH_ORDER "${order}". Valid values: rarity, random`);
  }

  const minHours = number("ACH_MIN_HOURS", 10, { min: 0 });
  const maxHours = number("ACH_MAX_HOURS", 150, { min: 0 });
  if (maxHours < minHours) {
    throw new Error(`ACH_MAX_HOURS (${maxHours}) is lower than ACH_MIN_HOURS (${minHours}).`);
  }

  return {
    enabled: flag("ACH_ENABLED", false),
    dryRun: flag("ACH_DRY_RUN", true),
    hoursEach: number("ACH_HOURS_EACH", 3, { min: 0.1 }),
    minHours,
    maxHours,
    jitterPercent: number("ACH_JITTER", 20, { max: 90 }),
    order,
    completion: parseCompletion(process.env.ACH_COMPLETION),
    burstChance: number("ACH_BURST", 0.1, { max: 1 }),
    // Stat-linked achievements are unlocked with their stat raised to match
    includeProgress: flag("ACH_STAT_LINKED", true),
    quietHours: process.env.ACH_QUIET_HOURS ?? "02-08",
    warmupMinutes: number("ACH_WARMUP", 15),
    exclude: list("ACH_EXCLUDE"),
    skipGames: list("ACH_SKIP_GAMES").map(Number).filter((id) => id > 0),
    stateFile: process.env.ACH_STATE_FILE || "./data/achievement-state.json",
  };
}
