/**
 * AppAI Customizer Embed
 * ─────────────────────────────────────────────────────────────────────────
 * Injected sitewide via the App Embed (ai-art-embed.liquid).
 * Detects if the current page is a merchant-created AppAI customizer page
 * and mounts the full customizer UI without requiring any theme blocks.
 *
 * HOW IT WORKS:
 *  1. On every page, reads the current URL pathname.
 *  2. If the path is /pages/<handle>, fetches the active customizer pages
 *     from the App Proxy at /apps/appai/customizer-pages (cached 5 min).
 *  3. If a match is found, hides the theme's generic page content and
 *     renders a self-contained customizer UI.
 *  4. All API calls go through the App Proxy (/apps/appai/…) — no
 *     hardcoded Railway domains, no CORS issues.
 *
 * IMPORTANT: Only /apps/appai/… proxy paths are used. Never absolute app URLs.
 */
;(function () {
  'use strict';

  if (window.__APPAI_CUSTOMIZER_EMBED__) return;
  window.__APPAI_CUSTOMIZER_EMBED__ = true;

  var PROXY = '/apps/appai';
  var CACHE_KEY = 'appai_cpages_v1';
  var CACHE_TTL = 5 * 60 * 1000; // 5 minutes

  // ── Utility ──────────────────────────────────────────────────────────────

  function slug(str) {
    return str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  }

  function esc(str) {
    return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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
    var el = document.createElement('div');
    el.setAttribute('style', [
      'position:fixed;top:20px;right:20px;z-index:999999;padding:12px 20px;border-radius:8px;',
      'font-family:system-ui,sans-serif;font-size:14px;line-height:1.4;max-width:320px;',
      'box-shadow:0 4px 16px rgba(0,0,0,0.15);transition:opacity 0.3s;',
      type === 'error'
        ? 'background:#fee2e2;color:#991b1b;border:1px solid #fca5a5;'
        : type === 'success'
        ? 'background:#d1fae5;color:#065f46;border:1px solid #6ee7b7;'
        : 'background:#eff6ff;color:#1e40af;border:1px solid #93c5fd;',
    ].join(''));
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(function () {
      el.style.opacity = '0';
      setTimeout(function () { el.parentNode && el.parentNode.removeChild(el); }, 300);
    }, 3500);
  }

  // ── Page detection ────────────────────────────────────────────────────────

  function getCurrentHandle() {
    var m = window.location.pathname.match(/^\/pages\/([^/?#]+)/);
    return m ? m[1] : null;
  }

  // ── Proxy fetch helpers ───────────────────────────────────────────────────

  function proxyFetch(path, options) {
    return fetch(PROXY + path, Object.assign({ credentials: 'same-origin' }, options || {}));
  }

  async function getCustomizerPages() {
    try {
      var cached = sessionStorage.getItem(CACHE_KEY);
      if (cached) {
        var c = JSON.parse(cached);
        if (Date.now() - c.ts < CACHE_TTL) return c.data;
      }
    } catch (_) {}
    try {
      var res = await proxyFetch('/customizer-pages');
      if (!res.ok) return [];
      var data = await res.json();
      var pages = data.pages || [];
      try { sessionStorage.setItem(CACHE_KEY, JSON.stringify({ data: pages, ts: Date.now() })); } catch (_) {}
      return pages;
    } catch (e) {
      console.warn('[AppAI Embed] Could not fetch customizer pages:', e);
      return [];
    }
  }

  // ── DOM manipulation ──────────────────────────────────────────────────────

  function hideThemePageContent() {
    var selectors = ['#MainContent > .page-width', 'main .page', 'main article', '.page__content'];
    selectors.forEach(function (sel) {
      var els = document.querySelectorAll(sel);
      els.forEach(function (el) { el.style.display = 'none'; });
    });
    // Also hide the standard Shopify page title rendered by the theme
    var pageTitle = document.querySelector('h1.page-title, h1.title, .page__title');
    if (pageTitle) pageTitle.style.display = 'none';
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

  // ── Customizer state & render ─────────────────────────────────────────────

  var S = {
    page: null,            // the customizer page config from proxy
    prompt: '',
    stylePreset: 'vibrant',
    generating: false,
    designId: null,
    pollTimer: null,
    pollCount: 0,
    design: null,          // { status, artworkUrl, mockupUrl, mockupUrls, designId }
    addingToCart: false,
    error: null,
    saved: false,
  };

  var ROOT = null;

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
    html += '<p class="appai-subtitle">' + esc(titleStr) + (priceStr ? ' &middot; <strong>' + esc(priceStr) + '</strong>' : '') + '</p>';
    html += '</div>';

    // Error banner
    if (S.error) {
      html += '<div class="appai-error">' + esc(S.error) + '</div>';
    }

    // Preview (when design is READY)
    if (S.design && S.design.status === 'READY') {
      html += buildPreviewHTML();
    }

    // Generator form
    if (!S.design || S.design.status !== 'READY') {
      html += buildFormHTML();
    }

    // Actions (after ready)
    if (S.design && S.design.status === 'READY') {
      html += buildActionsHTML();
    }

    html += '</div>';
    return html;
  }

  function buildFormHTML() {
    var disabled = S.generating ? ' disabled' : '';
    var html = '<div class="appai-section">';

    html += '<label class="appai-label" for="appai-prompt">Describe your design</label>';
    html += '<textarea' + disabled + ' id="appai-prompt" class="appai-textarea" placeholder="e.g. A mountain sunset with watercolor style…">' + esc(S.prompt) + '</textarea>';

    html += '<div class="appai-style-row">';
    html += '<span class="appai-label">Style</span>';
    ['vibrant', 'minimal', 'watercolor', 'realistic', 'abstract'].forEach(function (st) {
      var active = S.stylePreset === st ? ' appai-style-active' : '';
      html += '<button' + disabled + ' class="appai-style-btn' + active + '" data-style="' + st + '">' + st + '</button>';
    });
    html += '</div>';

    if (S.generating) {
      html += '<div class="appai-progress">';
      html += '<div class="appai-spinner"></div>';
      html += '<span>Generating your design… (' + Math.min(S.pollCount * 3, 90) + 's)</span>';
      html += '</div>';
    } else {
      html += '<button id="appai-generate-btn" class="appai-btn-primary"' + (S.prompt.trim() ? '' : ' disabled') + '>Generate Design</button>';
    }
    html += '</div>';
    return html;
  }

  function buildPreviewHTML() {
    var urls = (S.design.mockupUrls && S.design.mockupUrls.length)
      ? S.design.mockupUrls
      : (S.design.mockupUrl ? [S.design.mockupUrl] : []);

    var html = '<div class="appai-preview">';
    if (urls.length) {
      html += '<div class="appai-carousel">';
      urls.forEach(function (u, i) {
        html += '<img class="appai-mockup' + (i === 0 ? ' appai-mockup-active' : '') + '" src="' + esc(u) + '" alt="Design mockup ' + (i + 1) + '" />';
      });
      if (urls.length > 1) {
        html += '<div class="appai-carousel-dots">';
        urls.forEach(function (_, i) {
          html += '<button class="appai-dot' + (i === 0 ? ' appai-dot-active' : '') + '" data-idx="' + i + '"></button>';
        });
        html += '</div>';
      }
      html += '</div>';
    }
    html += '<button class="appai-btn-ghost appai-regenerate-btn">Try another design</button>';
    html += '</div>';
    return html;
  }

  function buildActionsHTML() {
    var disabled = S.addingToCart ? ' disabled' : '';
    var html = '<div class="appai-actions">';
    html += '<button id="appai-cart-btn" class="appai-btn-primary"' + disabled + '>';
    html += S.addingToCart ? '<span class="appai-spinner-sm"></span> Adding…' : 'Add to Cart';
    html += '</button>';
    if (S.saved) {
      html += '<div class="appai-saved">✓ Design saved — <a href="' + window.location.pathname + '?design_id=' + esc(S.designId) + '">Resume link</a></div>';
    } else {
      html += '<button id="appai-save-btn" class="appai-btn-ghost">Save design</button>';
    }
    html += '</div>';
    return html;
  }

  function bindEvents() {
    // Prompt
    var ta = document.getElementById('appai-prompt');
    if (ta) {
      ta.addEventListener('input', function () {
        S.prompt = ta.value;
        var btn = document.getElementById('appai-generate-btn');
        if (btn) btn.disabled = !S.prompt.trim();
      });
    }

    // Style buttons
    ROOT.querySelectorAll('[data-style]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        S.stylePreset = btn.getAttribute('data-style');
        ROOT.querySelectorAll('[data-style]').forEach(function (b) {
          b.classList.toggle('appai-style-active', b.getAttribute('data-style') === S.stylePreset);
        });
      });
    });

    // Generate
    var genBtn = document.getElementById('appai-generate-btn');
    if (genBtn) genBtn.addEventListener('click', handleGenerate);

    // Regenerate
    var regen = ROOT.querySelector('.appai-regenerate-btn');
    if (regen) regen.addEventListener('click', function () {
      S.design = null;
      S.designId = null;
      S.error = null;
      S.saved = false;
      render();
    });

    // Carousel dots
    ROOT.querySelectorAll('.appai-dot').forEach(function (dot) {
      dot.addEventListener('click', function () {
        var idx = parseInt(dot.getAttribute('data-idx'), 10);
        var imgs = ROOT.querySelectorAll('.appai-mockup');
        var dots = ROOT.querySelectorAll('.appai-dot');
        imgs.forEach(function (img, i) { img.classList.toggle('appai-mockup-active', i === idx); });
        dots.forEach(function (d, i) { d.classList.toggle('appai-dot-active', i === idx); });
      });
    });

    // Add to cart
    var cartBtn = document.getElementById('appai-cart-btn');
    if (cartBtn) cartBtn.addEventListener('click', handleAddToCart);

    // Save design
    var saveBtn = document.getElementById('appai-save-btn');
    if (saveBtn) saveBtn.addEventListener('click', handleSave);
  }

  // ── Handlers ──────────────────────────────────────────────────────────────

  async function handleGenerate() {
    if (!S.prompt.trim() || S.generating) return;
    S.generating = true;
    S.design = null;
    S.designId = null;
    S.error = null;
    S.pollCount = 0;
    render();

    try {
      var res = await proxyFetch('/designs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          baseVariantId: S.page.baseVariantId,
          prompt: S.prompt.trim(),
          options: {
            stylePreset: S.stylePreset,
            pageHandle: S.page.handle,
          },
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
        } else if (data.status === 'FAILED') {
          clearInterval(S.pollTimer);
          S.generating = false;
          S.error = data.errorMessage || 'Generation failed. Please try again.';
          render();
        } else if (S.pollCount > 60) {
          // 3-minute timeout
          clearInterval(S.pollTimer);
          S.generating = false;
          S.error = 'Generation timed out. Please try again.';
          render();
        }
        // Still GENERATING — re-render to update elapsed counter
        if (S.generating) render();
      } catch (err) {
        console.warn('[AppAI] Poll error:', err);
      }
    }, 3000);
  }

  async function handleAddToCart() {
    if (!S.design || S.addingToCart) return;
    S.addingToCart = true;
    render();

    var appaiUid = uid();
    try {
      var res = await fetch('/cart/add.js', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          id: parseInt(S.page.baseVariantId, 10),
          quantity: 1,
          properties: {
            _design_id: S.designId,
            _mockup_url: S.design.mockupUrl || '',
            _artwork_url: S.design.artworkUrl || '',
            _appai_uid: appaiUid,
          },
        }),
      });

      if (!res.ok) {
        var d = await res.json();
        throw new Error(d.description || d.message || 'Could not add to cart');
      }

      // Notify cart image replacer
      window.dispatchEvent(new CustomEvent('appai:cart-updated'));

      toast('Added to cart!', 'success');
      S.addingToCart = false;
      render();

      // Redirect after short delay or open cart drawer
      setTimeout(function () {
        if (window.Shopify && window.Shopify.theme && document.querySelector('[data-cart-drawer]')) {
          document.dispatchEvent(new CustomEvent('cart:open'));
        } else {
          window.location.href = '/cart';
        }
      }, 800);
    } catch (err) {
      S.addingToCart = false;
      S.error = err.message || 'Could not add to cart. Please try again.';
      render();
    }
  }

  function handleSave() {
    if (!S.designId) return;
    S.saved = true;
    render();
    // Update URL without reload
    var url = window.location.pathname + '?design_id=' + encodeURIComponent(S.designId);
    history.replaceState(null, '', url);
    toast('Design saved! Use the resume link to return to it.', 'success');
  }

  // ── Resume from ?design_id ─────────────────────────────────────────────

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
      '#appai-customizer-root{--c-primary:#6366f1;--c-primary-hover:#4f46e5;--c-bg:#f8fafc;--c-border:#e2e8f0;--c-text:#0f172a;--c-muted:#64748b;--c-error-bg:#fee2e2;--c-error:#991b1b;font-family:system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;line-height:1.5;color:var(--c-text);padding:24px 16px;max-width:680px;margin:0 auto}',
      '.appai-card{background:#fff;border:1px solid var(--c-border);border-radius:16px;padding:32px;box-shadow:0 1px 4px rgba(0,0,0,.06)}',
      '.appai-header{margin-bottom:24px}',
      '.appai-title{font-size:clamp(20px,4vw,28px);font-weight:700;margin:0 0 6px}',
      '.appai-subtitle{color:var(--c-muted);margin:0;font-size:15px}',
      '.appai-error{background:var(--c-error-bg);color:var(--c-error);border-radius:8px;padding:12px 16px;margin-bottom:16px;font-size:14px}',
      '.appai-section{margin-bottom:24px}',
      '.appai-label{display:block;font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--c-muted);margin-bottom:8px}',
      '.appai-textarea{width:100%;min-height:90px;padding:12px;border:1.5px solid var(--c-border);border-radius:8px;font-size:15px;font-family:inherit;resize:vertical;box-sizing:border-box;transition:border-color .15s}',
      '.appai-textarea:focus{outline:none;border-color:var(--c-primary)}',
      '.appai-textarea:disabled{background:#f1f5f9;color:var(--c-muted)}',
      '.appai-style-row{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px;align-items:center}',
      '.appai-style-btn{padding:6px 14px;border:1.5px solid var(--c-border);border-radius:20px;background:#fff;font-size:13px;cursor:pointer;transition:all .15s;text-transform:capitalize}',
      '.appai-style-btn:hover{border-color:var(--c-primary);color:var(--c-primary)}',
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
      '.appai-carousel{position:relative;border-radius:12px;overflow:hidden;background:var(--c-bg);aspect-ratio:1;max-height:400px;display:flex;align-items:center;justify-content:center}',
      '.appai-mockup{display:none;width:100%;height:100%;object-fit:contain}',
      '.appai-mockup-active{display:block}',
      '.appai-carousel-dots{display:flex;justify-content:center;gap:6px;padding:10px}',
      '.appai-dot{width:8px;height:8px;border-radius:50%;background:var(--c-border);border:none;cursor:pointer;transition:background .15s;padding:0}',
      '.appai-dot-active{background:var(--c-primary)}',
      '.appai-regenerate-btn{margin-top:8px}',
      '.appai-actions{border-top:1px solid var(--c-border);padding-top:20px;margin-top:4px}',
      '.appai-saved{text-align:center;font-size:13px;color:var(--c-muted);margin-top:8px}',
      '.appai-saved a{color:var(--c-primary)}',
      '@media(max-width:480px){.appai-card{padding:20px}.appai-carousel{max-height:260px}}',
    ].join(''));
  }

  // ── Mount ──────────────────────────────────────────────────────────────────

  async function mountCustomizer(page) {
    S.page = page;
    S.error = null;
    injectStyles();

    // Find or create root element
    var main = findMainContent();
    hideThemePageContent();

    ROOT = document.getElementById('appai-customizer-root');
    if (!ROOT) {
      ROOT = document.createElement('div');
      ROOT.id = 'appai-customizer-root';
      main.insertBefore(ROOT, main.firstChild);
    }

    // Check for resume
    await tryResume();
    render();
  }

  // ── Init ───────────────────────────────────────────────────────────────────

  async function init() {
    var handle = getCurrentHandle();
    if (!handle) return;

    var pages = await getCustomizerPages();
    var page = pages.find(function (p) { return p.handle === handle && p.status === 'active'; });
    if (!page) return;

    mountCustomizer(page);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
