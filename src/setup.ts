import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { PATHS } from "./constants.js";
import { installHooks } from "./hook-installer.js";

export async function runSetup(): Promise<void> {
  if (!existsSync(PATHS.autoConfigDir)) {
    await mkdir(PATHS.autoConfigDir, { recursive: true });
  }

  await installHooks();
  console.log(`[claude-auto] Hook relay installed: ${PATHS.hookRelayScript}`);
  console.log(`[claude-auto] Patched ${PATHS.claudeSettingsFile} with Stop/SubagentStop/StopFailure hooks (no-op unless CLAUDE_AUTO_RUN_SOCKET is set).`);

  console.log(
    "[claude-auto] Opening browser for Google login.\n" +
      "Log into your Google account that you use for Claude.\n" +
      "The session will be saved automatically once login is detected.\n"
  );

  const browser = await chromium.launch({
    headless: false,
    args: ["--disable-blink-features=AutomationControlled"],
  });

  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  });

  const page = await context.newPage();

  await page.goto("https://accounts.google.com", {
    waitUntil: "networkidle",
  });

  console.log("[claude-auto] Waiting for Google login...");

  let saved = false;

  const saveState = async (): Promise<boolean> => {
    try {
      await context.storageState({ path: PATHS.googleStateFile });
      saved = true;

      return true;
    } catch {
      return false;
    }
  };

  // Poll for login: check if SID cookie appears (means user is logged in)
  const pollInterval = setInterval(async () => {
    try {
      const cookies = await context.cookies("https://accounts.google.com");
      const hasSID = cookies.some((c) => c.name === "SID" && c.value.length > 10);
      if (hasSID && !saved) {
        await saveState();
        console.log(
          `\n[claude-auto] Google session saved to ${PATHS.googleStateFile}\n` +
            "You can close the browser now."
        );
      }
    } catch {
      // context may be destroyed
    }
  }, 3000);

  await new Promise<void>((resolve) => {
    browser.on("disconnected", () => {
      clearInterval(pollInterval);
      resolve();
    });
  });

  // Last-resort save attempt
  if (!saved) {
    await saveState();
  }

  if (saved && existsSync(PATHS.googleStateFile)) {
    console.log(
      "[claude-auto] Setup complete. You can now use 'claude-auto' on this machine\n" +
        "or copy the state file to a server:\n\n" +
        `  scp ${PATHS.googleStateFile} user@server:~/.claude-auto/google-state.json\n`
    );
  } else {
    console.error(
      "[claude-auto] Failed to save session. " +
        "Make sure you logged in before closing the browser."
    );
    process.exit(1);
  }
}
