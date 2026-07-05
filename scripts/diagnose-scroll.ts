/**
 * Diagnostic-only script (not shipped). Pinpoints WHERE wheel-over-iframe
 * scrolling dies on a given theme:
 *   A. Is the served embed JS the latest version (appaiAnimateWheelScroll)?
 *   B. Is the wheel-forward listener attached inside the iframe document?
 *   C. Do wheel events reach the iframe document at all?
 *   D. Can the parent page scroll (scrollHeight vs clientHeight, overflow)?
 *   E. Does wheel over NON-iframe page area scroll (baseline)?
 *   F. Does wheel over the iframe scroll the page?
 *
 * Usage: npx tsx scripts/diagnose-scroll.ts
 */
import { chromium, Page } from "playwright";
import fs from "fs";

const SHOP = "aiartstudio-gizsmzs2.myshopify.com";
const PAGE_HANDLE = "zip-hoodie-aop";
const PASSWORD = process.env.STOREFRONT_PASSWORD || "artstudio";

const THEMES: Record<string, string> = {
  Savor: "190904762733",
  Horizon: "188324249965",
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

async function pageScrollState(page: Page) {
  return page.evaluate(() => {
    const se = document.scrollingElement || document.documentElement;
    const cs = getComputedStyle(document.documentElement);
    const bs = getComputedStyle(document.body);
    return {
      scrollY: window.scrollY,
      seScrollTop: se.scrollTop,
      seScrollHeight: se.scrollHeight,
      seClientHeight: se.clientHeight,
      canScroll: se.scrollHeight > se.clientHeight + 1,
      htmlOverflowY: cs.overflowY,
      bodyOverflowY: bs.overflowY,
      htmlHeight: cs.height,
      bodyHeight: bs.height,
      bootOverlay: !!document.getElementById("appai-boot"),
    };
  });
}

async function diagnoseTheme(themeName: string, themeId: string) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const consoleLogs: string[] = [];
  page.on("console", (msg) => {
    const t = msg.text();
    if (/ai.?art|appai/i.test(t)) consoleLogs.push(`[${msg.type()}] ${t}`);
  });
  page.on("pageerror", (err) => consoleLogs.push(`[pageerror] ${err.message}`));

  const report: any = { theme: themeName, themeId };

  try {
    const url = `https://${SHOP}/pages/${PAGE_HANDLE}?preview_theme_id=${themeId}`;
    await gotoUrl(page, url);

    const iframeSelector = 'iframe[title="AI Design Studio"], iframe[title="AI Art Design Studio"]';
    let iframeFound = true;
    try {
      await page.waitForSelector(iframeSelector, { timeout: 30000 });
    } catch {
      iframeFound = false;
    }
    report.iframeFound = iframeFound;
    // Give BRIDGE_ACK / boot overlay removal time to settle.
    await page.waitForTimeout(6000);

    // ---- A. which embed script is loaded + is it the NEW version ----
    report.scripts = await page.evaluate(async () => {
      const srcs = Array.from(document.querySelectorAll("script[src]"))
        .map((s) => (s as HTMLScriptElement).src)
        .filter((s) => /appai|ai-art/i.test(s));
      const out: any = { srcs, versions: {} };
      for (const src of srcs) {
        if (!/appai-art-embed\.js/.test(src)) continue;
        try {
          const txt = await fetch(src).then((r) => r.text());
          out.versions[src] = {
            hasAnimator: txt.includes("appaiAnimateWheelScroll"),
            hasInstantScroll: txt.includes("appaiInstantScrollBy"),
            hasWheelForward: txt.includes("appaiAttachIframeWheelForward"),
            bytes: txt.length,
          };
        } catch (e: any) {
          out.versions[src] = { error: e?.message };
        }
      }
      return out;
    });

    // ---- D. parent page scroll capability ----
    report.parentBefore = await pageScrollState(page);

    // ---- B/C. inside the iframe ----
    const frame = page
      .frames()
      .find((f) => f.url().includes("/s/designer") || f.url().includes("/apps/appai/s/designer"));
    report.frameUrl = frame?.url();
    if (frame) {
      report.frameState = await frame.evaluate(() => {
        const w = window as any;
        return {
          parentWheelForwardFlag: w.__APPAI_PARENT_WHEEL_FORWARD__,
          wheelForwardDocAttr: document.documentElement.getAttribute("data-appai-wheel-forward-doc"),
          htmlOverflow: getComputedStyle(document.documentElement).overflowY,
          bodyOverflow: getComputedStyle(document.body).overflowY,
          scrollHeight: (document.scrollingElement || document.documentElement).scrollHeight,
          clientHeight: (document.scrollingElement || document.documentElement).clientHeight,
          embedAttr: document.documentElement.dataset.appaiEmbed,
        };
      });
      // Install wheel counters inside the frame (capture + bubble).
      await frame.evaluate(() => {
        const w = window as any;
        w.__diagWheelCount = 0;
        w.__diagWheelDefaultPrevented = 0;
        window.addEventListener(
          "wheel",
          (e) => {
            w.__diagWheelCount++;
          },
          { passive: true, capture: true },
        );
        document.addEventListener(
          "wheel",
          (e) => {
            if (e.defaultPrevented) w.__diagWheelDefaultPrevented++;
          },
          { passive: true },
        );
      });
    }

    // ---- E. baseline: wheel over a non-iframe part of the page (top strip) ----
    await page.mouse.move(720, 30);
    await page.waitForTimeout(200);
    const baseBefore = await page.evaluate(() => window.scrollY);
    for (let i = 0; i < 4; i++) {
      await page.mouse.wheel(0, 250);
      await page.waitForTimeout(80);
    }
    await page.waitForTimeout(600);
    const baseAfter = await page.evaluate(() => window.scrollY);
    report.baselineScroll = { before: baseBefore, after: baseAfter, moved: Math.abs(baseAfter - baseBefore) > 1 };
    // reset to top
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(300);

    // ---- F. wheel over the iframe ----
    if (iframeFound) {
      const box = await page.locator(iframeSelector).first().boundingBox();
      report.iframeBox = box;
      if (box) {
        const cx = box.x + box.width / 2;
        const cy = Math.min(box.y + 300, 850);
        await page.mouse.move(cx, cy);
        await page.waitForTimeout(300);
        const before = await pageScrollState(page);
        for (let i = 0; i < 6; i++) {
          await page.mouse.wheel(0, 300);
          await page.waitForTimeout(90);
        }
        await page.waitForTimeout(800);
        const after = await pageScrollState(page);
        let frameCounters: any = undefined;
        if (frame) {
          frameCounters = await frame.evaluate(() => {
            const w = window as any;
            return {
              wheelCount: w.__diagWheelCount,
              defaultPrevented: w.__diagWheelDefaultPrevented,
              frameScrollTop: (document.scrollingElement || document.documentElement).scrollTop,
            };
          });
        }
        const scrolledElements = await page.evaluate(() => {
          const out: any[] = [];
          document.querySelectorAll("body *").forEach((el) => {
            const h = el as HTMLElement;
            if (h.scrollTop > 2) {
              out.push({
                tag: h.tagName,
                id: h.id || undefined,
                cls: (h.className || "").toString().slice(0, 80) || undefined,
                scrollTop: h.scrollTop,
              });
            }
          });
          return out.slice(0, 10);
        });
        report.iframeScroll = {
          before: { scrollY: before.scrollY, seScrollTop: before.seScrollTop },
          after: { scrollY: after.scrollY, seScrollTop: after.seScrollTop },
          pageMoved: Math.abs(after.scrollY - before.scrollY) > 1 || Math.abs(after.seScrollTop - before.seScrollTop) > 1,
          frameCounters,
          scrolledElements,
        };
      }
    }
    report.parentAfter = await pageScrollState(page);
  } catch (e: any) {
    report.error = e?.message || String(e);
  }

  report.consoleLogs = consoleLogs.slice(-40);
  await browser.close();
  return report;
}

async function main() {
  const results: any[] = [];
  for (const [name, id] of Object.entries(THEMES)) {
    console.log(`Diagnosing ${name} (theme_id=${id})...`);
    results.push(await diagnoseTheme(name, id));
  }
  fs.writeFileSync("scripts/diagnose-scroll-report.json", JSON.stringify(results, null, 2));
  for (const r of results) {
    console.log(`\n=== ${r.theme} ===`);
    if (r.error) console.log("ERROR:", r.error);
    console.log("iframeFound:", r.iframeFound, "frameUrl:", r.frameUrl);
    console.log("scripts:", JSON.stringify(r.scripts?.versions));
    console.log("parent canScroll:", r.parentBefore?.canScroll, "scrollHeight:", r.parentBefore?.seScrollHeight, "clientHeight:", r.parentBefore?.seClientHeight, "boot:", r.parentBefore?.bootOverlay);
    console.log("frameState:", JSON.stringify(r.frameState));
    console.log("baselineScroll:", JSON.stringify(r.baselineScroll));
    console.log("iframeScroll.pageMoved:", r.iframeScroll?.pageMoved, "frameCounters:", JSON.stringify(r.iframeScroll?.frameCounters));
    console.log("scrolledElements:", JSON.stringify(r.iframeScroll?.scrolledElements));
    console.log("console:", JSON.stringify(r.consoleLogs?.slice(-8)));
  }
  console.log("\nFull report: scripts/diagnose-scroll-report.json");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
