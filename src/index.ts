#!/usr/bin/env node

import { spawn } from "node:child_process";
import { Command } from "commander";
import { AUTH_ERROR_PATTERNS, PATHS } from "./constants.js";
import { performHeadlessOAuth } from "./auth-flow.js";
import { refreshAccessToken } from "./oauth.js";
import {
  readCredentials,
  writeCredentials,
  isTokenExpired,
  getTokenExpiryInfo,
} from "./credentials.js";
import { runSetup } from "./setup.js";
import { runInteractive, StopFailure } from "./interactive-runner.js";
import { installHooks, uninstallHooks } from "./hook-installer.js";
import { logger, errMessage } from "./logger.js";

const program = new Command();

program
  .name("claude-auto")
  .description("Claude Code wrapper with automatic re-authentication")
  .version("1.0.0");

program
  .command("setup")
  .description("One-time setup: log into Google and save session for headless re-auth")
  .action(async () => {
    await runSetup();
  });

program
  .command("refresh")
  .description("Force re-authentication now (useful for cron)")
  .option("--debug", "Run with visible browser for debugging")
  .action(async (opts) => {
    await forceReauth(opts.debug ?? false);
  });

program
  .command("status")
  .description("Show current authentication status")
  .action(async () => {
    await showStatus();
  });

program
  .command("run", { isDefault: true })
  .description("Run claude with automatic re-auth on 401 (default)")
  .allowUnknownOption(true)
  .allowExcessArguments(true)
  .action(async () => {
    const claudeArgs = extractClaudeArgs();
    if (claudeArgs.length === 0) {
      program.help();

      return;
    }
    await runClaude(claudeArgs);
  });

program
  .command("tui-p <prompt>")
  .description(
    "Run a single-turn prompt by driving the interactive TUI via PTY + hooks.\n" +
      "Equivalent to `claude -p` but counts against subscription quota instead of API credits."
  )
  .option("--model <model>", "Override model (haiku/sonnet/opus)")
  .option("--cwd <dir>", "Working directory for the spawned claude")
  .option("--debug-tty", "Stream raw TUI output (ANSI) to stderr")
  .option("--timeout <ms>", "Hard timeout in milliseconds", (v) => parseInt(v, 10))
  .option("--skip-auth", "Skip claude-auto OAuth preflight and let the interactive claude CLI use its current auth state")
  .option("--setting-sources <sources>", "Claude setting sources to load. Defaults to project,local to avoid user-level API env overrides")
  .option("--skip-permissions", "Pass --dangerously-skip-permissions to claude (requires IS_SANDBOX=1)")
  .option("--append-system-prompt <text>", "Append to system prompt")
  .option("--mcp-config <path>", "Path to MCP config JSON")
  .allowUnknownOption(false)
  .action(async (prompt: string, opts) => {
    await runTuiP(prompt, opts);
  });

program
  .command("install-hooks")
  .description("Install Stop/SubagentStop/StopFailure relay hooks into ~/.claude/settings.json")
  .action(async () => {
    await installHooks();
    console.log("[claude-auto] hooks installed");
  });

program
  .command("uninstall-hooks")
  .description("Remove claude-auto relay hooks from ~/.claude/settings.json")
  .action(async () => {
    await uninstallHooks();
    console.log("[claude-auto] hooks removed");
  });

async function main(): Promise<void> {
  const knownCommands = ["setup", "refresh", "status", "help", "tui-p", "install-hooks", "uninstall-hooks", "run"];
  const firstArg = process.argv[2];
  const isOwnFlag = !firstArg || firstArg === "--help" || firstArg === "-h" || firstArg === "--version" || firstArg === "-v" || firstArg === "-V";

  if (firstArg && !knownCommands.includes(firstArg) && !isOwnFlag) {
    const claudeArgs = process.argv.slice(2);
    await runClaude(claudeArgs);

    return;
  }

  await program.parseAsync(process.argv);
}

interface TuiPOptions {
  model?: string;
  cwd?: string;
  debugTty?: boolean;
  timeout?: number;
  skipAuth?: boolean;
  settingSources?: string;
  skipPermissions?: boolean;
  appendSystemPrompt?: string;
  mcpConfig?: string;
}

async function runTuiP(prompt: string, opts: TuiPOptions): Promise<void> {
  const args: string[] = [];
  if (opts.model) {
    args.push("--model", opts.model);
  }
  if (opts.skipPermissions) {
    args.push("--dangerously-skip-permissions");
  }
  if (opts.appendSystemPrompt) {
    args.push("--append-system-prompt", opts.appendSystemPrompt);
  }
  if (opts.mcpConfig) {
    args.push("--mcp-config", opts.mcpConfig);
  }

  try {
    const result = await runInteractive({
      prompt,
      args,
      cwd: opts.cwd,
      timeoutMs: opts.timeout,
      debugTty: opts.debugTty ? process.stderr : undefined,
      skipAuth: opts.skipAuth,
      settingSources: opts.settingSources,
    });

    process.stdout.write(result.text);
    if (!result.text.endsWith("\n")) {
      process.stdout.write("\n");
    }
    process.exit(0);
  } catch (err) {
    if (err instanceof StopFailure) {
      logger.error(err.message);
      process.exit(2);
    }
    logger.error(errMessage(err));
    process.exit(1);
  }
}

function extractClaudeArgs(): string[] {
  const idx = process.argv.indexOf("run");
  if (idx === -1) {
    return process.argv.slice(2);
  }

  return process.argv.slice(idx + 1);
}

function isAuthError(output: string): boolean {
  const lower = output.toLowerCase();

  return AUTH_ERROR_PATTERNS.some((pattern) => lower.includes(pattern.toLowerCase()));
}

async function spawnClaude(
  args: string[]
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("claude", args, {
      stdio: ["inherit", "pipe", "pipe"],
      env: process.env,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      process.stdout.write(text);
    });

    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      process.stderr.write(text);
    });

    child.on("close", (code) => {
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });

    child.on("error", (err) => {
      resolve({
        exitCode: 1,
        stdout,
        stderr: stderr + `\nFailed to spawn claude: ${err.message}`,
      });
    });
  });
}

async function tryRefreshExisting(): Promise<boolean> {
  const creds = await readCredentials();
  if (!creds?.claudeAiOauth?.refreshToken) {
    return false;
  }

  logger.info("Attempting token refresh...");

  try {
    const tokens = await refreshAccessToken(creds.claudeAiOauth.refreshToken);
    await writeCredentials(tokens);
    logger.info("Token refresh successful.");

    return true;
  } catch (err) {
    logger.warn(`Token refresh failed: ${errMessage(err)}`);

    return false;
  }
}

async function performFullReauth(debug = false): Promise<boolean> {
  logger.info("Starting full OAuth re-authentication...");

  try {
    const tokens = await performHeadlessOAuth({ debug });
    await writeCredentials(tokens);
    logger.info("Full re-authentication successful.");

    return true;
  } catch (err) {
    logger.error(`Full re-auth failed: ${errMessage(err)}`);

    return false;
  }
}

async function runClaude(args: string[]): Promise<void> {
  const result = await spawnClaude(args);

  if (result.exitCode === 0) {
    process.exit(0);
  }

  if (!isAuthError(result.stderr + result.stdout)) {
    process.exit(result.exitCode);
  }

  logger.warn("Authentication error detected. Attempting recovery...");

  const refreshed = await tryRefreshExisting();
  if (refreshed) {
    logger.info("Retrying command after token refresh...");
    const retry = await spawnClaude(args);
    process.exit(retry.exitCode);
  }

  const reauthed = await performFullReauth();
  if (reauthed) {
    logger.info("Retrying command after full re-auth...");
    const retry = await spawnClaude(args);
    process.exit(retry.exitCode);
  }

  logger.error(
    "All recovery attempts failed. Run 'claude-auto setup' to refresh your Google session. " +
      `See ${PATHS.logFile} for details.`
  );
  process.exit(1);
}

async function forceReauth(debug = false): Promise<void> {
  const refreshed = await tryRefreshExisting();
  if (refreshed) {
    return;
  }

  const reauthed = await performFullReauth(debug);
  if (!reauthed) {
    logger.error(`Force re-auth failed. See ${PATHS.logFile} for details.`);
    process.exit(1);
  }
}

async function showStatus(): Promise<void> {
  const { existsSync } = await import("node:fs");
  const printFooter = (): void => {
    console.log(
      `Google state: ${existsSync(PATHS.googleStateFile) ? "present" : "NOT FOUND (run setup)"}`
    );
    console.log(
      `Log file: ${existsSync(PATHS.logFile) ? PATHS.logFile : `${PATHS.logFile} (not created yet)`}`
    );
  };

  const creds = await readCredentials();

  if (!creds) {
    console.log("Credentials file: not found");
    console.log("Status: NOT AUTHENTICATED");
    printFooter();

    return;
  }

  if (!creds.claudeAiOauth) {
    console.log("Credentials file: exists but no OAuth tokens");
    console.log("Status: NOT AUTHENTICATED");
    printFooter();

    return;
  }

  const expired = isTokenExpired(creds);
  const info = getTokenExpiryInfo(creds);

  console.log(`Token: ${info}`);
  console.log(`Status: ${expired ? "EXPIRED" : "ACTIVE"}`);
  console.log(`Scopes: ${creds.claudeAiOauth.scopes?.join(", ") ?? "unknown"}`);

  if (creds.claudeAiOauth.subscriptionType) {
    console.log(`Subscription: ${creds.claudeAiOauth.subscriptionType}`);
  }

  printFooter();
}

main().catch((err) => {
  logger.error(`Fatal: ${errMessage(err)}`);
  process.exit(1);
});
