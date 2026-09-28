/**
 * Achievement probe: reads a game's achievement list and your unlock state.
 *
 * Read-only. It logs in, requests the stats, prints them and logs off.
 * It never sets a game as played and never writes stats, so an idler
 * running elsewhere on the same account keeps going.
 *
 * Usage:
 *   node scripts/ach-probe.js <appId> [appId...]
 *
 * Results are saved to ./data/achievements/<appId>.json for ach-plan.js.
 */

import fs from "fs";
import path from "path";
import readline from "readline";
import SteamUser from "steam-user";
import SteamTotp from "steam-totp";
import chalk from "chalk";
import dotenv from "dotenv";
import { loadRefreshToken, saveRefreshToken, clearRefreshToken } from "../src/session.js";
import { getUserStats, fetchGlobalPercentages } from "../src/steam-stats.js";

dotenv.config();

const SENTRY_DIR = "./sentry";
const OUT_DIR = "./data/achievements";

const appIds = process.argv
  .slice(2)
  .map((arg) => parseInt(arg, 10))
  .filter((id) => id > 0);

if (appIds.length === 0) {
  console.log("Usage: node scripts/ach-probe.js <appId> [appId...]");
  process.exit(1);
}

const username = process.env.STEAM_USERNAME;
const password = process.env.STEAM_PASSWORD;
const sharedSecret = process.env.STEAM_SHARED_SECRET || "";

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

async function fetchGameName(appId) {
  try {
    const res = await fetch(`https://store.steampowered.com/api/appdetails?appids=${appId}&filters=basic`);
    const json = await res.json();
    return json[appId]?.success ? json[appId].data.name : `App ${appId}`;
  } catch {
    return `App ${appId}`;
  }
}

function fit(text, width) {
  const s = String(text ?? "");
  return s.length > width ? s.slice(0, width - 1) + "…" : s.padEnd(width);
}

function printReport(name, result, percentages) {
  const { achievements } = result;
  const unlocked = achievements.filter((a) => a.unlocked).length;
  const hasPercent = Object.keys(percentages).length > 0;

  console.log("");
  console.log(chalk.cyan.bold(`${name} (${result.appId})`));
  console.log(
    chalk.gray(
      `${achievements.length} achievements, ${unlocked} unlocked, ` +
        `${achievements.filter((a) => a.protected).length} protected, ` +
        `${achievements.filter((a) => a.progressStat).length} stat-linked` +
        (hasPercent ? "" : ", no global percentages published")
    )
  );
  console.log(
    chalk.gray(`${fit("#", 4)}${fit("API name", 28)}${fit("Name", 34)}${fit("Global", 8)}${fit("Flags", 7)}Unlocked`)
  );

  achievements.forEach((a, i) => {
    const pct = percentages[a.apiName];
    const flags = [a.protected ? "P" : "", a.progressStat ? "S" : "", a.hidden ? "H" : ""].join("");
    const when = a.unlocked ? new Date(a.unlockTime * 1000).toISOString().slice(0, 10) : "-";
    const line =
      fit(i + 1, 4) +
      fit(a.apiName, 28) +
      fit(a.name, 34) +
      fit(Number.isFinite(pct) ? `${pct.toFixed(1)}%` : "?", 8) +
      fit(flags, 7) +
      when;
    console.log(a.unlocked ? chalk.green(line) : line);
  });
  console.log(chalk.gray("Flags: P = protected, S = tied to a stat, H = hidden"));
}

async function probe() {
  let failures = 0;
  for (const appId of appIds) {
    try {
      const [name, result, percentages] = await Promise.all([
        fetchGameName(appId),
        getUserStats(client, appId),
        fetchGlobalPercentages(appId),
      ]);
      printReport(name, result, percentages);

      fs.mkdirSync(OUT_DIR, { recursive: true });
      const file = path.join(OUT_DIR, `${appId}.json`);
      fs.writeFileSync(
        file,
        JSON.stringify({ appId, name, fetchedAt: new Date().toISOString(), ...result, percentages }, null, 2)
      );
      console.log(chalk.gray(`Saved to ${file}`));
    } catch (err) {
      failures++;
      console.log(chalk.red(`\n✖ ${appId}: ${err.message}`));
    }
  }
  return failures;
}

client.on("steamGuard", async (domain, callback, lastCodeWrong) => {
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
  const failures = await probe();
  client.logOff();
  setTimeout(() => process.exit(failures > 0 ? 1 : 0), 1000);
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
  if (!username || !password) {
    console.log(chalk.red("✖ Set STEAM_USERNAME and STEAM_PASSWORD in .env first."));
    process.exit(1);
  }
  const options = { accountName: username, password, machineName: process.env.STEAM_MACHINE_NAME || "stunning-fortnight" };
  if (sharedSecret) options.twoFactorCode = SteamTotp.generateAuthCode(sharedSecret);
  console.log(chalk.gray(`Logging in as ${chalk.bold(username)}...`));
  client.logOn(options);
}

logIn();
