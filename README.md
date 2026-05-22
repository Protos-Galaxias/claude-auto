# claude-auto

Drop-in wrapper for `claude` CLI that automatically re-authenticates when OAuth tokens expire (401).

## Problem

Claude Code with Max subscription uses OAuth tokens that expire every ~30 days. On remote servers this requires manual re-login: SSH in, run `claude /login`, copy URL to browser, copy code back. `claude-auto` eliminates this by re-authenticating headlessly using a saved Google session.

## How it works

1. You run `claude-auto -p 'your prompt'` instead of `claude -p 'your prompt'`
2. If `claude` succeeds — output is passed through, nothing changes
3. If `claude` fails with 401 — `claude-auto`:
   - First tries to refresh the existing token (fast, no browser)
   - If refresh fails, launches headless Chromium with your saved Google session
   - Passes through Anthropic OAuth automatically (Google SSO + consent)
   - Writes fresh tokens to `~/.claude/.credentials.json`
   - Retries the original command

## Prerequisites

- Node.js >= 18
- `claude` CLI installed and in PATH
- Claude Pro or Max subscription

## Installation

```bash
# From the project directory
npm install
npm run build
npm link

# Or install globally from npm (when published)
# npm install -g claude-auto
```

Playwright will automatically download Chromium during `npm install` (~400MB).

## Setup (one-time)

Save your Google session for headless re-auth. Run this on a machine with a browser (your Mac, or server with VNC/X11):

```bash
claude-auto setup
```

This opens Chromium — log into the Google account you use for Claude, then close the browser. Session is saved to `~/.claude-auto/google-state.json`.

### Using setup on a different machine

If your server has no GUI, run setup on your Mac and copy the state file:

```bash
# On your Mac
claude-auto setup

# Copy to server
scp ~/.claude-auto/google-state.json user@server:~/.claude-auto/google-state.json
```

The Google session file is valid for ~2 years (Google SID cookie TTL).

## Usage

### As a drop-in replacement

```bash
# Instead of:
claude -p 'explain this code'

# Use:
claude-auto -p 'explain this code'
```

All arguments are passed through to `claude`. If auth fails, re-auth happens automatically.

### `tui-p`: TUI-driven `-p` (subscription-friendly)

Starting June 15 2026, Anthropic moves `claude -p` / Agent SDK / GitHub Actions usage into a separate "Agent SDK Credit pool" billed at API rates — subscription quota no longer applies to programmatic access.

`claude-auto tui-p` works around this by spawning the **interactive** TUI in a pseudo-TTY (via `node-pty`), typing the prompt for you, and grabbing the final assistant message from a `Stop` lifecycle hook (so no ANSI/TTY parsing). The output is captured server-side via `last_assistant_message`, not by reading stdout.

```bash
# One-time: installs hook relay + patches ~/.claude/settings.json
claude-auto setup

# Drop-in replacement for `claude -p`
claude-auto tui-p 'explain this code' --skip-permissions --model sonnet

# Works with prompts that spawn subagents — main Stop fires after all SubagentStop
claude-auto tui-p 'Spawn an Explore subagent to count .ts files, then report the count.'
```

See [TUI_TEST.md](./TUI_TEST.md) for the test recipe (including the subagent case).

The hooks installed by `setup` are no-ops unless `CLAUDE_AUTO_RUN_SOCKET` is set in the environment, so they don't affect your regular interactive `claude` sessions.

To remove them: `claude-auto uninstall-hooks`.

### Programmatic API (`runInteractive`)

```ts
import { runInteractive } from "claude-auto";

const controller = new AbortController();

const result = await runInteractive({
  prompt: "Read package.json and summarize.",
  args: ["--dangerously-skip-permissions", "--model", "sonnet"],
  signal: controller.signal,
  onToolUse: (ev) => {
    // Fires per main-agent PreToolUse. Pass includeSubagentTools: true to also see subagents.
    console.log(`🔧 ${ev.name}`);
  },
});

console.log(result.text);
console.log(result.usage);
//   { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, cacheHitRatio }

// Anywhere else: controller.abort() — kills the PTY and rejects with AbortError.
```

**Options highlights:**

| Option | Purpose |
|---|---|
| `signal` | Standard `AbortSignal`. Aborting kills the PTY (~100ms) and rejects with `AbortError` (`code: "ABORT_ERR"`). |
| `onToolUse` | Live callback per `PreToolUse` (`{ name, input?, agentId?, agentType?, toolUseId? }`). Main agent only by default. |
| `includeSubagentTools` | Also forward subagent `PreToolUse` events. Off by default (noisy: Read x10 per `Task`). |
| `result.usage` | Aggregated main-agent token usage parsed from the transcript. Parallel tool calls dedup by `message.id`. Subagent usage excluded (use `result.subagents` + transcripts of their sidechains for that). |

See [INVESTIGATION-NOTES.md](./INVESTIGATION-NOTES.md) for known TUI quirks (e.g. `--model + --resume` without `--append-system-prompt`).

### In scripts

```bash
#!/bin/bash
# your-script.sh
RESULT=$(claude-auto -p "Review this PR: $(git diff main)")
echo "$RESULT"
```

### Force re-authentication

```bash
claude-auto refresh
```

### Check status

```bash
claude-auto status
```

Output:
```
Token: Token expires at 2026-05-04T18:30:00.000Z (6h 45m remaining)
Status: ACTIVE
Scopes: user:profile, user:inference, user:sessions:claude_code, user:mcp_servers, user:file_upload
Google state: present
```

## Proactive refresh (cron)

Don't wait for tokens to expire — refresh proactively:

```bash
# Refresh every 7 days at 3am
0 3 */7 * * /usr/local/bin/claude-auto refresh >> /var/log/claude-auto.log 2>&1
```

This keeps the token chain alive and prevents 401s from happening at all.

## Files

| Path | Purpose |
|------|---------|
| `~/.claude/.credentials.json` | Claude Code OAuth tokens (access + refresh) |
| `~/.claude-auto/google-state.json` | Saved Google session (cookies + localStorage) |

## Recovery flow

```
claude-auto -p '...'
  │
  ├─ claude succeeds → done
  │
  └─ claude fails with 401
       │
       ├─ Try token refresh (POST /v1/oauth/token with refresh_token)
       │    ├─ Success → retry claude → done
       │    └─ Fail (refresh token dead)
       │
       └─ Full OAuth re-auth (headless Playwright)
            ├─ Success → retry claude → done
            └─ Fail → print error, suggest 'claude-auto setup'
```

## Troubleshooting

**"Google session state not found"**
Run `claude-auto setup` to create the Google session file.

**"OAuth flow timed out"**
Google session may have expired. Run `claude-auto setup` again.

**"Token exchange failed"**
Check that your Claude subscription (Pro or Max) is active.

**Headless auth triggers Google 2FA**
This can happen if the server IP is very different from where you ran setup. Run setup on the server directly (needs X11/VNC) or use a VPN to match IPs.

## License

MIT
