import { homedir } from "node:os";
import { join } from "node:path";

export const OAUTH = {
  clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
  // Max/Pro subscription accounts authenticate via the claude.ai chat flow.
  // platform.claude.com is the Console/API account login (wrong billing pool)
  // and also lacks the Google-popup login we automate against.
  authorizeUrl: "https://claude.ai/oauth/authorize",
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
  claudeSettingsFile: join(homedir(), ".claude", "settings.json"),
  credentialsFile: join(homedir(), ".claude", ".credentials.json"),
  autoConfigDir: join(homedir(), ".claude-auto"),
  googleStateFile: join(homedir(), ".claude-auto", "google-state.json"),
  hookRelayScript: join(homedir(), ".claude-auto", "hook-relay.sh"),
  logFile: join(homedir(), ".claude-auto", "claude-auto.log"),
} as const;

export const HOOK_RELAY_ENV = "CLAUDE_AUTO_RUN_SOCKET" as const;

export const HOOK_RELAY_MARKER = "claude-auto:hook-relay" as const;

export const AUTH_ERROR_PATTERNS = [
  "401",
  "authentication_error",
  "Failed to authenticate",
  "Invalid authentication credentials",
] as const;
