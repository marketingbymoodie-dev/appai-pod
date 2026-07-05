/**
 * Throwaway repro: tray sign-in on Savor + returning-visitor localStorage states.
 * Case A: fresh context, homepage -> sign-in -> panel must open on customizer page.
 * Case B: seeded appai_customer_id + appai_customer{isLoggedIn:false} (returning anon).
 * Case C: seeded appai_customer_id ONLY (no appai_customer record) — legacy state.
 */
import { chromium, Page, BrowserContext } from "playwright";

const SHOP = "aiartstudio-gizsmzs2.myshopify.com";
const PASSWORD = process.env.STOREFRONT_PASSWORD || "artstudio";
const THEMES: Record<string, string> = {
  Savor: "190904762733",
  Tinker: "190904926573",
};

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

async function runCase(
  context: BrowserContext,
  themeId: string,
  label: string,
  seed: null | { id?: boolean; customer?: { isLoggedIn: boolean } },
) {
  const page = await context.newPage();
  await gotoUrl(page, `https://${SHOP}/?preview_theme_id=${themeId}`);

  if (seed) {
    await page.evaluate(function (args) {
      var withId = args[0];
      var customerJson = args[1];
      try { localStorage.clear(); } catch (_) {}
      if (withId) localStorage.setItem("appai_customer_id", "999999");
      if (customerJson) localStorage.setItem("appai_customer", customerJson);
    }, [seed.id !== false, seed.customer ? JSON.stringify({ id: "999999", isLoggedIn: seed.customer.isLoggedIn }) : ""]);
    await page.reload({ waitUntil: "domcontentloaded" });
  }

  await page.waitForSelector("#appai-tray-launcher", { timeout: 20000 });
  await page.waitForTimeout(1200);
  await page.click("#appai-tray-launcher");
  await page.waitForTimeout(600);

  const trayText = await page.evaluate(function () {
    var el = document.getElementById("appai-tray-body");
    return el ? el.innerText : "";
  });
  const hasSignIn = trayText.includes("Sign in or Create an Account");
  console.log(`[${label}] sign-in item visible:`, hasSignIn);

  if (!hasSignIn) {
    console.log(`[${label}] tray text:`, JSON.stringify(trayText.slice(0, 200)));
    await page.close();
    return;
  }

  await page.click("#appai-tray-body button.appai-tray-item");
  // Wait for navigation to the customizer page.
  await page.waitForURL(/\/pages\//, { timeout: 20000 }).catch(function () {});
  console.log(`[${label}] landed on:`, page.url());
  await page.waitForSelector('iframe[title="AI Art Design Studio"]', { timeout: 30000 }).catch(function () {});
  await page.waitForTimeout(8000);
  const frame = page.frames().find(function (f) { return f.url().includes("/apps/appai/s/designer"); });
  console.log(`[${label}] iframe has openSignIn=1:`, frame ? frame.url().includes("openSignIn=1") : "NO FRAME");
  const panelVisible = frame
    ? await frame.evaluate(function () {
        var els = Array.prototype.slice.call(document.querySelectorAll("h3"));
        return els.some(function (el) { return (el.textContent || "").toLowerCase().indexOf("sign in or create account") !== -1; });
      })
    : false;
  console.log(`[${label}] OTP panel opened:`, panelVisible);
  await page.close();
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  for (const [themeName, themeId] of Object.entries(THEMES)) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await runCase(context, themeId, `${themeName} A-fresh`, null);
    await runCase(context, themeId, `${themeName} B-returning-anon`, { customer: { isLoggedIn: false } });
    await runCase(context, themeId, `${themeName} C-id-only`, { id: true });
    await context.close();
  }
  await browser.close();
}

main().catch(function (e) {
  console.error(e);
  process.exit(1);
});
