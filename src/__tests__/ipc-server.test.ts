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
