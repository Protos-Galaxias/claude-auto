import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  installHooks,
  uninstallHooks,
  mergeHooks,
  removeHooks,
  createHookSettings,
  type HookPaths,
  type SettingsFile,
} from "../hook-installer.js";

function mkPaths(): { dir: string; paths: HookPaths } {
  const dir = mkdtempSync(join(tmpdir(), "ca-hooks-"));
  const paths: HookPaths = {
    autoConfigDir: join(dir, ".claude-auto"),
    claudeConfigDir: join(dir, ".claude"),
    hookRelayScript: join(dir, ".claude-auto", "hook-relay.sh"),
    claudeSettingsFile: join(dir, ".claude", "settings.json"),
  };

  return { dir, paths };
}

test("mergeHooks adds all three events to an empty settings object", () => {
  const out = mergeHooks({}, "/abs/relay.sh");
  assert.deepEqual(Object.keys(out.hooks!).sort(), ["Stop", "StopFailure", "SubagentStop"]);
  for (const ev of ["Stop", "StopFailure", "SubagentStop"]) {
    assert.equal(out.hooks![ev].length, 1);
    assert.equal(out.hooks![ev][0].hooks[0].type, "command");
    assert.match(out.hooks![ev][0].hooks[0].command, /\/abs\/relay\.sh # claude-auto:hook-relay/);
  }
});

test("mergeHooks preserves unrelated keys and unrelated hook events", () => {
  const settings: SettingsFile = {
    customKey: { foo: "bar" },
    hooks: {
      PreToolUse: [
        { matcher: "Bash", hooks: [{ type: "command", command: "/my/lint.sh" }] },
      ],
    },
  };

  const out = mergeHooks(settings, "/abs/relay.sh");

  assert.deepEqual(out.customKey, { foo: "bar" });
  assert.equal(out.hooks!.PreToolUse.length, 1);
  assert.equal(out.hooks!.PreToolUse[0].hooks[0].command, "/my/lint.sh");
  assert.equal(out.hooks!.Stop.length, 1);
});

test("mergeHooks preserves foreign Stop hooks alongside our relay", () => {
  const settings: SettingsFile = {
    hooks: {
      Stop: [
        { hooks: [{ type: "command", command: "/their/notifier.sh" }] },
      ],
    },
  };

  const out = mergeHooks(settings, "/abs/relay.sh");

  assert.equal(out.hooks!.Stop.length, 2);
  assert.equal(out.hooks!.Stop[0].hooks[0].command, "/their/notifier.sh");
  assert.match(out.hooks!.Stop[1].hooks[0].command, /relay\.sh/);
});

test("mergeHooks is idempotent (re-run does not duplicate)", () => {
  let s = mergeHooks({}, "/abs/relay.sh");
  s = mergeHooks(s, "/abs/relay.sh");
  s = mergeHooks(s, "/abs/relay.sh");
  for (const ev of ["Stop", "StopFailure", "SubagentStop"]) {
    assert.equal(s.hooks![ev].length, 1, `event ${ev} should have exactly 1 group`);
  }
});

test("mergeHooks replaces our own relay if path changes (no stale entries)", () => {
  let s = mergeHooks({}, "/old/relay.sh");
  s = mergeHooks(s, "/new/relay.sh");
  for (const ev of ["Stop", "StopFailure", "SubagentStop"]) {
    assert.equal(s.hooks![ev].length, 1);
    assert.match(s.hooks![ev][0].hooks[0].command, /\/new\/relay\.sh/);
  }
});

test("removeHooks strips only our entries", () => {
  const merged = mergeHooks(
    {
      hooks: {
        Stop: [
          { hooks: [{ type: "command", command: "/their/notifier.sh" }] },
        ],
      },
    },
    "/abs/relay.sh"
  );

  const cleaned = removeHooks(merged);

  assert.equal(cleaned.hooks!.Stop.length, 1);
  assert.equal(cleaned.hooks!.Stop[0].hooks[0].command, "/their/notifier.sh");
  assert.equal(cleaned.hooks!.SubagentStop, undefined);
  assert.equal(cleaned.hooks!.StopFailure, undefined);
});

test("installHooks writes script and settings to disk with correct content/perms", async () => {
  const { dir, paths } = mkPaths();
  try {
    await installHooks(paths);

    assert.equal(existsSync(paths.hookRelayScript), true);
    assert.equal(existsSync(paths.claudeSettingsFile), true);

    const mode = statSync(paths.hookRelayScript).mode & 0o777;
    assert.equal(mode, 0o755);

    const script = readFileSync(paths.hookRelayScript, "utf8");
    assert.match(script, /#!\/bin\/bash/);
    assert.match(script, /CLAUDE_AUTO_RUN_SOCKET/);
    assert.match(script, /python3/);

    const settings = JSON.parse(readFileSync(paths.claudeSettingsFile, "utf8"));
    assert.equal(settings.hooks.Stop.length, 1);
    assert.match(settings.hooks.Stop[0].hooks[0].command, /hook-relay\.sh # claude-auto:hook-relay/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("installHooks merges into a pre-existing settings.json without clobbering", async () => {
  const { dir, paths } = mkPaths();
  try {
    const { mkdirSync } = await import("node:fs");
    mkdirSync(paths.claudeConfigDir, { recursive: true });
    writeFileSync(
      paths.claudeSettingsFile,
      JSON.stringify({
        theme: "dark",
        hooks: {
          PreToolUse: [
            { matcher: "Bash", hooks: [{ type: "command", command: "/x/y.sh" }] },
          ],
          Stop: [
            { hooks: [{ type: "command", command: "/their/notify.sh" }] },
          ],
        },
      })
    );

    await installHooks(paths);

    const settings = JSON.parse(readFileSync(paths.claudeSettingsFile, "utf8"));
    assert.equal(settings.theme, "dark");
    assert.equal(settings.hooks.PreToolUse[0].hooks[0].command, "/x/y.sh");
    assert.equal(settings.hooks.Stop.length, 2);
    assert.equal(settings.hooks.Stop[0].hooks[0].command, "/their/notify.sh");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("uninstallHooks is safe to call when settings does not exist", async () => {
  const { dir, paths } = mkPaths();
  try {
    await uninstallHooks(paths);
    assert.equal(existsSync(paths.claudeSettingsFile), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("createHookSettings omits PreToolUse by default", () => {
  const s = createHookSettings("/relay.sh");
  assert.deepEqual(
    Object.keys(s.hooks!).sort(),
    ["Stop", "StopFailure", "SubagentStop"]
  );
});

test("createHookSettings includes PreToolUse when includeToolUse is true", () => {
  const s = createHookSettings("/relay.sh", { includeToolUse: true });
  assert.deepEqual(
    Object.keys(s.hooks!).sort(),
    ["PreToolUse", "Stop", "StopFailure", "SubagentStop"]
  );
  assert.equal(s.hooks!.PreToolUse.length, 1);
  assert.match(s.hooks!.PreToolUse[0].hooks[0].command, /\/relay\.sh/);
});

test("install then uninstall returns settings to original state", async () => {
  const { dir, paths } = mkPaths();
  try {
    const { mkdirSync } = await import("node:fs");
    mkdirSync(paths.claudeConfigDir, { recursive: true });
    const original = {
      theme: "dark",
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "/x.sh" }] }],
      },
    };
    writeFileSync(paths.claudeSettingsFile, JSON.stringify(original));

    await installHooks(paths);
    await uninstallHooks(paths);

    const after = JSON.parse(readFileSync(paths.claudeSettingsFile, "utf8"));
    assert.equal(after.theme, "dark");
    assert.equal(after.hooks.PreToolUse[0].hooks[0].command, "/x.sh");
    assert.equal(after.hooks.Stop, undefined);
    assert.equal(after.hooks.SubagentStop, undefined);
    assert.equal(after.hooks.StopFailure, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
