import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection } from "node:net";
import { startIpcServer, type HookEvent } from "../ipc-server.js";

function sockPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "ca-ipc-"));

  return join(dir, "ipc.sock");
}

function send(path: string, payload: HookEvent | string): Promise<void> {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);

  return new Promise((resolve, reject) => {
    const sock = createConnection(path);
    sock.on("connect", () => {
      sock.end(body);
    });
    sock.on("close", () => resolve());
    sock.on("error", reject);
  });
}

test("startIpcServer resolves on main Stop event", async () => {
  const p = sockPath();
  const ipc = startIpcServer(p);

  await send(p, {
    hook_event_name: "Stop",
    session_id: "s1",
    transcript_path: "/tmp/x.jsonl",
    last_assistant_message: "hello world",
  });

  const ev = await ipc.done;
  ipc.close();

  assert.equal(ev.hook_event_name, "Stop");
  assert.equal((ev as any).last_assistant_message, "hello world");
});

test("startIpcServer ignores Stop with agent_id (subagent's main stop)", async () => {
  const p = sockPath();
  const ipc = startIpcServer(p);

  // This shouldn't resolve done.
  await send(p, {
    hook_event_name: "Stop",
    session_id: "s2",
    transcript_path: "/tmp/x.jsonl",
    last_assistant_message: "subagent stop",
    agent_id: "agent-xyz",
  });

  // Then send the real main Stop.
  await send(p, {
    hook_event_name: "Stop",
    session_id: "s2",
    transcript_path: "/tmp/x.jsonl",
    last_assistant_message: "real main",
  });

  const ev = await ipc.done;
  ipc.close();

  assert.equal((ev as any).last_assistant_message, "real main");
});

test("startIpcServer accumulates SubagentStop events without resolving", async () => {
  const p = sockPath();
  const ipc = startIpcServer(p);

  await send(p, {
    hook_event_name: "SubagentStop",
    session_id: "s3",
    agent_id: "a1",
    agent_type: "Explore",
    last_assistant_message: "found 5 files",
  });

  await send(p, {
    hook_event_name: "SubagentStop",
    session_id: "s3",
    agent_id: "a2",
    agent_type: "Explore",
    last_assistant_message: "found 10 files",
  });

  // Should not be resolved yet — race a tiny timeout to confirm.
  const raced = await Promise.race([
    ipc.done.then(() => "resolved"),
    new Promise((r) => setTimeout(() => r("pending"), 100)),
  ]);
  assert.equal(raced, "pending");

  await send(p, {
    hook_event_name: "Stop",
    session_id: "s3",
    transcript_path: "/tmp/x.jsonl",
    last_assistant_message: "main summary",
  });

  const ev = await ipc.done;
  ipc.close();

  assert.equal((ev as any).last_assistant_message, "main summary");
  assert.equal(ipc.subagents.length, 2);
  assert.deepEqual(
    ipc.subagents.map((s) => s.agent_id),
    ["a1", "a2"]
  );
});

test("startIpcServer resolves on StopFailure with error type", async () => {
  const p = sockPath();
  const ipc = startIpcServer(p);

  await send(p, {
    hook_event_name: "StopFailure",
    session_id: "s4",
    error: "rate_limit",
    error_details: "429 Too Many Requests",
  });

  const ev = await ipc.done;
  ipc.close();

  assert.equal(ev.hook_event_name, "StopFailure");
  assert.equal((ev as any).error, "rate_limit");
});

test("startIpcServer cleans up socket on close", async () => {
  const p = sockPath();
  const ipc = startIpcServer(p);
  await new Promise((r) => setTimeout(r, 50));
  ipc.close();
  // Calling close twice should be safe.
  ipc.close();
  const { existsSync } = await import("node:fs");
  assert.equal(existsSync(p), false);
  rmSync(join(p, ".."), { recursive: true, force: true });
});

test("startIpcServer ignores empty payloads", async () => {
  const p = sockPath();
  const ipc = startIpcServer(p);

  await send(p, "");

  const raced = await Promise.race([
    ipc.done.then(() => "resolved"),
    new Promise((r) => setTimeout(() => r("pending"), 100)),
  ]);
  ipc.close();
  assert.equal(raced, "pending");
});

test("startIpcServer forwards every event to onEvent listener", async () => {
  const p = sockPath();
  const seen: HookEvent[] = [];
  const ipc = startIpcServer(p, { onEvent: (ev) => seen.push(ev) });

  await send(p, {
    hook_event_name: "PreToolUse",
    session_id: "s5",
    tool_name: "Bash",
    tool_input: { command: "ls" },
    tool_use_id: "tu1",
  });
  await send(p, {
    hook_event_name: "PreToolUse",
    session_id: "s5",
    tool_name: "Read",
    tool_input: { file_path: "/tmp/x" },
  });
  await send(p, {
    hook_event_name: "Stop",
    session_id: "s5",
    transcript_path: "/tmp/x.jsonl",
    last_assistant_message: "done",
  });

  await ipc.done;
  ipc.close();

  assert.equal(seen.length, 3);
  assert.equal(seen[0].hook_event_name, "PreToolUse");
  assert.equal((seen[0] as any).tool_name, "Bash");
  assert.equal(seen[1].hook_event_name, "PreToolUse");
  assert.equal((seen[1] as any).tool_name, "Read");
  assert.equal(seen[2].hook_event_name, "Stop");
});

test("startIpcServer keeps running when onEvent throws", async () => {
  const p = sockPath();
  let calls = 0;
  const ipc = startIpcServer(p, {
    onEvent: () => {
      calls += 1;
      throw new Error("listener boom");
    },
  });

  await send(p, {
    hook_event_name: "PreToolUse",
    session_id: "s6",
    tool_name: "Bash",
  });
  await send(p, {
    hook_event_name: "Stop",
    session_id: "s6",
    transcript_path: "/tmp/x.jsonl",
    last_assistant_message: "ok",
  });

  const ev = await ipc.done;
  ipc.close();

  assert.equal(calls, 2);
  assert.equal(ev.hook_event_name, "Stop");
});

test("startIpcServer routes PreToolUse to listener but does not resolve done", async () => {
  const p = sockPath();
  const ipc = startIpcServer(p, { onEvent: () => {} });

  await send(p, {
    hook_event_name: "PreToolUse",
    session_id: "s7",
    tool_name: "Edit",
  });

  const raced = await Promise.race([
    ipc.done.then(() => "resolved"),
    new Promise((r) => setTimeout(() => r("pending"), 100)),
  ]);
  ipc.close();
  assert.equal(raced, "pending");
});
