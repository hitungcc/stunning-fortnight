import SteamUser from "steam-user";
import SteamTotp from "steam-totp";
import chalk from "chalk";
import { loadConfig } from "./config.js";
import { log } from "./logger.js";

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

const client = new SteamUser({
  autoRelogin: true,
  renewRefreshTokens: true,
  dataDirectory: "./sentry",         // store sentry files for session persistence
});

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
// Heartbeat — periodic status logging
// ─────────────────────────────────────────────────────────────
function startHeartbeat() {
  stopHeartbeat();
  const intervalMs = config.heartbeatInterval * 60 * 1000;

  heartbeatTimer = setInterval(() => {
    const uptime = loginStartTime ? formatUptime(Date.now() - loginStartTime) : "unknown";
    const memUsage = Math.round(process.memoryUsage().rss / 1024 / 1024);
    const gameList = formatGameList(config.gameIds, gameNames);
    log.heartbeat(
      `Idling ${config.gameIds.length} game(s) | ` +
      `Uptime: ${uptime} | ` +
      `Memory: ${memUsage}MB`
    );
    log.heartbeat(`Games: ${gameList}`);
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
  log.info("Attempting to log in as", chalk.bold(config.username), "...");

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
// Event: Steam Guard code needed (email-based 2FA)
// ─────────────────────────────────────────────────────────────
client.on("steamGuard", (domain, callback, lastCodeWrong) => {
  if (config.sharedSecret) {
    // Mobile authenticator — generate code automatically
    const code = SteamTotp.generateAuthCode(config.sharedSecret);
    log.info(`Steam Guard (mobile): auto-generated code`);
    callback(code);
    return;
  }

  if (domain) {
    // Email-based Steam Guard — cannot auto-generate
    log.warn(
      `Steam Guard code required! Check your email at *@${domain}`
    );
    log.warn(
      "For unattended 24/7 operation, set up Mobile Authenticator " +
      "and provide STEAM_SHARED_SECRET in .env"
    );

    // Read from stdin (works in terminal, not ideal for PM2)
    process.stdout.write("Enter Steam Guard code: ");
    let input = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.resume();
    process.stdin.once("data", (data) => {
      input = data.toString().trim();
      process.stdin.pause();
      callback(input);
    });
  } else {
    // Mobile authenticator but no shared secret
    log.warn(
      "Steam Guard mobile code required but no STEAM_SHARED_SECRET set."
    );
    log.warn(
      "For unattended operation, provide STEAM_SHARED_SECRET in .env"
    );

    process.stdout.write("Enter Mobile Authenticator code: ");
    let input = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.resume();
    process.stdin.once("data", (data) => {
      input = data.toString().trim();
      process.stdin.pause();
      callback(input);
    });
  }
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
  log.steam(`Now idling ${config.gameIds.length} game(s):`);
  for (const id of config.gameIds) {
    const name = gameNames[id] || `Unknown`;
    log.steam(`  → ${chalk.bold(name)} ${chalk.gray(`(App ID: ${id})`)}`);  
  }

  // Start idling the configured games
  client.gamesPlayed(config.gameIds);

  // Start heartbeat
  startHeartbeat();

  log.success("Service is running! Press Ctrl+C to stop (or let PM2 manage it).");
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
    const appName = gameNames[playingApp] || playingApp;
    log.warn(
      `Idling blocked! Game being played elsewhere: ${appName} (App ID: ${playingApp}). ` +
      `Idling will resume when you stop playing.`
    );
  } else {
    // Re-start idling
    client.gamesPlayed(config.gameIds);
    const gameList = formatGameList(config.gameIds, gameNames);
    log.steam(`Idling resumed: ${gameList}`);
  }
});

// ─────────────────────────────────────────────────────────────
// Event: Disconnected
// ─────────────────────────────────────────────────────────────
client.on("disconnected", (eresult, msg) => {
  stopHeartbeat();
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

  // Some errors are fatal and shouldn't auto-reconnect
  const fatalErrors = [
    SteamUser.EResult.InvalidPassword,
    SteamUser.EResult.AccountDisabled,
    SteamUser.EResult.AccountLockedDown,
    SteamUser.EResult.InvalidLoginAuthCode,
  ];

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
  log.debug("Received new refresh token (session persisted)");
});

// ─────────────────────────────────────────────────────────────
// Graceful shutdown
// ─────────────────────────────────────────────────────────────
function shutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  log.info(`\nReceived ${signal}. Shutting down gracefully...`);
  stopHeartbeat();

  client.gamesPlayed([]); // stop idling
  client.logOff();

  setTimeout(() => {
    log.info("Goodbye! 👋");
    process.exit(0);
  }, 2000);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// Handle uncaught exceptions (keep PM2 from restarting in loops)
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
log.info(`Heartbeat interval: ${config.heartbeatInterval} minutes`);
log.info(`Reconnect delay: ${config.reconnectDelay} seconds`);
log.info(`2FA mode: ${config.sharedSecret ? "Auto (shared_secret)" : "Manual prompt"}`);
log.info(`Device name: ${config.machineName}`);
log.info("═══════════════════════════════════════════════════");

// Pre-fetch game names before login for boot log
(async () => {
  log.info("Fetching game names...");
  gameNames = await fetchGameNames(config.gameIds);
  for (const id of config.gameIds) {
    log.info(`  → ${chalk.bold(gameNames[id] || "Unknown")} ${chalk.gray(`(${id})`)}`);  
  }
  doLogin();
})();
