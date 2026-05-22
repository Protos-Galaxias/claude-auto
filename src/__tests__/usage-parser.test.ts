import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aggregateUsage, parseTranscriptUsage } from "../usage-parser.js";

function assistantLine(opts: {
  id: string;
  input: number;
  output: number;
  cacheRead?: number;
  cacheCreation?: number;
  sidechain?: boolean;
}): string {
  return JSON.stringify({
    type: "assistant",
    isSidechain: opts.sidechain ?? false,
    message: {
      id: opts.id,
      usage: {
        input_tokens: opts.input,
        output_tokens: opts.output,
        cache_read_input_tokens: opts.cacheRead ?? 0,
        cache_creation_input_tokens: opts.cacheCreation ?? 0,
      },
    },
  });
}

test("aggregateUsage returns undefined for empty input", () => {
  assert.equal(aggregateUsage(""), undefined);
  assert.equal(aggregateUsage("   \n  \n"), undefined);
});

test("aggregateUsage skips non-assistant lines", () => {
  const jsonl = [
    JSON.stringify({ type: "user", message: { content: "hi" } }),
    JSON.stringify({ type: "permission-mode", permissionMode: "default" }),
    JSON.stringify({ type: "system", subtype: "turn_duration", durationMs: 1234 }),
  ].join("\n");

  assert.equal(aggregateUsage(jsonl), undefined);
});

test("aggregateUsage sums multiple assistant turns", () => {
  const jsonl = [
    assistantLine({ id: "m1", input: 10, output: 5, cacheRead: 100, cacheCreation: 20 }),
    assistantLine({ id: "m2", input: 3, output: 9, cacheRead: 200, cacheCreation: 0 }),
  ].join("\n");

  const u = aggregateUsage(jsonl);
  assert.ok(u);
  assert.equal(u.inputTokens, 13);
  assert.equal(u.outputTokens, 14);
  assert.equal(u.cacheReadTokens, 300);
  assert.equal(u.cacheCreationTokens, 20);
  // cacheRead / (input + cacheRead + cacheCreation) = 300 / 333
  assert.ok(Math.abs(u.cacheHitRatio - 300 / 333) < 1e-9);
});

test("aggregateUsage dedups by message.id (parallel tool calls share an id)", () => {
  const jsonl = [
    assistantLine({ id: "msg_parallel", input: 5, output: 100, cacheRead: 1000 }),
    assistantLine({ id: "msg_parallel", input: 5, output: 100, cacheRead: 1000 }),
    assistantLine({ id: "msg_parallel", input: 5, output: 100, cacheRead: 1000 }),
    assistantLine({ id: "msg_final", input: 1, output: 9, cacheRead: 18000 }),
  ].join("\n");

  const u = aggregateUsage(jsonl);
  assert.ok(u);
  // Only msg_parallel (once) + msg_final.
  assert.equal(u.inputTokens, 5 + 1);
  assert.equal(u.outputTokens, 100 + 9);
  assert.equal(u.cacheReadTokens, 1000 + 18000);
});

test("aggregateUsage ignores sidechain (subagent) assistant entries", () => {
  const jsonl = [
    assistantLine({ id: "main", input: 5, output: 9, cacheRead: 100 }),
    assistantLine({ id: "sub1", input: 999, output: 999, cacheRead: 999, sidechain: true }),
    assistantLine({ id: "sub2", input: 999, output: 999, cacheRead: 999, sidechain: true }),
  ].join("\n");

  const u = aggregateUsage(jsonl);
  assert.ok(u);
  assert.equal(u.inputTokens, 5);
  assert.equal(u.outputTokens, 9);
  assert.equal(u.cacheReadTokens, 100);
});

test("aggregateUsage tolerates malformed JSON lines and missing usage", () => {
  const jsonl = [
    "{not json",
    JSON.stringify({ type: "assistant", isSidechain: false, message: { id: "m1" } }), // no usage
    assistantLine({ id: "m2", input: 7, output: 3 }),
    "",
  ].join("\n");

  const u = aggregateUsage(jsonl);
  assert.ok(u);
  assert.equal(u.inputTokens, 7);
  assert.equal(u.outputTokens, 3);
  assert.equal(u.cacheHitRatio, 0);
});

test("aggregateUsage counts assistant entries without message.id (no dedup possible)", () => {
  // Defensively: if id is absent, every line is counted.
  const jsonl = [
    JSON.stringify({
      type: "assistant",
      isSidechain: false,
      message: { usage: { input_tokens: 2, output_tokens: 1 } },
    }),
    JSON.stringify({
      type: "assistant",
      isSidechain: false,
      message: { usage: { input_tokens: 3, output_tokens: 4 } },
    }),
  ].join("\n");

  const u = aggregateUsage(jsonl);
  assert.ok(u);
  assert.equal(u.inputTokens, 5);
  assert.equal(u.outputTokens, 5);
});

test("aggregateUsage cacheHitRatio is 0 when there's no input-side traffic", () => {
  const jsonl = JSON.stringify({
    type: "assistant",
    isSidechain: false,
    message: {
      id: "m1",
      usage: { input_tokens: 0, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  });

  const u = aggregateUsage(jsonl);
  assert.ok(u);
  assert.equal(u.cacheHitRatio, 0);
});

test("parseTranscriptUsage returns undefined when file doesn't exist", async () => {
  const u = await parseTranscriptUsage("/no/such/file.jsonl");
  assert.equal(u, undefined);
});

test("parseTranscriptUsage waits for a deferred write of the assistant entry", async () => {
  // Stop hook can fire before claude has flushed the final assistant entry to
  // disk on fresh-project sessions. Parser should retry briefly.
  const dir = mkdtempSync(join(tmpdir(), "ca-usage-retry-"));
  const path = join(dir, "transcript.jsonl");
  try {
    writeFileSync(
      path,
      [
        JSON.stringify({ type: "user", message: { content: "hi" } }),
        JSON.stringify({ type: "permission-mode", permissionMode: "default" }),
      ].join("\n") + "\n"
    );

    setTimeout(() => {
      writeFileSync(
        path,
        [
          JSON.stringify({ type: "user", message: { content: "hi" } }),
          JSON.stringify({ type: "permission-mode", permissionMode: "default" }),
          assistantLine({ id: "m_late", input: 7, output: 4, cacheRead: 100 }),
        ].join("\n") + "\n"
      );
    }, 75);

    const u = await parseTranscriptUsage(path);
    assert.ok(u, "parser should eventually pick up the late assistant entry");
    assert.equal(u.inputTokens, 7);
    assert.equal(u.outputTokens, 4);
    assert.equal(u.cacheReadTokens, 100);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parseTranscriptUsage reads a real on-disk file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ca-usage-"));
  const path = join(dir, "transcript.jsonl");
  try {
    writeFileSync(
      path,
      [
        assistantLine({ id: "m1", input: 4, output: 11, cacheRead: 50, cacheCreation: 5 }),
        assistantLine({ id: "m2", input: 1, output: 22, cacheRead: 60 }),
      ].join("\n")
    );

    const u = await parseTranscriptUsage(path);
    assert.ok(u);
    assert.equal(u.inputTokens, 5);
    assert.equal(u.outputTokens, 33);
    assert.equal(u.cacheReadTokens, 110);
    assert.equal(u.cacheCreationTokens, 5);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
