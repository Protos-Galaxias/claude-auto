import { readCredentials, writeCredentials, isTokenExpired } from "./credentials.js";
import { refreshAccessToken, type OAuthTokens } from "./oauth.js";
import { performHeadlessOAuth, type AuthFlowOptions } from "./auth-flow.js";

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
  const log = silent ? () => {} : console.log.bind(console);

  if (!force) {
    const creds = await readCredentials();
    if (creds?.claudeAiOauth && !isTokenExpired(creds)) {
      return {
        tokens: {
          accessToken: creds.claudeAiOauth.accessToken,
          refreshToken: creds.claudeAiOauth.refreshToken,
          expiresAt: creds.claudeAiOauth.expiresAt,
          scopes: creds.claudeAiOauth.scopes,
        },
        method: "cached",
      };
    }
  }

  const creds = await readCredentials();
  if (creds?.claudeAiOauth?.refreshToken) {
    try {
      log("[claude-auto] Refreshing token...");
      const tokens = await refreshAccessToken(creds.claudeAiOauth.refreshToken);
      await writeCredentials(tokens);
      log("[claude-auto] Token refreshed.");

      return { tokens, method: "refreshed" };
    } catch {
      log("[claude-auto] Refresh failed, falling back to full re-auth...");
    }
  }

  log("[claude-auto] Starting full OAuth re-authentication...");
  const tokens = await performHeadlessOAuth({ debug });
  await writeCredentials(tokens);
  log("[claude-auto] Re-authentication successful.");

  return { tokens, method: "full_reauth" };
}
