/**
 * Diagnostic-only script (not shipped). Uses Playwright to gather hard evidence
 * from the real dev store, on all failing themes, for two bugs:
 *   1. Iframe wheel scroll not moving the parent page.
 *   2. "Customizer" nav dropdown not opening when the mouse approaches from below.
 *
 * Uses ?preview_theme_id=<id> so the STORE'S LIVE THEME IS NEVER CHANGED.
 *
 * Usage: STOREFRONT_PASSWORD=xxxx npx tsx scripts/diagnose-storefront.ts
 */
import { chromium, Page } from "playwright";
import fs from "fs";

const SHOP = "aiartstudio-gizsmzs2.myshopify.com";
const PAGE_HANDLE = "zip-hoodie-aop";
const PASSWORD = process.env.STOREFRONT_PASSWORD || "artstudio";

const THEMES: Record<string, string> = {
  Horizon: "188324249965",
  Savor: "190904762733",
  Tinker: "190904926573",
  Dawn: "190905024877",
};

// Mirrors findCustomizerDropdownContainers()/findBestContainer() in
// extensions/theme-extension/assets/appai-saved-designs-nav.js so the probe
// inspects the exact element the app would target, and tags it for later steps.
const LOCATE_TARGET_JS = `
(function () {
  function findBestContainer(ancestor, pageLinks) {
    var firstLink = pageLinks[0];
    var linkParent = firstLink.parentElement;
    var tag = linkParent ? linkParent.tagName.toLowerCase() : '';
    if (tag === 'ul' || tag === 'div' || tag === 'nav') return linkParent;
    if (tag === 'li') {
      var liParent = linkParent.parentElement;
      if (liParent) {
        var lpt = liParent.tagName.toLowerCase();
        if (lpt === 'ul' || lpt === 'div' || lpt === 'nav') return liParent;
      }
    }
    var uls = ancestor.querySelectorAll('ul');
    for (var i = 0; i < uls.length; i++) {
      if (uls[i].querySelector('a[href*="/pages/"]')) return uls[i];
    }
    return ancestor;
  }
  function isInFooter(el) {
    var node = el;
    while (node && node !== document.body) {
      var tagname = node.tagName ? node.tagName.toLowerCase() : '';
      var cls = (node.className || '').toString().toLowerCase();
      if (tagname === 'footer' || cls.indexOf('footer') !== -1) return true;
      node = node.parentElement;
    }
    return false;
  }
  document.querySelectorAll('[data-appai-diag-trigger],[data-appai-diag-container]').forEach(function(el){
    el.removeAttribute('data-appai-diag-trigger');
    el.removeAttribute('data-appai-diag-container');
  });
  var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
  var node, trigger = null, container = null;
  var allMatches = [];
  while ((node = walker.nextNode())) {
    if (node.nodeValue && node.nodeValue.trim() === 'Customizer') {
      var candidate = node.parentElement;
      var rect = candidate.getBoundingClientRect();
      allMatches.push({ visible: rect.width > 0 && rect.height > 0, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } });
      if (isInFooter(candidate)) continue;
      if (rect.width === 0 || rect.height === 0) continue; // prefer a VISIBLE trigger
      var el = candidate, depth = 0;
      while (el && el !== document.body && depth < 8) {
        var pageLinks = el.querySelectorAll('a[href*="/pages/"]');
        if (pageLinks.length > 0) {
          container = findBestContainer(el, pageLinks);
          trigger = candidate;
          break;
        }
        el = el.parentElement;
        depth++;
      }
      if (trigger) break;
    }
  }
  if (!trigger || !container) return { allMatches: allMatches };
  trigger.setAttribute('data-appai-diag-trigger', '1');
  container.setAttribute('data-appai-diag-container', '1');
  var tr = trigger.getBoundingClientRect();
  return { allMatches: allMatches, triggerRect: { x: tr.x, y: tr.y, width: tr.width, height: tr.height } };
})()
`;

async function unlockStorefront(page: Page) {
  await page.goto(`https://${SHOP}/`, { waitUntil: "domcontentloaded" });
  if (page.url().includes("/password")) {
    await page.fill('input[name="password"]', PASSWORD);
    await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded" }).catch(() => {}),
      page.click('button[type="submit"], input[type="submit"]'),
    ]);
  }
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

function containerState(page: Page) {
  return page.evaluate(() => {
    const el = document.querySelector('[data-appai-diag-container="1"]') as HTMLElement | null;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return {
      visible:
        rect.width > 0 &&
        rect.height > 0 &&
        cs.visibility !== "hidden" &&
        cs.display !== "none" &&
        parseFloat(cs.opacity || "1") > 0.05,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      display: cs.display,
      visibility: cs.visibility,
      opacity: cs.opacity,
      maxHeight: cs.maxHeight,
    };
  });
}

async function sampleElementAt(page: Page, x: number, y: number) {
  return page.evaluate(
    ([px, py]) => {
      const el = document.elementFromPoint(px as number, py as number);
      if (!el) return null;
      const cs = getComputedStyle(el);
      return {
        tag: el.tagName,
        id: (el as HTMLElement).id || undefined,
        cls: ((el as HTMLElement).className || "").toString().slice(0, 100) || undefined,
        isTrigger: el.hasAttribute("data-appai-diag-trigger") || !!el.closest('[data-appai-diag-trigger="1"]'),
        isContainer: el.hasAttribute("data-appai-diag-container") || !!el.closest('[data-appai-diag-container="1"]'),
        pointerEvents: cs.pointerEvents,
        zIndex: cs.zIndex,
        position: cs.position,
      };
    },
    [x, y],
  );
}

async function approachAndSample(page: Page, fromX: number, fromY: number, toX: number, toY: number, steps: number) {
  await page.mouse.move(fromX, fromY);
  await page.waitForTimeout(200);
  const samples: any[] = [];
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const x = fromX + (toX - fromX) * t;
    const y = fromY + (toY - fromY) * t;
    await page.mouse.move(x, y, { steps: 3 });
    await page.waitForTimeout(60);
    const el = await sampleElementAt(page, x, y);
    samples.push({ x: Math.round(x), y: Math.round(y), el });
  }
  await page.waitForTimeout(350);
  return samples;
}

async function hoverProbe(page: Page) {
  const located = await page.evaluate(LOCATE_TARGET_JS);
  if (!located || !(located as any).triggerRect) {
    return { error: "Could not locate a visible Customizer trigger/container", allMatches: (located as any)?.allMatches };
  }
  const rect = (located as any).triggerRect;
  const targetX = rect.x + rect.width / 2;
  const targetY = rect.y + rect.height / 2;
  const viewport = page.viewportSize()!;

  await page.mouse.move(5, 5);
  await page.waitForTimeout(300);
  const closedState = await containerState(page);

  const aboveSamples = await approachAndSample(page, targetX, Math.max(2, targetY - 250), targetX, targetY, 10);
  const aboveOpenState = await containerState(page);
  await page.mouse.move(5, 5);
  await page.waitForTimeout(400);

  const belowY = Math.min(viewport.height - 5, targetY + 350);
  const belowSamples = await approachAndSample(page, targetX, belowY, targetX, targetY, 10);
  const belowOpenState = await containerState(page);
  await page.mouse.move(5, 5);
  await page.waitForTimeout(300);

  return {
    triggerRect: rect,
    closedState,
    fromAbove: { samples: aboveSamples, openState: aboveOpenState },
    fromBelow: { samples: belowSamples, openState: belowOpenState },
  };
}

async function diagnoseTheme(themeName: string, themeId: string) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const consoleLogs: string[] = [];
  page.on("console", (msg) => {
    const text = msg.text();
    if (/ai.?art|appai/i.test(text)) consoleLogs.push(`[${msg.type()}] ${text}`);
  });
  page.on("pageerror", (err) => consoleLogs.push(`[pageerror] ${err.message}`));

  const report: any = { theme: themeName, themeId };

  try {
    await unlockStorefront(page);

    // ---- BASELINE: hover behavior on the theme's HOME PAGE (no app iframe/scripts
    // beyond the harmless nav-injection script) — isolates whether the hover
    // direction bug is theme-native or caused by our app. ----
    await gotoUrl(page, `https://${SHOP}/?preview_theme_id=${themeId}`);
    await page.waitForTimeout(1500);
    report.homepageHover = await hoverProbe(page);

    // ---- CUSTOMIZER PAGE ----
    const url = `https://${SHOP}/pages/${PAGE_HANDLE}?preview_theme_id=${themeId}`;
    await gotoUrl(page, url);

    const iframeSelector = 'iframe[title="AI Art Design Studio"]';
    let iframeFound = true;
    try {
      await page.waitForSelector(iframeSelector, { timeout: 25000 });
    } catch {
      iframeFound = false;
    }
    report.iframeFound = iframeFound;

    // ---------------- SCROLL PROBE ----------------
    if (iframeFound) {
      const box = await page.locator(iframeSelector).boundingBox();
      report.iframeBox = box;
      if (box) {
        const cx = box.x + box.width / 2;
        const cy = box.y + Math.min(box.height / 2, 350);
        await page.mouse.move(cx, cy);
        await page.waitForTimeout(600);

        const before = await page.evaluate(() => ({
          winScrollY: window.scrollY,
          docScrollTop: (document.scrollingElement || document.documentElement).scrollTop,
        }));

        for (let i = 0; i < 6; i++) {
          await page.mouse.wheel(0, 300);
          await page.waitForTimeout(90);
        }
        await page.waitForTimeout(400);

        const after = await page.evaluate(() => ({
          winScrollY: window.scrollY,
          docScrollTop: (document.scrollingElement || document.documentElement).scrollTop,
        }));

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
                overflowY: getComputedStyle(h).overflowY,
              });
            }
          });
          return out.slice(0, 15);
        });

        let iframeWheelForwardFlag: any = undefined;
        try {
          const frame = page
            .frames()
            .find((f) => f.url().includes("/s/designer") || f.url().includes("/apps/appai/s/designer"));
          if (frame) {
            iframeWheelForwardFlag = await frame.evaluate(() => (window as any).__APPAI_PARENT_WHEEL_FORWARD__);
          }
        } catch {}

        report.scroll = {
          before,
          after,
          pageMoved:
            Math.abs(after.winScrollY - before.winScrollY) > 1 || Math.abs(after.docScrollTop - before.docScrollTop) > 1,
          scrolledElements,
          iframeWheelForwardFlag,
        };
      }
    }

    // ---------------- HOVER PROBE (customizer page) ----------------
    report.customizerHover = await hoverProbe(page);
  } catch (e: any) {
    report.error = e?.message || String(e);
  }

  report.consoleLogs = consoleLogs.slice(-60);
  await browser.close();
  return report;
}

async function main() {
  const results: any[] = [];
  for (const [name, id] of Object.entries(THEMES)) {
    console.log(`Diagnosing ${name} (theme_id=${id})...`);
    const r = await diagnoseTheme(name, id);
    results.push(r);
  }
  const outPath = "scripts/diagnose-storefront-report.json";
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log(`\nFull report written to ${outPath}`);

  for (const r of results) {
    console.log(`\n=== ${r.theme} ===`);
    if (r.error) console.log("ERROR:", r.error);
    console.log("iframeFound:", r.iframeFound);
    if (r.scroll) {
      console.log("scroll.pageMoved:", r.scroll.pageMoved, "iframeWheelForwardFlag:", r.scroll.iframeWheelForwardFlag);
      console.log("scroll.scrolledElements:", JSON.stringify(r.scroll.scrolledElements));
    }
    console.log(
      "homepageHover: closed=",
      r.homepageHover?.closedState?.visible,
      "fromAbove=",
      r.homepageHover?.fromAbove?.openState?.visible,
      "fromBelow=",
      r.homepageHover?.fromBelow?.openState?.visible,
      r.homepageHover?.error || "",
    );
    console.log(
      "customizerHover: closed=",
      r.customizerHover?.closedState?.visible,
      "fromAbove=",
      r.customizerHover?.fromAbove?.openState?.visible,
      "fromBelow=",
      r.customizerHover?.fromBelow?.openState?.visible,
      r.customizerHover?.error || "",
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
