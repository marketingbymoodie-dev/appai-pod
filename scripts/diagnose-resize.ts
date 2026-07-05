/**
 * LOCKDOWN TEST — live scroll-mode switching (see
 * docs/iframe-scroll-architecture.md). Verifies that resizing the viewport
 * AFTER mount (no reload) — mirroring Shopify theme-editor's mobile-preview
 * toggle — converts the iframe to internal mobile scrolling live, instead of
 * leaving the desktop wheel hijack attached while the iframe can't scroll.
 *
 * Scenario A: fresh 390px load (mouse only, no touch flags) — expect PASS.
 * Scenario B: load at 1280px, then resize to 390px WITHOUT reload — expect
 *             PASS (this was the reported bug: hijack stayed attached,
 *             iframe stuck, before the live-mode-switching fix).
 *
 * Runs across Tinker, Savor, and Dawn per the lockdown doc's required themes.
 *
 * Usage: npx tsx scripts/diagnose-resize.ts
 */
import { chromium, Page } from "playwright";

const SHOP = "aiartstudio-gizsmzs2.myshopify.com";
const PAGE_HANDLE = "zip-hoodie-aop";
const PASSWORD = process.env.STOREFRONT_PASSWORD || "artstudio";
const THEMES: Record<string, string> = {
  Tinker: "190904926573",
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

async function checkScrollState(page: Page, label: string) {
  const iframeSelector = 'iframe[title="AI Art Design Studio"]';
  await page.waitForSelector(iframeSelector, { timeout: 30000 });
  await page.waitForTimeout(6000);

  const frame = page
    .frames()
    .find((f) => f.url().includes("/s/designer") || f.url().includes("/apps/appai/s/designer"));
  if (!frame) return { label, error: "designer frame not found" };

  const frameState = await frame.evaluate(() => ({
    hijackAttached: document.documentElement.getAttribute("data-appai-wheel-forward-doc") === "1",
    mobileNativeAttr: document.documentElement.dataset.appaiMobileNativeScroll,
    htmlOverflow: getComputedStyle(document.documentElement).overflowY,
    scrollHeight: (document.scrollingElement || document.documentElement).scrollHeight,
    clientHeight: (document.scrollingElement || document.documentElement).clientHeight,
  }));

  const box = await page.locator(iframeSelector).first().boundingBox();
  if (!box) return { label, error: "no iframe box", frameState };

  const vh = page.viewportSize()!.height;
  await page.mouse.move(box.x + box.width / 2, Math.min(box.y + 200, vh - 20));
  await page.waitForTimeout(200);
  for (let i = 0; i < 5; i++) {
    await page.mouse.wheel(0, 200);
    await page.waitForTimeout(120);
  }
  await page.waitForTimeout(600);

  const frameScrollTop = await frame.evaluate(
    () => (document.scrollingElement || document.documentElement).scrollTop,
  );
  const parentScrollY = await page.evaluate(() => window.scrollY);

  return {
    label,
    frameState,
    frameScrollTop,
    parentScrollY,
    iframeScrolledInternally: frameScrollTop > 5,
  };
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  let allPassed = true;

  for (const [theme, themeId] of Object.entries(THEMES)) {
    const url = `https://${SHOP}/pages/${PAGE_HANDLE}?preview_theme_id=${themeId}`;
    console.log(`\n=== ${theme} ===`);

    // Scenario A: fresh narrow load.
    {
      const context = await browser.newContext({ viewport: { width: 390, height: 800 } });
      const page = await context.newPage();
      await gotoUrl(page, url);
      const result = await checkScrollState(page, `${theme} A: fresh 390px load`);
      console.log(JSON.stringify(result, null, 2));
      if (!result.iframeScrolledInternally) allPassed = false;
      await context.close();
    }

    // Scenario B: desktop load, then resize to narrow WITHOUT reload.
    {
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      const page = await context.newPage();
      await gotoUrl(page, url);
      await page.waitForSelector('iframe[title="AI Art Design Studio"]', { timeout: 30000 });
      await page.waitForTimeout(6000);
      await page.setViewportSize({ width: 390, height: 800 });
      await page.waitForTimeout(1500); // let any resize listeners react
      const result = await checkScrollState(page, `${theme} B: desktop->narrow resize (no reload)`);
      console.log(JSON.stringify(result, null, 2));
      if (!result.iframeScrolledInternally) allPassed = false;
      await context.close();
    }
  }

  await browser.close();
  if (!allPassed) {
    console.error("\nFAIL: one or more scenarios did not scroll the iframe internally.");
    process.exit(1);
  }
  console.log("\nPASS: all themes/scenarios scrolled the iframe internally as expected.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
