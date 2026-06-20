import { test } from "node:test";
import assert from "node:assert/strict";
import { isClaudeLoginPage } from "../auth-flow.js";

const AUTHORIZE_URL =
  "https://claude.ai/oauth/authorize?code=true&client_id=9d1c250a&response_type=code";

// The exact URL the main tab got stuck on in the field report: claude bounced
// back to a login/account-selection page after the Google popup completed.
const SELECT_ACCOUNT_URL =
  "https://claude.ai/login?selectAccount=true&returnTo=%2Foauth%2Fauthorize%3Fcode%3Dtrue%26client_id%3D9d1c250a";

test("before first Google click, any claude host is treated as a login page", () => {
  assert.equal(isClaudeLoginPage("https://claude.ai/login", false), true);
  assert.equal(isClaudeLoginPage(AUTHORIZE_URL, false), true);
  assert.equal(isClaudeLoginPage("https://claude.com/", false), true);
});

test("the selectAccount re-prompt is detected as a login page even after first click", () => {
  assert.equal(isClaudeLoginPage(SELECT_ACCOUNT_URL, true), true);
});

test("a plain /login bounce is detected after first click", () => {
  assert.equal(isClaudeLoginPage("https://claude.ai/login?returnTo=%2Foauth", true), true);
});

test("the oauth/authorize consent page is NOT a login page after first click", () => {
  // This must stay false so the consent gates (cookie dismissal, Authorize)
  // run instead of trying to re-click Google.
  assert.equal(isClaudeLoginPage(AUTHORIZE_URL, true), false);
});

test("non-claude hosts are never login pages", () => {
  assert.equal(isClaudeLoginPage("https://accounts.google.com/o/oauth2", false), false);
  assert.equal(isClaudeLoginPage("https://accounts.google.com/o/oauth2", true), false);
  assert.equal(isClaudeLoginPage("http://localhost:9999/callback?code=abc", true), false);
});

test("selectAccount matching is case-insensitive", () => {
  assert.equal(
    isClaudeLoginPage("https://claude.ai/foo?SelectAccount=true", true),
    true
  );
});

test("a bare claude.ai path without login markers is not a re-prompt after click", () => {
  assert.equal(isClaudeLoginPage("https://claude.ai/chat/123", true), false);
});
