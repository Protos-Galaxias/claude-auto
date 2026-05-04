import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { PATHS } from "./constants.js";
import type { OAuthTokens } from "./oauth.js";

export interface CredentialsFile {
  claudeAiOauth?: {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    scopes: string[];
    subscriptionType?: string | null;
    rateLimitTier?: string | null;
  };
  [key: string]: unknown;
}

export async function readCredentials(): Promise<CredentialsFile | null> {
  if (!existsSync(PATHS.credentialsFile)) {
    return null;
  }

  try {
    const raw = await readFile(PATHS.credentialsFile, "utf-8");

    return JSON.parse(raw) as CredentialsFile;
  } catch {
    return null;
  }
}

export async function writeCredentials(tokens: OAuthTokens): Promise<void> {
  if (!existsSync(PATHS.claudeConfigDir)) {
    await mkdir(PATHS.claudeConfigDir, { recursive: true });
  }

  const existing = (await readCredentials()) ?? {};

  const prev = existing.claudeAiOauth;

  existing.claudeAiOauth = {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt,
    scopes: tokens.scopes,
    subscriptionType: prev?.subscriptionType ?? null,
    rateLimitTier: prev?.rateLimitTier ?? null,
  };

  await writeFile(
    PATHS.credentialsFile,
    JSON.stringify(existing, null, 2) + "\n",
    { mode: 0o600 }
  );
}

export function isTokenExpired(creds: CredentialsFile): boolean {
  if (!creds.claudeAiOauth) {
    return true;
  }

  const bufferMs = 5 * 60 * 1000;

  return Date.now() >= creds.claudeAiOauth.expiresAt - bufferMs;
}

export function getTokenExpiryInfo(creds: CredentialsFile): string {
  if (!creds.claudeAiOauth) {
    return "No OAuth tokens found";
  }

  const expiresAt = new Date(creds.claudeAiOauth.expiresAt);
  const now = Date.now();
  const diffMs = creds.claudeAiOauth.expiresAt - now;

  if (diffMs <= 0) {
    return `Token expired at ${expiresAt.toISOString()}`;
  }

  const hours = Math.floor(diffMs / (1000 * 60 * 60));
  const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));

  return `Token expires at ${expiresAt.toISOString()} (${hours}h ${minutes}m remaining)`;
}
