/** Targeted Savor verification: reset .page-wrapper to 0, wheel over iframe, measure wrapper. */
import { chromium, Page } from "playwright";

const SHOP = "aiartstudio-gizsmzs2.myshopify.com";
const PAGE_HANDLE = "zip-hoodie-aop";
const PASSWORD = process.env.STOREFRONT_PASSWORD || "artstudio";
const THEME_ID = "190904762733"; // Savor

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

async function wrapperTop(page: Page) {
  return page.evaluate(() => {
    const w = document.querySelector(".page-wrapper");
    return w ? Math.round(w.scrollTop) : -1;
  });
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newContext({ viewport: { width: 1440, height: 900 } }).then((c) => c.newPage());
  await gotoUrl(page, `https://${SHOP}/pages/${PAGE_HANDLE}?preview_theme_id=${THEME_ID}`);
  await page.waitForSelector('iframe[title="AI Art Design Studio"]', { timeout: 30000 });
  await page.waitForTimeout(7000);

  const box = await page.locator('iframe[title="AI Art Design Studio"]').first().boundingBox();
  console.log("iframe box:", JSON.stringify(box));
  const wrapperInfo = await page.evaluate(() => {
    const w = document.querySelector(".page-wrapper");
    if (!w) return null;
    return { scrollHeight: w.scrollHeight, clientHeight: w.clientHeight, max: w.scrollHeight - w.clientHeight };
  });
  console.log("wrapper:", JSON.stringify(wrapperInfo));

  // Reset wrapper to top instantly.
  await page.evaluate(() => {
    const w = document.querySelector(".page-wrapper") as HTMLElement;
    if (w) w.scrollBy({ top: -99999, behavior: "instant" as ScrollBehavior });
  });
  await page.waitForTimeout(300);
  console.log("wrapper after reset:", await wrapperTop(page));

  // Wheel over the iframe, measure after each tick.
  if (box) {
    const cx = box.x + box.width / 2;
    const cy = Math.max(box.y + 100, 400);
    await page.mouse.move(cx, Math.min(cy, 850));
    await page.waitForTimeout(200);
    for (let i = 0; i < 3; i++) {
      await page.mouse.wheel(0, 120);
      await page.waitForTimeout(300);
      console.log(`after wheel ${i + 1} (120px):`, await wrapperTop(page));
    }
  }
  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
