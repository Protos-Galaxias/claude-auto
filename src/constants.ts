import { homedir } from "node:os";
import { join } from "node:path";

export const OAUTH = {
  clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
  authorizeUrl: "https://platform.claude.com/oauth/authorize",
  tokenUrl: "https://platform.claude.com/v1/oauth/token",
  scopes: [
    "user:profile",
    "user:inference",
    "user:sessions:claude_code",
    "user:mcp_servers",
    "user:file_upload",
  ],
  codeChallengeMethod: "S256" as const,
} as const;

export const PATHS = {
  claudeConfigDir: join(homedir(), ".claude"),
  credentialsFile: join(homedir(), ".claude", ".credentials.json"),
  autoConfigDir: join(homedir(), ".claude-auto"),
  googleStateFile: join(homedir(), ".claude-auto", "google-state.json"),
} as const;

export const AUTH_ERROR_PATTERNS = [
  "401",
  "authentication_error",
  "Failed to authenticate",
  "Invalid authentication credentials",
] as const;
