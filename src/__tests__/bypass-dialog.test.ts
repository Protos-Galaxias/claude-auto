import { test } from "node:test";
import assert from "node:assert/strict";
import {
  detectStartupDialog,
  looksLikeBypassDialog,
  stripAnsi,
  wantsBypassPermissions,
} from "../bypass-dialog.js";

test("wantsBypassPermissions detects the flag", () => {
  assert.equal(wantsBypassPermissions(undefined), false);
  assert.equal(wantsBypassPermissions([]), false);
  assert.equal(wantsBypassPermissions(["--model", "sonnet"]), false);
  assert.equal(wantsBypassPermissions(["--dangerously-skip-permissions"]), true);
  assert.equal(
    wantsBypassPermissions(["--model", "haiku", "--dangerously-skip-permissions", "--resume", "x"]),
    true
  );
});

test("stripAnsi removes cursor positioning sequences", () => {
  const input = "\x1b[3GIn\x1b[6GBypass\x1b[13GPermissions\x1b[25Gmode";
  assert.equal(stripAnsi(input), "InBypassPermissionsmode");
});

test("stripAnsi removes OSC sequences (window titles etc.)", () => {
  const input = "before\x1b]0;some title\x07after";
  assert.equal(stripAnsi(input), "beforeafter");
});

test("stripAnsi removes SGR colours and modes", () => {
  const input = "\x1b[31mred\x1b[0m \x1b[1;33mbold-yellow\x1b[0m";
  assert.equal(stripAnsi(input), "red bold-yellow");
});

test("looksLikeBypassDialog matches a real captured TTY frame", () => {
  // Lifted directly from /tmp/claude-auto-smoke-tty.log produced by the smoke
  // run that initially hung on the dialog.
  const realFrame = [
    "\x1b[3GWARNING:\x1b[12GClaude\x1b[19GCode\x1b[24Grunning\x1b[32Gin\x1b[35GBypass\x1b[42GPermissions\x1b[54Gmode\r\r",
    "\r\r",
    "\x1b[3GIn\x1b[6GBypass\x1b[13GPermissions\x1b[25Gmode,\x1b[31GClaude\x1b[38GCode\x1b[43Gwill\x1b[48Gnot\x1b[52Gask\x1b[56Gfor\x1b[60Gyour\x1b[65Gapproval\x1b[74Gbefore\x1b[81Grunning\x1b[89Gpotentially\x1b[101Gdangerous\x1b[111Gcommands.\r\r",
    "\x1b[3G\x1b[5G1.\x1b[8GNo,\x1b[12Gexit\r\r",
    "\x1b[5G2.\x1b[8GYes,\x1b[13GI\x1b[15Gaccept\r\r",
    "\x1b[3GEnter\x1b[9Gto\x1b[12Gconfirm\x1b[20G\xc2\xb7\x1b[22GEsc\x1b[26Gto\x1b[29Gcancel\r\r",
  ].join("");

  assert.equal(looksLikeBypassDialog(realFrame), true);
});

test("looksLikeBypassDialog rejects an ordinary input prompt", () => {
  const ordinary = "\x1b[2J\x1b[H\x1b[3G>\x1b[5GType\x1b[10Gyour\x1b[15Gmessage";
  assert.equal(looksLikeBypassDialog(ordinary), false);
});

test("looksLikeBypassDialog rejects only the title (no accept choice)", () => {
  const partial = "Welcome to Bypass Permissions mode\nLoading…";
  assert.equal(looksLikeBypassDialog(partial), false);
});

test("looksLikeBypassDialog rejects only the accept choice (no title)", () => {
  // Some random other dialog might offer "Yes, I accept" — we shouldn't
  // auto-press 2 unless the bypass title is also present.
  const partial = "Some other dialog\n1. No, exit\n2. Yes, I accept";
  assert.equal(looksLikeBypassDialog(partial), false);
});

test("looksLikeBypassDialog handles empty input", () => {
  assert.equal(looksLikeBypassDialog(""), false);
});

test("detectStartupDialog returns null on empty / unrelated text", () => {
  assert.equal(detectStartupDialog(""), null);
  assert.equal(detectStartupDialog("just some normal log output"), null);
});

test("detectStartupDialog identifies the bypass dialog with response '2\\r'", () => {
  const bypass = [
    "\x1b[3GWARNING:\x1b[12GClaude\x1b[19GCode\x1b[24Grunning\x1b[32Gin\x1b[35GBypass\x1b[42GPermissions\x1b[54Gmode",
    "\x1b[5G1.\x1b[8GNo,\x1b[12Gexit",
    "\x1b[5G2.\x1b[8GYes,\x1b[13GI\x1b[15Gaccept",
  ].join("\r\r");

  const d = detectStartupDialog(bypass);
  assert.deepEqual(d, { kind: "bypass", response: "2\r" });
});

test("detectStartupDialog identifies the trust-folder dialog with response '1\\r'", () => {
  // Lifted from /tmp/claude-auto-smoke-bypass.log captured on a fresh project.
  const trust = [
    "\x1b[2GQuick\x1b[8Gsafety\x1b[15Gcheck:\x1b[22GIs\x1b[25Gthis\x1b[30Ga\x1b[32Gproject\x1b[40Gyou\x1b[44Gcreated\x1b[52Gor\x1b[55Gone\x1b[59Gyou\x1b[63Gtrust?",
    "\x1b[4G1.\x1b[7GYes,\x1b[12GI\x1b[14Gtrust\x1b[20Gthis\x1b[25Gfolder",
    "\x1b[4G2.\x1b[7GNo,\x1b[11Gexit",
  ].join("\r\r");

  const d = detectStartupDialog(trust);
  assert.deepEqual(d, { kind: "trust", response: "1\r" });
});

test("detectStartupDialog prefers trust over bypass when both substrings happen to be present", () => {
  // Defensive: if a future TUI rendered both in one frame, we should accept
  // trust first (it always comes first in the actual flow anyway).
  const mixed = "trust this folder yes, I trust ... bypass permissions yes, I accept";

  const d = detectStartupDialog(mixed);
  assert.equal(d?.kind, "trust");
});

test("detectStartupDialog returns null for an ordinary TUI input prompt", () => {
  const idle = "\x1b[2J\x1b[H\x1b[3G> Type your message\x1b[5G/help to see commands";
  assert.equal(detectStartupDialog(idle), null);
});
