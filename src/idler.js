import SteamUser from "steam-user";
import SteamTotp from "steam-totp";
import chalk from "chalk";
import { loadConfig } from "./config.js";
import { log } from "./logger.js";
import { IdleScheduler, ROLE, formatDuration } from "./scheduler.js";
import { AchievementRunner, parseQuietHours } from "./achiever.js";
import { loadRefreshToken, saveRefreshToken, clearRefreshToken } from "./session.js";

// ─────────────────────────────────────────────────────────────
// Fetch game names from Steam Store API
// ─────────────────────────────────────────────────────────────
async function fetchGameNames(appIds) {
  const names = {};
  for (const appId of appIds) {
    try {
      const res = await fetch(
        `https://store.steampowered.com/api/appdetails?appids=${appId}&filters=basic`
      );
      const json = await res.json();
      if (json[appId]?.success) {
        names[appId] = json[appId].data.name;
      } else {
        names[appId] = `Unknown (${appId})`;
      }
    } catch {
      names[appId] = `Unknown (${appId})`;
    }
  }
  return names;
}

/**
 * Format game list for display: "Game Name (12345), Other Game (67890)"
 */
function formatGameList(gameIds, nameMap) {
  return gameIds
    .map((id) => {
      const name = nameMap[id];
      return name ? `${name} (${id})` : `${id}`;
    })
    .join(", ");
}

// ─────────────────────────────────────────────────────────────
// Load config
// ─────────────────────────────────────────────────────────────
let config;
try {
  config = loadConfig();
} catch (err) {
  log.error(err.message);
  process.exit(1);
}

// ─────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────
let reconnectAttempts = 0;
let heartbeatTimer = null;
let isShuttingDown = false;
let loginStartTime = null;
let gameNames = {};  // { appId: "Game Name" }

const SENTRY_DIR = "./sentry";

const client = new SteamUser({
  autoRelogin: true,
  renewRefreshTokens: true,
  dataDirectory: SENTRY_DIR,         // store sentry files for session persistence
});

// Whether the login currently in flight used the saved refresh token, so the
// error handler knows whether a rejection means "token is dead, fall back to
// password" or "password/2FA are actually wrong".
let loginViaRefreshToken = false;

// Decides which games are idling at any moment — see IDLE_MODE in .env
const scheduler = new IdleScheduler({
  mode: config.idle.mode,
  gameIds: config.gameIds,
  pinnedIds: config.idle.pinnedIds,
  batchSize: config.idle.batchSize,
  intervalMinutes: config.idle.intervalMinutes,
  jitterPercent: config.idle.jitterPercent,
  statePath: config.idle.stateFile,
});

// Unlocks achievements on an idle-time schedule — see ACH_* in .env
const achiever = config.achievements.enabled
  ? new AchievementRunner({
      client,
      scheduler,
      settings: config.achievements,
      nameOf: (id) => nameOf(id),
    })
  : null;

log.info(`Machine name: ${chalk.bold(config.machineName)} (will appear in Steam login devices)`);

// ─────────────────────────────────────────────────────────────
// Format uptime helper
// ─────────────────────────────────────────────────────────────
function formatUptime(ms) {
  const seconds = Math.floor(ms / 1000);
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  const parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  parts.push(`${secs}s`);
  return parts.join(" ");
}

// ─────────────────────────────────────────────────────────────
// Idling — either the rotating batch or the whole list
// ─────────────────────────────────────────────────────────────
function nameOf(id) {
  return gameNames[id] || `Unknown (${id})`;
}

/** Called by the scheduler every time the active set changes. */
function onScheduleChange(activeIds) {
  client.gamesPlayed(activeIds);
  achiever?.onActive(activeIds);
  const list = chalk.bold(formatGameList(activeIds, gameNames));
  if (scheduler.rotates) {
    log.steam(
      `Now idling: ${list} ` +
      chalk.gray(`(next switch in ~${config.idle.intervalMinutes}m)`)
    );
  } else {
    log.steam(`Now idling: ${list}`);
  }
}

/** (Re)start idling after login. */
function startIdling() {
  scheduler.start(onScheduleChange);
}

/** Bank playtime whenever idling actually stops. */
function pauseIdling() {
  scheduler.pause();
  achiever?.pause();
}

// ─────────────────────────────────────────────────────────────
// Heartbeat — periodic status logging
// ─────────────────────────────────────────────────────────────
function startHeartbeat() {
  stopHeartbeat();
  const intervalMs = config.heartbeatInterval * 60 * 1000;

  heartbeatTimer = setInterval(() => {
    const uptime = loginStartTime ? formatUptime(Date.now() - loginStartTime) : "unknown";
    const memUsage = Math.round(process.memoryUsage().rss / 1024 / 1024);

    // Bank progress on every heartbeat so a hard kill loses minutes, not hours
    scheduler.credit();
    scheduler.save();

    log.heartbeat(
      `Mode ${chalk.bold(scheduler.mode)}: ${scheduler.describe()} | ` +
      `Uptime: ${uptime} | Memory: ${memUsage}MB`
    );
    log.heartbeat(`Active: ${formatGameList(scheduler.active, gameNames)}`);
    for (const { id, ms, role } of scheduler.stats()) {
      const tag =
        role === ROLE.PINNED
          ? chalk.green("pinned")
          : role === ROLE.PARKED
            ? chalk.gray("parked")
            : chalk.cyan("rotating");
      const ach = achiever?.status(id);
      log.heartbeat(
        `  ${chalk.gray("·")} ${nameOf(id)} — ${formatDuration(ms)} idled ` +
        chalk.gray("[") + tag + chalk.gray("]") +
        (ach ? chalk.gray(` · ${ach}`) : "")
      );
    }
  }, intervalMs);

  // Don't let heartbeat timer prevent process exit
  if (heartbeatTimer.unref) heartbeatTimer.unref();
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

// ─────────────────────────────────────────────────────────────
// Login
// ─────────────────────────────────────────────────────────────
function doLogin() {
  const savedToken = loadRefreshToken(SENTRY_DIR);

  if (savedToken) {
    log.info("Logging in with saved session (no 2FA needed)...");
    loginViaRefreshToken = true;
    try {
      client.logOn({ refreshToken: savedToken });
    } catch (err) {
      // Malformed/corrupt token file — don't loop on it, fall back to password.
      log.warn(`Saved session token is invalid (${err.message}); logging in with password.`);
      clearRefreshToken(SENTRY_DIR);
      loginViaRefreshToken = false;
      doLogin();
    }
    return;
  }

  log.info("Attempting to log in as", chalk.bold(config.username), "...");
  loginViaRefreshToken = false;

  const loginOptions = {
    accountName: config.username,
    password: config.password,
    machineName: config.machineName,  // device name shown in Steam login history
  };

  // If shared_secret is available, generate 2FA code automatically
  if (config.sharedSecret) {
    loginOptions.twoFactorCode = SteamTotp.generateAuthCode(config.sharedSecret);
    log.info("2FA code generated automatically from shared_secret");
  }

  client.logOn(loginOptions);
}

// ─────────────────────────────────────────────────────────────
// Event: Steam Guard code needed
// ─────────────────────────────────────────────────────────────
client.on("steamGuard", (domain, callback, lastCodeWrong) => {
  if (config.sharedSecret) {
    // Mobile authenticator — generate code automatically
    const code = SteamTotp.generateAuthCode(config.sharedSecret);
    log.info("Steam Guard (mobile): auto-generated code");
    callback(code);
    return;
  }

  if (lastCodeWrong) {
    log.error("Previous Steam Guard code was rejected — try again.");
  }

  if (domain) {
    log.warn(`Steam Guard code required! Check your email at *@${domain}`);
  } else {
    log.warn("Steam Guard mobile code required but no STEAM_SHARED_SECRET set.");
  }
  log.warn(
    "Type the code below. For unattended operation set STEAM_SHARED_SECRET in .env, " +
    "or run `npm run bootstrap` once so the session is cached in ./sentry/."
  );

  // Running inside tmux means stdin is a real terminal: attach the session
  // and type the code straight into the pane.
  process.stdout.write("Enter Steam Guard code: ");
  process.stdin.setEncoding("utf-8");
  process.stdin.resume();
  process.stdin.once("data", (data) => {
    process.stdin.pause();
    callback(data.toString().trim());
  });
});

// ─────────────────────────────────────────────────────────────
// Event: Logged in successfully
// ─────────────────────────────────────────────────────────────
client.on("loggedOn", async (details) => {
  loginStartTime = Date.now();
  reconnectAttempts = 0;

  log.success(`Logged in as ${config.username} (SteamID: ${client.steamID})`);

  // Set persona state (0 = Offline/Invisible for stealth idling)
  client.setPersona(config.personaState);
  const stateNames = ["Offline", "Online", "Busy", "Away", "Snooze", "Looking to Trade", "Looking to Play"];
  log.info(`Persona state set to: ${stateNames[config.personaState] || config.personaState}`);

  if (config.personaState === 0) {
    log.info(
      chalk.yellow("Note: Persona is Offline — friends cannot see you playing. ") +
      chalk.yellow("Playtime still accumulates. Change to 1 (Online) if you want visibility.")
    );
  }

  // Resolve game names from Steam Store API
  log.info("Resolving game names from Steam Store...");
  gameNames = await fetchGameNames(config.gameIds);

  // Log each game with its resolved name
  log.steam(`Game pool (${config.gameIds.length}):`);
  for (const id of config.gameIds) {
    log.steam(`  → ${chalk.bold(nameOf(id))} ${chalk.gray(`(App ID: ${id})`)}`);
  }

  startIdling();
  startHeartbeat();

  if (achiever) {
    // Games this mode will actually idle; parked ones would never progress
    const schedulable = config.gameIds.filter((id) => !scheduler.parked.includes(id));
    achiever
      .prepare(schedulable)
      .then(() => achiever.start())
      .catch((err) => log.error(`Achievement planning failed: ${err.message}`));
  }

  log.success("Service is running! Ctrl+B then D detaches tmux, Ctrl+C stops the idler.");
});

// ─────────────────────────────────────────────────────────────
// Event: Account info received
// ─────────────────────────────────────────────────────────────
client.on("accountInfo", (name, country) => {
  log.info(`Account name: ${name} | Country: ${country}`);
});

// ─────────────────────────────────────────────────────────────
// Event: Wallet balance
// ─────────────────────────────────────────────────────────────
client.on("wallet", (hasWallet, currency, balance) => {
  if (hasWallet) {
    // balance is in cents
    const formatted = (balance / 100).toFixed(2);
    log.info(`Wallet balance: ${formatted} (currency code: ${currency})`);
  }
});

// ─────────────────────────────────────────────────────────────
// Event: Game playing state changed (e.g. playing elsewhere)
// ─────────────────────────────────────────────────────────────
client.on("playingState", (blocked, playingApp) => {
  if (blocked) {
    log.warn(
      `Idling blocked! Game being played elsewhere: ${nameOf(playingApp)} ` +
      `(App ID: ${playingApp}). Idling will resume when you stop playing.`
    );
    // Don't credit idle time we aren't actually getting
    pauseIdling();
  } else {
    // Resume the same set it was on — a rotating queue loses nothing
    const active = scheduler.resume();
    if (active.length === 0) return;   // login handler hasn't picked a set yet
    client.gamesPlayed(active);
    achiever?.onActive(active);
    log.steam(`Idling resumed: ${formatGameList(active, gameNames)}`);
  }
});

// ─────────────────────────────────────────────────────────────
// Event: Disconnected
// ─────────────────────────────────────────────────────────────
client.on("disconnected", (eresult, msg) => {
  stopHeartbeat();
  achiever?.stop();
  pauseIdling();
  log.warn(`Disconnected from Steam (EResult: ${eresult}, Message: ${msg || "none"})`);

  if (isShuttingDown) return;

  // Auto-reconnect logic
  const maxAttempts = config.maxReconnectAttempts;
  if (maxAttempts > 0 && reconnectAttempts >= maxAttempts) {
    log.error(`Max reconnect attempts (${maxAttempts}) reached. Exiting.`);
    process.exit(1);
  }

  reconnectAttempts++;
  log.info(
    `Reconnecting in ${config.reconnectDelay}s... ` +
    `(attempt ${reconnectAttempts}${maxAttempts > 0 ? `/${maxAttempts}` : ""})`
  );

  setTimeout(() => {
    if (!isShuttingDown) doLogin();
  }, config.reconnectDelay * 1000);
});

// ─────────────────────────────────────────────────────────────
// Event: Error
// ─────────────────────────────────────────────────────────────
client.on("error", (err) => {
  log.error(`Steam client error: ${err.message}`);
  pauseIdling();

  // Some errors are fatal and shouldn't auto-reconnect
  const fatalErrors = [
    SteamUser.EResult.InvalidPassword,
    SteamUser.EResult.AccountDisabled,
    SteamUser.EResult.AccountLockedDown,
    SteamUser.EResult.InvalidLoginAuthCode,
  ];

  // A saved session token can go stale (revoked, expired, Steam Guard reset).
  // That's not a real credential failure — clear it and fall back to a normal
  // password + 2FA login instead of treating it as fatal.
  const tokenRejected = [
    SteamUser.EResult.AccessDenied,
    SteamUser.EResult.Expired,
    SteamUser.EResult.InvalidSignature,
    ...fatalErrors,
  ];

  if (loginViaRefreshToken && tokenRejected.includes(err.eresult)) {
    log.warn("Saved session was rejected by Steam; clearing it and logging in with password.");
    clearRefreshToken(SENTRY_DIR);
    loginViaRefreshToken = false;
    setTimeout(() => {
      if (!isShuttingDown) doLogin();
    }, 1000);
    return;
  }

  if (fatalErrors.includes(err.eresult)) {
    log.error("Fatal authentication error. Check your credentials and 2FA settings.");
    log.error("Exiting. Fix the issue and restart the service.");
    process.exit(1);
  }

  // Non-fatal errors: steam-user autoRelogin handles most, but
  // we catch anything that falls through
  if (!isShuttingDown) {
    const delay = config.reconnectDelay;
    reconnectAttempts++;
    log.info(`Will attempt reconnect in ${delay}s...`);
    setTimeout(() => {
      if (!isShuttingDown) doLogin();
    }, delay * 1000);
  }
});

// ─────────────────────────────────────────────────────────────
// Event: New login key (session refresh — good for persistence)
// ─────────────────────────────────────────────────────────────
client.on("refreshToken", (token) => {
  const err = saveRefreshToken(SENTRY_DIR, token);
  if (err) {
    log.warn(`Could not persist session token (${err.message}); will need 2FA on next restart.`);
  } else {
    log.debug("Refresh token saved — next restart won't need a 2FA prompt.");
  }
});

// ─────────────────────────────────────────────────────────────
// Graceful shutdown
// ─────────────────────────────────────────────────────────────
function shutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  log.info(`\nReceived ${signal}. Shutting down gracefully...`);
  stopHeartbeat();
  scheduler.stop();   // banks and persists accumulated playtime
  achiever?.stop();
  achiever?.save();

  client.gamesPlayed([]); // stop idling
  client.logOff();

  setTimeout(() => {
    log.info("Goodbye! 👋");
    process.exit(0);
  }, 2000);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// Keep the process alive on unexpected errors — a tmux pane that dies
// silently is worse than one that logs and keeps retrying.
process.on("uncaughtException", (err) => {
  log.error("Uncaught exception:", err.message);
  log.error(err.stack);
});

process.on("unhandledRejection", (reason) => {
  log.error("Unhandled rejection:", reason);
});

// ─────────────────────────────────────────────────────────────
// Boot
// ─────────────────────────────────────────────────────────────
log.info("═══════════════════════════════════════════════════");
log.info("  STUNNING-FORTNIGHT • Steam Idler Service");
log.info("═══════════════════════════════════════════════════");
log.info(`Games to idle: [${config.gameIds.join(", ")}]`);
log.info(`Idle mode: ${chalk.bold(scheduler.mode)} — ${scheduler.describe()}`);
if (scheduler.pinned.length > 0) {
  log.info(`Pinned (always on): [${scheduler.pinned.join(", ")}]`);
}
if (scheduler.parked.length > 0) {
  log.info(chalk.yellow(`Never played in this mode: [${scheduler.parked.join(", ")}]`));
}
if (scheduler.rotates) {
  log.info(
    `Rotation: every ${config.idle.intervalMinutes}m ` +
    `(±${config.idle.jitterPercent}% jitter)`
  );
}
log.info(`Idle state file: ${config.idle.stateFile}`);
if (achiever) {
  const a = config.achievements;
  const quiet = parseQuietHours(a.quietHours);
  const completion = Array.isArray(a.completion) ? a.completion.join("–") : a.completion;
  log.info(
    `Achievements: ${a.dryRun ? chalk.yellow("DRY-RUN (nothing is unlocked)") : chalk.green("LIVE")} | ` +
    `${a.hoursEach}h each, ${a.minHours}–${a.maxHours}h per game | completion ${completion}% | ` +
    `quiet hours ${quiet ? `${quiet.start}:00–${quiet.end}:00` : "off"}`
  );
} else {
  log.info("Achievements: off (set ACH_ENABLED=true to enable)");
}
log.info(`Heartbeat interval: ${config.heartbeatInterval} minutes`);
log.info(`Reconnect delay: ${config.reconnectDelay} seconds`);
log.info(`2FA mode: ${config.sharedSecret ? "Auto (shared_secret)" : "Manual prompt"}`);
log.info(`Device name: ${config.machineName}`);
log.info("═══════════════════════════════════════════════════");

// Pre-fetch game names before login for the boot log
(async () => {
  log.info("Fetching game names...");
  gameNames = await fetchGameNames(config.gameIds);
  for (const id of config.gameIds) {
    log.info(`  → ${chalk.bold(nameOf(id))} ${chalk.gray(`(${id})`)}`);
  }
  doLogin();
})();
