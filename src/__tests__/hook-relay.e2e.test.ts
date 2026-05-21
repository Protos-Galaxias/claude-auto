import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installHooks, type HookPaths } from "../hook-installer.js";
import { startIpcServer } from "../ipc-server.js";

function mkPaths(): { dir: string; paths: HookPaths } {
  const dir = mkdtempSync(join(tmpdir(), "ca-e2e-"));
  const paths: HookPaths = {
    autoConfigDir: join(dir, ".claude-auto"),
    claudeConfigDir: join(dir, ".claude"),
    hookRelayScript: join(dir, ".claude-auto", "hook-relay.sh"),
    claudeSettingsFile: join(dir, ".claude", "settings.json"),
  };

  return { dir, paths };
}

function runRelay(scriptPath: string, socketPath: string, stdin: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(scriptPath, [], {
      env: { ...process.env, CLAUDE_AUTO_RUN_SOCKET: socketPath },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (c) => (stderr += c.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        return reject(new Error(`relay exited ${code}: ${stderr}`));
      }
      resolve(code ?? 0);
    });
    child.stdin.write(stdin);
    child.stdin.end();
  });
}

test("hook relay script is a no-op when CLAUDE_AUTO_RUN_SOCKET is unset", async () => {
  const { dir, paths } = mkPaths();
  try {
    await installHooks(paths);

    const code = await new Promise<number>((resolve, reject) => {
      const child = spawn(paths.hookRelayScript, [], {
        env: { ...process.env, CLAUDE_AUTO_RUN_SOCKET: "" },
        stdio: ["pipe", "pipe", "pipe"],
      });
      child.on("error", reject);
      child.on("close", (c) => resolve(c ?? 1));
      child.stdin.write(`{"hook_event_name":"Stop"}`);
      child.stdin.end();
    });

    assert.equal(code, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hook relay script forwards stdin JSON to unix socket via python3", async () => {
  const { dir, paths } = mkPaths();
  try {
    await installHooks(paths);

    const sockPath = join(dir, "test.sock");
    const ipc = startIpcServer(sockPath);

    const payload = JSON.stringify({
      hook_event_name: "Stop",
      session_id: "abc",
      transcript_path: "/tmp/x.jsonl",
      last_assistant_message: "round-trip ok",
    });

    await runRelay(paths.hookRelayScript, sockPath, payload);

    const ev = await ipc.done;
    ipc.close();

    assert.equal(ev.hook_event_name, "Stop");
    assert.equal((ev as any).last_assistant_message, "round-trip ok");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hook relay handles multi-event sequence end-to-end (subagent then main stop)", async () => {
  const { dir, paths } = mkPaths();
  try {
    await installHooks(paths);

    const sockPath = join(dir, "test.sock");
    const ipc = startIpcServer(sockPath);

    await runRelay(
      paths.hookRelayScript,
      sockPath,
      JSON.stringify({
        hook_event_name: "SubagentStop",
        session_id: "s1",
        agent_id: "a1",
        agent_type: "Explore",
        last_assistant_message: "subagent done",
      })
    );

    await runRelay(
      paths.hookRelayScript,
      sockPath,
      JSON.stringify({
        hook_event_name: "Stop",
        session_id: "s1",
        transcript_path: "/tmp/x.jsonl",
        last_assistant_message: "main summary",
      })
    );

    const ev = await ipc.done;
    ipc.close();

    assert.equal((ev as any).last_assistant_message, "main summary");
    assert.equal(ipc.subagents.length, 1);
    assert.equal(ipc.subagents[0].agent_id, "a1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hook relay survives unicode + newlines in last_assistant_message", async () => {
  const { dir, paths } = mkPaths();
  try {
    await installHooks(paths);

    const sockPath = join(dir, "test.sock");
    const ipc = startIpcServer(sockPath);

    const tricky = "Привет 🚀\nlinebreak\t\"quoted\"";
    const payload = JSON.stringify({
      hook_event_name: "Stop",
      session_id: "u",
      transcript_path: "/tmp/x.jsonl",
      last_assistant_message: tricky,
    });

    await runRelay(paths.hookRelayScript, sockPath, payload);

    const ev = await ipc.done;
    ipc.close();

    assert.equal((ev as any).last_assistant_message, tricky);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
