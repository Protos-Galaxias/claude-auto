# Investigation notes

## Quirk: `--model <X> --resume <id>` hangs without `--append-system-prompt`

**Reported on:** claude-auto `d599b0c`, claude CLI `2.1.146`.

### Repro matrix (from caller, 2026-05-22)

| Combo | `--model` | `--append-system-prompt` | `--resume` | Result |
|-------|-----------|--------------------------|------------|--------|
| A     | haiku     | —                        | yes        | HANG (60s timeout) |
| B     | —         | yes                      | yes        | OK (5.7s) |
| C     | haiku     | yes                      | yes        | OK (7.1s) |
| D     | —         | yes (only seed)          | yes        | OK (5.9s) |

Only combo **A** hangs. Workaround: always pass `--append-system-prompt "<anything non-empty>"` when resuming with an explicit model. In production this is already the case (identity prompt is always prepended), but the invisible failure mode for callers that hit combo A makes this worth fixing upstream of the workaround.

### Current diagnostic shim

`interactive-runner.ts` enriches `Timed out after Nms` errors with a hint when the args match combo A:

> `Timed out after 60000ms — hint: --model + --resume without --append-system-prompt is a known TUI quirk … Try adding a non-empty --append-system-prompt to args.`

This is **not a fix** — just a signpost so the next person who hits it doesn't waste a debug session.

### Hypotheses (untested)

1. **`waitForReady` quiet-period false positive.**
   Current logic: resolve after 800ms with no PTY output. In combo A the TUI emits an initial burst, goes quiet for >800ms while still rendering the resume banner / model picker, then redraws once input is actually accepted. Our `sendPrompt` fires into the wrong render pass and the characters land in a non-input view. Enter does nothing. We block on `ipc.done` until timeout.

2. **TUI special-cases system-prompt presence in resume mode.**
   With `--append-system-prompt`, the TUI may render an additional line which extends the "noisy" period past our 800ms threshold; without it, the gap appears earlier. Same root cause as #1, expressed differently.

3. **Ink input box not mounted yet on combo A.**
   Resume restores N messages of history; rendering N messages may delay the input box mount. With system prompt, the resume restore renders a header line that nudges the input mount slightly later — past the gap.

All three would be fixed the same way: make `waitForReady` resilient to mid-render quiet periods (e.g. wait for an "input prompt" marker rather than relying purely on quiet time).

### Repro plan (when we have time + caller's MCP config)

Need from caller to repro deterministically:

- The exact `.mcp-config.json` (or equivalent test config).
- A working seed session id (or repro steps with `--dangerously-skip-permissions` and free models).
- `--debug-tty` output of combo A vs combo C, captured to disk.

With those, the path is:

1. Run combo A with `--debug-tty` piped to a file. Confirm the hang.
2. Diff the captured TTY stream of A vs C around the moment our `sendPrompt` fires. Look for: input box marker (`│ > `), cursor positioning, any "restoring session…" line that takes longer than 800ms.
3. If hypothesis #1 holds: replace the 800ms quiet timer with a regex match against the input box marker. Fall back to the timer with `READY_MAX_WAIT_MS` as the hard cap.
4. If #3 holds: same fix as #1 — wait for the input marker, not the quiet period.

### Why we did not ship a blind fix

The obvious "increase `READY_QUIET_MS` when `--resume` is in args" defends against #1/#2 but:
- Adds latency to every resume run, not just combo A.
- Masks rather than addresses the root cause; the next TUI version may regress it differently.
- We cannot verify the fix without a real repro, and shipping defenses we can't validate is worse than shipping a diagnostic.

Diagnostic hint goes out now (low risk, high signal). Real fix waits for caller's data.
