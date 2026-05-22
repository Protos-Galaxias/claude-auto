import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { authenticate } from "./authenticate.js";
import { createHookSettings, installHooks } from "./hook-installer.js";
import { HOOK_RELAY_ENV, PATHS } from "./constants.js";
import {
  startIpcServer,
  type HookEvent,
  type PreToolUseEvent,
  type SubagentStopEvent,
  type StopFailureEvent,
} from "./ipc-server.js";
import { parseTranscriptUsage, type UsageStats } from "./usage-parser.js";
import { throwIfAborted, withAbort } from "./abort.js";

import pty from "node-pty";

const require = createRequire(import.meta.url);
const READY_QUIET_MS = 800;
const READY_MAX_WAIT_MS = 8000;
const KILL_AFTER_EXIT_MS = 1500;

export interface ToolUseEvent {
  /** Tool name (e.g. "Read", "Bash", "Edit"). */
  name: string;
  /** Raw tool input as Claude sent it. Not sanitized. */
  input?: unknown;
  /** Subagent id if this came from a subagent (only set when includeSubagentTools is true). */
  agentId?: string;
  /** Subagent type if this came from a subagent. */
  agentType?: string;
  /** Claude's tool_use_id (useful for correlating with PostToolUse later). */
  toolUseId?: string;
}

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
  /** External cancellation. On abort the PTY is killed, IPC closed, and the call rejects with AbortError. */
  signal?: AbortSignal;
  /**
   * Live callback fired on every PreToolUse event. Wires up PreToolUse hook in
   * the per-run settings file. By default only main-agent tool calls are forwarded;
   * pass {@link RunInteractiveOptions.includeSubagentTools} to also see subagent tools.
   * Listener errors are swallowed.
   */
  onToolUse?: (ev: ToolUseEvent) => void;
  /** Forward subagent PreToolUse events to onToolUse too. Off by default (noisy). */
  includeSubagentTools?: boolean;
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
  /** Aggregated main-agent token usage parsed from the transcript. Undefined if parse failed. */
  usage?: UsageStats;
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
  throwIfAborted(opts.signal);

  if (!opts.skipHookInstall) {
    await installHooks();
  }
  if (!opts.skipAuth) {
    await authenticate({ silent: true });
  }

  throwIfAborted(opts.signal);

  try {
    return await runOnce(opts);
  } catch (err) {
    if (err instanceof AuthRetryNeeded) {
      throwIfAborted(opts.signal);
      await authenticate({ force: true, silent: true });
      throwIfAborted(opts.signal);

      return await runOnce(opts);
    }
    throw err;
  }
}

async function runOnce(opts: RunInteractiveOptions): Promise<RunInteractiveResult> {
  const runDir = mkdtempSync(join(tmpdir(), "claude-auto-"));
  const sockPath = join(runDir, "ipc.sock");
  const settingsPath = join(runDir, "settings.json");
  const wantsToolUse = typeof opts.onToolUse === "function";
  writeFileSync(
    settingsPath,
    JSON.stringify(
      createHookSettings(PATHS.hookRelayScript, { includeToolUse: wantsToolUse }),
      null,
      2
    ) + "\n",
    { encoding: "utf8" }
  );

  const ipc = startIpcServer(sockPath, {
    onEvent: makeIpcEventListener(opts),
  });

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

  const abortCleanup = wireAbort(opts.signal, child, ipc);

  try {
    await withAbort(opts.signal, async () => {
      await waitForReady(child);
      await sendPrompt(child, opts.prompt);
    });

    const timeout = opts.timeoutMs ?? 10 * 60_000;
    const event = await withAbort(opts.signal, () =>
      raceWithTimeout(ipc.done, timeout).catch((err) => {
        throw enrichTimeoutError(err, opts);
      })
    );

    if (event.hook_event_name === "StopFailure") {
      if (event.error === "authentication_failed") {
        throw new AuthRetryNeeded(event.error_details ?? event.error);
      }
      throw new StopFailure(event);
    }

    const usage = await parseTranscriptUsage(event.transcript_path);

    return {
      text: event.last_assistant_message ?? "",
      sessionId: event.session_id,
      transcriptPath: event.transcript_path,
      subagents: ipc.subagents,
      usage,
    };
  } finally {
    abortCleanup();
    await shutdown(child, exitPromise, exitInfo, ipc, runDir);
  }
}

function makeIpcEventListener(opts: RunInteractiveOptions): ((ev: HookEvent) => void) | undefined {
  const onToolUse = opts.onToolUse;
  if (!onToolUse) {
    return;
  }
  const includeSub = opts.includeSubagentTools === true;

  return (ev) => {
    if (ev.hook_event_name !== "PreToolUse") {
      return;
    }
    if (!includeSub && ev.agent_id) {
      return;
    }
    try {
      onToolUse(toToolUseEvent(ev));
    } catch {
      // Caller-provided callback errors must never break the run.
    }
  };
}

function toToolUseEvent(ev: PreToolUseEvent): ToolUseEvent {
  const out: ToolUseEvent = { name: ev.tool_name };
  if (ev.tool_input !== undefined) {
    out.input = ev.tool_input;
  }
  if (ev.agent_id) {
    out.agentId = ev.agent_id;
  }
  if (ev.agent_type) {
    out.agentType = ev.agent_type;
  }
  if (ev.tool_use_id) {
    out.toolUseId = ev.tool_use_id;
  }

  return out;
}

function waitForReady(child: pty.IPty): Promise<void> {
  return new Promise((resolve) => {
    let lastChunkAt = Date.now();
    let resolved = false;

    const finish = (): void => {
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
      try {
        child.write("/exit\r");
      } catch {}
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

/**
 * Adds a diagnostic hint when a timeout matches the known `--model + --resume`
 * without `--append-system-prompt` quirk. See notes in INVESTIGATION-NOTES.md.
 */
function enrichTimeoutError(err: unknown, opts: RunInteractiveOptions): unknown {
  if (!(err instanceof Error) || !err.message.startsWith("Timed out after ")) {
    return err;
  }
  const args = opts.args ?? [];
  const hasResume = args.includes("--resume");
  const hasModel = args.includes("--model");
  const hasSystemPrompt = args.includes("--append-system-prompt") || args.includes("--system-prompt");
  if (hasResume && hasModel && !hasSystemPrompt) {
    err.message += " — hint: --model + --resume without --append-system-prompt is a known TUI quirk (see INVESTIGATION-NOTES.md). Try adding a non-empty --append-system-prompt to args.";
  }

  return err;
}

function wireAbort(
  signal: AbortSignal | undefined,
  child: pty.IPty,
  ipc: { close: () => void }
): () => void {
  if (!signal) {
    return () => {};
  }
  const onAbort = (): void => {
    try {
      child.kill();
    } catch {}
    try {
      ipc.close();
    } catch {}
  };
  if (signal.aborted) {
    onAbort();

    return () => {};
  }
  signal.addEventListener("abort", onAbort, { once: true });

  return () => signal.removeEventListener("abort", onAbort);
}
