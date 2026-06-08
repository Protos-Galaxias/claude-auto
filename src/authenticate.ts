import { readCredentials, writeCredentials, isTokenExpired } from "./credentials.js";
import { refreshAccessToken, type OAuthTokens } from "./oauth.js";
import { performHeadlessOAuth, type AuthFlowOptions } from "./auth-flow.js";
import { logger, errMessage } from "./logger.js";

export interface AuthenticateOptions {
  /** Force full re-auth even if tokens are still valid */
  force?: boolean;
  /** Show browser for debugging */
  debug?: boolean;
  /** Suppress console.log output */
  silent?: boolean;
}

export interface AuthenticateResult {
  tokens: OAuthTokens;
  /** How the tokens were obtained */
  method: "cached" | "refreshed" | "full_reauth";
}

/**
 * Get valid Claude OAuth tokens, re-authenticating if needed.
 *
 * Tries in order:
 * 1. Return cached tokens if still valid (unless `force` is set)
 * 2. Refresh using existing refresh_token
 * 3. Full headless OAuth via saved Google session
 *
 * Requires `claude-auto setup` to have been run at least once.
 */
export async function authenticate(
  options: AuthenticateOptions = {}
): Promise<AuthenticateResult> {
  const { force = false, debug = false, silent = false } = options;
  // File log is always written; `silent` only suppresses the stderr echo so
  // library callers can stay quiet while we still keep a forensic trail.
  const echo = !silent;

  if (!force) {
    const cached = await readCredentials();
    if (cached?.claudeAiOauth && !isTokenExpired(cached)) {
      logger.info("Using cached token (still valid).", { echo });

      return {
        tokens: {
          accessToken: cached.claudeAiOauth.accessToken,
          refreshToken: cached.claudeAiOauth.refreshToken,
          expiresAt: cached.claudeAiOauth.expiresAt,
          scopes: cached.claudeAiOauth.scopes,
        },
        method: "cached",
      };
    }
  }

  const creds = await readCredentials();
  if (creds?.claudeAiOauth?.refreshToken) {
    try {
      logger.info(force ? "Forced re-auth: refreshing token..." : "Token expired: refreshing token...", { echo });
      const tokens = await refreshAccessToken(creds.claudeAiOauth.refreshToken);
      await writeCredentials(tokens);
      logger.info("Token refreshed successfully.", { echo });

      return { tokens, method: "refreshed" };
    } catch (err) {
      logger.warn(`Token refresh failed: ${errMessage(err)}. Falling back to full OAuth.`, { echo });
    }
  } else {
    logger.warn("No usable refresh token found; going straight to full OAuth.", { echo });
  }

  logger.info("Starting full headless OAuth re-authentication...", { echo });
  try {
    const tokens = await performHeadlessOAuth({ debug });
    await writeCredentials(tokens);
    logger.info("Full re-authentication successful.", { echo });

    return { tokens, method: "full_reauth" };
  } catch (err) {
    logger.error(`Full re-authentication failed: ${errMessage(err)}`, { echo });
    throw err;
  }
}
