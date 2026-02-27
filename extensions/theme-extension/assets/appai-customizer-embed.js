/**
 * AppAI Customizer Embed
 * ─────────────────────────────────────────────────────────────────────────
 * Injected sitewide via the App Embed (ai-art-embed.liquid).
 *
 * HOW IT WORKS:
 *  1. On every page, reads the current URL pathname.
 *  2. If the path is /pages/<handle>, fetches the active customizer pages
 *     from the App Proxy at /apps/appai/customizer-pages (cached 5 min).
 *  3. If the current handle is in the list but DISABLED, redirects to the
 *     shop's fallback URL (configurable in app admin).
 *  4. If a match is found with status=active, hides the theme's generic page
 *     content and renders a self-contained customizer UI.
 *  5. All API calls go through the App Proxy (/apps/appai/…) — no
 *     hardcoded Railway domains, no CORS issues.
 *
 * ADD-TO-CART FLOW (native Shopify product, ensures correct cart thumbnail):
 *  1. User enters a prompt and clicks "Generate Design".
 *  2. Design generates asynchronously; UI polls until READY.
 *  3. User previews mockups and clicks "Create product & add to cart".
 *  4. Calls POST /apps/appai/publish-design to create a dedicated Shopify
 *     product with the mockup images as native product images.
 *  5. Adds the returned shopifyVariantId to cart via /cart/add.js.
 *  6. Cart/checkout thumbnail is a real product image — no hacks needed.
 *
 * CUSTOMER KEY:
 *  The customerKey is a stable identifier per browser session, used to
 *  enforce the 20-design limit server-side. Prefers a logged-in Shopify
 *  customer ID; falls back to a UUID stored in localStorage.
 */
;(function () {
  'use strict';

  if (window.__APPAI_CUSTOMIZER_EMBED__) return;
  window.__APPAI_CUSTOMIZER_EMBED__ = true;

  var PROXY = '/apps/appai';
  var CACHE_KEY = 'appai_cpages_v2';  // v2: now includes fallbackUrl
  var CACHE_TTL = 5 * 60 * 1000;     // 5 minutes

  // ── Utilities ──────────────────────────────────────────────────────────────

  function esc(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function uid() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
  }

  function injectCSS(css) {
    var s = document.createElement('style');
    s.textContent = css;
    document.head.appendChild(s);
  }

  function toast(msg, type) {
    type = type || 'info';
    var colours = {
      error:   'background:#fee2e2;color:#991b1b;border:1px solid #fca5a5;',
      success: 'background:#d1fae5;color:#065f46;border:1px solid #6ee7b7;',
      info:    'background:#eff6ff;color:#1e40af;border:1px solid #93c5fd;',
    };
    var el = document.createElement('div');
    el.setAttribute('style',
      'position:fixed;top:20px;right:20px;z-index:999999;padding:12px 20px;' +
      'border-radius:8px;font-family:system-ui,sans-serif;font-size:14px;' +
      'line-height:1.4;max-width:320px;box-shadow:0 4px 16px rgba(0,0,0,0.15);' +
      'transition:opacity 0.3s;' + (colours[type] || colours.info)
    );
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(function () {
      el.style.opacity = '0';
      setTimeout(function () { el.parentNode && el.parentNode.removeChild(el); }, 300);
    }, 4000);
  }

  /** Returns a stable customer key: Shopify customer ID if logged in, else localStorage UUID. */
  function getCustomerKey() {
    try {
      var shopifyId = window.ShopifyAnalytics &&
        window.ShopifyAnalytics.meta &&
        window.ShopifyAnalytics.meta.page &&
        window.ShopifyAnalytics.meta.page.customerId;
      if (shopifyId) return 'shopify:' + shopifyId;
    } catch (_) {}
    try {
      var stored = localStorage.getItem('appai_uid');
      if (stored) return stored;
      var fresh = uid();
      localStorage.setItem('appai_uid', fresh);
      return fresh;
    } catch (_) {}
    return uid(); // ephemeral fallback (won't persist)
  }

  // ── Page detection ─────────────────────────────────────────────────────────

  function getCurrentHandle() {
    var m = window.location.pathname.match(/^\/pages\/([^/?#]+)/);
    return m ? m[1] : null;
  }

  // ── Proxy fetch helpers ────────────────────────────────────────────────────

  function proxyFetch(path, options) {
    return fetch(PROXY + path, Object.assign({ credentials: 'same-origin' }, options || {}));
  }

  async function getCustomizerConfig() {
    // Returns { pages: [...], fallbackUrl: string }
    try {
      var cached = sessionStorage.getItem(CACHE_KEY);
      if (cached) {
        var c = JSON.parse(cached);
        if (Date.now() - c.ts < CACHE_TTL) return c.data;
      }
    } catch (_) {}
    try {
      var res = await proxyFetch('/customizer-pages');
      if (!res.ok) return { pages: [], fallbackUrl: '/' };
      var data = await res.json();
      var result = { pages: data.pages || [], fallbackUrl: data.fallbackUrl || '/' };
      try { sessionStorage.setItem(CACHE_KEY, JSON.stringify({ data: result, ts: Date.now() })); } catch (_) {}
      return result;
    } catch (e) {
      console.warn('[AppAI Embed] Could not fetch customizer config:', e);
      return { pages: [], fallbackUrl: '/' };
    }
  }

  // ── DOM helpers ────────────────────────────────────────────────────────────

  function hideThemePageContent() {
    var selectors = [
      '#MainContent > .page-width', 'main .page', 'main article',
      '.page__content', '.shopify-section--rich-text',
    ];
    selectors.forEach(function (sel) {
      document.querySelectorAll(sel).forEach(function (el) { el.style.display = 'none'; });
    });
    var t = document.querySelector('h1.page-title, h1.title, .page__title');
    if (t) t.style.display = 'none';
  }

  function findMainContent() {
    return (
      document.querySelector('#MainContent') ||
      document.querySelector('main[role="main"]') ||
      document.querySelector('main') ||
      document.querySelector('[role="main"]') ||
      document.body
    );
  }

  // ── State ──────────────────────────────────────────────────────────────────

  var S = {
    page: null,

    // Generation
    prompt: '',
    stylePreset: 'vibrant',
    generating: false,
    designId: null,
    pollTimer: null,
    pollCount: 0,
    design: null,       // { designId, status, artworkUrl, mockupUrl, mockupUrls, errorMessage }
    activeCarouselIdx: 0,

    // Publish + cart
    publishing: false,   // currently running publish-design + cart-add
    publishStep: '',     // label for the button while busy
    published: null,     // { shopifyVariantId, shopifyProductHandle, reused }
    addedToCart: false,

    // Save/resume
    saved: false,

    // Errors
    error: null,
    publishError: null,  // separate so user can retry publish without re-generating
  };

  var ROOT = null;

  // ── Render ────────────────────────────────────────────────────────────────

  function render() {
    if (!ROOT) return;
    ROOT.innerHTML = buildHTML();
    bindEvents();
  }

  function buildHTML() {
    var p = S.page;
    var priceStr = p.baseProductPrice ? '$' + parseFloat(p.baseProductPrice).toFixed(2) : '';
    var titleStr = [p.baseProductTitle, p.baseVariantTitle].filter(Boolean).join(' — ');

    var html = '<div class="appai-card">';

    // Header
    html += '<div class="appai-header">';
    html += '<h1 class="appai-title">' + esc(p.title || 'Create Your Custom Design') + '</h1>';
    html += '<p class="appai-subtitle">' + esc(titleStr) +
      (priceStr ? ' &middot; <strong>' + esc(priceStr) + '</strong>' : '') + '</p>';
    html += '</div>';

    // Error banners
    if (S.error) {
      html += '<div class="appai-error">' + esc(S.error) + '</div>';
    }
    if (S.publishError) {
      html += '<div class="appai-error appai-publish-error">' +
        esc(S.publishError) +
        ' <button class="appai-retry-btn">Retry</button>' +
        '</div>';
    }

    // Preview (when design is READY)
    if (S.design && S.design.status === 'READY') {
      html += buildPreviewHTML();
    }

    // Generator form (before/while generating, or after a "try another")
    if (!S.design || S.design.status !== 'READY') {
      html += buildFormHTML();
    }

    // Actions (after READY)
    if (S.design && S.design.status === 'READY') {
      html += buildActionsHTML();
    }

    html += '</div>';
    return html;
  }

  function buildFormHTML() {
    var dis = S.generating ? ' disabled' : '';
    var html = '<div class="appai-section">';
    html += '<label class="appai-label" for="appai-prompt">Describe your design</label>';
    html += '<textarea' + dis + ' id="appai-prompt" class="appai-textarea" ' +
      'placeholder="e.g. A mountain sunset in watercolor style…">' + esc(S.prompt) + '</textarea>';

    html += '<div class="appai-style-row"><span class="appai-label">Style</span>';
    ['vibrant', 'minimal', 'watercolor', 'realistic', 'abstract'].forEach(function (st) {
      var act = S.stylePreset === st ? ' appai-style-active' : '';
      html += '<button' + dis + ' class="appai-style-btn' + act + '" data-style="' + st + '">' + st + '</button>';
    });
    html += '</div>';

    if (S.generating) {
      html += '<div class="appai-progress">' +
        '<div class="appai-spinner"></div>' +
        '<span>Generating your design… (' + Math.min(S.pollCount * 3, 90) + 's)</span>' +
        '</div>';
    } else {
      html += '<button id="appai-generate-btn" class="appai-btn-primary"' +
        (S.prompt.trim() ? '' : ' disabled') + '>Generate Design</button>';
    }
    html += '</div>';
    return html;
  }

  function buildPreviewHTML() {
    var urls = (S.design.mockupUrls && S.design.mockupUrls.length)
      ? S.design.mockupUrls
      : (S.design.mockupUrl ? [S.design.mockupUrl] : []);
    var idx = S.activeCarouselIdx;

    var html = '<div class="appai-preview">';
    if (urls.length) {
      html += '<div class="appai-carousel">';
      urls.forEach(function (u, i) {
        html += '<img class="appai-mockup' + (i === idx ? ' appai-mockup-active' : '') +
          '" src="' + esc(u) + '" alt="Mockup ' + (i + 1) + '" data-mockup-idx="' + i + '" />';
      });
      if (urls.length > 1) {
        html += '<div class="appai-carousel-dots">';
        urls.forEach(function (_, i) {
          html += '<button class="appai-dot' + (i === idx ? ' appai-dot-active' : '') +
            '" data-idx="' + i + '"></button>';
        });
        html += '</div>';
      }
      html += '</div>';
    }
    if (!S.publishing && !S.addedToCart) {
      html += '<button class="appai-btn-ghost appai-regenerate-btn">Try another design</button>';
    }
    html += '</div>';
    return html;
  }

  function buildActionsHTML() {
    var html = '<div class="appai-actions">';

    if (S.addedToCart) {
      html += '<div class="appai-success">✓ Added to cart! ' +
        '<a href="/cart" class="appai-link">View cart →</a></div>';
      html += '<button class="appai-btn-ghost appai-regenerate-btn" style="margin-top:12px;">Create another design</button>';
    } else if (S.publishing) {
      html += '<button class="appai-btn-primary" disabled>' +
        '<span class="appai-spinner-sm"></span> ' + esc(S.publishStep || 'Working…') +
        '</button>';
    } else {
      html += '<button id="appai-publish-cart-btn" class="appai-btn-primary">Create product &amp; add to cart</button>';
      if (S.saved) {
        html += '<div class="appai-saved">✓ Design saved — ' +
          '<a href="' + window.location.pathname + '?design_id=' + esc(S.designId) + '" class="appai-link">Resume link</a>' +
          '</div>';
      } else {
        html += '<button id="appai-save-btn" class="appai-btn-ghost">Save design for later</button>';
      }
    }

    html += '</div>';
    return html;
  }

  // ── Event binding ─────────────────────────────────────────────────────────

  function bindEvents() {
    // Prompt textarea
    var ta = document.getElementById('appai-prompt');
    if (ta) {
      ta.addEventListener('input', function () {
        S.prompt = ta.value;
        var btn = document.getElementById('appai-generate-btn');
        if (btn) btn.disabled = !S.prompt.trim();
      });
    }

    // Style selector
    ROOT.querySelectorAll('[data-style]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        if (btn.disabled) return;
        S.stylePreset = btn.getAttribute('data-style');
        ROOT.querySelectorAll('[data-style]').forEach(function (b) {
          b.classList.toggle('appai-style-active', b.getAttribute('data-style') === S.stylePreset);
        });
      });
    });

    // Generate button
    var genBtn = document.getElementById('appai-generate-btn');
    if (genBtn) genBtn.addEventListener('click', handleGenerate);

    // Regenerate / try another
    ROOT.querySelectorAll('.appai-regenerate-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        if (S.pollTimer) clearInterval(S.pollTimer);
        S.design = null;
        S.designId = null;
        S.error = null;
        S.publishError = null;
        S.saved = false;
        S.published = null;
        S.addedToCart = false;
        S.activeCarouselIdx = 0;
        render();
      });
    });

    // Carousel dots
    ROOT.querySelectorAll('.appai-dot').forEach(function (dot) {
      dot.addEventListener('click', function () {
        S.activeCarouselIdx = parseInt(dot.getAttribute('data-idx'), 10);
        var imgs = ROOT.querySelectorAll('.appai-mockup');
        var dots = ROOT.querySelectorAll('.appai-dot');
        imgs.forEach(function (img, i) { img.classList.toggle('appai-mockup-active', i === S.activeCarouselIdx); });
        dots.forEach(function (d, i) { d.classList.toggle('appai-dot-active', i === S.activeCarouselIdx); });
      });
    });

    // Create product & add to cart
    var publishBtn = document.getElementById('appai-publish-cart-btn');
    if (publishBtn) publishBtn.addEventListener('click', handlePublishAndAddToCart);

    // Save design
    var saveBtn = document.getElementById('appai-save-btn');
    if (saveBtn) saveBtn.addEventListener('click', handleSave);

    // Retry publish (inside error banner)
    var retryBtn = ROOT.querySelector('.appai-retry-btn');
    if (retryBtn) retryBtn.addEventListener('click', handlePublishAndAddToCart);
  }

  // ── Handlers ──────────────────────────────────────────────────────────────

  async function handleGenerate() {
    if (!S.prompt.trim() || S.generating) return;
    S.generating = true;
    S.design = null;
    S.designId = null;
    S.error = null;
    S.publishError = null;
    S.pollCount = 0;
    S.activeCarouselIdx = 0;
    render();

    try {
      var res = await proxyFetch('/designs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          baseVariantId: S.page.baseVariantId,
          prompt: S.prompt.trim(),
          options: { stylePreset: S.stylePreset, pageHandle: S.page.handle },
        }),
      });
      var data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Generation failed');
      S.designId = data.designId;
      startPolling();
    } catch (err) {
      S.generating = false;
      S.error = err.message || 'Could not start generation. Please try again.';
      render();
    }
  }

  function startPolling() {
    if (S.pollTimer) clearInterval(S.pollTimer);
    S.pollTimer = setInterval(async function () {
      S.pollCount++;
      try {
        var res = await proxyFetch('/designs/' + S.designId);
        var data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Poll error');

        if (data.status === 'READY') {
          clearInterval(S.pollTimer);
          S.generating = false;
          S.design = data;
          render();
          return;
        }
        if (data.status === 'FAILED') {
          clearInterval(S.pollTimer);
          S.generating = false;
          S.error = data.errorMessage || 'Generation failed. Please try again.';
          render();
          return;
        }
        if (S.pollCount > 60) {
          clearInterval(S.pollTimer);
          S.generating = false;
          S.error = 'Generation timed out. Please try again.';
          render();
          return;
        }
        // Still GENERATING — update elapsed counter
        if (S.generating) render();
      } catch (err) {
        console.warn('[AppAI] Poll error:', err);
      }
    }, 3000);
  }

  /**
   * Publish-design flow:
   *  1. POST /apps/appai/publish-design  → get shopifyVariantId
   *  2. POST /cart/add.js with shopifyVariantId
   */
  async function handlePublishAndAddToCart() {
    if (!S.design || S.publishing) return;
    S.publishing = true;
    S.publishError = null;

    var customerKey = getCustomerKey();

    try {
      // Step 1 — Create the Shopify product
      S.publishStep = 'Creating your product…';
      render();

      var publishRes = await proxyFetch('/publish-design', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          designId: S.designId,
          customerKey: customerKey,
          chosenMockupIndex: S.activeCarouselIdx,
        }),
      });
      var publishData = await publishRes.json();
      if (!publishRes.ok) {
        throw new Error(publishData.error || 'Could not create product. Please try again.');
      }

      S.published = publishData;
      var shopifyVariantId = publishData.shopifyVariantId;

      // Step 2 — Add the published variant to cart
      S.publishStep = 'Adding to cart…';
      render();

      var cartRes = await fetch('/cart/add.js', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          id: parseInt(shopifyVariantId, 10),
          quantity: 1,
          properties: { _design_id: S.designId },
        }),
      });
      if (!cartRes.ok) {
        var cartErr = await cartRes.json();
        throw new Error(cartErr.description || cartErr.message || 'Could not add to cart');
      }

      // Notify cart image replacer (the product already has real images so this is bonus)
      window.dispatchEvent(new CustomEvent('appai:cart-updated'));

      S.publishing = false;
      S.addedToCart = true;
      render();
      toast('Added to cart!', 'success');

      // Redirect after short delay
      setTimeout(function () {
        if (window.Shopify && window.Shopify.theme && document.querySelector('[data-cart-drawer], #CartDrawer')) {
          document.dispatchEvent(new CustomEvent('cart:open'));
        } else {
          window.location.href = '/cart';
        }
      }, 900);

    } catch (err) {
      S.publishing = false;
      S.publishError = err.message || 'Something went wrong. Please try again.';
      render();
    }
  }

  function handleSave() {
    if (!S.designId) return;
    S.saved = true;
    history.replaceState(null, '', window.location.pathname + '?design_id=' + encodeURIComponent(S.designId));
    render();
    toast('Design saved! Use the resume link to return.', 'success');
  }

  // ── Resume ─────────────────────────────────────────────────────────────────

  async function tryResume() {
    var params = new URLSearchParams(window.location.search);
    var designId = params.get('design_id');
    if (!designId) return false;
    try {
      var res = await proxyFetch('/designs/' + designId);
      if (!res.ok) return false;
      var data = await res.json();
      if (data.status === 'READY') {
        S.designId = data.designId;
        S.design = data;
        S.saved = true;
        return true;
      }
    } catch (_) {}
    return false;
  }

  // ── CSS ────────────────────────────────────────────────────────────────────

  function injectStyles() {
    injectCSS([
      '#appai-customizer-root{--c-primary:#6366f1;--c-primary-hover:#4f46e5;--c-bg:#f8fafc;--c-border:#e2e8f0;--c-text:#0f172a;--c-muted:#64748b;--c-error-bg:#fee2e2;--c-error:#991b1b;--c-success-bg:#d1fae5;--c-success:#065f46;font-family:system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;line-height:1.5;color:var(--c-text);padding:24px 16px;max-width:680px;margin:0 auto}',
      '.appai-card{background:#fff;border:1px solid var(--c-border);border-radius:16px;padding:32px;box-shadow:0 1px 4px rgba(0,0,0,.06)}',
      '.appai-header{margin-bottom:24px}',
      '.appai-title{font-size:clamp(20px,4vw,28px);font-weight:700;margin:0 0 6px}',
      '.appai-subtitle{color:var(--c-muted);margin:0;font-size:15px}',
      '.appai-error{background:var(--c-error-bg);color:var(--c-error);border-radius:8px;padding:12px 16px;margin-bottom:16px;font-size:14px;display:flex;align-items:center;justify-content:space-between;gap:12px}',
      '.appai-retry-btn{padding:4px 12px;border:1px solid var(--c-error);border-radius:6px;background:transparent;color:var(--c-error);font-size:13px;cursor:pointer;flex-shrink:0}',
      '.appai-section{margin-bottom:24px}',
      '.appai-label{display:block;font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--c-muted);margin-bottom:8px}',
      '.appai-textarea{width:100%;min-height:90px;padding:12px;border:1.5px solid var(--c-border);border-radius:8px;font-size:15px;font-family:inherit;resize:vertical;box-sizing:border-box;transition:border-color .15s}',
      '.appai-textarea:focus{outline:none;border-color:var(--c-primary)}',
      '.appai-textarea:disabled{background:#f1f5f9;color:var(--c-muted)}',
      '.appai-style-row{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px;align-items:center}',
      '.appai-style-btn{padding:6px 14px;border:1.5px solid var(--c-border);border-radius:20px;background:#fff;font-size:13px;cursor:pointer;transition:all .15s;text-transform:capitalize}',
      '.appai-style-btn:hover:not(:disabled){border-color:var(--c-primary);color:var(--c-primary)}',
      '.appai-style-active{border-color:var(--c-primary)!important;background:var(--c-primary)!important;color:#fff!important}',
      '.appai-style-btn:disabled{opacity:.5;cursor:not-allowed}',
      '.appai-progress{display:flex;align-items:center;gap:12px;padding:14px;background:var(--c-bg);border-radius:8px;font-size:14px;color:var(--c-muted);margin-top:16px}',
      '@keyframes appai-spin{to{transform:rotate(360deg)}}',
      '.appai-spinner{width:20px;height:20px;border:2.5px solid var(--c-border);border-top-color:var(--c-primary);border-radius:50%;animation:appai-spin .7s linear infinite;flex-shrink:0}',
      '.appai-spinner-sm{display:inline-block;width:14px;height:14px;border:2px solid rgba(255,255,255,.4);border-top-color:#fff;border-radius:50%;animation:appai-spin .7s linear infinite;vertical-align:middle;margin-right:6px}',
      '.appai-btn-primary{display:block;width:100%;padding:14px;background:var(--c-primary);color:#fff;border:none;border-radius:8px;font-size:16px;font-weight:600;cursor:pointer;margin-top:16px;transition:background .15s}',
      '.appai-btn-primary:hover:not(:disabled){background:var(--c-primary-hover)}',
      '.appai-btn-primary:disabled{opacity:.6;cursor:not-allowed}',
      '.appai-btn-ghost{display:block;width:100%;padding:12px;background:transparent;color:var(--c-muted);border:1.5px solid var(--c-border);border-radius:8px;font-size:14px;cursor:pointer;margin-top:10px;transition:all .15s}',
      '.appai-btn-ghost:hover:not(:disabled){border-color:var(--c-primary);color:var(--c-primary)}',
      '.appai-preview{margin-bottom:24px}',
      '.appai-carousel{position:relative;border-radius:12px;overflow:hidden;background:var(--c-bg);aspect-ratio:1;max-height:420px;display:flex;align-items:center;justify-content:center}',
      '.appai-mockup{display:none;width:100%;height:100%;object-fit:contain}',
      '.appai-mockup-active{display:block}',
      '.appai-carousel-dots{display:flex;justify-content:center;gap:6px;padding:10px}',
      '.appai-dot{width:8px;height:8px;border-radius:50%;background:var(--c-border);border:none;cursor:pointer;transition:background .15s;padding:0}',
      '.appai-dot-active{background:var(--c-primary)}',
      '.appai-regenerate-btn{margin-top:8px}',
      '.appai-actions{border-top:1px solid var(--c-border);padding-top:20px;margin-top:4px}',
      '.appai-success{background:var(--c-success-bg);color:var(--c-success);border-radius:8px;padding:14px 16px;font-size:14px;text-align:center}',
      '.appai-link{color:inherit;font-weight:600}',
      '.appai-saved{text-align:center;font-size:13px;color:var(--c-muted);margin-top:8px}',
      '@media(max-width:480px){.appai-card{padding:20px}.appai-carousel{max-height:280px}}',
    ].join(''));
  }

  // ── Mount ──────────────────────────────────────────────────────────────────

  async function mountCustomizer(page) {
    S.page = page;
    S.error = null;
    injectStyles();

    var main = findMainContent();
    hideThemePageContent();

    ROOT = document.getElementById('appai-customizer-root');
    if (!ROOT) {
      ROOT = document.createElement('div');
      ROOT.id = 'appai-customizer-root';
      main.insertBefore(ROOT, main.firstChild);
    }

    await tryResume();
    render();
  }

  // ── Init ───────────────────────────────────────────────────────────────────

  async function init() {
    var handle = getCurrentHandle();
    if (!handle) return;

    // Check BEFORE any async work — ai-art-embed.liquid sets this flag synchronously
    // as soon as it detects a /pages/:handle URL, so this guard runs in the same
    // tick as DOMContentLoaded and prevents any unnecessary fetch.
    if (window.__APPAI_CUSTOMIZER_HANDLED) {
      console.log('[AppAI Embed] Already handled by embed block, skipping custom renderer.');
      return;
    }

    var config = await getCustomizerConfig();
    var pages = config.pages || [];
    var fallbackUrl = config.fallbackUrl || '/';

    // Find matching page record
    var page = null;
    for (var i = 0; i < pages.length; i++) {
      if (pages[i].handle === handle) { page = pages[i]; break; }
    }

    if (!page) return; // Not a customizer page — let the theme render normally

    if (page.status !== 'active') {
      // Disabled page → redirect to fallback hub URL
      console.log('[AppAI Embed] Customizer page "' + handle + '" is disabled. Redirecting to ' + fallbackUrl);
      window.location.replace(fallbackUrl);
      return;
    }

    // Re-check after the async config fetch in case the flag was set while we were waiting
    if (window.__APPAI_CUSTOMIZER_HANDLED) {
      console.log('[AppAI Embed] Embed block took over during config fetch, skipping custom renderer.');
      return;
    }

    mountCustomizer(page);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
