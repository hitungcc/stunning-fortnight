/**
 * Single-achievement unlock test. THIS CHANGES THE ACCOUNT - use a test account.
 *
 * Logs in, starts "playing" the game, unlocks one achievement (and raises
 * its progress stat to the unlock value, unless --no-stat), then reads the
 * stats back to confirm Steam kept the change.
 *
 * Usage:
 *   node scripts/ach-unlock-once.js <appId> <API_NAME> [--no-stat] [--yes]
 */

import readline from "readline";
import SteamUser from "steam-user";
import SteamTotp from "steam-totp";
import chalk from "chalk";
import dotenv from "dotenv";
import { loadRefreshToken, saveRefreshToken, clearRefreshToken } from "../src/session.js";
import { getUserStats, buildUnlock, storeStats } from "../src/steam-stats.js";

dotenv.config();

const SENTRY_DIR = "./sentry";
const SESSION_WARMUP_MS = 5_000;
const VERIFY_DELAY_MS = 3_000;

const [appIdArg, apiName] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const appId = parseInt(appIdArg, 10);
const raiseStat = !process.argv.includes("--no-stat");
const skipConfirm = process.argv.includes("--yes");

if (!(appId > 0) || !apiName) {
  console.log("Usage: node scripts/ach-unlock-once.js <appId> <API_NAME> [--no-stat] [--yes]");
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const client = new SteamUser({ autoRelogin: false, renewRefreshTokens: true, dataDirectory: SENTRY_DIR });
let viaToken = false;

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) =>
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    })
  );
}

function finish(code) {
  client.gamesPlayed([]);
  client.logOff();
  setTimeout(() => process.exit(code), 1000);
}

async function run() {
  client.gamesPlayed([appId]);
  console.log(chalk.gray(`Playing ${appId}, waiting ${SESSION_WARMUP_MS / 1000}s before reading stats...`));
  await sleep(SESSION_WARMUP_MS);

  const before = await getUserStats(client, appId);
  const { achievement, writes, notes } = buildUnlock(before, apiName, { raiseStat });

  console.log("");
  console.log(chalk.cyan.bold(`${achievement.name} (${achievement.apiName})`));
  if (achievement.unlocked) {
    console.log(chalk.yellow("Already unlocked; nothing to do."));
    return 0;
  }
  for (const w of writes) console.log(`  ${w.kind.padEnd(12)} ${w.name}: ${w.from} → ${w.to}`);
  for (const n of notes) console.log(chalk.yellow(`  note: ${n}`));

  if (!skipConfirm) {
    const answer = await ask(chalk.yellow("\nSend this to Steam? [y/N] "));
    if (answer.toLowerCase() !== "y") {
      console.log("Cancelled; nothing was written.");
      return 0;
    }
  }

  const result = await storeStats(client, before, writes);
  console.log(chalk.green("✔ Steam accepted the write"));
  for (const f of result.failedValidation) {
    console.log(chalk.yellow(`  stat ${f.id} failed validation, reverted to ${f.reverted}`));
  }
  if (result.outOfDate) console.log(chalk.yellow("  Steam reports our stats were out of date"));

  await sleep(VERIFY_DELAY_MS);
  const after = await getUserStats(client, appId);
  const unlocked = after.achievements.find((a) => a.apiName === apiName);
  console.log("");
  console.log(
    unlocked.unlocked
      ? chalk.green(`✔ Verified: unlocked at ${new Date(unlocked.unlockTime * 1000).toISOString()}`)
      : chalk.red("✖ Read-back shows it still locked")
  );
  for (const w of writes.filter((w) => w.kind === "stat")) {
    const now = after.stats.find((s) => s.id === w.id)?.value;
    const ok = now >= w.to;
    console.log((ok ? chalk.green : chalk.red)(`${ok ? "✔" : "✖"} ${w.name} is now ${now} (wanted ${w.to})`));
  }
  return unlocked.unlocked ? 0 : 1;
}

client.on("steamGuard", async (domain, callback, lastCodeWrong) => {
  const sharedSecret = process.env.STEAM_SHARED_SECRET;
  if (sharedSecret) {
    callback(SteamTotp.generateAuthCode(sharedSecret));
    return;
  }
  if (lastCodeWrong) console.log(chalk.red("✖ Wrong code, try again."));
  const where = domain ? `email code (sent to *@${domain})` : "mobile authenticator code";
  callback(await ask(chalk.yellow(`Steam Guard ${where}: `)));
});

client.on("refreshToken", (token) => saveRefreshToken(SENTRY_DIR, token));

client.on("loggedOn", async () => {
  console.log(chalk.green(`✔ Logged in (SteamID: ${client.steamID})`));
  try {
    finish(await run());
  } catch (err) {
    console.log(chalk.red(`✖ ${err.message}`));
    finish(1);
  }
});

client.on("playingState", (blocked, playingApp) => {
  if (blocked) console.log(chalk.yellow(`Warning: account is playing ${playingApp} elsewhere`));
});

client.on("error", (err) => {
  if (viaToken) {
    console.log(chalk.yellow("Saved session was rejected; logging in with password."));
    clearRefreshToken(SENTRY_DIR);
    viaToken = false;
    logIn();
    return;
  }
  console.log(chalk.red(`✖ Steam error: ${err.message}`));
  process.exit(1);
});

function logIn() {
  const token = loadRefreshToken(SENTRY_DIR);
  if (token) {
    viaToken = true;
    client.logOn({ refreshToken: token });
    return;
  }
  const { STEAM_USERNAME: accountName, STEAM_PASSWORD: password, STEAM_SHARED_SECRET: sharedSecret } = process.env;
  if (!accountName || !password) {
    console.log(chalk.red("✖ Set STEAM_USERNAME and STEAM_PASSWORD in .env first."));
    process.exit(1);
  }
  const options = { accountName, password, machineName: process.env.STEAM_MACHINE_NAME || "stunning-fortnight" };
  if (sharedSecret) options.twoFactorCode = SteamTotp.generateAuthCode(sharedSecret);
  client.logOn(options);
}

logIn();
