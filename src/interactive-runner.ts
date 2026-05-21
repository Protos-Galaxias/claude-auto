import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { authenticate } from "./authenticate.js";
import { createHookSettings, installHooks } from "./hook-installer.js";
import { HOOK_RELAY_ENV, PATHS } from "./constants.js";
import {
  startIpcServer,
  type SubagentStopEvent,
  type StopFailureEvent,
} from "./ipc-server.js";

import pty from "node-pty";

const require = createRequire(import.meta.url);
const READY_QUIET_MS = 800;
const READY_MAX_WAIT_MS = 8000;
const KILL_AFTER_EXIT_MS = 1500;

export interface RunInteractiveOptions {
  /** User prompt to send to Claude (will be typed into the TUI). */
  prompt: string;
  /** Extra CLI args to pass to `claude` (e.g. ["--model", "sonnet"]). */
  args?: string[];
  /** Working directory for the spawned `claude`. Defaults to process.cwd(). */
  cwd?: string;
  /** Hard timeout for the whole run. Defaults to 10 min. */
  timeoutMs?: number;
  /** Stream raw TUI output (ANSI included) to this writable. Default: discard. */
  debugTty?: NodeJS.WritableStream;
  /** Don't auto-install hooks. Caller is responsible. */
  skipHookInstall?: boolean;
  /** Don't run preflight authenticate(). */
  skipAuth?: boolean;
  /** Sources Claude should load settings from. Defaults to project/local only to avoid user-level API env overrides. */
  settingSources?: string;
}

export interface RunInteractiveResult {
  /** Final main-agent message (text from Stop hook's last_assistant_message). */
  text: string;
  /** Claude session id captured from the hook. */
  sessionId: string;
  /** Path to the JSONL transcript on disk. */
  transcriptPath: string;
  /** All SubagentStop events captured during the run. */
  subagents: SubagentStopEvent[];
}

export class AuthRetryNeeded extends Error {
  constructor(public detail: string) {
    super(`auth retry: ${detail}`);
  }
}

export class StopFailure extends Error {
  constructor(public event: StopFailureEvent) {
    super(`StopFailure: ${event.error}${event.error_details ? ` (${event.error_details})` : ""}`);
  }
}

export async function runInteractive(opts: RunInteractiveOptions): Promise<RunInteractiveResult> {
  if (!opts.skipHookInstall) {
    await installHooks();
  }
  if (!opts.skipAuth) {
    await authenticate({ silent: true });
  }

  try {
    return await runOnce(opts);
  } catch (err) {
    if (err instanceof AuthRetryNeeded) {
      await authenticate({ force: true, silent: true });

      return await runOnce(opts);
    }
    throw err;
  }
}

async function runOnce(opts: RunInteractiveOptions): Promise<RunInteractiveResult> {
  const runDir = mkdtempSync(join(tmpdir(), "claude-auto-"));
  const sockPath = join(runDir, "ipc.sock");
  const settingsPath = join(runDir, "settings.json");
  writeFileSync(
    settingsPath,
    JSON.stringify(createHookSettings(PATHS.hookRelayScript), null, 2) + "\n",
    { encoding: "utf8" }
  );

  const ipc = startIpcServer(sockPath);

  const cleanEnv = { ...process.env };
  delete cleanEnv.CLAUDECODE;
  delete cleanEnv.CLAUDE_CODE_ENTRYPOINT;
  cleanEnv[HOOK_RELAY_ENV] = sockPath;
  cleanEnv.IS_SANDBOX = cleanEnv.IS_SANDBOX ?? "1";

  ensureNodePtySpawnHelperExecutable();

  const claudeArgs = [
    "--setting-sources",
    opts.settingSources ?? "project,local",
    "--settings",
    settingsPath,
    ...(opts.args ?? []),
  ];

  const child = pty.spawn("claude", claudeArgs, {
    name: "xterm-256color",
    cols: 200,
    rows: 50,
    cwd: opts.cwd ?? process.cwd(),
    env: cleanEnv as Record<string, string>,
  });

  let exitInfo: { code: number; signal?: number } | null = null;
  const exitPromise = new Promise<void>((resolve) => {
    child.onExit(({ exitCode, signal }) => {
      exitInfo = { code: exitCode, signal };
      resolve();
    });
  });

  child.onData((d) => {
    if (opts.debugTty) {
      opts.debugTty.write(d);
    }
  });

  try {
    await waitForReady(child);
    await sendPrompt(child, opts.prompt);

    const timeout = opts.timeoutMs ?? 10 * 60_000;
    const event = await raceWithTimeout(ipc.done, timeout);

    if (event.hook_event_name === "StopFailure") {
      if (event.error === "authentication_failed") {
        throw new AuthRetryNeeded(event.error_details ?? event.error);
      }
      throw new StopFailure(event);
    }

    return {
      text: event.last_assistant_message ?? "",
      sessionId: event.session_id,
      transcriptPath: event.transcript_path,
      subagents: ipc.subagents,
    };
  } finally {
    await shutdown(child, exitPromise, exitInfo, ipc, runDir);
  }
}

function waitForReady(child: pty.IPty): Promise<void> {
  return new Promise((resolve) => {
    let lastChunkAt = Date.now();
    let resolved = false;

    const finish = () => {
      if (!resolved) {
        resolved = true;
        sub.dispose();
        clearInterval(poll);
        clearTimeout(hardLimit);
        resolve();
      }
    };

    const sub = child.onData(() => {
      lastChunkAt = Date.now();
    });

    const poll = setInterval(() => {
      if (Date.now() - lastChunkAt >= READY_QUIET_MS) {
        finish();
      }
    }, 100);

    const hardLimit = setTimeout(finish, READY_MAX_WAIT_MS);
  });
}

async function sendPrompt(child: pty.IPty, prompt: string): Promise<void> {
  const normalized = prompt.replace(/\r?\n/g, " ");
  child.write(normalized);

  // Claude's Ink input can drop an immediate Enter for longer pasted prompts.
  // Give the PTY/TUI a small, length-aware settling window before submitting.
  const submitDelayMs = Math.min(Math.max(500, normalized.length * 5), 3000);
  await new Promise((resolve) => setTimeout(resolve, submitDelayMs));
  child.write("\r");
}

function ensureNodePtySpawnHelperExecutable(): void {
  if (process.platform === "win32") {
    return;
  }

  try {
    const { dirname } = require("node:path") as typeof import("node:path");
    const { existsSync, statSync, chmodSync } = require("node:fs") as typeof import("node:fs");
    const packagePath = require.resolve("node-pty/package.json");
    const packageDir = dirname(packagePath);
    const helperPath = join(packageDir, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper");

    if (!existsSync(helperPath)) {
      return;
    }

    const mode = statSync(helperPath).mode;
    if ((mode & 0o111) !== 0) {
      return;
    }

    chmodSync(helperPath, mode | 0o755);
  } catch {
    // Let node-pty surface the real spawn error if the helper still cannot run.
  }
}

async function shutdown(
  child: pty.IPty,
  exitPromise: Promise<void>,
  exitInfo: { code: number; signal?: number } | null,
  ipc: { close: () => void },
  runDir: string
): Promise<void> {
  try {
    if (!exitInfo) {
      child.write("/exit\r");
      await raceWithTimeout(exitPromise, KILL_AFTER_EXIT_MS).catch(() => {
        try {
          child.kill();
        } catch {}
      });
    }
  } finally {
    ipc.close();
    try {
      const { rmSync, existsSync } = await import("node:fs");
      if (existsSync(runDir)) {
        rmSync(runDir, { recursive: true, force: true });
      }
    } catch {}
  }
}

function raceWithTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}
