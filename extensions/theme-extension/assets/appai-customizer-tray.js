/**
 * AppAI Customizer Tray
 * ─────────────────────────────────────────────────────────────────────────
 * Floating "Customize" launcher button + slide-out tray, on every storefront
 * page (including customizer pages, so customers can hop between products).
 *
 * WHY THIS EXISTS
 * ────────────────
 * Theme-native nav dropdowns are hover-driven and their behavior varies by
 * theme (e.g. Horizon-family menus don't open when the pointer approaches
 * from below — verified against the theme's own menu items with no app code
 * involved). This launcher is fully app-owned DOM: click-driven only, so it
 * behaves identically on every theme, desktop and mobile.
 *
 * It deliberately NEVER touches the theme's header/menu DOM.
 *
 * THEME STYLE MATCHING
 * ─────────────────────
 * The button and tray read the merchant theme's computed styles at runtime
 * (same approach as extractStoreTheme in appai-art-embed.js): primary button
 * colors/radius/font for the launcher, body background/text + heading font
 * for the tray. Falls back to a neutral dark scheme when nothing usable is
 * found (e.g. transparent backgrounds).
 *
 * DATA
 * ─────
 * Pages list: GET /apps/appai/customizer-pages (App Proxy, same-origin).
 * Saved designs: delegates to the existing drawer via
 * window.__APPAI_OPEN_SAVED_DESIGNS_DRAWER__ (only present when the customer
 * is logged in and has designs — the section hides itself otherwise).
 *
 * SETTINGS
 * ─────────
 * Merchant-configurable via the app embed (theme editor):
 *   <script type="application/json" id="appai-tray-settings">
 *     { "enabled": true, "label": "Product Customizer", "position": "top-left", "shimmer": true }
 *   </script>
 * Absent settings (e.g. on self-bootstrapped customizer pages) = defaults.
 */
;(function () {
  'use strict';

  if (window.__APPAI_CUSTOMIZER_TRAY__) return;
  window.__APPAI_CUSTOMIZER_TRAY__ = true;

  var PROXY = '/apps/appai';
  var BTN_ID = 'appai-tray-launcher';
  var TRAY_ID = 'appai-customizer-tray';
  var OVERLAY_ID = 'appai-tray-overlay';

  // ─── Settings ─────────────────────────────────────────────────────────

  var POSITIONS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];

  function readSettings() {
    var defaults = { enabled: true, label: 'Product Customizer', position: 'top-left', shimmer: true };
    try {
      var el = document.getElementById('appai-tray-settings');
      if (!el) return defaults;
      var parsed = JSON.parse(el.textContent || '{}');
      return {
        enabled: parsed.enabled !== false,
        label: (typeof parsed.label === 'string' && parsed.label.trim()) ? parsed.label.trim() : defaults.label,
        position: POSITIONS.indexOf(parsed.position) !== -1 ? parsed.position : defaults.position,
        shimmer: parsed.shimmer !== false,
      };
    } catch (_) {
      return defaults;
    }
  }

  // ─── Theme style extraction ───────────────────────────────────────────

  function isUsableColor(c) {
    if (!c) return false;
    if (c === 'transparent') return false;
    var m = c.match(/rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*(?:,\s*([\d.]+)\s*)?\)/);
    if (m && m[1] !== undefined && parseFloat(m[1]) < 0.1) return false;
    return true;
  }

  function extractTrayTheme() {
    var t = {
      buttonBg: '#111827',
      buttonColor: '#ffffff',
      buttonRadius: '999px',
      buttonFontFamily: '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif',
      trayBg: '#ffffff',
      trayColor: '#111827',
      trayMuted: '#6b7280',
      trayBorder: 'rgba(0,0,0,0.08)',
      bodyFontFamily: '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif',
      headingFontFamily: '',
      headingFontWeight: '700',
    };
    try {
      var bodyCs = getComputedStyle(document.body);
      if (bodyCs.fontFamily) {
        t.bodyFontFamily = bodyCs.fontFamily;
        t.buttonFontFamily = bodyCs.fontFamily;
      }
      if (isUsableColor(bodyCs.backgroundColor)) t.trayBg = bodyCs.backgroundColor;
      if (isUsableColor(bodyCs.color)) {
        t.trayColor = bodyCs.color;
        t.trayMuted = bodyCs.color;
      }

      var h = document.querySelector('h1, h2, .product__title');
      if (h) {
        var hcs = getComputedStyle(h);
        t.headingFontFamily = hcs.fontFamily || '';
        t.headingFontWeight = hcs.fontWeight || '700';
      }

      var btn = document.querySelector(
        'button[name="add"], .product-form__submit, button.btn--primary, ' +
        '.btn--filled, button.button--primary, .button--primary, ' +
        'form[action*="/cart/add"] button[type="submit"], button.button'
      );
      if (btn) {
        var bcs = getComputedStyle(btn);
        if (isUsableColor(bcs.backgroundColor)) {
          t.buttonBg = bcs.backgroundColor;
          if (isUsableColor(bcs.color)) t.buttonColor = bcs.color;
        }
        if (bcs.fontFamily) t.buttonFontFamily = bcs.fontFamily;
        var r = parseFloat(bcs.borderRadius);
        // Keep the pill look unless the theme is clearly sharp-cornered.
        if (!isNaN(r) && r < 4) t.buttonRadius = '8px';
      }
    } catch (_) {}
    return t;
  }

  // ─── Data ─────────────────────────────────────────────────────────────

  var _pages = null; // active pages [{handle,title,baseProductTitle}]
  var _settings = null; // resolved settings from readSettings()

  function fetchPages() {
    return fetch(PROXY + '/customizer-pages', { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (!data || !data.pages) return [];
        return data.pages.filter(function (p) { return p.status === 'active'; });
      })
      .catch(function () { return []; });
  }

  // ─── DOM: styles ──────────────────────────────────────────────────────

  /** rgba() version of a computed color, for the shimmer sweep highlight. */
  function colorWithAlpha(color, alpha) {
    var m = (color || '').match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
    if (m) return 'rgba(' + m[1] + ',' + m[2] + ',' + m[3] + ',' + alpha + ')';
    return 'rgba(255,255,255,' + alpha + ')';
  }

  function ensureStyles(theme, settings) {
    if (document.getElementById('appai-tray-styles')) return;
    var side = settings.position.indexOf('left') !== -1 ? 'left' : 'right';
    var isTop = settings.position.indexOf('top') === 0;
    // Vertical placement uses CSS vars kept up to date by
    // updateLauncherOffsets(): top positions track the theme header's bottom
    // edge (sticky headers included); bottom positions clear Shopify's
    // preview bar iframe on password-protected/preview stores.
    var vertical = isTop
      ? 'top:var(--appai-tray-top,16px);'
      : 'bottom:calc(var(--appai-tray-bottom,20px) + env(safe-area-inset-bottom,0px));';
    var style = document.createElement('style');
    style.id = 'appai-tray-styles';
    style.textContent = [
      '#' + BTN_ID + '{',
        'position:fixed;' + vertical + side + ':20px;',
        'z-index:2147483640;',
        'display:flex;align-items:center;gap:8px;',
        'padding:12px 18px;border:none;cursor:pointer;',
        'background:' + theme.buttonBg + ';color:' + theme.buttonColor + ';',
        'border-radius:' + theme.buttonRadius + ';',
        'font-family:' + theme.buttonFontFamily + ';',
        'font-size:14.5px;font-weight:600;line-height:1;letter-spacing:0.01em;',
        'box-shadow:0 4px 16px rgba(0,0,0,0.22);',
        'transition:transform 160ms ease,box-shadow 160ms ease,opacity 200ms ease,top 200ms ease;',
        'opacity:0;transform:translateY(8px);',
      '}',
      '#' + BTN_ID + '.appai-visible{opacity:1;transform:translateY(0);}',
      '#' + BTN_ID + ':hover{transform:translateY(-1px);box-shadow:0 6px 20px rgba(0,0,0,0.28);}',
      '#' + BTN_ID + ':active{transform:translateY(0);}',
      '#' + BTN_ID + ' svg{flex-shrink:0;}',
      // Same shimmer treatment as the "Loading AI Art Studio" boot title,
      // recolored to sweep the theme's button text color.
      settings.shimmer ? [
        '@keyframes appai-tray-shimmer{0%{background-position:200% center;}100%{background-position:-200% center;}}',
        '#' + BTN_ID + ' .appai-tray-label{',
          'background:linear-gradient(90deg,' + theme.buttonColor + ' 0%,' + theme.buttonColor + ' 35%,' +
            colorWithAlpha(theme.buttonColor, 0.35) + ' 50%,' + theme.buttonColor + ' 65%,' + theme.buttonColor + ' 100%);',
          'background-size:200% auto;',
          '-webkit-background-clip:text;background-clip:text;',
          '-webkit-text-fill-color:transparent;color:transparent;',
          'animation:appai-tray-shimmer 2.4s linear infinite;',
        '}',
      ].join('') : '',
      '#' + OVERLAY_ID + '{',
        'position:fixed;inset:0;background:rgba(0,0,0,0.45);z-index:2147483641;',
        'opacity:0;transition:opacity 250ms ease;pointer-events:none;',
      '}',
      '#' + OVERLAY_ID + '.appai-open{opacity:1;pointer-events:auto;}',
      '#' + TRAY_ID + '{',
        'position:fixed;top:0;' + side + ':0;height:100%;width:min(400px,100vw);',
        'background:' + theme.trayBg + ';color:' + theme.trayColor + ';',
        'z-index:2147483642;',
        'transform:translateX(' + (side === 'left' ? '-100%' : '100%') + ');',
        'transition:transform 320ms cubic-bezier(0.4,0,0.2,1);',
        'display:flex;flex-direction:column;',
        'box-shadow:' + (side === 'left' ? '6px' : '-6px') + ' 0 32px rgba(0,0,0,0.18);',
        'font-family:' + theme.bodyFontFamily + ';',
      '}',
      '#' + TRAY_ID + '.appai-open{transform:translateX(0);}',
      '#appai-tray-header{',
        'display:flex;align-items:center;justify-content:space-between;',
        'padding:20px 24px 18px;border-bottom:1px solid ' + theme.trayBorder + ';flex-shrink:0;',
      '}',
      '#appai-tray-title{margin:0;font-size:17px;letter-spacing:-0.01em;',
        'font-family:' + (theme.headingFontFamily || theme.bodyFontFamily) + ';',
        'font-weight:' + theme.headingFontWeight + ';color:inherit;',
      '}',
      '#appai-tray-close{',
        'background:none;border:none;cursor:pointer;padding:6px;color:inherit;opacity:0.65;',
        'display:flex;align-items:center;justify-content:center;border-radius:8px;',
        'transition:opacity 150ms;flex-shrink:0;',
      '}',
      '#appai-tray-close:hover{opacity:1;}',
      '#appai-tray-body{flex:1;min-height:0;overflow-y:auto;padding:16px 16px 24px;overscroll-behavior:contain;}',
      '.appai-tray-section-label{',
        'font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;',
        'opacity:0.55;margin:12px 8px 8px;',
      '}',
      '.appai-tray-item{',
        'display:flex;align-items:center;gap:12px;width:100%;box-sizing:border-box;',
        'padding:13px 14px;border:none;background:none;cursor:pointer;text-align:left;',
        'color:inherit;text-decoration:none;border-radius:10px;',
        'font-family:inherit;font-size:14.5px;',
        'transition:background 150ms;',
      '}',
      '.appai-tray-item:hover{background:rgba(127,127,127,0.12);}',
      '.appai-tray-item[aria-current="page"]{background:rgba(127,127,127,0.10);cursor:default;}',
      '.appai-tray-item-icon{',
        'flex-shrink:0;width:36px;height:36px;border-radius:9px;',
        'display:flex;align-items:center;justify-content:center;',
        'background:' + theme.buttonBg + ';color:' + theme.buttonColor + ';',
      '}',
      '.appai-tray-item-text{flex:1;min-width:0;}',
      '.appai-tray-item-title{display:block;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.appai-tray-item-sub{display:block;font-size:12px;opacity:0.6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px;}',
      '.appai-tray-item-chevron{flex-shrink:0;opacity:0.4;}',
      '#appai-tray-empty{padding:32px 20px;text-align:center;opacity:0.65;font-size:13.5px;line-height:1.5;}',
    ].join('');
    document.head.appendChild(style);
  }

  // ─── DOM: launcher + tray ─────────────────────────────────────────────

  var ICON_SPARK =
    '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" ' +
    'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M12 3l1.9 5.7a1 1 0 0 0 .63.63L20.2 11.2a.5.5 0 0 1 0 .95l-5.67 1.9a1 1 0 0 0-.63.63L12 20.4a.5.5 0 0 1-.95 0l-1.9-5.67a1 1 0 0 0-.63-.63L2.85 12.2a.5.5 0 0 1 0-.95l5.67-1.9a1 1 0 0 0 .63-.63L11.05 3a.5.5 0 0 1 .95 0z"/></svg>';

  var ICON_BOOKMARK =
    '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" ' +
    'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>';

  var ICON_BRUSH =
    '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" ' +
    'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M9.06 11.9l8.07-8.06a2.85 2.85 0 1 1 4.03 4.03l-8.06 8.08"/>' +
    '<path d="M7.07 14.94c-1.66 0-3 1.35-3 3.02 0 1.33-2.5 1.52-2 2.02 1.08 1.1 2.49 2.02 4 2.02 2.2 0 4-1.8 4-4.04a3.01 3.01 0 0 0-3-3.02z"/></svg>';

  var ICON_CHEVRON =
    '<svg class="appai-tray-item-chevron" xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" ' +
    'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<polyline points="9 18 15 12 9 6"/></svg>';

  function buildLauncher(theme, settings) {
    if (document.getElementById(BTN_ID)) return;
    var btn = document.createElement('button');
    btn.id = BTN_ID;
    btn.type = 'button';
    btn.setAttribute('aria-haspopup', 'dialog');
    btn.setAttribute('aria-label', settings.label + ' — open product customizer menu');
    var labelSpan = document.createElement('span');
    labelSpan.className = 'appai-tray-label';
    labelSpan.textContent = settings.label;
    btn.innerHTML = ICON_SPARK;
    btn.appendChild(labelSpan);
    btn.addEventListener('click', openTray);
    document.body.appendChild(btn);
    startOffsetTracking(settings);
    // Fade in after append so the transition runs.
    requestAnimationFrame(function () {
      requestAnimationFrame(function () { btn.classList.add('appai-visible'); });
    });
  }

  // ─── Vertical offset tracking ─────────────────────────────────────────
  // Top positions: sit just below the theme's header/menu bar, following it
  // when sticky and gliding up to 16px when the header scrolls out of view.
  // Bottom positions: clear Shopify's preview bar iframe (only present on
  // password-protected/preview stores) so the button is never hidden by it.

  /**
   * Bottom edge of the theme's header chrome (announcement bar + menu bar)
   * currently occupying the top of the viewport. The button must NEVER sit
   * over the menu bar, so this is deliberately generous:
   *
   * - Checks ALL candidates and takes the MAX bottom, so announcement bars
   *   above the menu don't shadow it (requiring top≈0 broke Tinker/Horizon,
   *   whose headers start below an announcement bar).
   * - Includes every section inside the header group — Horizon-family themes
   *   wrap sections in zero-height custom elements, so the outer wrapper can
   *   measure 0 while the inner sections measure fine.
   * - Anchors on the header cart icon as a selector-proof fallback: whatever
   *   ancestor section contains it IS the menu bar, on any theme.
   */
  function visibleHeaderBottom() {
    var els = [];
    var found = document.querySelectorAll(
      '.shopify-section-group-header-group, .shopify-section-group-header-group [id^="shopify-section"], ' +
      '[id^="shopify-section"][id*="header"], [id^="shopify-section"][id*="announcement"], ' +
      'header.header, .header-wrapper, .site-header, sticky-header, header-component, header'
    );
    for (var i = 0; i < found.length; i++) els.push(found[i]);
    try {
      // First /cart link in DOM order is the header's cart icon on virtually
      // every theme (footer/drawer links come later in the document).
      var cart = document.querySelector('a[href*="/cart"]');
      var anchor = cart && cart.closest ? cart.closest('[id^="shopify-section"], header, .shopify-section') : null;
      if (anchor) els.push(anchor);
    } catch (_) {}

    var bottom = 0;
    var vh = window.innerHeight;
    for (var j = 0; j < els.length; j++) {
      var r = els[j].getBoundingClientRect();
      // Visible, starts in the upper third of the viewport, and is plausibly
      // header chrome (bottom in the upper 60%) — hero/content sections that
      // happen to match the selectors fail these bounds.
      if (r.height > 0 && r.width > 0 && r.top < vh / 3 && r.bottom > 0 && r.bottom < vh * 0.6) {
        if (r.bottom > bottom) bottom = r.bottom;
      }
    }
    return bottom;
  }

  function updateLauncherOffsets(settings) {
    var btn = document.getElementById(BTN_ID);
    if (!btn) return;
    if (settings.position.indexOf('top') === 0) {
      var headerBottom = visibleHeaderBottom();
      // At page top with no measurable header (very custom theme markup),
      // assume a typical header height — overlapping the menu bar is the one
      // thing this button must never do. 16px only applies once scrolled.
      if (headerBottom === 0 && (window.scrollY || window.pageYOffset || 0) < 40) headerBottom = 72;
      var top = headerBottom > 0 ? headerBottom + 14 : 16;
      btn.style.setProperty('--appai-tray-top', Math.round(top) + 'px');
    } else {
      var bottom = 20;
      var bar = document.querySelector(
        '#preview-bar-iframe, #PBarNextFrame, iframe[src*="preview_bar"], iframe[src*="/tools/preview"]'
      );
      if (bar) {
        var br = bar.getBoundingClientRect();
        if (br.height > 0 && br.height < 200) bottom = Math.round(br.height) + 16;
      }
      btn.style.setProperty('--appai-tray-bottom', Math.round(bottom) + 'px');
    }
  }

  function startOffsetTracking(settings) {
    updateLauncherOffsets(settings);
    var ticking = false;
    var onScrollResize = function () {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(function () {
        ticking = false;
        updateLauncherOffsets(settings);
      });
    };
    if (settings.position.indexOf('top') === 0) {
      window.addEventListener('scroll', onScrollResize, { passive: true });
    }
    window.addEventListener('resize', onScrollResize);
    // The preview bar iframe (and some sticky headers) mount late — re-check
    // a few times after load rather than observing the whole DOM forever.
    setTimeout(function () { updateLauncherOffsets(settings); }, 1000);
    setTimeout(function () { updateLauncherOffsets(settings); }, 3000);
  }

  function buildTray() {
    var existing = document.getElementById(TRAY_ID);
    if (existing) return existing;

    var overlay = document.createElement('div');
    overlay.id = OVERLAY_ID;
    overlay.addEventListener('click', closeTray);
    document.body.appendChild(overlay);

    var tray = document.createElement('div');
    tray.id = TRAY_ID;
    tray.setAttribute('role', 'dialog');
    tray.setAttribute('aria-modal', 'true');
    tray.setAttribute('aria-label', 'Product customizer');

    var header = document.createElement('div');
    header.id = 'appai-tray-header';
    var title = document.createElement('h2');
    title.id = 'appai-tray-title';
    title.textContent = (_settings && _settings.label) || 'Product Customizer';
    var closeBtn = document.createElement('button');
    closeBtn.id = 'appai-tray-close';
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', 'Close customizer menu');
    closeBtn.innerHTML =
      '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" ' +
      'fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">' +
      '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
    closeBtn.addEventListener('click', closeTray);
    header.appendChild(title);
    header.appendChild(closeBtn);
    tray.appendChild(header);

    var body = document.createElement('div');
    body.id = 'appai-tray-body';
    tray.appendChild(body);

    document.body.appendChild(tray);
    return tray;
  }

  function currentPageHandle() {
    var m = window.location.pathname.match(/^\/pages\/([^/?#]+)/);
    return m ? m[1] : null;
  }

  function renderTrayBody() {
    var body = document.getElementById('appai-tray-body');
    if (!body) return;
    body.innerHTML = '';

    var pages = _pages || [];
    var here = currentPageHandle();

    // Saved designs first — only when the existing drawer is available
    // (customer logged in with >=1 design). Re-checked on every render
    // because the saved-designs script initialises asynchronously.
    if (typeof window.__APPAI_OPEN_SAVED_DESIGNS_DRAWER__ === 'function') {
      var savedLabel = document.createElement('div');
      savedLabel.className = 'appai-tray-section-label';
      savedLabel.textContent = 'Your designs';
      body.appendChild(savedLabel);

      var savedBtn = document.createElement('button');
      savedBtn.type = 'button';
      savedBtn.className = 'appai-tray-item';

      var sIcon = document.createElement('span');
      sIcon.className = 'appai-tray-item-icon';
      sIcon.innerHTML = ICON_BOOKMARK;

      var sText = document.createElement('span');
      sText.className = 'appai-tray-item-text';
      var sTitle = document.createElement('span');
      sTitle.className = 'appai-tray-item-title';
      sTitle.textContent = 'Saved Designs';
      sText.appendChild(sTitle);
      var count = (window.__APPAI_SAVED_DESIGNS__ || []).length;
      if (count > 0) {
        var sSub = document.createElement('span');
        sSub.className = 'appai-tray-item-sub';
        sSub.textContent = count + (count === 1 ? ' design' : ' designs');
        sText.appendChild(sSub);
      }

      savedBtn.appendChild(sIcon);
      savedBtn.appendChild(sText);
      savedBtn.insertAdjacentHTML('beforeend', ICON_CHEVRON);
      savedBtn.addEventListener('click', function () {
        closeTray();
        // Give the tray's close animation a beat so the drawer slides over cleanly.
        setTimeout(function () {
          try { window.__APPAI_OPEN_SAVED_DESIGNS_DRAWER__(); } catch (_) {}
        }, 120);
      });
      body.appendChild(savedBtn);
    }

    if (pages.length > 0) {
      var pagesLabel = document.createElement('div');
      pagesLabel.className = 'appai-tray-section-label';
      pagesLabel.textContent = 'Design your own';
      body.appendChild(pagesLabel);

      pages.forEach(function (p) {
        var isCurrent = p.handle === here;
        var a = document.createElement('a');
        a.className = 'appai-tray-item';
        a.href = '/pages/' + encodeURIComponent(p.handle);
        if (isCurrent) {
          a.setAttribute('aria-current', 'page');
          a.addEventListener('click', function (e) { e.preventDefault(); closeTray(); });
        }

        var icon = document.createElement('span');
        icon.className = 'appai-tray-item-icon';
        icon.innerHTML = ICON_BRUSH;

        var text = document.createElement('span');
        text.className = 'appai-tray-item-text';
        var titleEl = document.createElement('span');
        titleEl.className = 'appai-tray-item-title';
        titleEl.textContent = p.title || p.baseProductTitle || p.handle;
        text.appendChild(titleEl);
        var subText = isCurrent ? "You're here" : (p.baseProductTitle && p.baseProductTitle !== p.title ? p.baseProductTitle : '');
        if (subText) {
          var sub = document.createElement('span');
          sub.className = 'appai-tray-item-sub';
          sub.textContent = subText;
          text.appendChild(sub);
        }

        a.appendChild(icon);
        a.appendChild(text);
        if (!isCurrent) a.insertAdjacentHTML('beforeend', ICON_CHEVRON);
        body.appendChild(a);
      });
    } else {
      var empty = document.createElement('div');
      empty.id = 'appai-tray-empty';
      empty.textContent = 'No customizer pages are available right now.';
      body.appendChild(empty);
    }
  }

  function openTray() {
    buildTray();
    renderTrayBody();
    var overlay = document.getElementById(OVERLAY_ID);
    var tray = document.getElementById(TRAY_ID);
    overlay.classList.add('appai-open');
    tray.classList.add('appai-open');
    document.body.style.overflow = 'hidden';
    setTimeout(function () {
      var closeBtn = document.getElementById('appai-tray-close');
      if (closeBtn) closeBtn.focus();
    }, 330);
    // Background refresh so a just-published page appears without reload.
    fetchPages().then(function (pages) {
      if (pages.length !== (_pages || []).length) {
        _pages = pages;
        var tray2 = document.getElementById(TRAY_ID);
        if (tray2 && tray2.classList.contains('appai-open')) renderTrayBody();
      }
    });
  }

  function closeTray() {
    var tray = document.getElementById(TRAY_ID);
    var overlay = document.getElementById(OVERLAY_ID);
    if (tray) tray.classList.remove('appai-open');
    if (overlay) overlay.classList.remove('appai-open');
    document.body.style.overflow = '';
  }

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      var tray = document.getElementById(TRAY_ID);
      if (tray && tray.classList.contains('appai-open')) closeTray();
    }
  });

  // ─── Init ─────────────────────────────────────────────────────────────

  function init() {
    var settings = readSettings();
    _settings = settings;
    if (!settings.enabled) return;

    fetchPages().then(function (pages) {
      _pages = pages;
      // No active customizer pages → nothing to launch into; stay hidden.
      if (!pages || pages.length === 0) {
        console.log('[AppAI Tray] No active customizer pages; launcher hidden.');
        return;
      }
      var theme = extractTrayTheme();
      ensureStyles(theme, settings);
      buildLauncher(theme, settings);
      console.log('[AppAI Tray] Launcher ready with', pages.length, 'customizer page(s).');
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
