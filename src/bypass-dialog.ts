/**
 * Helpers for detecting and accepting the first-run dialogs that claude TUI
 * may show before it's ready to accept a prompt:
 *
 *   1. Trust-folder dialog (always, first time `claude` runs in a `cwd`):
 *        "Quick safety check: Is this a project you trust?
 *         1. Yes, I trust this folder
 *         2. No, exit"
 *      → respond "1\r"
 *
 *   2. Bypass-permissions dialog (first time `--dangerously-skip-permissions`
 *      is used in a project):
 *        "WARNING: Claude Code running in Bypass Permissions mode …
 *         1. No, exit
 *         2. Yes, I accept"
 *      → respond "2\r"
 *
 * If left unanswered the TUI never mounts the chat input, the prompt we type
 * goes into the dialog picker (gets dropped or selects the wrong option),
 * and the run hangs to timeout.
 *
 * Extracted into its own module so detection is unit-testable without a PTY.
 */

export type StartupDialog =
  | { kind: "trust"; response: "1\r" }
  | { kind: "bypass"; response: "2\r" };

const TRUST_DIALOG_PATTERNS = [
  /trust\s*this\s*folder/i,
  /yes\s*,?\s*i\s*trust/i,
];

const BYPASS_DIALOG_PATTERNS = [
  /bypass\s*permissions/i,
  /yes\s*,?\s*i\s*accept/i,
];

/**
 * Strips the cursor-positioning / SGR / OSC escape sequences that pollute
 * claude's TUI output, leaving plain text that's safe to substring-match.
 */
export function stripAnsi(s: string): string {
  return s
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
    .replace(/\x1b\][^\x07]*\x07/g, "")
    .replace(/\x1b[=>78]/g, "");
}

/**
 * Detects which (if any) startup dialog is currently shown on the TUI based
 * on the recent raw TTY buffer. Returns `null` if no known dialog is visible.
 * Conservative: both signature substrings must be present.
 */
export function detectStartupDialog(recentTty: string): StartupDialog | null {
  const cleaned = stripAnsi(recentTty);

  if (TRUST_DIALOG_PATTERNS.every((re) => re.test(cleaned))) {
    return { kind: "trust", response: "1\r" };
  }
  if (BYPASS_DIALOG_PATTERNS.every((re) => re.test(cleaned))) {
    return { kind: "bypass", response: "2\r" };
  }

  return null;
}

/**
 * True iff the caller asked for `--dangerously-skip-permissions`.
 * Used as a gate before scanning for the bypass dialog specifically — the
 * trust dialog can fire regardless of args.
 */
export function wantsBypassPermissions(args: readonly string[] | undefined): boolean {
  if (!args) {
    return false;
  }

  return args.includes("--dangerously-skip-permissions");
}

/**
 * Back-compat alias for the bypass-only detector. Prefer
 * {@link detectStartupDialog} for new code.
 */
export function looksLikeBypassDialog(recentTty: string): boolean {
  const d = detectStartupDialog(recentTty);

  return d?.kind === "bypass";
}
