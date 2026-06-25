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
  };
}
