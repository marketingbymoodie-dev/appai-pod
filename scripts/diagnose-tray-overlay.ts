/** Throwaway check: launcher hides while theme nav drawer is open (mobile). */
import { chromium, Page } from "playwright";

const SHOP = "aiartstudio-gizsmzs2.myshopify.com";
const PASSWORD = process.env.STOREFRONT_PASSWORD || "artstudio";
const THEMES: Record<string, string> = {
  Dawn: "190905024877",
  Tinker: "190904926573",
  Horizon: "188324249965",
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

async function launcherState(page: Page) {
  return page.evaluate(() => {
    const btn = document.getElementById("appai-tray-launcher");
    return {
      exists: !!btn,
      suppressed: btn ? btn.classList.contains("appai-suppressed") : null,
      opacity: btn ? getComputedStyle(btn).opacity : null,
    };
  });
}

/** Click the first VISIBLE menu toggle in the header. */
async function clickBurger(page: Page): Promise<boolean> {
  const candidates = await page.$$(
    'header summary, header [aria-controls][aria-expanded], ' +
    'header button[aria-label*="enu" i], [class*="header"] button[aria-label*="enu" i], ' +
    'summary[aria-label*="enu" i], button[class*="menu-toggle" i], header-drawer summary'
  );
  for (const c of candidates) {
    const box = await c.boundingBox();
    if (box && box.width > 4 && box.height > 4) {
      // JS click: some themes overlay the toggle with transparent wrappers,
      // which fails Playwright's actionability check but works for users.
      await c.evaluate((el) => (el as HTMLElement).click());
      return true;
    }
  }
  return false;
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  for (const [theme, id] of Object.entries(THEMES)) {
    const context = await browser.newContext({ viewport: { width: 390, height: 800 } });
    const page = await context.newPage();
    await gotoUrl(page, `https://${SHOP}/?preview_theme_id=${id}`);
    try {
      await page.waitForSelector("#appai-tray-launcher", { timeout: 30000, state: "attached" });
    } catch {
      console.log(`${theme}: launcher not in DOM after 30s — skipping`);
      await context.close();
      continue;
    }
    await page.waitForTimeout(1500);

    const before = await launcherState(page);

    const opened = await clickBurger(page);
    if (!opened) {
      console.log(`${theme}: no visible burger toggle found`);
      await context.close();
      continue;
    }
    await page.waitForTimeout(1000);
    const open = await launcherState(page);

    // Close: click the same toggle (toggles closed on all three themes) or
    // a close button inside the drawer, then let the rechecks settle.
    const closeBtn = await page.$(
      'dialog[open] button[aria-label*="lose" i], details[open] button[aria-label*="lose" i], ' +
      '[class*="drawer"] button[aria-label*="lose" i]'
    );
    if (closeBtn && (await closeBtn.boundingBox())) {
      await closeBtn.click();
    } else {
      await page.keyboard.press("Escape");
    }
    await page.waitForTimeout(1200);
    const closed = await launcherState(page);

    console.log(
      `${theme}: before=${JSON.stringify(before)} | menuOpen=${JSON.stringify(open)} | closed=${JSON.stringify(closed)}`
    );
    await context.close();
  }
  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
