#!/usr/bin/env node

import { spawn } from "node:child_process";
import { Command } from "commander";
import { AUTH_ERROR_PATTERNS } from "./constants.js";
import { performHeadlessOAuth } from "./auth-flow.js";
import { refreshAccessToken } from "./oauth.js";
import {
  readCredentials,
  writeCredentials,
  isTokenExpired,
  getTokenExpiryInfo,
} from "./credentials.js";
import { runSetup } from "./setup.js";

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

async function main(): Promise<void> {
  const knownCommands = ["setup", "refresh", "status", "help"];
  const firstArg = process.argv[2];
  const isOwnFlag = !firstArg || firstArg === "--help" || firstArg === "-h" || firstArg === "--version" || firstArg === "-v" || firstArg === "-V";

  if (firstArg && !knownCommands.includes(firstArg) && !isOwnFlag) {
    const claudeArgs = process.argv.slice(2);
    await runClaude(claudeArgs);

    return;
  }

  await program.parseAsync(process.argv);
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

  console.error("[claude-auto] Attempting token refresh...");

  try {
    const tokens = await refreshAccessToken(creds.claudeAiOauth.refreshToken);
    await writeCredentials(tokens);
    console.error("[claude-auto] Token refresh successful.");

    return true;
  } catch (err) {
    console.error(
      `[claude-auto] Token refresh failed: ${err instanceof Error ? err.message : err}`
    );

    return false;
  }
}

async function performFullReauth(debug = false): Promise<boolean> {
  console.error("[claude-auto] Starting full OAuth re-authentication...");

  try {
    const tokens = await performHeadlessOAuth({ debug });
    await writeCredentials(tokens);
    console.error("[claude-auto] Full re-authentication successful.");

    return true;
  } catch (err) {
    console.error(
      `[claude-auto] Full re-auth failed: ${err instanceof Error ? err.message : err}`
    );

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

  console.error("\n[claude-auto] Authentication error detected. Attempting recovery...\n");

  const refreshed = await tryRefreshExisting();
  if (refreshed) {
    console.error("[claude-auto] Retrying command...\n");
    const retry = await spawnClaude(args);
    process.exit(retry.exitCode);
  }

  const reauthed = await performFullReauth();
  if (reauthed) {
    console.error("[claude-auto] Retrying command...\n");
    const retry = await spawnClaude(args);
    process.exit(retry.exitCode);
  }

  console.error(
    "[claude-auto] All recovery attempts failed.\n" +
      "Try running 'claude-auto setup' to refresh your Google session."
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
    console.error("[claude-auto] Force re-auth failed.");
    process.exit(1);
  }
}

async function showStatus(): Promise<void> {
  const creds = await readCredentials();

  if (!creds) {
    console.log("Credentials file: not found");
    console.log("Status: NOT AUTHENTICATED");

    return;
  }

  if (!creds.claudeAiOauth) {
    console.log("Credentials file: exists but no OAuth tokens");
    console.log("Status: NOT AUTHENTICATED");

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

  const { existsSync } = await import("node:fs");
  const { PATHS } = await import("./constants.js");
  console.log(
    `Google state: ${existsSync(PATHS.googleStateFile) ? "present" : "NOT FOUND (run setup)"}`
  );
}

main().catch((err) => {
  console.error(`[claude-auto] Fatal: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
