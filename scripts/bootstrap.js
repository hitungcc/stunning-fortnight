/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║         STUNNING-FORTNIGHT • Bootstrap / First-Login         ║
 * ╚══════════════════════════════════════════════════════════════╝
 *
 * Run this ONCE manually before starting the idler in tmux.
 * It will:
 *   1. Log in with your credentials (and prompt for Steam Guard code)
 *   2. Save the machine auth token to ./sentry/
 *   3. Exit cleanly
 *
 * After this, the idler reuses the saved session and won’t need codes.
 *
 * Usage:
 *   node scripts/bootstrap.js
 */

import SteamUser from "steam-user";
import SteamTotp from "steam-totp";
import chalk from "chalk";
import readline from "readline";
import dotenv from "dotenv";
import { loadConfig } from "../src/config.js";

dotenv.config();

const config = loadConfig();

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function ask(question) {
  return new Promise((resolve) => rl.question(question, resolve));
}

console.log("");
console.log(chalk.cyan("╔══════════════════════════════════════════════════════════╗"));
console.log(chalk.cyan("║       STUNNING-FORTNIGHT — First Login Bootstrap         ║"));
console.log(chalk.cyan("╚══════════════════════════════════════════════════════════╝"));
console.log("");
console.log(chalk.gray("This will log in once and save the session to ./sentry/"));
console.log(chalk.gray("After this, the idler will not need Steam Guard codes on restart.\n"));

const client = new SteamUser({
  autoRelogin: false,
  dataDirectory: "./sentry",
});

client.on("steamGuard", async (domain, callback, lastCodeWrong) => {
  if (config.sharedSecret) {
    const code = SteamTotp.generateAuthCode(config.sharedSecret);
    console.log(chalk.green(`✔ 2FA code auto-generated: ${chalk.bold(code)}`));
    callback(code);
    return;
  }

  if (lastCodeWrong) {
    console.log(chalk.red("✖ Wrong code! Try again."));
  }

  let prompt;
  if (domain) {
    prompt = chalk.yellow(`\n📧 Steam Guard email code (sent to *@${domain}): `);
  } else {
    prompt = chalk.yellow(`\n📱 Steam Guard mobile authenticator code: `);
  }

  const code = await ask(prompt);
  callback(code.trim());
});

let finishTimeout;

client.on("loggedOn", () => {
  console.log("");
  console.log(chalk.green("✔ Logged in successfully!"));
  console.log(chalk.gray("Waiting for session token to be saved..."));
  
  // Fallback in case refreshToken doesn't fire
  finishTimeout = setTimeout(finishBootstrap, 5000);
});

client.on("refreshToken", () => {
  if (finishTimeout) clearTimeout(finishTimeout);
  finishBootstrap();
});

function finishBootstrap() {
  console.log(chalk.green("✔ Session token saved to ./sentry/"));
  console.log("");
  console.log(chalk.cyan("You can now start the idler in tmux:"));
  console.log(chalk.bold("  npm run tmux:start"));
  console.log("");
  console.log(chalk.gray("Logging off and exiting..."));

  client.logOff();
}

client.on("disconnected", () => {
  rl.close();
  process.exit(0);
});

client.on("error", (err) => {
  console.log(chalk.red(`\n✖ Error: ${err.message}`));
  rl.close();
  process.exit(1);
});

// Start login
const loginOptions = {
  accountName: config.username,
  password: config.password,
  machineName: config.machineName,
};

if (config.sharedSecret) {
  loginOptions.twoFactorCode = SteamTotp.generateAuthCode(config.sharedSecret);
}

console.log(chalk.gray(`Logging in as ${chalk.bold(config.username)}...`));
client.logOn(loginOptions);
