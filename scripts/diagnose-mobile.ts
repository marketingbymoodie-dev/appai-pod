/**
 * Mobile-mode verification (diagnostic-only, not shipped).
 * Emulates a narrow, touch-capable viewport (matches Shopify's mobile preview
 * conditions: max-width 767 → mobileNativeScroll mode) and verifies:
 *   1. The wheel-forward hijack is NOT attached inside the iframe document.
 *   2. Wheel over the iframe scrolls the IFRAME's own content (lower sections
 *      reachable), not just the parent store page.
 */
import { chromium, Page } from "playwright";

const SHOP = "aiartstudio-gizsmzs2.myshopify.com";
const PAGE_HANDLE = "zip-hoodie-aop";
const PASSWORD = process.env.STOREFRONT_PASSWORD || "artstudio";

const THEMES: Record<string, string> = {
  Savor: "190904762733",
  Dawn: "190905024877",
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

async function run(themeName: string, themeId: string) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 390, height: 800 },
    hasTouch: true,
    isMobile: true,
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  });
  const page = await context.newPage();
  const out: any = { theme: themeName };
  try {
    await gotoUrl(page, `https://${SHOP}/pages/${PAGE_HANDLE}?preview_theme_id=${themeId}`);
    await page.waitForSelector('iframe[title="AI Art Design Studio"]', { timeout: 30000 });
    await page.waitForTimeout(7000);

    const frame = page
      .frames()
      .find((f) => f.url().includes("/s/designer") || f.url().includes("/apps/appai/s/designer"));
    if (!frame) throw new Error("designer frame not found");

    out.frameState = await frame.evaluate(() => ({
      hijackAttached: document.documentElement.getAttribute("data-appai-wheel-forward-doc") === "1",
      mobileNativeAttr: document.documentElement.dataset.appaiMobileNativeScroll,
      htmlOverflow: getComputedStyle(document.documentElement).overflowY,
      scrollHeight: (document.scrollingElement || document.documentElement).scrollHeight,
      clientHeight: (document.scrollingElement || document.documentElement).clientHeight,
      scrollTop: (document.scrollingElement || document.documentElement).scrollTop,
    }));

    // Wheel over the iframe → the IFRAME content should scroll internally.
    const box = await page.locator('iframe[title="AI Art Design Studio"]').first().boundingBox();
    out.iframeBox = box;
    if (box) {
      await page.mouse.move(box.x + box.width / 2, Math.min(box.y + 200, 780));
      await page.waitForTimeout(200);
      for (let i = 0; i < 5; i++) {
        await page.mouse.wheel(0, 200);
        await page.waitForTimeout(120);
      }
      await page.waitForTimeout(600);
    }
    out.afterWheel = await frame.evaluate(() => ({
      frameScrollTop: (document.scrollingElement || document.documentElement).scrollTop,
    }));
    out.parentScrollY = await page.evaluate(() => window.scrollY);
    out.iframeScrolledInternally = out.afterWheel.frameScrollTop > 5;
  } catch (e: any) {
    out.error = e?.message || String(e);
  }
  await browser.close();
  return out;
}

async function main() {
  for (const [name, id] of Object.entries(THEMES)) {
    console.log(`Mobile-verifying ${name}...`);
    const r = await run(name, id);
    console.log(JSON.stringify(r, null, 2));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
