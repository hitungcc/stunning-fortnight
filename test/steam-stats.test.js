import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseAchievementSchema,
  parseSchema,
  buildUnlock,
  encodeStatValue,
  decodeStatValue,
} from "../src/steam-stats.js";

/** Encode a plain object as binary KeyValues (the format Steam sends the schema in). */
function kv(obj) {
  const parts = [];
  const cstr = (s) => Buffer.from(`${s}\0`, "utf8");
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === "object") {
      parts.push(Buffer.from([0]), cstr(key), kv(value));
    } else if (typeof value === "number") {
      const n = Buffer.alloc(4);
      n.writeInt32LE(value);
      parts.push(Buffer.from([2]), cstr(key), n);
    } else {
      parts.push(Buffer.from([1]), cstr(key), cstr(value));
    }
  }
  parts.push(Buffer.from([8]));
  return Buffer.concat(parts);
}

const schema = kv({
  480: {
    stats: {
      1: {
        type: 4,
        id: 1,
        bits: {
          0: { name: "ACH_WIN", bit: 0, display: { name: { english: "Winner" }, desc: { english: "Win" }, hidden: 0 } },
          1: { name: "ACH_PROT", bit: 1, permission: 2, display: { name: "Guarded", hidden: 1 } },
          2: {
            name: "ACH_KILL",
            bit: 2,
            progress: { min_val: "0", max_val: "100", value: { operation: "statvalue", operand1: "kills" } },
            display: { name: { english: "Hunter" } },
          },
        },
      },
      2: { type: 1, id: 2, name: "kills", maxchange: "50", incrementonly: "1" },
      4: { type: "FLOAT", id: 4, name: "distance", default: "1.5", permission: 2 },
      3: { type: "ACHIEVEMENTS", bits: { 0: { name: "ACH_LATE", bit: 0, display: { name: { german: "Spät" } } } } },
    },
  },
});

test("parses achievement bits and ignores plain stats", () => {
  const list = parseAchievementSchema(schema);
  assert.deepEqual(
    list.map((a) => [a.apiName, a.blockId, a.bit]),
    [
      ["ACH_WIN", 1, 0],
      ["ACH_PROT", 1, 1],
      ["ACH_KILL", 1, 2],
      ["ACH_LATE", 3, 0],
    ]
  );
});

test("reads display text, hidden, protected and stat links", () => {
  const byName = Object.fromEntries(parseAchievementSchema(schema).map((a) => [a.apiName, a]));
  assert.equal(byName.ACH_WIN.name, "Winner");
  assert.equal(byName.ACH_WIN.description, "Win");
  assert.equal(byName.ACH_WIN.hidden, false);
  assert.equal(byName.ACH_PROT.name, "Guarded");
  assert.equal(byName.ACH_PROT.hidden, true);
  assert.equal(byName.ACH_PROT.protected, true);
  assert.equal(byName.ACH_WIN.protected, false);
  assert.equal(byName.ACH_KILL.progressStat, "kills");
  assert.equal(byName.ACH_LATE.name, "Spät"); // falls back to the first language
});

test("parses plain stats with their limits", () => {
  const { stats } = parseSchema(schema);
  assert.deepEqual(stats, [
    { id: 2, name: "kills", type: "int", defaultValue: 0, min: null, max: null, maxChange: 50, incrementOnly: true, protected: false },
    { id: 4, name: "distance", type: "float", defaultValue: 1.5, min: null, max: null, maxChange: null, incrementOnly: false, protected: true },
  ]);
  const kill = parseAchievementSchema(schema).find((a) => a.apiName === "ACH_KILL");
  assert.equal(kill.progressMax, 100);
});

test("stat values round-trip through Steam's uint32 form", () => {
  assert.equal(decodeStatValue(encodeStatValue(-5, "int"), "int"), -5);
  assert.equal(decodeStatValue(encodeStatValue(2.5, "float"), "float"), 2.5);
  assert.equal(encodeStatValue(1, "float"), 0x3f800000);
});

function snapshot() {
  const { achievements, stats } = parseSchema(schema);
  return {
    appId: 480,
    crcStats: 123,
    blocks: { 1: 0b001, 3: 0 },
    stats: stats.map((s) => ({ ...s, value: s.name === "kills" ? 30 : s.defaultValue })),
    achievements: achievements.map((a) => ({ ...a, unlocked: false, unlockTime: 0 })),
  };
}

test("unlock sets only the achievement's bit, keeping the rest of the block", () => {
  const { writes } = buildUnlock(snapshot(), "ACH_LATE");
  assert.deepEqual(writes, [{ kind: "achievement", id: 3, name: "block 3 bit 0", from: 0, to: 1 }]);

  const kill = buildUnlock(snapshot(), "ACH_KILL", { raiseStat: false });
  assert.equal(kill.writes[0].to, 0b101);
  assert.equal(kill.writes.length, 1);
});

test("unlock raises the progress stat to the unlock value", () => {
  const { writes, notes } = buildUnlock(snapshot(), "ACH_KILL");
  assert.deepEqual(writes[1], { kind: "stat", id: 2, name: "kills", type: "int", from: 30, to: 100 });
  assert.match(notes[0], /exceeds maxchange 50/);
});

test("unlock never lowers a stat that is already past the target", () => {
  const snap = snapshot();
  snap.stats.find((s) => s.name === "kills").value = 250;
  assert.equal(buildUnlock(snap, "ACH_KILL").writes.length, 1);
});

test("unlock refuses protected achievements", () => {
  assert.throws(() => buildUnlock(snapshot(), "ACH_PROT"), /protected/);
  assert.throws(() => buildUnlock(snapshot(), "NOPE"), /No achievement/);
});
