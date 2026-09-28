import SteamUser from "steam-user";
import BinaryKVParser from "binarykvparser";
import { createRequire } from "module";

/**
 * Reads a game's achievement schema and the user's unlock state over the
 * Steam CM connection (the same messages the real Steam client sends).
 *
 * steam-user ships the protobuf definitions for these messages but has no
 * public API for them, so we encode/decode them ourselves and send them
 * through client._send(). That is an internal method; pin steam-user's
 * major version and re-check this file when upgrading.
 */
const require = createRequire(import.meta.url);
const Schema = require("steam-user/protobufs/generated/_load.js");
const { EMsg, EResult } = SteamUser;

const REQUEST_TIMEOUT_MS = 15_000;

// Stat types, numeric or named depending on schema age
const ACHIEVEMENT_TYPES = new Set(["4", "5", "ACHIEVEMENTS", "GROUPACHIEVEMENTS"]);
const STAT_TYPES = { 1: "int", INT: "int", 2: "float", FLOAT: "float", 3: "avgrate", AVGRATE: "avgrate" };

// Steam sends every stat as a uint32; ints and floats are that same 4 bytes reinterpreted
const word = Buffer.alloc(4);
export function decodeStatValue(raw, type) {
  word.writeUInt32LE(raw >>> 0);
  return type === "float" ? word.readFloatLE() : word.readInt32LE();
}
export function encodeStatValue(value, type) {
  if (type === "float") word.writeFloatLE(value);
  else word.writeInt32LE(Math.trunc(value));
  return word.readUInt32LE();
}

function num(value, fallback = null) {
  const n = Number(value);
  return value == null || value === "" || !Number.isFinite(n) ? fallback : n;
}

function decode(Proto, body) {
  const buf = body?.toBuffer ? body.toBuffer() : body;
  return Proto.toObject(Proto.decode(buf), { longs: String, defaults: true });
}

/** Send a protobuf message and resolve with the decoded job response. */
function request(client, emsg, RequestProto, payload, ResponseProto) {
  return new Promise((resolve, reject) => {
    if (!client.steamID) {
      reject(new Error("Not logged on to Steam."));
      return;
    }

    const timer = setTimeout(
      () => reject(new Error(`No response to ${EMsg[emsg]} within ${REQUEST_TIMEOUT_MS / 1000}s`)),
      REQUEST_TIMEOUT_MS
    );

    const body = Buffer.from(RequestProto.encode(payload).finish());
    client._send({ msg: emsg, proto: {} }, body, (responseBody) => {
      clearTimeout(timer);
      try {
        resolve(decode(ResponseProto, responseBody));
      } catch (err) {
        reject(new Error(`Could not decode ${EMsg[emsg]} response: ${err.message}`));
      }
    });
  });
}

/** Schema strings are either plain or { english: "...", german: "..." }. */
function localized(value) {
  if (value == null) return "";
  if (typeof value !== "object") return String(value);
  return value.english ?? Object.values(value)[0] ?? "";
}

// Permission bits 1|2 mean only a game server / Valve can set it
const isProtected = (permission) => (Number(permission ?? 0) & 3) !== 0;

/**
 * Flatten the binary KeyValues schema into achievements and plain stats.
 * @param {Buffer} schemaBytes
 */
export function parseSchema(schemaBytes) {
  const root = BinaryKVParser.parse(schemaBytes);
  const game = Object.values(root)[0] || {};
  const achievements = [];
  const stats = [];

  for (const [statKey, stat] of Object.entries(game.stats || {})) {
    const type = String(stat.type_int ?? stat.type ?? "").toUpperCase();
    const id = Number(stat.id ?? statKey);

    if (!ACHIEVEMENT_TYPES.has(type)) {
      if (STAT_TYPES[type] && stat.name) {
        stats.push({
          id,
          name: stat.name,
          type: STAT_TYPES[type],
          defaultValue: num(stat.default, 0),
          min: num(stat.min),
          max: num(stat.max),
          maxChange: num(stat.maxchange),
          incrementOnly: String(stat.incrementonly ?? "0") === "1",
          protected: isProtected(stat.permission),
        });
      }
      continue;
    }
    if (!stat.bits) continue;

    for (const [bitKey, bit] of Object.entries(stat.bits)) {
      const display = bit.display || {};
      const progressStat = bit.progress?.value?.operand1 || null;
      achievements.push({
        apiName: bit.name,
        name: localized(display.name) || bit.name,
        description: localized(display.desc),
        hidden: String(display.hidden ?? "0") === "1",
        blockId: id,
        bit: Number(bit.bit ?? bitKey),
        protected: isProtected(bit.permission ?? stat.permission),
        // Achievements driven by a stat ("kill 100 enemies") name that stat here,
        // with the value that unlocks it
        progressStat,
        progressMax: progressStat ? num(bit.progress.max_val) : null,
      });
    }
  }

  achievements.sort((a, b) => a.blockId - b.blockId || a.bit - b.bit);
  stats.sort((a, b) => a.id - b.id);
  return { achievements, stats };
}

export function parseAchievementSchema(schemaBytes) {
  return parseSchema(schemaBytes).achievements;
}

/**
 * Fetch the schema plus the logged-on user's unlock state for one game.
 * Read-only: nothing is written to the account.
 *
 * @param {SteamUser} client  a logged-on steam-user client
 * @param {number} appId
 */
export async function getUserStats(client, appId) {
  const res = await request(
    client,
    EMsg.ClientGetUserStats,
    Schema.CMsgClientGetUserStats,
    {
      game_id: String(appId),
      crc_stats: 0,
      schema_local_version: -1, // ask for the full schema
      steam_id_for_user: client.steamID.getSteamID64(),
    },
    Schema.CMsgClientGetUserStatsResponse
  );

  if (res.eresult !== EResult.OK) {
    const reason = EResult[res.eresult] || res.eresult;
    throw new Error(`Steam refused the stats request for ${appId} (EResult: ${reason})`);
  }
  if (!res.schema || res.schema.length === 0) {
    throw new Error(`Steam returned no stats schema for ${appId} (game may have no achievements)`);
  }

  // unlock_time[bit] is a unix timestamp, 0 while locked
  const unlockTimes = new Map(res.achievement_blocks.map((b) => [b.achievement_id, b.unlock_time]));
  // Raw uint32 per stat id; Steam omits stats still at their default
  const raw = new Map(res.stats.map((s) => [s.stat_id, s.stat_value >>> 0]));

  const schema = parseSchema(Buffer.from(res.schema));

  const achievements = schema.achievements.map((a) => {
    const unlockTime = unlockTimes.get(a.blockId)?.[a.bit] || 0;
    return { ...a, unlocked: unlockTime > 0, unlockTime };
  });

  const stats = schema.stats.map((s) => ({
    ...s,
    value: raw.has(s.id) ? decodeStatValue(raw.get(s.id), s.type) : s.defaultValue,
  }));

  // Current bitmask of every achievement block, needed to flip a single bit
  const blocks = {};
  for (const id of new Set(achievements.map((a) => a.blockId))) blocks[id] = raw.get(id) ?? 0;

  return { appId, crcStats: res.crc_stats, blocks, stats, achievements };
}

/**
 * Work out the stat writes that unlock one achievement: its block with the
 * bit set, plus (optionally) its progress stat raised to the unlock value.
 * Pure; exported so the plan can be shown before anything is sent.
 *
 * @param {object} snapshot  result of getUserStats()
 * @param {string} apiName
 * @param {{ raiseStat?: boolean }} [opts]
 */
export function buildUnlock(snapshot, apiName, { raiseStat = true } = {}) {
  const achievement = snapshot.achievements.find((a) => a.apiName === apiName);
  if (!achievement) throw new Error(`No achievement "${apiName}" in app ${snapshot.appId}`);
  if (achievement.protected) throw new Error(`"${apiName}" is protected; only the game server can set it`);

  const before = snapshot.blocks[achievement.blockId] ?? 0;
  const writes = [
    {
      kind: "achievement",
      id: achievement.blockId,
      name: `block ${achievement.blockId} bit ${achievement.bit}`,
      from: before,
      to: (before | (1 << achievement.bit)) >>> 0,
    },
  ];
  const notes = [];

  if (raiseStat && achievement.progressStat) {
    const stat = snapshot.stats.find((s) => s.name === achievement.progressStat);
    const target = achievement.progressMax;
    if (!stat) {
      notes.push(`stat "${achievement.progressStat}" not in schema; unlocking without it`);
    } else if (stat.protected) {
      notes.push(`stat "${stat.name}" is protected; unlocking without it`);
    } else if (stat.type === "avgrate") {
      notes.push(`stat "${stat.name}" is an average rate; unlocking without it`);
    } else if (target == null) {
      notes.push(`no unlock value for "${stat.name}" in schema; unlocking without it`);
    } else if (stat.value < target) {
      const to = stat.max != null ? Math.min(target, stat.max) : target;
      if (stat.maxChange != null && to - stat.value > stat.maxChange) {
        notes.push(`"${stat.name}" jump of ${to - stat.value} exceeds maxchange ${stat.maxChange}; Steam may revert it`);
      }
      writes.push({ kind: "stat", id: stat.id, name: stat.name, type: stat.type, from: stat.value, to });
    }
  }

  return { achievement, writes, notes };
}

/**
 * Send the writes from buildUnlock() to Steam. This changes the account.
 * @returns {Promise<{ failedValidation: object[], outOfDate: boolean }>}
 */
export async function storeStats(client, snapshot, writes) {
  const steamId = client.steamID.getSteamID64();
  const res = await request(
    client,
    EMsg.ClientStoreUserStats2,
    Schema.CMsgClientStoreUserStats2,
    {
      game_id: String(snapshot.appId),
      settor_steam_id: steamId,
      settee_steam_id: steamId,
      crc_stats: snapshot.crcStats,
      explicit_reset: false,
      stats: writes.map((w) => ({
        stat_id: w.id,
        stat_value: w.kind === "achievement" ? w.to : encodeStatValue(w.to, w.type),
      })),
    },
    Schema.CMsgClientStoreUserStatsResponse
  );

  if (res.eresult !== EResult.OK) {
    throw new Error(`Steam rejected the write (EResult: ${EResult[res.eresult] || res.eresult})`);
  }
  return {
    failedValidation: res.stats_failed_validation.map((f) => ({ id: f.stat_id, reverted: f.reverted_stat_value })),
    outOfDate: res.stats_out_of_date,
  };
}

/**
 * Global unlock percentage per achievement API name. Public endpoint, no key.
 * Resolves to an empty object if Steam doesn't publish stats for the game.
 */
export async function fetchGlobalPercentages(appId) {
  try {
    const res = await fetch(
      "https://api.steampowered.com/ISteamUserStats/" +
        `GetGlobalAchievementPercentagesForApp/v2/?gameid=${appId}`
    );
    if (!res.ok) return {};
    const json = await res.json();
    const list = json?.achievementpercentages?.achievements || [];
    return Object.fromEntries(list.map((a) => [a.name, Number(a.percent)]));
  } catch {
    return {};
  }
}
