/**
 * Tray sign-in verification.
 * Case 1: customizer page (iframe present) — sign-in item posts open-sign-in
 *         to the iframe, whose own OTP panel opens.
 * Case 2: non-customizer page (no iframe) — sign-in item opens the tray's
 *         OWN in-tray OTP panel (no navigation). OTP endpoints are mocked so
 *         the full email → code → signed-in flow is exercised end to end.
 *
 * Serves the LOCAL appai-customizer-tray.js via route interception so this
 * validates the working tree, not the deployed asset.
 */
import { chromium, Page, BrowserContext } from "playwright";
import * as fs from "fs";
import * as path from "path";

const SHOP = "aiartstudio-gizsmzs2.myshopify.com";
const PASSWORD = process.env.STOREFRONT_PASSWORD || "artstudio";
const THEME_ID = "190904926573"; // Tinker

const LOCAL_TRAY_JS = fs.readFileSync(
  path.join(process.cwd(), "extensions", "theme-extension", "assets", "appai-customizer-tray.js"),
  "utf8",
);

async function serveLocalTray(context: BrowserContext) {
  await context.route(/appai-customizer-tray\.js/, (route) => {
    route.fulfill({ contentType: "application/javascript; charset=utf-8", body: LOCAL_TRAY_JS });
  });
}

async function gotoUrl(page: Page, url: string) {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  if (page.url().includes("/password")) {
    await page.fill('input[name="password"]', PASSWORD);
    await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded" }).catch(() => {}),
      page.click('button[type="submit"], input[type="submit"]'),
    ]);
    await page.goto(url, { waitUntil: "domcontentloaded" });
  }
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  let failures = 0;

  // ── Case 1: customizer page (iframe present) — postMessage path ──
  {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await serveLocalTray(context);
    const page = await context.newPage();
    await gotoUrl(page, `https://${SHOP}/pages/zip-hoodie-aop?preview_theme_id=${THEME_ID}`);
    await page.waitForSelector('iframe[title="AI Art Design Studio"]', { timeout: 30000 });
    await page.waitForTimeout(6000);

    await page.waitForSelector("#appai-tray-launcher", { timeout: 15000 });
    await page.click("#appai-tray-launcher");
    await page.waitForTimeout(600);

    const trayText = await page.evaluate(
      () => document.getElementById("appai-tray-body")?.innerText || "",
    );
    const hasSignIn = trayText.includes("Sign in or Create an Account");
    console.log("Case 1 tray shows sign-in item:", hasSignIn);
    if (!hasSignIn) failures++;

    if (hasSignIn) {
      await page.click("#appai-tray-body button.appai-tray-item");
      await page.waitForTimeout(1500);
      const frame = page.frames().find((f) => f.url().includes("/apps/appai/s/designer"));
      const panelVisible = frame
        ? await frame.evaluate(() => {
            const els = Array.from(document.querySelectorAll("h3"));
            return els.some((el) => (el.textContent || "").toLowerCase().includes("sign in or create account"));
          })
        : false;
      console.log("Case 1 OTP panel opened in iframe:", panelVisible);
      if (!panelVisible) failures++;
      // Tray must have closed for the iframe path.
      const trayOpen = await page.evaluate(
        () => document.getElementById("appai-customizer-tray")?.classList.contains("appai-open") || false,
      );
      console.log("Case 1 tray closed after handing off to iframe:", !trayOpen);
      if (trayOpen) failures++;
    }
    await context.close();
  }

  // ── Case 2: non-customizer page (no iframe) — IN-TRAY OTP panel ──
  {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await serveLocalTray(context);
    // Mock the OTP endpoints so the flow completes without a real email.
    await context.route(/\/apps\/appai\/api\/storefront\/auth\/request-otp/, (route) => {
      route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true }) });
    });
    await context.route(/\/apps\/appai\/api\/storefront\/auth\/verify-otp/, (route) => {
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          customerId: "test-customer-123",
          identityToken: "test-token",
          credits: 5,
          freeGenerationsUsed: 1,
        }),
      });
    });
    let mergeCalled = false;
    await context.route(/\/apps\/appai\/api\/storefront\/merge-session/, (route) => {
      mergeCalled = true;
      route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true }) });
    });

    const page = await context.newPage();
    await gotoUrl(page, `https://${SHOP}/?preview_theme_id=${THEME_ID}`);
    // Seed an anon session so the merge call has something to fold in.
    await page.evaluate(() => localStorage.setItem("appai_session", "anon-test-session"));
    await page.waitForSelector("#appai-tray-launcher", { timeout: 20000 });
    await page.waitForTimeout(1500);
    await page.click("#appai-tray-launcher");
    await page.waitForTimeout(600);

    const trayText = await page.evaluate(
      () => document.getElementById("appai-tray-body")?.innerText || "",
    );
    const hasSignIn = trayText.includes("Sign in or Create an Account");
    console.log("Case 2 tray shows sign-in item:", hasSignIn);
    if (!hasSignIn) failures++;

    const urlBefore = page.url();
    await page.click("#appai-tray-body button.appai-tray-item");
    await page.waitForTimeout(800);

    const noNav = page.url() === urlBefore;
    console.log("Case 2 no navigation on click:", noNav);
    if (!noNav) failures++;

    const panelShown = await page.isVisible(".appai-signin-title");
    console.log("Case 2 in-tray sign-in panel shown:", panelShown);
    if (!panelShown) failures++;

    // Email step
    await page.fill(".appai-signin-input", "test@example.com");
    await page.click(".appai-signin-submit");
    await page.waitForSelector(".appai-signin-input.appai-code", { timeout: 5000 });
    console.log("Case 2 advanced to code step: true");

    // Code step
    await page.fill(".appai-signin-input.appai-code", "123456");
    await page.click(".appai-signin-submit");
    await page.waitForSelector(".appai-signin-success", { timeout: 5000 });
    const successText = await page.textContent(".appai-signin-success");
    console.log("Case 2 success message:", JSON.stringify((successText || "").slice(0, 80)));

    const stored = await page.evaluate(() => ({
      customerId: localStorage.getItem("appai_customer_id"),
      token: localStorage.getItem("appai_identity_token"),
      email: localStorage.getItem("appai_otp_email"),
      customer: localStorage.getItem("appai_customer"),
    }));
    const cust = stored.customer ? JSON.parse(stored.customer) : null;
    const storageOk =
      stored.customerId === "test-customer-123" &&
      stored.token === "test-token" &&
      stored.email === "test@example.com" &&
      cust?.isLoggedIn === true &&
      cust?.id === "test-customer-123" &&
      cust?.credits === 5;
    console.log("Case 2 localStorage matches completeStorefrontLogin shape:", storageOk);
    if (!storageOk) { failures++; console.log("  stored:", stored); }

    await page.waitForTimeout(3000);
    console.log("Case 2 merge-session called with anon session:", mergeCalled);
    if (!mergeCalled) failures++;

    const trayTextAfter = await page.evaluate(
      () => document.getElementById("appai-tray-body")?.innerText || "",
    );
    const signInGone = !trayTextAfter.includes("Sign in or Create an Account");
    console.log("Case 2 sign-in item gone after login:", signInGone);
    if (!signInGone) failures++;

    await context.close();
  }

  // ── Case 3: non-customizer page — Google sign-in from the in-tray panel ──
  {
    const APP_URL = "https://appai-pod-production.up.railway.app";
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await serveLocalTray(context);
    await context.route(/\/apps\/appai\/api\/storefront\/auth\/config/, (route) => {
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ googleClientId: "test-client-id", appUrl: APP_URL }),
      });
    });
    // Stub the central auth popup ON THE APP ORIGIN so event.origin passes
    // the tray's isAllowedCentralAuthOrigin check.
    await context.route(/\/storefront\/google-auth/, (route) => {
      route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><script>
          var p = new URLSearchParams(location.search);
          window.opener.postMessage({
            type: 'APPAI_STOREFRONT_GOOGLE_AUTH',
            nonce: p.get('nonce'),
            ok: true,
            customerId: 'google-customer-9',
            identityToken: 'google-token',
            credits: 3,
            freeGenerationsUsed: 0,
            email: 'guser@example.com',
          }, p.get('openerOrigin'));
        <\/script>`,
      });
    });
    await context.route(/\/apps\/appai\/api\/storefront\/merge-session/, (route) => {
      route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true }) });
    });

    const page = await context.newPage();
    await gotoUrl(page, `https://${SHOP}/?preview_theme_id=${THEME_ID}`);
    await page.waitForSelector("#appai-tray-launcher", { timeout: 20000 });
    await page.waitForTimeout(1500);
    await page.click("#appai-tray-launcher");
    await page.waitForTimeout(600);
    await page.click("#appai-tray-body button.appai-tray-item");
    await page.waitForTimeout(800);

    const googleShown = await page.isVisible(".appai-signin-google");
    console.log("Case 3 Google button shown in panel:", googleShown);
    if (!googleShown) failures++;
    const dividerShown = await page.isVisible(".appai-signin-divider");
    console.log("Case 3 'or' divider shown:", dividerShown);
    if (!dividerShown) failures++;

    if (googleShown) {
      await page.click(".appai-signin-google");
      await page.waitForSelector(".appai-signin-success", { timeout: 10000 });
      const successText = await page.textContent(".appai-signin-success");
      console.log("Case 3 success message:", JSON.stringify((successText || "").slice(0, 80)));

      const stored = await page.evaluate(() => ({
        customerId: localStorage.getItem("appai_customer_id"),
        token: localStorage.getItem("appai_identity_token"),
        email: localStorage.getItem("appai_otp_email"),
        customer: localStorage.getItem("appai_customer"),
      }));
      const cust = stored.customer ? JSON.parse(stored.customer) : null;
      const storageOk =
        stored.customerId === "google-customer-9" &&
        stored.token === "google-token" &&
        stored.email === "guser@example.com" &&
        cust?.isLoggedIn === true &&
        cust?.credits === 3;
      console.log("Case 3 localStorage written from Google result:", storageOk);
      if (!storageOk) { failures++; console.log("  stored:", stored); }

      await page.waitForTimeout(3000);
      const trayTextAfter = await page.evaluate(
        () => document.getElementById("appai-tray-body")?.innerText || "",
      );
      const signInGone = !trayTextAfter.includes("Sign in or Create an Account");
      console.log("Case 3 sign-in item gone after Google login:", signInGone);
      if (!signInGone) failures++;
    }
    await context.close();
  }

  await browser.close();
  console.log(failures === 0 ? "ALL PASS" : `FAILURES: ${failures}`);
  if (failures > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
