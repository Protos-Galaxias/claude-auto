import { chromium, type BrowserContext, type Page } from "playwright";
import { existsSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { PATHS } from "./constants.js";
import {
  generatePKCE,
  buildAuthorizeUrl,
  exchangeCodeForTokens,
  type OAuthTokens,
} from "./oauth.js";
import { logger } from "./logger.js";

const TIMEOUT_MS = 180_000;
const REDIRECT_PATTERN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/callback/;
const MANUAL_REDIRECT_PATTERN = /oauth\/code\/callback.*code=/;
const CLOUDFLARE_TITLE = /just a moment|attention required|checking your browser/i;

// A real desktop UA + disabling the automation flag is what gets us past the
// Cloudflare challenge on claude.ai. Headless Chromium is detected and blocked,
// so the browser is always launched headful (use xvfb on headless servers).
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export interface AuthFlowOptions {
  /** Extra logging of every page transition. The browser is always headful. */
  debug?: boolean;
}

export async function performHeadlessOAuth(
  options: AuthFlowOptions = {}
): Promise<OAuthTokens> {
  const debug = options.debug ?? false;

  if (!existsSync(PATHS.googleStateFile)) {
    throw new Error(
      `Google session state not found at ${PATHS.googleStateFile}\n` +
        `Run 'claude-auto setup' first to save your Google session.`
    );
  }

  // Diagnostic switch: drive the full browser flow (Cloudflare, Google popup,
  // account pick, consent) but stop before granting and never exchange the
  // code. Lets us validate the automation without minting/overwriting tokens.
  const dryRun = process.env.CLAUDE_AUTO_OAUTH_DRY_RUN === "1";

  const pkce = generatePKCE();
  const redirectUri = "http://localhost:9999/callback";
  const authorizeUrl = buildAuthorizeUrl(pkce, redirectUri);

  logger.info(`Starting OAuth flow (claude.ai, headful${dryRun ? ", DRY RUN" : ""})...`);
  if (debug) {
    logger.info(`Authorize URL: ${authorizeUrl}`);
  }

  // Headful Chromium needs an X display. On a headless Linux box (server, cron)
  // there is none, so spin up Xvfb automatically instead of failing.
  const stopDisplay = await ensureXDisplay();

  let browser: import("playwright").Browser | null = null;
  try {
    browser = await chromium.launch({
      headless: false,
      args: ["--disable-blink-features=AutomationControlled"],
    });

    const context = await browser.newContext({
      storageState: PATHS.googleStateFile,
      userAgent: USER_AGENT,
      viewport: { width: 1280, height: 900 },
    });

    const codePromise = waitForAuthCode(context);

    const page = await context.newPage();

    // Register AFTER the main page exists so the popup driver only runs on the
    // Google popup, not on the main claude.ai tab.
    context.on("page", (popup) => {
      void driveGooglePopup(popup, debug);
    });

    await page.goto(authorizeUrl, { waitUntil: "domcontentloaded" });

    await driveConsentFlow(page, { debug, dryRun });

    if (dryRun) {
      throw new Error("DRY RUN: reached consent flow without granting (no token minted).");
    }

    const code = await codePromise;

    logger.info("Authorization code captured, exchanging for tokens...");

    const tokens = await exchangeCodeForTokens(
      code,
      pkce.codeVerifier,
      redirectUri,
      pkce.state
    );

    logger.info("Tokens obtained successfully.");

    await context.storageState({ path: PATHS.googleStateFile });

    return tokens;
  } finally {
    if (browser) {
      await browser.close();
    }
    stopDisplay();
  }
}

/**
 * Ensures Chromium has an X display. On macOS/Windows or when DISPLAY is already
 * set, does nothing. On a headless Linux host it launches Xvfb on a free display
 * and returns a cleanup that tears it down. Throws an actionable error if Xvfb
 * isn't installed.
 */
async function ensureXDisplay(): Promise<() => void> {
  if (process.platform !== "linux") {
    return () => {};
  }
  if (process.env.DISPLAY && process.env.DISPLAY.length > 0) {
    return () => {};
  }

  let binaryMissing = false;

  for (let n = 99; n <= 108; n++) {
    if (existsSync(`/tmp/.X${n}-lock`)) {
      continue;
    }

    const display = `:${n}`;
    const proc = spawn(
      "Xvfb",
      [display, "-screen", "0", "1280x1024x24", "-nolisten", "tcp"],
      { stdio: "ignore" }
    );

    const ready = await new Promise<boolean>((resolve) => {
      let settled = false;
      const done = (ok: boolean): void => {
        if (settled) {
          return;
        }
        settled = true;
        resolve(ok);
      };

      proc.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "ENOENT") {
          binaryMissing = true;
        }
        done(false);
      });
      proc.on("exit", () => done(false));

      const poll = setInterval(() => {
        if (existsSync(`/tmp/.X${n}-lock`)) {
          clearInterval(poll);
          done(true);
        }
      }, 100);

      setTimeout(() => {
        clearInterval(poll);
        done(existsSync(`/tmp/.X${n}-lock`));
      }, 3000);
    });

    if (binaryMissing) {
      throw xvfbMissingError();
    }

    if (!ready) {
      proc.kill("SIGKILL");
      continue;
    }

    process.env.DISPLAY = display;
    logger.info(`No DISPLAY set — started Xvfb on ${display}.`);

    return () => {
      try {
        proc.kill("SIGKILL");
      } catch {
        // already gone
      }
    };
  }

  throw xvfbMissingError();
}

function xvfbMissingError(): Error {
  return new Error(
    "Headful browser needs an X display, but none is available.\n" +
      "Install a virtual display:  sudo apt-get install -y xvfb\n" +
      "Then re-run normally, or wrap the command:  xvfb-run -a claude-auto refresh"
  );
}

function extractCode(url: string): string | null {
  if (!REDIRECT_PATTERN.test(url) && !MANUAL_REDIRECT_PATTERN.test(url)) {
    return null;
  }

  try {
    const parsed = new URL(url);

    return parsed.searchParams.get("code");
  } catch {
    return null;
  }
}

/**
 * Resolves with the OAuth `code` as soon as the browser attempts to hit the
 * localhost callback (no server listens there — the request itself carries the
 * code). Listening at the context level covers the main tab and any popup.
 */
function waitForAuthCode(context: BrowserContext): Promise<string> {
  return new Promise((resolve, reject) => {
    let resolved = false;
    const timer = setTimeout(() => {
      reject(new Error(`OAuth flow timed out after ${TIMEOUT_MS / 1000}s`));
    }, TIMEOUT_MS);

    const tryResolve = (url: string) => {
      const code = extractCode(url);
      if (!code || resolved) {
        return;
      }
      resolved = true;
      clearTimeout(timer);
      resolve(code);
    };

    context.on("request", (req) => tryResolve(req.url()));
    context.on("response", (res) => tryResolve(res.url()));
    context.on("page", (p) => {
      p.on("framenavigated", (frame) => {
        if (frame === p.mainFrame()) {
          tryResolve(frame.url());
        }
      });
    });
  });
}

/**
 * Steps the main claude.ai tab through: Cloudflare wait → "Continue with Google"
 * → (Google handled in popup) → final "Authorize" consent. Bails out once the
 * code is captured (the loop is best-effort; waitForAuthCode is the real signal).
 */
interface ConsentFlowOptions {
  debug: boolean;
  dryRun: boolean;
}

async function driveConsentFlow(page: Page, options: ConsentFlowOptions): Promise<void> {
  const { debug, dryRun } = options;
  let clickedGoogle = false;
  let lastUrl = "";
  let stuck = 0;
  let loginButtonWait = 0;
  const googleClickedUrls = new Set<string>();

  for (let attempt = 0; attempt < 75; attempt++) {
    if (page.isClosed()) {
      return;
    }

    await page.waitForTimeout(2000);

    const url = page.url();
    const title = await page.title().catch(() => "?");

    if (debug) {
      logger.info(`[main ${attempt}] ${safeHost(url)} — "${title}"`);
    }

    if (REDIRECT_PATTERN.test(url) || (url.includes("oauth/code/callback") && url.includes("code="))) {
      return;
    }

    if (CLOUDFLARE_TITLE.test(title)) {
      if (debug) {
        logger.info("Waiting out Cloudflare challenge...");
      }
      continue;
    }

    // claude.ai may bounce the main tab back to a login / account-selection
    // page after the Google popup completes (e.g. ?selectAccount=true), where
    // "Continue with Google" must be clicked AGAIN. The button is often a
    // "Loading..." skeleton for a few seconds before it renders, so we retry
    // on every distinct login URL rather than latching after the first click.
    if (isClaudeLoginPage(url, clickedGoogle)) {
      if (googleClickedUrls.has(url)) {
        // Already clicked Google on this exact URL; the popup/redirect should
        // be in flight. Don't re-click (avoids loops), just wait it out.
        continue;
      }
      if (await clickByText(page, /continue with google/i)) {
        logger.info(`Clicked 'Continue with Google'${clickedGoogle ? " (re-prompt)" : ""}.`);
        clickedGoogle = true;
        googleClickedUrls.add(url);
        stuck = 0;
        loginButtonWait = 0;
        lastUrl = url;
        continue;
      }

      // Button not rendered yet (commonly shows "Loading..."). Keep waiting,
      // but fail with an actionable error if it never appears.
      loginButtonWait++;
      if (loginButtonWait >= 20) {
        const buttons = await describeClickables(page);
        logger.error(
          `claude.ai login page never rendered a 'Continue with Google' button on ${url} ("${title}"). ` +
            `Visible clickables: ${JSON.stringify(buttons)}`
        );
        throw new Error(
          "claude.ai login page never showed a 'Continue with Google' button — the login UI likely changed. " +
            `Re-run with --debug and check ${PATHS.logFile} for the logged button list.`
        );
      }
      if (debug) {
        logger.info(`[main ${attempt}] login page, Google button not ready (wait ${loginButtonWait})`);
      }
      continue;
    }

    // Cookie banner can overlay the authorize button — dismiss it once.
    if (clickedGoogle && url.includes("/oauth/authorize")) {
      await clickByText(page, /^(accept all cookies|reject all cookies|accept|reject)/i);

      const body = (await page.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ");

      // The account reached the consent page but isn't entitled to Claude Code.
      if (/max or pro is required|requires? (a )?(max|pro)|need a (max|pro) subscription/i.test(body)) {
        throw new Error(
          "Claude account reached the authorize page but has no active Max/Pro subscription — " +
            "cannot mint a Claude Code token. Verify the subscription is active on this account, " +
            "or run 'claude-auto setup' with the correct Google account."
        );
      }

      if (debug) {
        const all = await describeClickables(page);
        logger.info(`[authorize page] clickables=${JSON.stringify(all)} body="${body.slice(0, 300)}"`);
      }
    }

    // Final subscription consent screen.
    if (clickedGoogle && (await hasConsentButton(page))) {
      if (dryRun) {
        logger.info("DRY RUN: consent screen reached; not clicking Authorize.");

        return;
      }
      if (await clickByText(page, /^(authorize|allow access|allow|approve|grant access)$/i)) {
        logger.info("Clicked claude.ai authorize/consent.");
        continue;
      }
    }

    if (url === lastUrl) {
      stuck++;
    } else {
      stuck = 0;
      lastUrl = url;
    }

    // Only treat a non-login, non-Cloudflare page as a hard stall. While the
    // Google popup is doing its thing the main tab legitimately sits idle.
    if (stuck >= 20) {
      const buttons = await describeClickables(page);
      logger.error(
        `OAuth main tab stuck on ${url} ("${title}"). Visible clickables: ${JSON.stringify(buttons)}`
      );
      throw new Error(
        "OAuth flow stalled on the claude.ai page — the login/consent UI likely changed. " +
          `Re-run with --debug and check ${PATHS.logFile} for the logged button list.`
      );
    }
  }
}

/**
 * True when the main tab is sitting on a claude.ai/.com login or
 * account-selection screen where "Continue with Google" should be clicked.
 *
 * Before the first Google click, any claude host counts (the initial
 * authorize URL lands on the login screen). After it, we only treat explicit
 * login / account-selection URLs as re-prompts so the oauth/authorize consent
 * page isn't mistaken for a login page.
 */
export function isClaudeLoginPage(url: string, clickedGoogle: boolean): boolean {
  if (!/claude\.(ai|com)/.test(safeHost(url))) {
    return false;
  }
  if (!clickedGoogle) {
    return true;
  }

  return /\/login\b/.test(url) || /selectaccount=true/i.test(url);
}

/**
 * Drives the Google account/consent popup: pick the saved account, then click
 * through any "Continue"/"Allow" consent. Never types credentials — relies on
 * the saved Google session being live.
 */
async function driveGooglePopup(popup: Page, debug: boolean): Promise<void> {
  try {
    await popup.waitForLoadState("domcontentloaded").catch(() => {});

    let lastUrl = "";

    for (let i = 0; i < 16; i++) {
      if (popup.isClosed()) {
        return;
      }

      await popup.waitForTimeout(1500);
      const url = popup.url();
      const host = safeHost(url);

      if (!host.includes("google.com")) {
        continue;
      }

      const changed = url !== lastUrl;
      lastUrl = url;

      if (debug) {
        const title = await popup.title().catch(() => "?");
        const buttons = await describeClickables(popup);
        logger.info(`[popup ${i}] ${host} — "${title}" buttons=${JSON.stringify(buttons)}`);
      }

      // Prefer advancing a consent/continue screen first. On the account chooser
      // there is no such button, so we fall through to picking the account.
      if (
        await clickByText(popup, /^(continue|allow|next|confirm|continue to claude|продолжить|подтвердить|разрешить|далее)/i)
      ) {
        logger.info("Google: clicked continue/allow.");
        continue;
      }

      // Account chooser — only act when the page actually changed, to avoid
      // re-clicking the same tile in a loop.
      if (changed && (await pickGoogleAccount(popup))) {
        logger.info("Google: selected saved account.");
        continue;
      }
    }
  } catch (err) {
    if (debug) {
      logger.warn(`Google popup handler error: ${err instanceof Error ? err.message : err}`);
    }
  }
}

async function pickGoogleAccount(popup: Page): Promise<boolean> {
  // Click the account by its email/name text (most reliable), then fall back to
  // structural selectors for the account chooser tile.
  try {
    const byId = popup.locator("[data-identifier]").first();
    if (await byId.isVisible({ timeout: 1000 })) {
      const email = await byId.getAttribute("data-identifier").catch(() => null);
      if (email) {
        await popup.getByText(email, { exact: false }).first().click({ timeout: 1500 }).catch(async () => {
          await byId.click().catch(() => {});
        });

        return true;
      }
      await byId.click();

      return true;
    }
  } catch {
    // fall through
  }

  const selectors = ['li div[role="link"]', 'div[role="link"]', "li"];
  for (const selector of selectors) {
    try {
      const el = popup.locator(selector).first();
      if (await el.isVisible({ timeout: 1000 })) {
        const label = ((await el.textContent().catch(() => "")) ?? "").trim();
        if (/use another account|другой аккаунт/i.test(label)) {
          continue;
        }
        await el.click();

        return true;
      }
    } catch {
      // try next selector
    }
  }

  return false;
}

async function clickByText(target: Page, textRe: RegExp): Promise<boolean> {
  const candidates = target.locator('button, [role="button"], a[role="button"], input[type="submit"]');
  const count = await candidates.count().catch(() => 0);

  for (let i = 0; i < count; i++) {
    const el = candidates.nth(i);
    try {
      const raw = (await el.textContent().catch(() => "")) ?? "";
      const text = raw.trim();
      if (text && textRe.test(text) && (await el.isVisible().catch(() => false))) {
        await el.click().catch(() => {});

        return true;
      }
    } catch {
      // ignore and continue scanning
    }
  }

  return false;
}

async function hasConsentButton(page: Page): Promise<boolean> {
  for (const re of [/^authorize$/i, /^allow access$/i, /^allow$/i, /^approve$/i, /^grant access$/i]) {
    const candidates = page.locator('button, [role="button"]');
    const count = await candidates.count().catch(() => 0);
    for (let i = 0; i < count; i++) {
      const text = ((await candidates.nth(i).textContent().catch(() => "")) ?? "").trim();
      if (text && re.test(text) && (await candidates.nth(i).isVisible().catch(() => false))) {
        return true;
      }
    }
  }

  return false;
}

async function describeClickables(
  page: Page
): Promise<Array<{ tag: string; text: string }>> {
  try {
    return await page.evaluate(() => {
      const nodes = Array.from(
        document.querySelectorAll('button, a, input[type="submit"], [role="button"]')
      );

      return nodes
        .filter((el) => (el as HTMLElement).offsetParent !== null)
        .map((el) => ({
          tag: el.tagName.toLowerCase(),
          text: (el.textContent ?? (el as HTMLInputElement).value ?? "").trim().slice(0, 60),
        }))
        .filter((c) => c.text)
        .slice(0, 30);
    });
  } catch {
    return [];
  }
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "?";
  }
}
