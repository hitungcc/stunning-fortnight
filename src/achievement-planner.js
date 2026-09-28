/**
 * Turns a game's locked achievements into an unlock timeline measured in
 * *idle time for that game*, not wall-clock time. An entry with
 * atMs = 5h unlocks once the game has idled 5 hours since the plan started,
 * however long that takes with rotation, pauses and disconnects.
 *
 * Pure logic: no Steam, no clock, no I/O. Pass `seed` for repeatable plans.
 */

const HOUR = 3_600_000;
const MINUTE = 60_000;

export const DEFAULT_PLAN_SETTINGS = {
  hoursEach: 3, // average idle hours per achievement
  minHours: 10, // total budget never shorter than this...
  maxHours: 150, // ...or longer than this
  jitterPercent: 20, // per-game budget varies by ±N%
  order: "rarity", // "rarity" = common first, rare last; "random" = shuffled
  completion: 100, // % of the game's achievements to end at; or [min, max] to roll per game
  burstChance: 0.1, // chance an unlock lands minutes after the previous one
  includeProgress: true, // stat-driven achievements ("kill 100 enemies"); their stat is raised on unlock
  exclude: [], // achievement API names never to unlock
};

/** Small seedable PRNG (mulberry32) so a saved seed reproduces a plan. */
export function createRng(seed) {
  if (seed == null) return Math.random;
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal via Box–Muller. */
function gaussian(rng) {
  const u = 1 - rng();
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function shuffle(list, rng) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function median(values) {
  if (values.length === 0) return 50;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Why an achievement is left out of the plan, or null if it's eligible. */
export function skipReason(achievement, settings) {
  if (achievement.unlocked) return "already unlocked";
  if (achievement.protected) return "protected (server-side only)";
  if (achievement.progressStat && !settings.includeProgress) {
    return `tied to stat "${achievement.progressStat}"`;
  }
  if (settings.exclude.includes(achievement.apiName)) return "excluded";
  return null;
}

/**
 * @param {object}   opts
 * @param {object[]} opts.achievements  from getUserStats()
 * @param {Record<string, number>} [opts.percentages]  global unlock % by API name
 * @param {object}   [opts.settings]    overrides for DEFAULT_PLAN_SETTINGS
 * @param {number}   [opts.seed]
 * @returns {{ entries: object[], skipped: object[], budgetMs: number,
 *             completionTarget: number, seed: number|null }}
 */
export function planAchievements({ achievements, percentages = {}, settings = {}, seed = null }) {
  const s = { ...DEFAULT_PLAN_SETTINGS, ...settings };
  const rng = createRng(seed);

  const known = achievements.map((a) => percentages[a.apiName]).filter(Number.isFinite);
  const fallbackPercent = median(known);
  const withPercent = achievements.map((a) => ({
    ...a,
    percent: Number.isFinite(percentages[a.apiName]) ? percentages[a.apiName] : fallbackPercent,
    percentKnown: Number.isFinite(percentages[a.apiName]),
  }));

  const skipped = [];
  const eligible = [];
  for (const a of withPercent) {
    const reason = skipReason(a, s);
    if (reason) skipped.push({ ...a, reason });
    else eligible.push(a);
  }

  // ── Order: common first with some noise, or fully shuffled ────
  let ordered;
  if (s.order === "random") {
    ordered = shuffle(eligible, rng);
  } else {
    // Log-normal noise lets neighbours in rarity swap places now and then
    ordered = eligible
      .map((a) => ({ a, key: (a.percent + 0.1) * Math.exp(gaussian(rng) * 0.2) }))
      .sort((x, y) => y.key - x.key)
      .map((x) => x.a);
  }

  // ── Completion target: stop short by dropping the tail (rarest) ──
  const completionTarget = Array.isArray(s.completion)
    ? s.completion[0] + rng() * (s.completion[1] - s.completion[0])
    : s.completion;
  const alreadyUnlocked = achievements.filter((a) => a.unlocked).length;
  const wanted = Math.ceil((achievements.length * Math.min(100, completionTarget)) / 100);
  const count = Math.max(0, Math.min(ordered.length, wanted - alreadyUnlocked));
  for (const a of ordered.slice(count)) skipped.push({ ...a, reason: "beyond completion target" });
  ordered = ordered.slice(0, count);

  if (ordered.length === 0) {
    return { entries: [], skipped, budgetMs: 0, completionTarget, seed };
  }

  // ── Budget: per-achievement pace, clamped, then jittered ──────
  const clampedHours = Math.min(s.maxHours, Math.max(s.minHours, ordered.length * s.hoursEach));
  const jitter = 1 + (rng() * 2 - 1) * (s.jitterPercent / 100);
  const budgetMs = Math.round(clampedHours * jitter * HOUR);

  // ── Gaps: exponential (natural clustering), longer before rare ones,
  //    occasionally a near-instant follow-up burst ──────────────
  const gaps = ordered.map((a, i) => {
    if (i > 0 && rng() < s.burstChance) {
      return { burst: true, ms: Math.round(MINUTE * (1 + rng() * 14)) }; // 1–15 min
    }
    const rarity = 1 - Math.min(100, a.percent) / 100;
    return { burst: false, weight: -Math.log(1 - rng()) * (1 + 2 * rarity) };
  });
  const burstMs = gaps.reduce((sum, g) => sum + (g.burst ? g.ms : 0), 0);
  const weightSum = gaps.reduce((sum, g) => sum + (g.burst ? 0 : g.weight), 0);
  const spreadMs = Math.max(0, budgetMs - burstMs);

  let at = 0;
  const entries = ordered.map((a, i) => {
    const g = gaps[i];
    at += g.burst ? g.ms : Math.round((g.weight / weightSum) * spreadMs);
    return {
      apiName: a.apiName,
      name: a.name,
      percent: a.percent,
      percentKnown: a.percentKnown,
      burst: g.burst,
      atMs: at,
    };
  });

  return { entries, skipped, budgetMs, completionTarget, seed };
}
