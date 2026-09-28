/**
 * Achievement plan preview: shows when each achievement would unlock,
 * measured in idle time for that game. Offline; nothing touches Steam.
 *
 * Usage:
 *   node scripts/ach-plan.js <appId | file.json> [options]
 *
 * Input is a file saved by ach-probe.js (./data/achievements/<appId>.json).
 *
 * Options:
 *   --hours-each <n>      average idle hours per achievement   (default 3)
 *   --min-hours <n>       shortest total budget                (default 10)
 *   --max-hours <n>       longest total budget                 (default 150)
 *   --jitter <n>          ±% variation of the total budget     (default 20)
 *   --order <rarity|random>                                    (default rarity)
 *   --completion <n|a-b>  target %, or a range rolled per game (default 100)
 *   --burst <n>           chance 0–1 of a quick follow-up      (default 0.1)
 *   --no-progress         skip stat-linked achievements
 *   --exclude <a,b>       API names to leave locked
 *   --seed <n>            repeatable plan
 */

import fs from "fs";
import path from "path";
import chalk from "chalk";
import { planAchievements } from "../src/achievement-planner.js";
import { formatDuration } from "../src/scheduler.js";

const args = process.argv.slice(2);
const target = args[0]?.startsWith("--") ? undefined : args[0];

function option(name) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

function number(name) {
  const raw = option(name);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    console.log(chalk.red(`--${name} expects a number, got "${raw}"`));
    process.exit(1);
  }
  return n;
}

if (!target) {
  console.log("Usage: node scripts/ach-plan.js <appId | file.json> [options]");
  process.exit(1);
}

const file = /^\d+$/.test(target) ? path.join("./data/achievements", `${target}.json`) : target;
if (!fs.existsSync(file)) {
  console.log(chalk.red(`No data at ${file}. Run: node scripts/ach-probe.js ${target}`));
  process.exit(1);
}
const data = JSON.parse(fs.readFileSync(file, "utf-8"));

const settings = {};
const set = (key, value) => value !== undefined && (settings[key] = value);
set("hoursEach", number("hours-each"));
set("minHours", number("min-hours"));
set("maxHours", number("max-hours"));
set("jitterPercent", number("jitter"));
set("burstChance", number("burst"));
set("order", option("order"));
if (args.includes("--no-progress")) settings.includeProgress = false;
if (option("exclude")) settings.exclude = option("exclude").split(",").map((s) => s.trim());

const completion = option("completion");
if (completion !== undefined) {
  const range = completion.split("-").map(Number);
  settings.completion = range.length === 2 ? range : range[0];
}

const seed = number("seed") ?? Math.floor(Math.random() * 2 ** 31);
const plan = planAchievements({
  achievements: data.achievements,
  percentages: data.percentages,
  settings,
  seed,
});

const total = data.achievements.length;
const unlocked = data.achievements.filter((a) => a.unlocked).length;

console.log("");
console.log(chalk.cyan.bold(`${data.name} (${data.appId})`));
console.log(
  chalk.gray(
    `${unlocked}/${total} unlocked now → ${unlocked + plan.entries.length}/${total} ` +
      `(target ${plan.completionTarget.toFixed(0)}%) over ${formatDuration(plan.budgetMs)} of idle · seed ${seed}`
  )
);

const ineligible = plan.skipped.filter((s) => !s.unlocked && s.reason !== "beyond completion target").length;
if (ineligible > 0) {
  console.log(
    chalk.yellow(
      `${ineligible} locked achievement(s) can't be planned with these settings, ` +
        "so the target can't be reached (see skipped list below)."
    )
  );
}

if (plan.entries.length === 0) {
  console.log(chalk.yellow("Nothing to plan."));
} else {
  let prev = 0;
  for (const [i, e] of plan.entries.entries()) {
    const gap = e.atMs - prev;
    prev = e.atMs;
    const pct = e.percentKnown ? `${e.percent.toFixed(1)}%` : "?";
    console.log(
      `${String(i + 1).padStart(3)}  ` +
        `${formatDuration(e.atMs).padStart(8)}  ` +
        chalk.gray(`+${formatDuration(gap)}`.padEnd(9)) +
        `${pct.padStart(6)}  ${e.name}` +
        (e.burst ? chalk.magenta("  (burst)") : "")
    );
  }
}

const reasons = {};
for (const s of plan.skipped) reasons[s.reason] = (reasons[s.reason] || 0) + 1;
for (const [reason, count] of Object.entries(reasons)) {
  console.log(chalk.gray(`Skipped ${count}: ${reason}`));
}
