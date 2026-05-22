export { OAUTH, PATHS, AUTH_ERROR_PATTERNS } from "./constants.js";

export {
  generatePKCE,
  buildAuthorizeUrl,
  exchangeCodeForTokens,
  refreshAccessToken,
  type OAuthTokens,
  type PKCEChallenge,
} from "./oauth.js";

export {
  readCredentials,
  writeCredentials,
  isTokenExpired,
  getTokenExpiryInfo,
  type CredentialsFile,
} from "./credentials.js";

export {
  performHeadlessOAuth,
  type AuthFlowOptions,
} from "./auth-flow.js";

export { runSetup } from "./setup.js";

export { authenticate, type AuthenticateOptions, type AuthenticateResult } from "./authenticate.js";

export {
  runInteractive,
  AuthRetryNeeded,
  StopFailure,
  type RunInteractiveOptions,
  type RunInteractiveResult,
  type ToolUseEvent,
} from "./interactive-runner.js";

export {
  parseTranscriptUsage,
  aggregateUsage,
  type UsageStats,
} from "./usage-parser.js";

export {
  type StopEvent,
  type SubagentStopEvent,
  type StopFailureEvent,
  type PreToolUseEvent,
  type HookEvent,
} from "./ipc-server.js";

export { installHooks, uninstallHooks } from "./hook-installer.js";
