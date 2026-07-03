/**
 * Deep scroll-write instrumentation (diagnostic-only, not shipped).
 * On Savor + Horizon: wheel events reach our handler (defaultPrevented) but the
 * page does not move. Instrument Element.prototype.scrollTop writes, window
 * rAF, and window.scrollBy in the PARENT to see what our code actually does,
 * then try direct writes to find what blocks them.
 */
import { chromium, Page } from "playwright";
import fs from "fs";

const SHOP = "aiartstudio-gizsmzs2.myshopify.com";
const PAGE_HANDLE = "zip-hoodie-aop";
const PASSWORD = process.env.STOREFRONT_PASSWORD || "artstudio";

const THEMES: Record<string, string> = {
  Savor: "190904762733",
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

async function diagnoseTheme(themeName: string, themeId: string) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const report: any = { theme: themeName, themeId };
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  try {
    await gotoUrl(page, `https://${SHOP}/pages/${PAGE_HANDLE}?preview_theme_id=${themeId}`);
    const iframeSelector = 'iframe[title="AI Art Design Studio"]';
    await page.waitForSelector(iframeSelector, { timeout: 30000 });
    await page.waitForTimeout(6000);

    // ---- Instrument parent: scrollTop writes, scrollBy calls, rAF count ----
    await page.evaluate(() => {
      const w = window as any;
      w.__diag = { scrollWrites: [], scrollByCalls: [], rafCount: 0 };
      const desc = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop")!;
      Object.defineProperty(Element.prototype, "scrollTop", {
        configurable: true,
        get: desc.get,
        set(v: number) {
          w.__diag.scrollWrites.push({
            tag: (this as Element).tagName,
            cls: String((this as HTMLElement).className || "").slice(0, 50),
            v: Math.round(v),
            actualAfter: -1,
          });
          desc.set!.call(this, v);
          w.__diag.scrollWrites[w.__diag.scrollWrites.length - 1].actualAfter = Math.round(
            desc.get!.call(this) as number,
          );
        },
      });
      const origScrollBy = window.scrollBy.bind(window);
      (window as any).scrollBy = function (...args: any[]) {
        w.__diag.scrollByCalls.push(JSON.stringify(args).slice(0, 80));
        return origScrollBy(...(args as [any]));
      };
      const origRaf = window.requestAnimationFrame.bind(window);
      (window as any).requestAnimationFrame = function (cb: FrameRequestCallback) {
        w.__diag.rafCount++;
        return origRaf(cb);
      };
    });

    // ---- Parent env facts ----
    report.env = await page.evaluate(() => {
      const html = document.documentElement;
      const body = document.body;
      const hcs = getComputedStyle(html);
      const bcs = getComputedStyle(body);
      const iframe = document.querySelector('iframe[title="AI Art Design Studio"]');
      const chain: any[] = [];
      let node: Element | null = iframe ? iframe.parentElement : null;
      let depth = 0;
      while (node && depth < 20) {
        const cs = getComputedStyle(node);
        chain.push({
          tag: node.tagName,
          id: (node as HTMLElement).id || undefined,
          cls: String((node as HTMLElement).className || "").slice(0, 60),
          overflowY: cs.overflowY,
          scrollHeight: node.scrollHeight,
          clientHeight: node.clientHeight,
          scrollable:
            (cs.overflowY === "auto" || cs.overflowY === "scroll" || cs.overflowY === "overlay") &&
            node.scrollHeight > node.clientHeight + 1,
        });
        node = node.parentElement;
        depth++;
      }
      return {
        html: {
          overflowY: hcs.overflowY,
          scrollBehavior: hcs.scrollBehavior,
          scrollSnapType: hcs.scrollSnapType,
          height: hcs.height,
        },
        body: { overflowY: bcs.overflowY, scrollBehavior: bcs.scrollBehavior, height: bcs.height },
        se: {
          tag: (document.scrollingElement || html).tagName,
          scrollHeight: (document.scrollingElement || html).scrollHeight,
          clientHeight: (document.scrollingElement || html).clientHeight,
        },
        iframeAncestors: chain,
      };
    });

    // ---- Wheel over iframe ----
    const box = await page.locator(iframeSelector).first().boundingBox();
    if (box) {
      await page.mouse.move(box.x + box.width / 2, Math.min(box.y + 300, 850));
      await page.waitForTimeout(200);
      for (let i = 0; i < 5; i++) {
        await page.mouse.wheel(0, 300);
        await page.waitForTimeout(100);
      }
      await page.waitForTimeout(900);
    }
    report.afterWheel = await page.evaluate(() => {
      const w = window as any;
      return {
        diag: {
          scrollWrites: w.__diag.scrollWrites.slice(0, 30),
          scrollByCalls: w.__diag.scrollByCalls.slice(0, 10),
          rafCount: w.__diag.rafCount,
        },
        scrollY: window.scrollY,
        seScrollTop: (document.scrollingElement || document.documentElement).scrollTop,
      };
    });

    // ---- Direct write test: can the parent scroller be moved by JS at all? ----
    report.directWrite = await page.evaluate(async () => {
      const se = (document.scrollingElement || document.documentElement) as HTMLElement;
      const before = se.scrollTop;
      se.scrollTop = before + 250;
      const immediately = se.scrollTop;
      await new Promise((r) => setTimeout(r, 400));
      const settled = se.scrollTop;
      // also try window.scrollTo
      window.scrollTo(0, 500);
      await new Promise((r) => setTimeout(r, 400));
      const afterScrollTo = se.scrollTop;
      return { before, immediately, settled, afterScrollTo, windowScrollY: window.scrollY };
    });
  } catch (e: any) {
    report.error = e?.message || String(e);
  }
  report.pageErrors = pageErrors.slice(-10);
  await browser.close();
  return report;
}

async function main() {
  const results: any[] = [];
  for (const [name, id] of Object.entries(THEMES)) {
    console.log(`Deep-diagnosing ${name}...`);
    results.push(await diagnoseTheme(name, id));
  }
  fs.writeFileSync("scripts/diagnose-scroll2-report.json", JSON.stringify(results, null, 2));
  for (const r of results) {
    console.log(`\n=== ${r.theme} ===`);
    if (r.error) console.log("ERROR:", r.error);
    console.log("html:", JSON.stringify(r.env?.html), "body:", JSON.stringify(r.env?.body));
    console.log("se:", JSON.stringify(r.env?.se));
    console.log("iframe ancestor scrollers:", JSON.stringify(r.env?.iframeAncestors?.filter((a: any) => a.scrollable)));
    console.log("afterWheel scrollY:", r.afterWheel?.scrollY, "seScrollTop:", r.afterWheel?.seScrollTop);
    console.log("scrollWrites:", JSON.stringify(r.afterWheel?.diag?.scrollWrites));
    console.log("scrollByCalls:", JSON.stringify(r.afterWheel?.diag?.scrollByCalls), "rafCount:", r.afterWheel?.diag?.rafCount);
    console.log("directWrite:", JSON.stringify(r.directWrite));
    console.log("pageErrors:", JSON.stringify(r.pageErrors));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
