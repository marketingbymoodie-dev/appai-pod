/** Throwaway check: tray shows Sign in item when logged out, and it opens the OTP panel. */
import { chromium, Page } from "playwright";

const SHOP = "aiartstudio-gizsmzs2.myshopify.com";
const PASSWORD = process.env.STOREFRONT_PASSWORD || "artstudio";
const THEME_ID = "190904926573"; // Tinker

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

  // ── Case 1: customizer page (iframe present) — postMessage path ──
  {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
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
    console.log("Tray text:", JSON.stringify(trayText.slice(0, 300)));

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
    }
    await context.close();
  }

  // ── Case 2: non-customizer page (no iframe) — navigate path ──
  {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    await gotoUrl(page, `https://${SHOP}/?preview_theme_id=${THEME_ID}`);
    await page.waitForSelector("#appai-tray-launcher", { timeout: 20000 });
    await page.waitForTimeout(1500);
    await page.click("#appai-tray-launcher");
    await page.waitForTimeout(600);

    const trayText = await page.evaluate(
      () => document.getElementById("appai-tray-body")?.innerText || "",
    );
    const hasSignIn = trayText.includes("Sign in or Create an Account");
    console.log("Case 2 tray shows sign-in item:", hasSignIn);

    if (hasSignIn) {
      await Promise.all([
        page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => {}),
        page.click("#appai-tray-body button.appai-tray-item"),
      ]);
      console.log("Case 2 navigated to:", page.url());
      await page.waitForSelector('iframe[title="AI Art Design Studio"]', { timeout: 30000 });
      await page.waitForTimeout(8000);
      const frame = page.frames().find((f) => f.url().includes("/apps/appai/s/designer"));
      console.log("Case 2 iframe URL has openSignIn:", frame ? frame.url().includes("openSignIn=1") : "no frame");
      const panelVisible = frame
        ? await frame.evaluate(() => {
            const els = Array.from(document.querySelectorAll("h3"));
            return els.some((el) => (el.textContent || "").toLowerCase().includes("sign in or create account"));
          })
        : false;
      console.log("Case 2 OTP panel opened on load:", panelVisible);
    }
    await context.close();
  }

  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
