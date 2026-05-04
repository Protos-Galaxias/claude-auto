import { randomBytes, createHash } from "node:crypto";
import { OAUTH } from "./constants.js";

function base64url(buffer: Buffer): string {
  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export interface PKCEChallenge {
  codeVerifier: string;
  codeChallenge: string;
  state: string;
}

export function generatePKCE(): PKCEChallenge {
  const codeVerifier = base64url(randomBytes(32));
  const codeChallenge = base64url(
    createHash("sha256").update(codeVerifier).digest()
  );
  const state = base64url(randomBytes(32));

  return { codeVerifier, codeChallenge, state };
}

export function buildAuthorizeUrl(
  pkce: PKCEChallenge,
  redirectUri: string
): string {
  const params = new URLSearchParams({
    code: "true",
    client_id: OAUTH.clientId,
    response_type: "code",
    redirect_uri: redirectUri,
    scope: OAUTH.scopes.join(" "),
    code_challenge: pkce.codeChallenge,
    code_challenge_method: OAUTH.codeChallengeMethod,
    state: pkce.state,
  });

  return `${OAUTH.authorizeUrl}?${params.toString()}`;
}

export interface OAuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes: string[];
}

export async function exchangeCodeForTokens(
  code: string,
  codeVerifier: string,
  redirectUri: string,
  state: string
): Promise<OAuthTokens> {
  const response = await fetch(OAUTH.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: OAUTH.clientId,
      code_verifier: codeVerifier,
      state,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Token exchange failed (${response.status}): ${body}`
    );
  }

  const data = (await response.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    scope?: string;
  };

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000,
    scopes: (data.scope ?? OAUTH.scopes.join(" ")).split(" "),
  };
}

export async function refreshAccessToken(
  refreshToken: string
): Promise<OAuthTokens> {
  const response = await fetch(OAUTH.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: OAUTH.clientId,
      scope: OAUTH.scopes.join(" "),
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Token refresh failed (${response.status}): ${body}`
    );
  }

  const data = (await response.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    scope?: string;
  };

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000,
    scopes: (data.scope ?? OAUTH.scopes.join(" ")).split(" "),
  };
}
