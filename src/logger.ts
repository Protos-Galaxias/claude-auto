import {
  appendFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
} from "node:fs";
import { dirname } from "node:path";
import { PATHS } from "./constants.js";

const PREFIX = "[claude-auto]";
const MAX_LOG_BYTES = 5 * 1024 * 1024;

type LogLevel = "info" | "warn" | "error";

export interface LogOptions {
  /** Also echo the line to stderr. Defaults to true. File is always written regardless. */
  echo?: boolean;
}

function ensureLogDir(): void {
  const dir = dirname(PATHS.logFile);
  if (existsSync(dir)) {
    return;
  }

  mkdirSync(dir, { recursive: true });
}

function rotateIfTooBig(): void {
  if (!existsSync(PATHS.logFile)) {
    return;
  }

  const { size } = statSync(PATHS.logFile);
  if (size < MAX_LOG_BYTES) {
    return;
  }

  renameSync(PATHS.logFile, `${PATHS.logFile}.old`);
}

function appendToFile(line: string): void {
  try {
    ensureLogDir();
    rotateIfTooBig();
    appendFileSync(PATHS.logFile, line, { encoding: "utf8" });
  } catch {
    // Logging must never break the app. A failed write is silently dropped;
    // the stderr echo (if enabled) is the fallback channel.
  }
}

function format(level: LogLevel, message: string): string {
  const ts = new Date().toISOString();

  return `${ts} ${PREFIX} [${level}] ${message}\n`;
}

function emit(level: LogLevel, message: string, options: LogOptions = {}): void {
  const echo = options.echo ?? true;
  const line = format(level, message);

  if (echo) {
    process.stderr.write(line);
  }

  appendToFile(line);
}

export const logger = {
  info: (message: string, options?: LogOptions): void => emit("info", message, options),
  warn: (message: string, options?: LogOptions): void => emit("warn", message, options),
  error: (message: string, options?: LogOptions): void => emit("error", message, options),
} as const;

export function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
