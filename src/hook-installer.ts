import { readFile, writeFile, mkdir, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import { PATHS, HOOK_RELAY_ENV, HOOK_RELAY_MARKER } from "./constants.js";

const RELAY_SCRIPT = `#!/bin/bash
# ${HOOK_RELAY_MARKER}
# No-op unless ${HOOK_RELAY_ENV} is set (only claude-auto sets it).
[ -z "\${${HOOK_RELAY_ENV}}" ] && exit 0
exec python3 -c '
import sys, socket, os
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.connect(os.environ["${HOOK_RELAY_ENV}"])
s.sendall(sys.stdin.buffer.read())
s.shutdown(socket.SHUT_WR)
s.close()
'
`;

const RELAY_EVENTS = ["Stop", "SubagentStop", "StopFailure"] as const;

interface HookHandler {
  type: string;
  command: string;
}

interface HookGroup {
  matcher?: string;
  hooks: HookHandler[];
}

export interface SettingsFile {
  hooks?: Record<string, HookGroup[]>;
  [key: string]: unknown;
}

export interface HookPaths {
  autoConfigDir: string;
  claudeConfigDir: string;
  hookRelayScript: string;
  claudeSettingsFile: string;
}

const DEFAULT_PATHS: HookPaths = {
  autoConfigDir: PATHS.autoConfigDir,
  claudeConfigDir: PATHS.claudeConfigDir,
  hookRelayScript: PATHS.hookRelayScript,
  claudeSettingsFile: PATHS.claudeSettingsFile,
};

export async function installHooks(paths: HookPaths = DEFAULT_PATHS): Promise<void> {
  await ensureDir(paths.autoConfigDir);
  await ensureDir(paths.claudeConfigDir);

  await writeFile(paths.hookRelayScript, RELAY_SCRIPT, { encoding: "utf8" });
  await chmod(paths.hookRelayScript, 0o755);

  const settings = await readSettings(paths.claudeSettingsFile);
  const next = mergeHooks(settings, paths.hookRelayScript);

  await writeFile(
    paths.claudeSettingsFile,
    JSON.stringify(next, null, 2) + "\n",
    { encoding: "utf8" }
  );
}

export async function uninstallHooks(paths: HookPaths = DEFAULT_PATHS): Promise<void> {
  if (!existsSync(paths.claudeSettingsFile)) {
    return;
  }

  const settings = await readSettings(paths.claudeSettingsFile);
  const next = removeHooks(settings);

  await writeFile(
    paths.claudeSettingsFile,
    JSON.stringify(next, null, 2) + "\n",
    { encoding: "utf8" }
  );
}

async function ensureDir(path: string): Promise<void> {
  if (existsSync(path)) {
    return;
  }
  await mkdir(path, { recursive: true });
}

async function readSettings(settingsPath: string): Promise<SettingsFile> {
  if (!existsSync(settingsPath)) {
    return {};
  }

  try {
    const raw = await readFile(settingsPath, "utf8");

    return JSON.parse(raw) as SettingsFile;
  } catch {
    return {};
  }
}

function isRelayHandler(handler: HookHandler): boolean {
  return handler.type === "command" && handler.command.includes(HOOK_RELAY_MARKER);
}

function isOurGroup(group: HookGroup): boolean {
  return group.hooks.some(isRelayHandler);
}

export function mergeHooks(settings: SettingsFile, relayScriptPath: string): SettingsFile {
  const hooks = { ...(settings.hooks ?? {}) };
  const handler = createRelayHandler(relayScriptPath);

  for (const event of RELAY_EVENTS) {
    const existing = (hooks[event] ?? []).filter((g) => !isOurGroup(g));
    hooks[event] = [...existing, { hooks: [handler] }];
  }

  return { ...settings, hooks };
}

export function createHookSettings(relayScriptPath: string): SettingsFile {
  const handler = createRelayHandler(relayScriptPath);

  return {
    hooks: Object.fromEntries(
      RELAY_EVENTS.map((event) => [event, [{ hooks: [handler] }]])
    ),
  };
}

export function removeHooks(settings: SettingsFile): SettingsFile {
  const hooks = { ...(settings.hooks ?? {}) };

  for (const event of Object.keys(hooks)) {
    hooks[event] = hooks[event].filter((g) => !isOurGroup(g));
    if (hooks[event].length === 0) {
      delete hooks[event];
    }
  }

  return { ...settings, hooks };
}

function createRelayHandler(relayScriptPath: string): HookHandler {
  return {
    type: "command",
    command: `${relayScriptPath} # ${HOOK_RELAY_MARKER}`,
  };
}
