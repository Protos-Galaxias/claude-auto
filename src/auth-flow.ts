import { chromium } from "playwright";
import { existsSync } from "node:fs";
import { PATHS } from "./constants.js";
import {
  generatePKCE,
  buildAuthorizeUrl,
  exchangeCodeForTokens,
  type OAuthTokens,
} from "./oauth.js";
import { logger } from "./logger.js";

const TIMEOUT_MS = 120_000;
const REDIRECT_PATTERN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/callback/;
const MANUAL_REDIRECT_PATTERN = /oauth\/code\/callback.*code=/;

export interface AuthFlowOptions {
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

  const pkce = generatePKCE();
  const redirectUri = "http://localhost:9999/callback";
  const authorizeUrl = buildAuthorizeUrl(pkce, redirectUri);

  logger.info("Starting OAuth flow...");
  if (debug) {
    logger.info(`Authorize URL: ${authorizeUrl}`);
  }

  const browser = await chromium.launch({ headless: !debug });

  try {
    const context = await browser.newContext({
      storageState: PATHS.googleStateFile,
    });

    const page = await context.newPage();

    const codePromise = waitForAuthCode(page);

    await page.goto(authorizeUrl, { waitUntil: "domcontentloaded" });

    await handleInterstitialPages(page, debug);

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
    await browser.close();
  }
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

function waitForAuthCode(page: import("playwright").Page): Promise<string> {
  return new Promise((resolve, reject) => {
    let resolved = false;
    const timer = setTimeout(() => {
      reject(new Error(`OAuth flow timed out after ${TIMEOUT_MS / 1000}s`));
    }, TIMEOUT_MS);

    const tryResolve = (code: string) => {
      if (resolved) {
        return;
      }
      resolved = true;
      clearTimeout(timer);
      resolve(code);
    };

    page.on("request", (request) => {
      const code = extractCode(request.url());
      if (code) {
        tryResolve(code);
      }
    });

    page.on("response", (response) => {
      const code = extractCode(response.url());
      if (code) {
        tryResolve(code);
      }
    });

    page.on("framenavigated", (frame) => {
      if (frame !== page.mainFrame()) {
        return;
      }
      const code = extractCode(frame.url());
      if (code) {
        tryResolve(code);
      }
    });
  });
}

async function handleInterstitialPages(
  page: import("playwright").Page,
  debug: boolean
): Promise<void> {
  for (let attempt = 0; attempt < 15; attempt++) {
    await page.waitForTimeout(2000);

    const currentUrl = page.url();

    if (debug) {
      logger.info(`[${attempt}] URL: ${currentUrl}`);
      const title = await page.title().catch(() => "?");
      logger.info(`[${attempt}] Title: ${title}`);
    }

    if (REDIRECT_PATTERN.test(currentUrl)) {
      return;
    }

    // Also check if the URL contains the code param (manual redirect URL)
    if (currentUrl.includes("oauth/code/callback") && currentUrl.includes("code=")) {
      return;
    }

    if (currentUrl.includes("accounts.google.com")) {
      logger.info("On Google SSO page, waiting for auto-login...");
      await tryClickGoogleContinue(page);
      continue;
    }

    if (
      currentUrl.includes("claude.ai") ||
      currentUrl.includes("claude.com") ||
      currentUrl.includes("platform.claude.com")
    ) {
      if (debug) {
        const text = await page.locator("body").innerText().catch(() => "");
        logger.info(`Page text (first 500 chars): ${text.slice(0, 500)}`);
      }
      logger.info("On Anthropic page, checking for consent...");
      const clicked = await tryClickAnthropicConsent(page);
      if (!clicked && debug) {
        logger.info("No consent button found, waiting...");
      }
      continue;
    }

    if (debug) {
      logger.info(`Unknown page: ${currentUrl}`);
    }
  }
}

async function tryClickGoogleContinue(
  page: import("playwright").Page
): Promise<void> {
  const selectors = [
    'button:has-text("Continue")',
    'button:has-text("Allow")',
    'input[type="submit"]',
    "#submit_approve_access",
    'button[name="continue"]',
  ];

  for (const selector of selectors) {
    try {
      const el = page.locator(selector).first();
      if (await el.isVisible({ timeout: 1000 })) {
        await el.click();
        logger.info(`Clicked Google button: ${selector}`);

        return;
      }
    } catch {
      // selector not found
    }
  }
}

async function tryClickAnthropicConsent(
  page: import("playwright").Page
): Promise<boolean> {
  const selectors = [
    'button:has-text("Authorize")',
    'button:has-text("Allow")',
    'button:has-text("Accept")',
    'button:has-text("Approve")',
    'button[type="submit"]',
  ];

  for (const selector of selectors) {
    try {
      const el = page.locator(selector).first();
      if (await el.isVisible({ timeout: 1000 })) {
        await el.click();
        logger.info(`Clicked Anthropic consent: ${selector}`);

        return true;
      }
    } catch {
      // selector not found
    }
  }

  return false;
}
