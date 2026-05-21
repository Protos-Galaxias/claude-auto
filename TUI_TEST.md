# Manual test recipe for `claude-auto tui-p`

The goal: verify that driving the interactive TUI via PTY+hooks works as a drop-in for `claude -p`, including the subagent edge case.

> Run these on a machine with a fresh terminal and an authenticated Claude Code session. The TUI flow types your prompt into a real `claude` instance, so output costs go against your subscription, not API credits.

## 0. One-time install

```bash
cd path/to/claude-auto
npm install
npm run build
npm link

# Installs Google session + hook relay + ~/.claude/settings.json patch
claude-auto setup

# Sanity check: relay is in place
test -x ~/.claude-auto/hook-relay.sh && echo OK
jq '.hooks | keys' ~/.claude/settings.json   # expect ["Stop","StopFailure","SubagentStop"]
```

Verify python3 is on PATH (the relay uses it):

```bash
command -v python3
```

## 1. Smoke test (no subagent)

```bash
claude-auto tui-p "Reply with exactly the word PING and nothing else." --timeout 60000 --skip-auth
```

Expected: stdout is `PING\n`, exit 0, run wall-clock 5–15s. If you see ANSI dumped to stderr or it hangs, retry with `--debug-tty` to inspect the TUI:

```bash
claude-auto tui-p "Reply with PING." --skip-auth --debug-tty 2>/tmp/tui.log
less -R /tmp/tui.log
```

Common failure: the prompt was sent before the TUI was ready. Tune `READY_QUIET_MS` / `READY_MAX_WAIT_MS` in `src/interactive-runner.ts` if so.

## 2. Subagent test (the case from the brief)

This prompt forces a `Task` spawn so we exercise `SubagentStop` arriving before `Stop`:

```bash
claude-auto tui-p \
  "Spawn an Explore subagent/task to answer: what is 2+2? Wait for it to finish. Then reply exactly MAIN SAW 4." \
  --skip-auth \
  --timeout 120000
```

What you should observe:

- stdout is `MAIN SAW 4\n`, written by the **main** agent after the subagent finishes.
- exit 0.
- Internally, `result.subagents` (exposed via the library API) contains at least one entry with `agent_type` = `Explore` or similar.

To inspect subagent events programmatically:

```ts
import { runInteractive } from "claude-auto";

const r = await runInteractive({
  prompt: "Use the Task tool ...",
  args: ["--dangerously-skip-permissions"],
});
console.log("main:", r.text);
console.log("subagents fired:", r.subagents.map(s => ({ id: s.agent_id, type: s.agent_type, msg: s.last_assistant_message })));
```

If you see `r.text === r.subagents[0].last_assistant_message`, that's a bug (we resolved on SubagentStop instead of Stop). The runner explicitly filters with `!ev.agent_id`, so it shouldn't happen — but worth re-checking on a Claude Code minor version bump.

## 3. Two parallel subagents

Tests that multiple `SubagentStop` events don't accidentally trigger termination:

```bash
claude-auto tui-p \
  "Spawn TWO Explore subagents in parallel via the Task tool. One should count .ts files, the other should count .js files. Then reply with both counts." \
  --skip-auth \
  --timeout 300000
```

Expected: exit 0, stdout has two counts, `r.subagents.length >= 2`.

Avoid `--skip-permissions` for this smoke test unless you've already accepted Claude Code's bypass warning in the TUI. On a fresh machine it pauses on an interactive “Yes, I accept” screen, so the automation will wait until timeout.

## 4. Auth retry

Force a stale token:

```bash
# Manually corrupt the access token (refresh token stays valid)
jq '.claudeAiOauth.accessToken = "broken"' ~/.claude/.credentials.json > /tmp/c && mv /tmp/c ~/.claude/.credentials.json

claude-auto tui-p "Reply with OK."
```

Expected: the run hits StopFailure with `error: authentication_failed`, runner calls `authenticate({force:true})`, then retries the whole flow and succeeds. stdout = `OK\n`, exit 0.

## 5. Cleanup / uninstall

```bash
claude-auto uninstall-hooks
jq '.hooks' ~/.claude/settings.json  # should no longer contain hook-relay marker
```

## Debugging hook plumbing in isolation

You can mock a "claude" run by hand:

```bash
# Terminal A: pretend to be the runner — listen on a socket
SOCK=/tmp/test.sock
rm -f $SOCK
nc -lU $SOCK | jq .

# Terminal B: pretend to be claude — fire the relay manually
echo '{"hook_event_name":"Stop","session_id":"abc","transcript_path":"/tmp/x.jsonl","last_assistant_message":"hi"}' \
  | CLAUDE_AUTO_RUN_SOCKET=$SOCK ~/.claude-auto/hook-relay.sh
```

Terminal A should pretty-print the JSON. If not, the relay is misconfigured (check `python3`, socket permissions, etc.).
