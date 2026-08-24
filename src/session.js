import fs from "fs";
import path from "path";

/**
 * Persists the Steam refresh token so the idler can log back in without a
 * 2FA prompt after a process restart.
 *
 * steam-user only auto-persists the legacy machine-auth token (which
 * suppresses the *email* Guard prompt) to `dataDirectory`. The refresh
 * token — the thing that actually lets you skip 2FA on the next run — is
 * only ever handed to the app via the `refreshToken` event; the library
 * never writes it to disk or reuses it across process restarts on its own.
 */
export function refreshTokenPath(sentryDir) {
  return path.join(sentryDir, "refresh-token.json");
}

export function loadRefreshToken(sentryDir) {
  try {
    const raw = fs.readFileSync(refreshTokenPath(sentryDir), "utf-8");
    const { token } = JSON.parse(raw);
    return token || null;
  } catch {
    return null;
  }
}

export function saveRefreshToken(sentryDir, token) {
  try {
    fs.mkdirSync(sentryDir, { recursive: true });
    fs.writeFileSync(
      refreshTokenPath(sentryDir),
      JSON.stringify({ token, savedAt: new Date().toISOString() }, null, 2)
    );
  } catch (err) {
    return err;
  }
  return null;
}

export function clearRefreshToken(sentryDir) {
  try {
    fs.unlinkSync(refreshTokenPath(sentryDir));
  } catch {
    // already gone — fine
  }
}
