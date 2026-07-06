(function () {
  'use strict';

  // Global init guard — prevents the script from running more than once if the
  // liquid block is included in multiple theme sections.
  if (window.__APPAI_CUSTOMIZER_INIT__) {
    console.log('[AI Art Embed] Already initialised, skipping duplicate run.');
    return;
  }
  window.__APPAI_CUSTOMIZER_INIT__ = true;

  function appaiTransitionInner(mockupUrl, productName) {
    return ''
      + '<div class="appai-transition-inner">'
      + '<div class="appai-transition-title">Loading AI Art Studio</div>'
      + '</div>';
  }

  function appaiApplyTransitionDocumentState() {
    document.documentElement.style.background = '#f4f4f5';
    document.documentElement.style.overflowY = 'scroll';
    document.documentElement.style.scrollbarGutter = 'stable both-edges';
    if (document.body) {
      document.body.style.background = '#f4f4f5';
      document.body.style.overflowY = 'scroll';
      document.body.style.scrollbarGutter = 'stable both-edges';
    }
  }

  /** Normalize WheelEvent deltaMode (line/page) to pixels for parent scroll. */
  function appaiNormalizeWheelDelta(delta, deltaMode, pageSize) {
    var value = delta || 0;
    if (deltaMode === 1) return value * 16;
    if (deltaMode === 2) return value * (pageSize || 800);
    return value;
  }

  function appaiGetPageScrollElement() {
    var el = document.scrollingElement || document.documentElement;
    if (el && el.scrollHeight > el.clientHeight + 1) return el;
    var selectors = [
      '#MainContent', 'main', '[role="main"]', '.content-for-layout',
      '#PageContainer', '.shopify-section-group-main',
    ];
    for (var i = 0; i < selectors.length; i++) {
      try {
        var node = document.querySelector(selectors[i]);
        if (node && node.scrollHeight > node.clientHeight + 1) return node;
      } catch (e) {}
    }
    return el;
  }

  /** If the theme scrolls a wrapper around the embed (some Horizon layouts), find it. */
  function appaiScrollRootForEmbedIframe() {
    var iframe = document.querySelector('iframe[title="AI Art Design Studio"]');
    if (!iframe) return null;
    var node = iframe.parentElement;
    var depth = 0;
    while (node && node !== document.documentElement && depth < 16) {
      try {
        var st = window.getComputedStyle(node);
        var oy = st.overflowY;
        if (
          (oy === 'auto' || oy === 'scroll' || oy === 'overlay') &&
          node.scrollHeight > node.clientHeight + 1
        ) {
          return node;
        }
      } catch (e) {}
      node = node.parentElement;
      depth++;
    }
    return null;
  }

  /**
   * Write a scroll delta INSTANTLY, overriding the theme's CSS
   * `scroll-behavior: smooth` (Savor/Horizon/Ritual set it on the page
   * scroller). Per CSSOM, `el.scrollTop = x` respects that CSS and starts a
   * ~300ms smooth animation instead of jumping; writing every wheel tick (or
   * every animation frame) cancels-and-restarts that animation from a barely
   * moved position, so the page looks completely frozen. `behavior:'instant'`
   * explicitly bypasses the CSS.
   */
  function appaiInstantScrollBy(el, dy, dx) {
    try {
      el.scrollBy({ top: dy, left: dx, behavior: 'instant' });
      return;
    } catch (e) {}
    try {
      // Fallback for engines without 'instant': inline style beats the
      // theme's stylesheet, making the plain write land immediately.
      var prev = el.style.scrollBehavior;
      el.style.scrollBehavior = 'auto';
      el.scrollTop += dy;
      el.scrollLeft += dx;
      el.style.scrollBehavior = prev;
    } catch (e) {}
  }

  /** Can this element still scroll in the given wheel direction? */
  function appaiCanScroll(el, dy, dx) {
    if (!el) return false;
    if (dy < 0 && el.scrollTop > 0) return true;
    if (dy > 0 && el.scrollTop + el.clientHeight < el.scrollHeight - 1) return true;
    if (dx < 0 && el.scrollLeft > 0) return true;
    if (dx > 0 && el.scrollLeft + el.clientWidth < el.scrollWidth - 1) return true;
    return false;
  }

  // Smooth animator for DISCRETE wheel ticks (classic mouse wheel: one notch =
  // one big ~100px delta). Writing scrollTop += 100 in a single frame is a hard
  // visual step — the browser normally animates each native wheel tick over
  // ~150ms. We reproduce that: accumulate the remaining distance and move ~35%
  // of it per animation frame. Trackpads (many small per-frame deltas) bypass
  // this and keep instant 1:1 writes, so they stay perfectly responsive.
  var appaiWheelAnim = { el: null, remY: 0, remX: 0, raf: 0 };
  function appaiAnimateWheelScroll(el, dy, dx) {
    if (appaiWheelAnim.el !== el) {
      appaiWheelAnim.el = el;
      appaiWheelAnim.remY = 0;
      appaiWheelAnim.remX = 0;
    }
    appaiWheelAnim.remY += dy;
    appaiWheelAnim.remX += dx;
    if (appaiWheelAnim.raf) return;
    var step = function () {
      appaiWheelAnim.raf = 0;
      var a = appaiWheelAnim;
      if (!a.el) return;
      var moveY = Math.abs(a.remY) <= 1 ? a.remY : a.remY * 0.35;
      var moveX = Math.abs(a.remX) <= 1 ? a.remX : a.remX * 0.35;
      appaiInstantScrollBy(a.el, moveY, moveX);
      a.remY -= moveY;
      a.remX -= moveX;
      if (Math.abs(a.remY) >= 0.5 || Math.abs(a.remX) >= 0.5) {
        a.raf = requestAnimationFrame(step);
      } else {
        a.remY = 0;
        a.remX = 0;
      }
    };
    appaiWheelAnim.raf = requestAnimationFrame(step);
  }

  function appaiScrollParentPage(deltaX, deltaY, deltaMode) {
    var dy = appaiNormalizeWheelDelta(deltaY, deltaMode, window.innerHeight || 800);
    var dx = appaiNormalizeWheelDelta(deltaX, deltaMode, window.innerWidth || 1200);
    if (Math.abs(dy) < 0.01 && Math.abs(dx) < 0.01) return;

    // Discrete wheel notch (line/page mode, or a single large pixel jump) →
    // animate like the browser's native smooth wheel scroll. Small frequent
    // trackpad deltas stay instant.
    var smooth = deltaMode !== 0 || Math.abs(dy) >= 60 || Math.abs(dx) >= 60;

    // Prefer the MAIN page scroller so scrolling over the iframe feels exactly
    // like scrolling over normal page content (1:1 native speed). Writing
    // scrollTop directly bypasses any theme CSS scroll-behavior:smooth, which
    // would otherwise animate/lag each tick. Only fall back to a wrapper
    // scroller around the iframe when the page itself cannot move in the wheel
    // direction (themes that scroll an inner container instead of <html>).
    var pageEl = appaiGetPageScrollElement();
    var targetEl = null;
    if (appaiCanScroll(pageEl, dy, dx)) {
      targetEl = pageEl;
    } else {
      var embedRoot = appaiScrollRootForEmbedIframe();
      if (embedRoot && appaiCanScroll(embedRoot, dy, dx)) targetEl = embedRoot;
    }

    if (targetEl) {
      if (smooth) {
        appaiAnimateWheelScroll(targetEl, dy, dx);
      } else {
        appaiInstantScrollBy(targetEl, dy, dx);
      }
      return;
    }

    // Last resort: window.scrollBy (covers edge cases where scrollingElement
    // math is off) then a direct write to whatever scroller we resolved.
    try {
      window.scrollBy({ top: dy, left: dx, behavior: smooth ? 'smooth' : 'instant' });
      return;
    } catch (e) {}
    appaiInstantScrollBy(pageEl, dy, dx);
  }

  /**
   * LIVE mobile-mode check — deliberately NOT cached. Used both to decide
   * framing at mount/attach time AND, critically, INSIDE the wheel hijack
   * listener on every event (see below). Shopify's theme editor "mobile
   * preview" toggle resizes the SAME iframe without a reload, so any value
   * captured only once at mount/attach time goes stale the moment the
   * merchant toggles device preview. See docs/iframe-scroll-architecture.md
   * before changing this — do not reintroduce a cached/attach-time-only check.
   */
  function appaiIsMobileScrollMode() {
    try {
      return window.matchMedia('(pointer: coarse), (max-width: 767px)').matches;
    } catch (e) {
      return window.innerWidth <= 767;
    }
  }

  /** Same-origin app-proxy iframe: scroll parent directly (more reliable than postMessage). */
  function appaiAttachIframeWheelForward(iframe, mobileNativeScroll) {
    if (mobileNativeScroll || !iframe) return;
    // Authoritative mobile check — do NOT trust the caller's flag alone.
    // In mobile-native mode the iframe is a fixed viewport-height box that
    // scrolls its own content; hijacking wheel here would scroll only the
    // store page and make the lower iframe content unreachable (seen in
    // Shopify's desktop mobile preview, where wheel input + narrow viewport
    // combine). cleanupDuplicateGenerators() used to pass `false` blindly.
    if (appaiIsMobileScrollMode()) return;
    if (iframe.getAttribute('data-appai-wheel-forward') === '1') return;
    iframe.setAttribute('data-appai-wheel-forward', '1');
    var tryAttach = function () {
      var doc;
      try { doc = iframe.contentDocument; } catch (e) { return; }
      if (!doc || !doc.documentElement) return;
      if (doc.documentElement.getAttribute('data-appai-wheel-forward-doc') === '1') {
        try { iframe.contentWindow.__APPAI_PARENT_WHEEL_FORWARD__ = true; } catch (e) {}
        return;
      }
      doc.documentElement.setAttribute('data-appai-wheel-forward-doc', '1');
      try { iframe.contentWindow.__APPAI_PARENT_WHEEL_FORWARD__ = true; } catch (e) {}
      doc.addEventListener('wheel', function (e) {
        // LIVE re-check (not just at attach time): if the theme editor's
        // mobile-preview toggle has since narrowed the viewport, this listener
        // may still be attached (it is never removed — see
        // docs/iframe-scroll-architecture.md), but it must act as a no-op so
        // the iframe's own internal scroll (mobile-native mode) takes over.
        if (appaiIsMobileScrollMode()) return;
        var target = e.target;
        // Open Radix overlays (dropdowns, popovers) always scroll internally.
        if (target && target.closest && target.closest(
          '[data-radix-select-content],[data-radix-popper-content-wrapper],[data-radix-dropdown-menu-content],[data-radix-popover-content]'
        )) {
          return;
        }
        // Opt-in inner-scroll panels scroll internally only while they can
        // still move in the wheel direction; at their boundary the wheel
        // hands off to the parent page (no dead zone).
        var inner = target && target.closest ? target.closest('[data-appai-inner-scroll]') : null;
        if (inner) {
          var canY = e.deltaY < 0 ? inner.scrollTop > 0
            : inner.scrollTop + inner.clientHeight < inner.scrollHeight - 1;
          var canX = e.deltaX < 0 ? inner.scrollLeft > 0
            : inner.scrollLeft + inner.clientWidth < inner.scrollWidth - 1;
          if ((e.deltaY && canY) || (e.deltaX && canX)) return;
        }
        appaiScrollParentPage(e.deltaX, e.deltaY, e.deltaMode);
        e.preventDefault();
      }, { passive: false, capture: true });
    };
    var retryAttach = function () {
      tryAttach();
    };
    if (!window.__appaiWheelRetryByIframe) window.__appaiWheelRetryByIframe = [];
    window.__appaiWheelRetryByIframe.push({ iframe: iframe, retry: retryAttach });
    if (!window.__appaiWheelBridgeListener) {
      window.__appaiWheelBridgeListener = true;
      window.addEventListener('message', function (e) {
        if (!e.data || e.data.type !== 'AI_ART_STUDIO_BRIDGE_ACK') return;
        var list = window.__appaiWheelRetryByIframe || [];
        for (var i = 0; i < list.length; i++) {
          if (list[i] && list[i].retry) list[i].retry();
        }
      });
    }
    iframe.addEventListener('load', tryAttach);
    tryAttach();
  }

  function appaiStyleTransitionOverlay(overlay) {
    overlay.style.cssText = [
      'position:fixed',
      'inset:0',
      'z-index:2147483647',
      'background:#f4f4f5',
      'display:flex',
      'align-items:center',
      'justify-content:center',
      'padding:24px',
      'box-sizing:border-box',
      'opacity:1',
      'visibility:visible',
      'transition:none',
      'pointer-events:auto',
      'transform:none'
    ].join(';') + ';';
  }

  function appaiBuildTransitionInner() {
    var inner = document.createElement('div');
    inner.className = 'appai-transition-inner';
    inner.style.cssText = 'display:flex;align-items:center;justify-content:center;width:min(92vw,760px);text-align:center;';
    var title = document.createElement('div');
    title.className = 'appai-transition-title';
    title.textContent = 'Loading AI Art Studio';
    title.style.cssText = [
      'margin:0',
      'display:inline-block',
      'padding:0.08em 0.04em 0.14em',
      'font:800 34px/1.18 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif',
      'letter-spacing:-0.04em',
      'text-align:center',
      'background:linear-gradient(90deg,#111827 0%,#111827 35%,#d1d5db 50%,#111827 65%,#111827 100%)',
      'background-size:200% auto',
      '-webkit-background-clip:text',
      'background-clip:text',
      '-webkit-text-fill-color:transparent',
      'color:transparent',
      'animation:appai-transition-title-shimmer 2.4s linear infinite'
    ].join(';') + ';';
    inner.appendChild(title);
    return inner;
  }

  function appaiEnsureTransitionStyles() {
    if (document.getElementById('appai-transition-styles')) return;
    var style = document.createElement('style');
    style.id = 'appai-transition-styles';
    style.textContent = [
      '@keyframes appai-transition-title-shimmer{0%{background-position:200% center}100%{background-position:-200% center}}',
      'html:has(#appai-nav-transition),body:has(#appai-nav-transition){scrollbar-gutter:stable both-edges;}',
      'html:has(#appai-nav-transition),body:has(#appai-nav-transition){overflow-y:scroll;}',
      '#appai-nav-transition{position:fixed;inset:0;z-index:2147483647;background:#f4f4f5;display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box;}',
      '.appai-transition-inner{display:flex;align-items:center;justify-content:center;width:min(92vw,760px);text-align:center;}',
      '.appai-transition-title{margin:0;display:inline-block;padding:0.08em 0.04em 0.14em;font:800 34px/1.18 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;letter-spacing:-0.04em;background:linear-gradient(90deg,#111827 0%,#111827 35%,#d1d5db 50%,#111827 65%,#111827 100%);background-size:200% auto;-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;color:transparent;animation:appai-transition-title-shimmer 2.4s linear infinite;}',
      '@media(max-width:640px){.appai-transition-title{font-size:28px;}}',
    ].join('');
    document.head.appendChild(style);
  }

  function appaiAttachTransitionOverlay(overlay) {
    var root = document.documentElement || document.body;
    if (document.body && root === document.documentElement && document.body.parentNode === root) {
      root.insertBefore(overlay, document.body);
    } else {
      root.appendChild(overlay);
    }
  }

  function appaiShowTransitionOverlay() {
    appaiEnsureTransitionStyles();
    appaiApplyTransitionDocumentState();
    var overlay = document.getElementById('appai-nav-transition');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'appai-nav-transition';
      overlay.setAttribute('aria-hidden', 'true');
      overlay.appendChild(appaiBuildTransitionInner());
      appaiAttachTransitionOverlay(overlay);
    } else if (!overlay.querySelector('.appai-transition-title')) {
      overlay.innerHTML = '';
      overlay.appendChild(appaiBuildTransitionInner());
    }
    appaiStyleTransitionOverlay(overlay);
    void overlay.offsetHeight;
    return overlay;
  }

  function appaiAfterTransitionPaint(cb) {
    if (window.requestAnimationFrame) {
      window.requestAnimationFrame(function () {
        window.requestAnimationFrame(cb);
      });
    } else {
      window.setTimeout(cb, 32);
    }
  }

  function appaiShowSavedDesignTransitionFromUrl() {
    try {
      var params = new URLSearchParams(window.location.search);
      var loadDesignId = params.get('loadDesignId') || '';
      if (!loadDesignId || document.getElementById('appai-nav-transition')) return;
      appaiShowTransitionOverlay();
    } catch (e) {}
  }

  window.addEventListener('message', function(event) {
    var data = event && event.data;
    if (!data || data.type !== 'AI_ART_STUDIO_SHOW_TRANSITION') return;
    try {
      appaiShowTransitionOverlay();
      appaiAfterTransitionPaint(function () {
        try {
          if (event.source && event.source.postMessage) {
            event.source.postMessage({
              type: 'AI_ART_STUDIO_TRANSITION_SHOWN',
              requestId: data.requestId || ''
            }, event.origin || '*');
          }
        } catch (replyError) {}
      });
    } catch (e) {
      try {
        if (event.source && event.source.postMessage) {
          event.source.postMessage({
            type: 'AI_ART_STUDIO_TRANSITION_SHOWN',
            requestId: data.requestId || '',
            error: true
          }, event.origin || '*');
        }
      } catch (replyError) {}
    }
  });

  appaiShowSavedDesignTransitionFromUrl();

  console.log('[AI Art Embed] Script starting...');

  // Customer ID is available if the customer is logged in on the storefront.
  // Anonymous generation is allowed — login is only required for saving designs.
  var customerId = (function () {
    var el = document.getElementById('appai-root');
    var raw = el && el.getAttribute('data-customer-id');
    if (!raw) return null;
    var n = Number(raw);
    return Number.isFinite(n) ? n : raw;
  })();




  /**
   * Ritual/Horizon-family sticky-header watchdog. The theme's
   * <header-component sticky="scroll-up"> hides the header with opacity:0
   * while scrolling down and reveals it on sustained upward scroll. Quick
   * wheel direction changes that end back AT THE VERY TOP can strand its
   * state machine at data-sticky-state="idle" + opacity:0 — an invisible
   * menu at scroll position 0 with no scroll room left to trigger the
   * reveal. Reproduced on Ritual's homepage with ALL app scripts blocked,
   * so it is a theme bug — but customers hit it constantly while wheel-
   * scrolling over the customizer iframe, so we heal it: if the header sits
   * at its natural top position yet is still hidden in "idle" for two
   * consecutive ticks (~0.8s), reset it to "inactive" (the theme's own
   * resting state at the top). No-op mid-page (rect.top is negative there)
   * and on themes without <header-component sticky> (e.g. Dawn).
   */
  function appaiInstallStickyHeaderWatchdog() {
    var armed = false;
    setInterval(function () {
      try {
        var hc = document.querySelector('header-component[sticky]');
        if (!hc || hc.getAttribute('data-sticky-state') !== 'idle') { armed = false; return; }
        var r = hc.getBoundingClientRect();
        var stuck = r.height > 0 && r.top > -4 && getComputedStyle(hc).opacity === '0';
        if (stuck && armed) {
          console.log('[AI Art Embed] Sticky-header watchdog: header stuck hidden at top, resetting to inactive.');
          hc.setAttribute('data-sticky-state', 'inactive');
          armed = false;
        } else {
          armed = stuck;
        }
      } catch (e) { armed = false; }
    }, 400);
  }
  appaiInstallStickyHeaderWatchdog();

  // Cart image replacement is now handled by appai-cart-images.js (loaded via script tag above).
  // Only run product page logic on product pages
  var isProductPage = window.location.pathname.includes('/products/') || 
                      window.location.pathname.includes('/products_preview');
  
  if (!isProductPage) {
    var _cpMatch = window.location.pathname.match(/^\/pages\/([^/?#]+)/);
    if (_cpMatch) {
      // Set flag synchronously NOW so appai-customizer-embed.js can never race with us
      window.__APPAI_CUSTOMIZER_HANDLED = true;
      console.log('[AI Art Embed] Customizer page detected, handle:', _cpMatch[1]);
      initCustomizerPage(_cpMatch[1]);
    } else {
      console.log('[AI Art Embed] Not a product or customizer page. Path:', window.location.pathname);
    }
    return;
  }
  console.log('[AI Art Embed] On product page, continuing...');
  
  // Set up GLOBAL message listener for mockups - runs regardless of how embed was added
  console.log('[AI Art Embed] Setting up global message listener...');
  window.addEventListener('message', function(event) {
    // Only process our message types
    if (!event.data || !event.data.type) return;
    
    // Log messages from our app
    if (event.data.type === 'AI_ART_STUDIO_MOCKUPS' || 
        (event.data.type && event.data.type.indexOf('ai-art-studio') !== -1)) {
      console.log('[AI Art Embed] Global listener received:', event.data.type, 'from:', event.origin);
    }

    // Wheel postMessage is handled once in createDesignStudio's trusted listener below.

    // Handle mockup updates from Railway app origin
    if (event.data.type === 'AI_ART_STUDIO_MOCKUPS') {
      // Security: only accept from Railway or localhost origins
      var isRailway = event.origin.indexOf('railway.app') !== -1;
      var isLocalhost = event.origin.indexOf('localhost') !== -1 || event.origin.indexOf('127.0.0.1') !== -1;
      if (!isRailway && !isLocalhost) {
        console.log('[AI Art Embed] Ignoring mockups from untrusted origin:', event.origin);
        return;
      }
      
      var mockupUrls = event.data.mockupUrls;
      console.log('[AI Art Embed] MOCKUPS received — count:', mockupUrls ? mockupUrls.length : 0, 'origin:', event.origin);
      if (!mockupUrls || mockupUrls.length === 0) {
        console.log('[AI Art Embed] No mockup URLs in message');
        return;
      }
      
      // Persist to sessionStorage so page refresh doesn't lose them
      try { sessionStorage.setItem('appai_mockups', JSON.stringify(mockupUrls)); } catch(e) {}
      
      console.log('[AI Art Embed] Processing', mockupUrls.length, 'mockups — URLs:', mockupUrls.map(function(u) { return u.substring(0, 80); }));

      // Hide the placeholder (it was shown while generating)
      var phEl = document.getElementById('ai-art-placeholder');
      if (phEl) phEl.style.display = 'none';

      // Ensure the native gallery is hidden (in case placeholder wasn't created)
      var nativeGallery = aiArtNativeGallery; // prefer the one already found by createPlaceholderGallery
      if (!nativeGallery) {
        var ngSelectors = [
          '.product__media-wrapper', '.product__media-gallery',
          '.product-single__photos', '.product__images',
          '.product-gallery', '.product__photo-container',
          '.product-images', '.product-media',
          '[data-product-media-container]', '[data-product-images]',
          '[data-media-gallery]', '.product__media-list',
          '.product__media', '.product-single__media-wrapper',
          '.product-featured-media'
        ];
        for (var i = 0; i < ngSelectors.length; i++) {
          nativeGallery = document.querySelector(ngSelectors[i]);
          if (nativeGallery) {
            nativeGallery.style.display = 'none';
            break;
          }
        }
      }

      // Create or update our custom gallery
      var customGallery = document.getElementById('ai-art-custom-gallery');
      if (!customGallery) {
        customGallery = document.createElement('div');
        customGallery.id = 'ai-art-custom-gallery';
        customGallery.style.cssText = 'width:100%;max-width:600px;margin-bottom:20px;';

        // Main image container
        var mainImageContainer = document.createElement('div');
        mainImageContainer.id = 'ai-art-main-image';
        mainImageContainer.style.cssText = 'width:100%;aspect-ratio:1/1;background:#f5f5f5;border-radius:8px;overflow:hidden;margin-bottom:12px;';

        var mainImg = document.createElement('img');
        mainImg.id = 'ai-art-main-img';
        mainImg.style.cssText = 'width:100%;height:100%;object-fit:contain;';
        mainImg.alt = 'Your custom design mockup';
        mainImageContainer.appendChild(mainImg);
        customGallery.appendChild(mainImageContainer);

        // Thumbnails container
        var thumbsContainer = document.createElement('div');
        thumbsContainer.id = 'ai-art-thumbs';
        thumbsContainer.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-start;';
        customGallery.appendChild(thumbsContainer);

        // Insert where the placeholder was, or before the hidden native gallery
        var insertRef = phEl || nativeGallery;
        if (insertRef && insertRef.parentNode) {
          insertRef.parentNode.insertBefore(customGallery, insertRef);
        } else {
          var productArea = document.querySelector('.product') ||
                           document.querySelector('[data-product]') ||
                           document.querySelector('main');
          if (productArea) productArea.insertBefore(customGallery, productArea.firstChild);
        }
        console.log('[AI Art Embed] Created custom gallery');
      }
      
      // Update main image
      var mainImg = document.getElementById('ai-art-main-img');
      if (mainImg) {
        mainImg.src = mockupUrls[0];
        console.log('[AI Art Embed] Set main image to first mockup');
      }
      
      // Update thumbnails
      var thumbsContainer = document.getElementById('ai-art-thumbs');
      if (thumbsContainer) {
        thumbsContainer.innerHTML = '';
        
        mockupUrls.forEach(function(url, index) {
          var thumb = document.createElement('div');
          thumb.className = 'ai-art-thumb';
          thumb.style.cssText = 'width:70px;height:70px;cursor:pointer;border:2px solid ' + (index === 0 ? '#000' : '#ddd') + ';border-radius:6px;overflow:hidden;transition:border-color 0.2s;';
          
          var thumbImg = document.createElement('img');
          thumbImg.src = url;
          thumbImg.alt = 'View ' + (index + 1);
          thumbImg.style.cssText = 'width:100%;height:100%;object-fit:cover;';
          thumb.appendChild(thumbImg);
          
          thumb.onclick = function() {
            // Update main image
            if (mainImg) mainImg.src = url;
            
            // Update thumbnail borders
            var allThumbs = thumbsContainer.querySelectorAll('.ai-art-thumb');
            allThumbs.forEach(function(t) { t.style.borderColor = '#ddd'; });
            thumb.style.borderColor = '#000';
            
            console.log('[AI Art Embed] Selected mockup', index + 1);
          };
          
          thumbsContainer.appendChild(thumb);
        });
        
        console.log('[AI Art Embed] Added', mockupUrls.length, 'thumbnails below main image');
      }
      
    }
  });
  
  // Skip if already initialized (either auto-embed or mounted into app block)
  if (document.getElementById('ai-art-studio-auto-embed') ||
      document.querySelector('[data-embed-handled="true"]')) {
    console.log('[AI Art Embed] Already initialized, skipping');
    return;
  }

  // Skip if there's already an iframe from body_html (legacy products)
  var existingIframe = document.querySelector('#ai-art-studio-container iframe, iframe[title="AI Design Studio"]');
  if (existingIframe) {
    console.log('[AI Art Embed] Found existing iframe in body_html, skipping auto-embed');
    return;
  }

  function hideNativeAddToCart() {
    const selectors = [
      'form[action="/cart/add"]',
      '.product-form__submit',
      '.product-form__buttons',
      '[data-add-to-cart]',
      '.add-to-cart',
      '#AddToCart',
      '.shopify-payment-button',
      '.product__submit',
      'button[name="add"]',
      '.product-form__cart-submit'
    ];
    
    selectors.forEach(selector => {
      document.querySelectorAll(selector).forEach(el => {
        if (!el.closest('.ai-art-studio-embed')) {
          el.style.display = 'none';
        }
      });
    });
    
    const productForms = document.querySelectorAll('form[action*="/cart/add"]');
    productForms.forEach(form => {
      if (!form.closest('.ai-art-studio-embed')) {
        form.style.display = 'none';
      }
    });
  }
  
  function createDesignStudio(config) {
    // Shopify.installations + our DB use *.myshopify.com; window.Shopify.shop is often only the handle.
    function normaliseMyshopifyShopForApi(raw) {
      var s = String(raw || '').trim();
      if (!s) {
        try {
          var root = document.getElementById('appai-root');
          var ds = root && root.getAttribute('data-shop');
          if (ds) s = String(ds).trim();
        } catch (e) {}
      }
      if (!s) return '';
      var lower = s.toLowerCase();
      if (lower.indexOf('.myshopify.com') !== -1) return lower;
      if (/^[a-z0-9][a-z0-9-]*$/i.test(s)) return lower + '.myshopify.com';
      return lower;
    }

    // ── Single-mount logic ──────────────────────────────────────────────
    // If the merchant added the "AI Art Design Studio" app block to this
    // page template, its container already exists in the DOM.  Mount the
    // iframe there and skip creating a second auto-embed container.
    var existingBlock =
      document.querySelector('.ai-art-studio-block [id^="ai-art-studio-container-"]') ||
      document.querySelector('[data-block-handle="ai-art-studio"] .ai-art-studio__container') ||
      document.querySelector('[data-block-handle="ai-art-studio"]');
    var container, studioContainer;
    var mobileNativeScroll = appaiIsMobileScrollMode();
    function appaiMobileFrameHeight() {
      var h = window.visualViewport && window.visualViewport.height ? window.visualViewport.height : window.innerHeight;
      return Math.max(520, Math.floor(h - 24));
    }
    function applyMobileNativeScrollFrame() {
      if (!mobileNativeScroll || !studioContainer) return;
      studioContainer.style.height = appaiMobileFrameHeight() + 'px';
      studioContainer.style.overflow = 'hidden';
      studioContainer.style.webkitOverflowScrolling = 'touch';
    }
    // Undo mobile framing when switching back to desktop mode live (theme
    // editor toggle). 600px matches the container's pre-mount default so
    // there is no flash of collapsed height before the iframe's first
    // ai-art-studio:resize report lands and drives the real height.
    function clearMobileNativeScrollFrame() {
      if (!studioContainer) return;
      studioContainer.style.height = '600px';
      studioContainer.style.overflow = '';
      studioContainer.style.webkitOverflowScrolling = '';
    }

    const urlParams = new URLSearchParams(window.location.search);
    const transitionDesignId = urlParams.get('loadDesignId') || '';

    function appaiLoadingInner() {
      return '<p class="ai-art-studio-embed__loading-title">Loading AI Art Studio</p>';
    }

    function ensureAppaiLoadingCover() {
      if (transitionDesignId && !document.getElementById('appai-nav-transition')) {
        appaiShowTransitionOverlay();
      }
      if (!studioContainer || studioContainer.querySelector('.ai-art-studio-embed__loading')) return;
      try {
        var position = window.getComputedStyle(studioContainer).position;
        if (!position || position === 'static') studioContainer.style.position = 'relative';
      } catch (e) {
        studioContainer.style.position = 'relative';
      }
      var loading = document.createElement('div');
      loading.className = 'ai-art-studio-embed__loading';
      loading.style.cssText = 'display:flex;align-items:center;justify-content:center;background:#f4f4f5;';
      loading.innerHTML = appaiLoadingInner();
      studioContainer.appendChild(loading);
    }

    function removeAppaiLoadingCover() {
      var loadingEl = studioContainer && studioContainer.querySelector('.ai-art-studio-embed__loading');
      if (loadingEl) {
        loadingEl.style.transition = 'opacity 0.2s ease';
        loadingEl.style.opacity = '0';
        setTimeout(function() { if (loadingEl.parentNode) loadingEl.remove(); }, 220);
      }
      try {
        var fullCover = document.getElementById('appai-nav-transition');
        if (fullCover) {
          fullCover.style.transition = 'opacity 0.2s ease';
          fullCover.style.opacity = '0';
          setTimeout(function() { if (fullCover.parentNode) fullCover.remove(); }, 220);
        }
        var bootCover = document.getElementById('appai-boot');
        if (bootCover) {
          bootCover.style.transition = 'opacity 0.2s ease';
          bootCover.style.opacity = '0';
          setTimeout(function() { if (bootCover.parentNode) bootCover.remove(); }, 220);
        }
      } catch (e) {}
    }

    if (existingBlock) {
      console.log('[AI Art Embed] Found existing app block container, mounting into it.');
      // Clear the block's "Loading design studio…" placeholder
      existingBlock.innerHTML = '';
      studioContainer = existingBlock;
      container = existingBlock.closest('.ai-art-studio-block') || existingBlock;
      // Mark it so the block's own inline script doesn't also create an iframe
      existingBlock.setAttribute('data-embed-handled', 'true');
    } else {
      container = document.createElement('div');
      container.className = 'ai-art-studio-embed';
      container.id = 'ai-art-studio-auto-embed';
      container.innerHTML = `
        <div class="ai-art-studio-embed__wrapper">
          <div class="ai-art-studio-embed__studio" style="height:600px;">
            <div class="ai-art-studio-embed__loading" style="display:flex;align-items:center;justify-content:center;background:#f4f4f5;">
              ${appaiLoadingInner()}
            </div>
          </div>
        </div>
      `;
      studioContainer = container.querySelector('.ai-art-studio-embed__studio');
    }
    ensureAppaiLoadingCover();
    applyMobileNativeScrollFrame();
    // Registered unconditionally (not gated on the mount-time mode) because
    // mobileNativeScroll can flip live via the matchMedia 'change' listener
    // below (Shopify theme editor mobile-preview toggle). The function itself
    // no-ops when not currently in mobile mode, so this is a cheap no-op most
    // of the time on desktop.
    var resizeFrame = function() { applyMobileNativeScrollFrame(); };
    window.addEventListener('resize', resizeFrame, { passive: true });
    if (window.visualViewport) window.visualViewport.addEventListener('resize', resizeFrame, { passive: true });
    
    const params = new URLSearchParams();
    params.set('shop', normaliseMyshopifyShopForApi(config.shopDomain));
    params.set('productTypeId', config.productTypeId);
    params.set('productId', config.productId);
    params.set('productHandle', config.productHandle);
    params.set('productTitle', config.productTitle);
    params.set('displayName', config.displayName);
    params.set('showPresets', 'true');
    if (config.selectedVariant) {
      params.set('selectedVariant', config.selectedVariant);
    }
    if (mobileNativeScroll) {
      params.set('mobileNativeScroll', '1');
    }
    // Large Printify imports (for example Bella+Canvas 3001) can have hundreds
    // of variants. Send designerConfig over postMessage instead of putting it
    // in the iframe URL, which can exceed browser/proxy URL limits.
    if (config.inlineDesignerConfig) {
      params.set('deferDesignerConfig', '1');
    }
    
    if (customerId) {
      params.set('customerId', String(customerId));
    }
    
    const sharedDesignId = urlParams.get('sharedDesignId');
    if (sharedDesignId) {
      params.set('sharedDesignId', sharedDesignId);
    }
    const loadDesignId = urlParams.get('loadDesignId');
    if (loadDesignId) {
      params.set('loadDesignId', loadDesignId);
    }
    const loadMockup = urlParams.get('loadMockup');
    if (loadMockup) {
      params.set('loadMockup', loadMockup);
    }
    // Set by the customizer tray's "Sign in" item when navigating here from a
    // page without a designer iframe — opens the OTP sign-in panel on load.
    if (urlParams.get('openSignIn') === '1') {
      params.set('openSignIn', '1');
    }
    
    const iframe = document.createElement('iframe');
    // Use App Proxy path so the iframe loads on the Shopify domain (first-party, no cross-origin fetch issues).
    // Shopify proxies /apps/appai/* → Railway /api/proxy/*, so the iframe and its API calls are same-origin.
    iframe.src = `${window.location.origin}/apps/appai/s/designer?${params.toString()}`;
    iframe.allow = 'clipboard-write; popups';
    iframe.title = 'AI Art Design Studio';
    iframe.style.cssText = 'width: 100%; height: 100%; border: none; overflow: hidden; display: block;';
    iframe.setAttribute('scrolling', mobileNativeScroll ? 'yes' : 'no');
    
    iframe.onload = function() {
      // Loading screen is removed on BRIDGE_ACK (when React app is fully mounted),
      // not here — iframe.onload fires before the React app has rendered.
      appaiAttachIframeWheelForward(iframe, mobileNativeScroll);
    };
    
    studioContainer.appendChild(iframe);

    // ── Live scroll-mode switching ──────────────────────────────────────
    // Shopify's theme editor "mobile preview" toggle resizes the SAME iframe
    // WITHOUT a reload, so the mode decided above at mount can go stale the
    // moment the merchant toggles device preview. Convert the running iframe
    // live on the matchMedia breakpoint crossing. Do NOT remove this without
    // re-testing scripts/diagnose-resize.ts — see
    // docs/iframe-scroll-architecture.md.
    try {
      var appaiScrollModeMql = window.matchMedia('(pointer: coarse), (max-width: 767px)');
      var appaiOnScrollModeChange = function (isMobileNow) {
        if (isMobileNow === mobileNativeScroll) return;
        mobileNativeScroll = isMobileNow;
        if (mobileNativeScroll) {
          applyMobileNativeScrollFrame();
        } else {
          clearMobileNativeScrollFrame();
          // If the page originally mounted in mobile mode, the wheel hijack
          // was never attached at all (its attach-time guard returned
          // immediately) — attach it now that we're live in desktop mode.
          appaiAttachIframeWheelForward(iframe, false);
        }
        try {
          iframe.setAttribute('scrolling', mobileNativeScroll ? 'yes' : 'no');
        } catch (e) {}
        try {
          iframe.contentWindow.postMessage(
            { type: 'ai-art-studio:set-scroll-mode', mobile: mobileNativeScroll },
            '*'
          );
        } catch (e) {}
      };
      if (appaiScrollModeMql.addEventListener) {
        appaiScrollModeMql.addEventListener('change', function (e) { appaiOnScrollModeChange(e.matches); });
      } else if (appaiScrollModeMql.addListener) {
        appaiScrollModeMql.addListener(function (e) { appaiOnScrollModeChange(e.matches); }); // Safari <14
      }
    } catch (e) {}

    // ================================================================
    // Theme extraction — reads computed styles from the live storefront DOM
    // and builds a plain object for injection into the iframe CSS variables.
    // Works with any Shopify theme (Dawn, custom, etc.) without relying on
    // theme-specific CSS variable names.
    // ================================================================
    function extractStoreTheme() {
      var theme = {};
      try {
        var body = document.body;
        var cs = getComputedStyle(body);

        // Body background and text
        theme.backgroundColor = cs.backgroundColor;
        theme.textColor = cs.color;
        theme.fontFamily = cs.fontFamily;
        theme.fontSize = cs.fontSize;

        // Primary button: try Shopify standard selectors then fall back broadly
        var btn = document.querySelector(
          'button[name="add"], .product-form__submit, .shopify-payment-button__button, ' +
          'button.btn--primary, .btn--filled, button.button--primary, .product-form button[type="submit"]'
        );
        if (!btn) btn = document.querySelector('button[type="submit"]');
        if (btn) {
          var bcs = getComputedStyle(btn);
          theme.buttonBg = bcs.backgroundColor;
          theme.buttonColor = bcs.color;
          theme.buttonRadius = bcs.borderRadius;
          theme.buttonFontSize = bcs.fontSize;
          theme.buttonFontWeight = bcs.fontWeight;
          theme.buttonFontFamily = bcs.fontFamily;
          theme.buttonBorderColor = bcs.borderColor;
          theme.buttonBorderWidth = bcs.borderWidth;
          theme.buttonLetterSpacing = bcs.letterSpacing;
          theme.buttonTextTransform = bcs.textTransform;
        }

        // Headings
        var h1 = document.querySelector('.product__title, h1.product-single__title, h1');
        if (!h1) h1 = document.querySelector('h1, h2');
        if (h1) {
          var hcs = getComputedStyle(h1);
          theme.headingFontFamily = hcs.fontFamily;
          theme.headingFontWeight = hcs.fontWeight;
          theme.headingColor = hcs.color;
          theme.headingLetterSpacing = hcs.letterSpacing;
          theme.headingTextTransform = hcs.textTransform;
        }

        // Inputs / form fields
        var input = document.querySelector(
          'input.field__input, .product-form input[type="text"], ' +
          '.product-form select, input[type="email"], input[type="text"]'
        );
        if (input) {
          var ics = getComputedStyle(input);
          theme.inputBg = ics.backgroundColor;
          theme.inputBorderColor = ics.borderColor;
          theme.inputRadius = ics.borderRadius;
          theme.inputColor = ics.color;
          theme.inputFontFamily = ics.fontFamily;
          theme.inputFontSize = ics.fontSize;
          theme.inputFontWeight = ics.fontWeight;
        }

        // Links / accent color
        var link = document.querySelector('a:not([class*="btn"]):not([class*="button"]):not([class*="nav"])');
        if (link) {
          theme.accentColor = getComputedStyle(link).color;
        }

        // Card / section background (for the app's card backgrounds)
        var section = document.querySelector('.product, .product-single, section.product__info, main');
        if (section) {
          theme.sectionBg = getComputedStyle(section).backgroundColor;
        }

        console.log('[AI Art Bridge] Extracted store theme:', JSON.stringify(theme).substring(0, 200));
      } catch (e) {
        console.warn('[AI Art Bridge] extractStoreTheme error:', e);
      }
      return theme;
    }

    // ================================================================
    // AI Art Bridge v1.0.0 — Production-grade storefront bridge
    // ================================================================
    var BRIDGE_VERSION = '1.0.0';
    window.AI_ART_STUDIO_BRIDGE_VERSION = BRIDGE_VERSION;

    var B = '[AI Art Bridge]'; // log prefix
    console.log(B, 'Installing bridge', BRIDGE_VERSION, 'appUrl:', config.appUrl);

    // Fling canceller: replaced each time a new fling starts so old ones self-stop.
    var stopFling = function() {};
    var googleAuthPopupRef = null;
    var googleAuthPopupPoll = null;

    // --- Compute iframe's effective origin ---
    // In App Proxy mode iframe.src is relative (/apps/appai/s/designer?...),
    // so new URL(iframe.src) resolves against page origin → Shopify domain.
    // In direct-Railway mode iframe.src is absolute → Railway origin.
    var iframeOrigin = '';
    try { iframeOrigin = new URL(iframe.src, window.location.href).origin; } catch(e) {}

    var appOrigin = '';
    try { appOrigin = new URL(config.appUrl).origin; } catch(e) {}

    // --- Strict origin allowlist ---
    var ALLOWED_ORIGINS = [
      iframeOrigin,
      appOrigin,
      window.location.origin
    ].filter(function(v, i, a) { return v && a.indexOf(v) === i; });
    console.log(B, 'Allowed origins:', ALLOWED_ORIGINS, 'iframeOrigin:', iframeOrigin);

    // --- Origin validation ---
    function isFromOurIframe(event) {
      try { return event.source === iframe.contentWindow; } catch(e) { return false; }
    }

    function isCentralAuthOrigin(origin) {
      if (!origin || origin === 'null') return false;
      try {
        var host = new URL(origin).hostname;
        if (host.endsWith('.railway.app')) return true;
        if (host === 'aiartstudio.app' || host.endsWith('.aiartstudio.app')) return true;
        if (appOrigin && origin === appOrigin) return true;
        return false;
      } catch (e) { return false; }
    }

    function isAllowedOrigin(origin) {
      if (!origin || origin === 'null') return false;
      if (ALLOWED_ORIGINS.indexOf(origin) !== -1) return true;
      if (isCentralAuthOrigin(origin)) return true;
      return false;
    }

    function isTrustedMessage(event) {
      // 1) Source identity — most reliable, works with "null" origins from Shopify CDN proxy
      if (isFromOurIframe(event)) return true;
      // 2) Origin in allowlist
      if (isAllowedOrigin(event.origin)) return true;
      // 3) Null origin with our protocol prefix (Shopify CDN/proxy rewrites)
      if ((!event.origin || event.origin === 'null') &&
          event.data && typeof event.data.type === 'string' &&
          event.data.type.indexOf('AI_ART_STUDIO') === 0) {
        console.log(B, 'Accepting null-origin AI_ART_STUDIO message:', event.data.type);
        return true;
      }
      return false;
    }

    // --- Reply helper: always reply via event.source + strict origin ---
    function replyToIframe(eventOrNull, msg) {
      var targets = [];
      // Prefer event.source + event.origin (spec-correct)
      if (eventOrNull && eventOrNull.source) {
        var replyOrigin = isAllowedOrigin(eventOrNull.origin) ? eventOrNull.origin : (iframeOrigin || '*');
        targets.push({ target: eventOrNull.source, origin: replyOrigin, label: 'event.source' });
      }
      // Fallback: iframe.contentWindow + iframeOrigin (matches iframe's actual origin)
      targets.push({ target: iframe.contentWindow, origin: iframeOrigin || '*', label: 'iframe.cw' });

      for (var i = 0; i < targets.length; i++) {
        try {
          targets[i].target.postMessage(msg, targets[i].origin);
          console.log(B, 'Reply sent via', targets[i].label, 'origin:', targets[i].origin, 'type:', msg.type);
          return;
        } catch(e) {
          console.warn(B, 'Reply via', targets[i].label, 'failed:', e.message);
        }
      }
      // Last resort: wildcard
      try {
        iframe.contentWindow.postMessage(msg, '*');
        console.log(B, 'Reply sent via wildcard fallback');
      } catch(e) {
        console.error(B, 'ALL reply methods failed:', e.message);
      }
    }

    // --- Design SKU: create/reuse a unique Shopify variant per design ---
    // This ensures each cart line item has its own variant image at checkout
    // without requiring Shopify Plus. Falls back to the original variantId if
    // the endpoint is unavailable or returns an error.
    function resolveDesignSku(sourceVariantId, designId, mockupUrl) {
      var appUrl = config.appUrl || '';
      var productId = config.productId || '';
      var shopDomain = normaliseMyshopifyShopForApi(config.shopDomain || (window.Shopify && window.Shopify.shop) || '');
      // Convert relative proxy URLs (e.g. /apps/appai/objects/designs/...) to absolute https:// URLs
      // so the backend can fetch the mockup image from Shopify's CDN.
      if (mockupUrl && mockupUrl.startsWith('/')) {
        mockupUrl = window.location.origin + mockupUrl;
      }
      // productId is optional — server resolves it from variantId when missing.
      if (!designId || !mockupUrl || !appUrl || !shopDomain) {
        console.log(B, '[resolveDesignSku] Missing params — designId:', !!designId, 'mockupUrl:', !!mockupUrl, 'appUrl:', !!appUrl, 'shopDomain:', !!shopDomain, '— using base variantId', sourceVariantId);
        return Promise.resolve({ variantId: sourceVariantId });
      }
      if (!mockupUrl.startsWith('https://')) {
        console.log(B, '[resolveDesignSku] Non-https mockupUrl:', mockupUrl.substring(0, 80), '— using base variantId', sourceVariantId);
        return Promise.resolve({ variantId: sourceVariantId });
      }
      var endpoint = appUrl.replace(/\/$/, '') + '/api/storefront/resolve-design-variant';
      console.log(B, '[resolveDesignSku] Calling endpoint for design', designId, 'productId:', productId || '(none, server will resolve)');
      var resolveBody = {
        shop: shopDomain,
        variantId: String(sourceVariantId),
        designId: String(designId),
        mockupUrl: mockupUrl
      };
      if (productId) resolveBody.productId = String(productId);
      return fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(resolveBody)
      })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data && data.success && data.variantId) {
          console.log(B, '[resolveDesignSku] Resolved variantId:', data.variantId,
            data.created ? '(created)' : data.reused ? '(reused)' : '(fallback)');
          return { variantId: data.variantId };
        }
        console.warn(B, '[resolveDesignSku] Bad response, falling back:', data);
        return { variantId: sourceVariantId };
      })
      .catch(function(err) {
        console.warn(B, '[resolveDesignSku] Error, falling back:', err);
        return { variantId: sourceVariantId };
      });
    }

    // --- Cart add via Shopify Ajax API ---
    function addToCart(variantId, quantity, properties) {
      if (!variantId) return Promise.reject(new Error('Missing variantId'));

      var safeProps = properties || {};
      if (safeProps['_mockup_url'] && String(safeProps['_mockup_url']).indexOf('data:') === 0) {
        console.warn(B, 'Stripping data: _mockup_url — too large for Shopify cart payload');
        safeProps = Object.assign({}, safeProps);
        delete safeProps['_mockup_url'];
        delete safeProps['mockup_url'];
      }

      var body = { items: [{ id: Number(variantId), quantity: quantity || 1, properties: safeProps }] };
      console.log(B, '_mockup_url being sent:', properties && properties['_mockup_url'] ? properties['_mockup_url'] : '(none)');
      console.log(B, 'POST /cart/add.js', JSON.stringify(body).substring(0, 400));

      var controller = new AbortController();
      var tid = setTimeout(function() { controller.abort(); }, 15000);

      return fetch('/cart/add.js', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify(body),
        credentials: 'same-origin',
        signal: controller.signal
      }).then(function(res) {
        clearTimeout(tid);
        console.log(B, '/cart/add.js status:', res.status);
        return res.text().then(function(text) {
          var json;
          try { json = JSON.parse(text); } catch(e) { json = { raw: text }; }
          if (!res.ok) {
            var errMsg = (json && (json.description || json.message)) || text || 'HTTP ' + res.status;
            if (res.status === 422 && (errMsg.toLowerCase().includes('cannot find') || errMsg.toLowerCase().includes('not found'))) {
              console.warn(B, 'Variant', variantId, 'not found — product may not be published to Online Store yet. Retrying once after 3s...');
              throw { __retryable: true, variantId: variantId, message: 'Product variant not available. It may still be publishing to the store.' };
            }
            throw new Error('Cart add failed: ' + errMsg);
          }

          // After successful add, fetch full cart state for diagnostics
          fetch('/cart.js', { credentials: 'same-origin' })
            .then(function(r) { return r.json(); })
            .then(function(cart) {
              var lastItem = cart.items && cart.items.length > 0 ? cart.items[cart.items.length - 1] : null;
              console.log(B, '/cart.js after add — item_count:', cart.item_count, 'last_item:', lastItem ? { title: lastItem.title, variant_id: lastItem.variant_id, has_mockup: !!(lastItem.properties && lastItem.properties['_mockup_url']) } : null);
            })
            .catch(function(e) { console.warn(B, 'Post-add /cart.js fetch failed:', e.message); });

          return json;
        });
      }).catch(function(err) {
        clearTimeout(tid);
        if (err.name === 'AbortError') throw new Error('Cart request timed out after 15s');
        throw err;
      });
    }

    // --- Refresh cart UI after successful add ---
    function refreshCartUI() {
      document.dispatchEvent(new CustomEvent('cart:refresh'));

      // Strategy 1: Dawn/OS 2.0 — re-render cart drawer via Section Rendering API
      var cartDrawer = document.querySelector('cart-drawer');
      var cartNotification = document.querySelector('cart-notification');

      if (cartDrawer || cartNotification) {
        var target = cartDrawer || cartNotification;
        var sectionWrapper = target.closest('[id^="shopify-section-"]');
        var sectionId = sectionWrapper ? sectionWrapper.id.replace('shopify-section-', '') : null;

        if (sectionId) {
          console.log(B, 'Fetching section render for:', sectionId);
          fetch('/?sections=' + sectionId)
            .then(function(r) { return r.json(); })
            .then(function(sections) {
              var html = sections[sectionId];
              if (html && sectionWrapper) {
                var parsed = new DOMParser().parseFromString(html, 'text/html');
                var newContent = parsed.querySelector('[id="' + sectionWrapper.id + '"]');
                sectionWrapper.innerHTML = newContent ? newContent.innerHTML : html;

                // Apply stored mockup immediately to the freshly-injected DOM
                if (typeof window.aiArtFastReplace === 'function') window.aiArtFastReplace();

                // Staggered retries for lazy-loaded images and slow drawer animations
                [500, 1500].forEach(function(delay) {
                  setTimeout(function() {
                    if (typeof window.__applyCartMockups === 'function') window.__applyCartMockups();
                    else if (typeof window.aiArtFastReplace === 'function') window.aiArtFastReplace();
                    try { window.dispatchEvent(new Event('appai:cart-updated')); } catch(_) {}
                  }, delay);
                });

                // Re-query and open the drawer
                var newDrawer = document.querySelector('cart-drawer');
                if (newDrawer) {
                  var details = newDrawer.querySelector('details');
                  if (details) details.open = true;
                  newDrawer.classList.add('active');
                  console.log(B, 'Opened cart-drawer via Section Rendering API');
                }
                // Re-trigger cart image replacement after new DOM is injected
                document.dispatchEvent(new CustomEvent('cart:refresh'));
                var newNotification = document.querySelector('cart-notification');
                if (newNotification) {
                  newNotification.classList.add('active');
                  try { if (typeof newNotification.open === 'function') newNotification.open(); } catch(e) {}
                }
              }
            }).catch(function(e) { console.warn(B, 'Section render failed:', e); });
        }
      }

      // Strategy 2: Click the native cart trigger (for non-Dawn themes)
      if (!cartDrawer && !cartNotification) {
        setTimeout(function() {
          var triggers = [
            '#cart-icon-bubble', '[data-cart-trigger]',
            'button[aria-controls*="cart" i]',
            '.header__icon--cart', '.cart-icon-bubble',
            '[data-action="toggle-cart"]', 'a[href="/cart"]'
          ];
          for (var i = 0; i < triggers.length; i++) {
            try {
              var btn = document.querySelector(triggers[i]);
              if (btn) {
                console.log(B, 'Opening cart via trigger click:', triggers[i]);
                btn.click();
                break;
              }
            } catch(e) {}
          }
        }, 300);
      }

      // Dispatch theme-agnostic events so any theme listening can react
      document.dispatchEvent(new CustomEvent('cart:updated'));

      // Update cart count badges and verify UI updated
      fetch('/cart.js', { credentials: 'same-origin' }).then(function(r) { return r.json(); }).then(function(cart) {
        document.querySelectorAll('.cart-count, .cart-count-bubble, [data-cart-count]').forEach(function(el) {
          el.textContent = String(cart.item_count);
          el.style.display = cart.item_count > 0 ? '' : 'none';
        });

        // Fallback: if cart has items but no drawer/notification opened after 2s,
        // navigate to /cart so the user can see their item
        if (cart.item_count > 0) {
          setTimeout(function() {
            var drawerVisible = document.querySelector('cart-drawer.active, cart-drawer [open], cart-notification.active');
            var cartPage = window.location.pathname === '/cart';
            if (!drawerVisible && !cartPage) {
              console.log(B, 'Cart UI did not open — redirecting to /cart');
              window.location.href = '/cart';
            }
          }, 2000);
        }
      }).catch(function() {});
    }

    // --- BRIDGE_READY heartbeat ---
    // React app inside iframe may not have mounted when iframe.onload fires.
    // Send BRIDGE_READY every 500ms until the iframe ACKs.
    var bridgeAcked = false;
    var heartbeatN = 0;
    var MAX_HEARTBEATS = 240; // 120s — Railway cold start can take up to 60s
    var heartbeatTimer = null;

    function sendBridgeReady() {
      if (bridgeAcked) return;
      try {
        // Use '*' for BRIDGE_READY — this is a non-sensitive handshake ping.
        // Using appOrigin can silently fail if the iframe's effective origin
        // differs (e.g. Shopify CDN proxy, redirect, or cross-origin quirk).
        iframe.contentWindow.postMessage({
          type: 'AI_ART_STUDIO_BRIDGE_READY',
          _bridgeVersion: BRIDGE_VERSION,
          timestamp: Date.now(),
          heartbeat: heartbeatN
        }, '*');
        if (heartbeatN % 10 === 0) console.log(B, 'BRIDGE_READY heartbeat #' + heartbeatN);
        heartbeatN++;
      } catch(e) {
        console.warn(B, 'Failed to send BRIDGE_READY:', e.message);
      }
    }

    function sendDesignerConfig() {
      if (!config.inlineDesignerConfig) return;
      try {
        iframe.contentWindow.postMessage({
          type: 'AI_ART_STUDIO_DESIGNER_CONFIG',
          designerConfig: config.inlineDesignerConfig,
          stylePresets: config.stylePresets || [],
          styleConfig: config.styleConfig || null,
        }, iframeOrigin || '*');
        console.log(B, 'Sent DESIGNER_CONFIG to iframe:', config.inlineDesignerConfig.name || config.inlineDesignerConfig.id);
      } catch(e) {
        console.warn(B, 'Failed to send DESIGNER_CONFIG:', e.message);
      }
    }

    iframe.addEventListener('load', function() {
      console.log(B, 'Iframe loaded, starting BRIDGE_READY heartbeat');
      sendBridgeReady();
      sendDesignerConfig();
      heartbeatTimer = setInterval(function() {
        if (bridgeAcked || heartbeatN >= MAX_HEARTBEATS) {
          clearInterval(heartbeatTimer);
          heartbeatTimer = null;
          if (!bridgeAcked) console.error(B, 'Bridge never acknowledged after', MAX_HEARTBEATS, 'heartbeats');
          return;
        }
        sendBridgeReady();
        if (config.inlineDesignerConfig) sendDesignerConfig();
      }, 500);
    });

    // --- Main message listener ---
    window.addEventListener('message', function(event) {
      var data = event.data;
      if (!data || typeof data.type !== 'string') return;

      var isOurs = data.type.indexOf('AI_ART_STUDIO') === 0 || data.type.indexOf('ai-art-studio') === 0;

      // Debug logging
      if (isOurs) {
        console.log(B, 'MSG:', data.type, 'origin:', event.origin, 'fromIframe:', isFromOurIframe(event));
      }

      // Trust gate
      if (!isTrustedMessage(event)) {
        if (isOurs) console.warn(B, 'BLOCKED untrusted:', data.type, 'origin:', event.origin);
        return;
      }

      // ===== GOOGLE AUTH POPUP (iframe → parent opens popup; popup → parent → iframe) =====
      if (data.type === 'APPAI_OPEN_GOOGLE_AUTH' && isFromOurIframe(event)) {
        var authUrl = data.url;
        if (!authUrl) return;
        try {
          if (googleAuthPopupPoll) { clearInterval(googleAuthPopupPoll); googleAuthPopupPoll = null; }
          googleAuthPopupRef = window.open(authUrl, 'appaiGoogleAuth', 'popup=yes,width=520,height=640');
          if (!googleAuthPopupRef) {
            replyToIframe(event, {
              type: 'APPAI_OPEN_GOOGLE_AUTH_FAILED',
              nonce: data.nonce,
              error: 'Popup blocked. Allow popups for this site and try again.',
            });
            return;
          }
          googleAuthPopupPoll = setInterval(function() {
            if (!googleAuthPopupRef || !googleAuthPopupRef.closed) return;
            clearInterval(googleAuthPopupPoll);
            googleAuthPopupPoll = null;
            googleAuthPopupRef = null;
            replyToIframe(event, {
              type: 'APPAI_GOOGLE_AUTH_POPUP_CLOSED',
              nonce: data.nonce,
            });
          }, 500);
        } catch (e) {
          replyToIframe(event, {
            type: 'APPAI_OPEN_GOOGLE_AUTH_FAILED',
            nonce: data.nonce,
            error: 'Could not open Google sign-in window.',
          });
        }
        return;
      }

      if (data.type === 'APPAI_STOREFRONT_GOOGLE_AUTH') {
        if (!isAllowedOrigin(event.origin)) {
          console.warn(B, 'BLOCKED GOOGLE_AUTH forward from origin:', event.origin);
          return;
        }
        try {
          iframe.contentWindow.postMessage(data, iframeOrigin || '*');
          console.log(B, 'Forwarded GOOGLE_AUTH result to iframe');
          if (googleAuthPopupPoll) { clearInterval(googleAuthPopupPoll); googleAuthPopupPoll = null; }
          googleAuthPopupRef = null;
        } catch (e) {
          console.warn(B, 'Failed to forward GOOGLE_AUTH to iframe:', e.message);
        }
        return;
      }

      // ===== BRIDGE_ACK =====
      if (data.type === 'AI_ART_STUDIO_BRIDGE_ACK') {
        bridgeAcked = true;
        if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
        console.log(B, 'Handshake COMPLETE. parent:', BRIDGE_VERSION, 'iframe:', data._bridgeVersion, 'after', heartbeatN, 'heartbeats');
        // If this page is restoring a saved design, keep the cover up until the
        // iframe confirms that exact design has been applied and painted. ACK
        // only means "React mounted", which is too early and exposes the
        // intermediate product/page states during cross-product navigation.
        if (!transitionDesignId) {
          removeAppaiLoadingCover();
        }

        // Push Shopify variants (with prices) into the iframe so the generator
        // can render a variant selector internally.
        if (config.shopifyVariants && config.shopifyVariants.length > 0) {
          try {
            iframe.contentWindow.postMessage({
              type: 'AI_ART_STUDIO_SHOPIFY_VARIANTS',
              variants: config.shopifyVariants,
              baseVariantId: config.selectedVariant || null,
              productTypeId: config.productTypeId || null,
            }, iframeOrigin || '*');
            console.log(B, 'Sent SHOPIFY_VARIANTS to iframe:', config.shopifyVariants.length, 'variants');
          } catch(e) {
            console.warn(B, 'Failed to send SHOPIFY_VARIANTS:', e.message);
          }
        }

        // Push style presets so the generator doesn't need to call /api/config.
        if (config.stylePresets && config.stylePresets.length > 0) {
          try {
            iframe.contentWindow.postMessage({
              type: 'AI_ART_STUDIO_STYLE_PRESETS',
              stylePresets: config.stylePresets,
            }, iframeOrigin || '*');
            console.log(B, 'Sent STYLE_PRESETS to iframe:', config.stylePresets.length, 'presets');
          } catch(e) {
            console.warn(B, 'Failed to send STYLE_PRESETS:', e.message);
          }
        }

        // Send store theme so the iframe can match the merchant's visual style.
        try {
          var storeTheme = extractStoreTheme();
          if (storeTheme && Object.keys(storeTheme).length > 0) {
            iframe.contentWindow.postMessage({
              type: 'AI_ART_STUDIO_THEME',
              theme: storeTheme,
            }, iframeOrigin || '*');
            console.log(B, 'Sent THEME to iframe');
          }
        } catch(e) {
          console.warn(B, 'Failed to send THEME:', e.message);
        }

        // Send loadDesignId from the parent page URL so the iframe can restore the saved design.
        // This is more reliable than passing it via iframe URL params (which may be cached by Shopify CDN).
        try {
          var pageUrlParams = new URLSearchParams(window.location.search);
          var loadDesignIdFromPage = pageUrlParams.get('loadDesignId');
          if (loadDesignIdFromPage) {
            iframe.contentWindow.postMessage({
              type: 'AI_ART_STUDIO_LOAD_DESIGN',
              loadDesignId: loadDesignIdFromPage,
            }, iframeOrigin || '*');
            console.log(B, 'Sent LOAD_DESIGN to iframe:', loadDesignIdFromPage);
          }
        } catch(e) {
          console.warn(B, 'Failed to send LOAD_DESIGN:', e.message);
        }

        return;
      }

      // ===== DESIGN_APPLIED =====
      if (data.type === 'AI_ART_STUDIO_DESIGN_APPLIED') {
        var appliedDesignId = data.designId ? String(data.designId) : '';
        if (!transitionDesignId || appliedDesignId === transitionDesignId) {
          removeAppaiLoadingCover();
        }
        return;
      }

      // ===== IFRAME_READY (iframe mounted before heartbeat reached it) =====
      if (data.type === 'AI_ART_STUDIO_IFRAME_READY') {
        console.log(B, 'Iframe announced READY, sending BRIDGE_READY immediately');
        sendBridgeReady();
        sendDesignerConfig();
        return;
      }

      // ===== PING → PONG =====
      if (data.type === 'AI_ART_STUDIO_PING') {
        console.log(B, 'PING received, replying PONG');
        replyToIframe(event, {
          type: 'AI_ART_STUDIO_PONG',
          _bridgeVersion: BRIDGE_VERSION,
          pingTimestamp: data.timestamp
        });
        return;
      }

      // ===== ADD TO CART =====
      if (data.type === 'AI_ART_STUDIO_ADD_TO_CART') {
        var cid = data.correlationId || '';
        console.log(B, '>>> ADD_TO_CART cid:', cid, 'variant:', data.variantId);

        // Store mockup URL for diagnostics; cart replacer re-fetches /cart.js each pass
        if (data.properties && data.properties['_mockup_url']) {
          window.__aiArtRecentMockup = { variantId: String(data.variantId), url: data.properties['_mockup_url'], designId: data.properties['_design_id'] || '' };
          try {
            if (window.AppAI && window.AppAI.setLatestDesign) {
              window.AppAI.setLatestDesign({
                _design_id: data.properties['_design_id'] || '',
                _mockup_url: data.properties['_mockup_url'],
                _artwork_url: data.properties['_artwork_url'] || '',
                _shop: config.shopDomain || '',
                _product_id: config.productId || '',
                _app_url: config.appUrl || ''
              });
            }
          } catch(_) {}
        }

        if (!data.variantId) {
          replyToIframe(event, {
            type: 'AI_ART_STUDIO_ADD_TO_CART_RESULT',
            correlationId: cid, ok: false, success: false,
            error: 'Missing variant ID', _bridgeVersion: BRIDGE_VERSION
          });
          return;
        }

        var atcMockupUrl = (data.properties && (data.properties['_mockup_url'] || data.properties['mockup_url'])) || '';
        if (atcMockupUrl && atcMockupUrl.indexOf('data:') === 0) {
          console.warn(B, 'Ignoring data: mockup for shadow-SKU resolve');
          atcMockupUrl = '';
        }
        var atcDesignId = (data.properties && data.properties['_design_id']) || '';
        // Use baseVariantId (the original base product variant) for resolveDesignSku so the
        // server can look it up on the base product and create a fresh shadow product if needed.
        // data.variantId may be a pre-created shadow variant ID that has since expired.
        var atcBaseVariantId = data.baseVariantId || data.variantId;

        resolveDesignSku(atcBaseVariantId, atcDesignId, atcMockupUrl)
          .then(function(sku) {
            return addToCart(sku.variantId, data.quantity, data.properties);
          })
          .then(function(cart) {
            console.log(B, 'Cart add SUCCESS for cid:', cid);
            replyToIframe(event, {
              type: 'AI_ART_STUDIO_ADD_TO_CART_RESULT',
              correlationId: cid, ok: true, success: true,
              cart: cart, result: cart, _bridgeVersion: BRIDGE_VERSION
            });
            refreshCartUI();
          })
          .catch(function(err) {
            // Retry once after 3s if variant not found (product may still be publishing)
            if (err && err.__retryable) {
              console.log(B, 'Retrying ATC in 3s for variant', err.variantId);
              return new Promise(function(resolve) { setTimeout(resolve, 3000); })
                .then(function() { return addToCart(err.variantId, data.quantity, data.properties); })
                .then(function(cart) {
                  console.log(B, 'Cart add SUCCESS on retry for cid:', cid);
                  replyToIframe(event, {
                    type: 'AI_ART_STUDIO_ADD_TO_CART_RESULT',
                    correlationId: cid, ok: true, success: true,
                    cart: cart, result: cart, _bridgeVersion: BRIDGE_VERSION
                  });
                  refreshCartUI();
                })
                .catch(function(retryErr) {
                  var msg = (retryErr && retryErr.message) || String(retryErr);
                  console.error(B, 'Cart add FAILED on retry for cid:', cid, msg);
                  replyToIframe(event, {
                    type: 'AI_ART_STUDIO_ADD_TO_CART_RESULT',
                    correlationId: cid, ok: false, success: false,
                    error: 'This product is not available for purchase yet. Please refresh the page and try again.',
                    _bridgeVersion: BRIDGE_VERSION
                  });
                });
            }
            console.error(B, 'Cart add FAILED for cid:', cid, err.message);
            replyToIframe(event, {
              type: 'AI_ART_STUDIO_ADD_TO_CART_RESULT',
              correlationId: cid, ok: false, success: false,
              error: err.message || String(err), _bridgeVersion: BRIDGE_VERSION
            });
          });
        return;
      }

      // ===== LEGACY ADD TO CART =====
      if (data.type === 'ai-art-studio:add-to-cart') {
        console.log(B, 'Legacy add-to-cart variant:', data.variantId);
        addToCart(data.variantId, 1, { '_artwork_url': data.artworkUrl || '', '_design_id': data.designId || '', 'Artwork': 'Custom AI Design' })
          .then(function(cart) {
            replyToIframe(event, { type: 'ai-art-studio:cart-updated', success: true, cart: cart });
            refreshCartUI();
          })
          .catch(function(err) {
            replyToIframe(event, { type: 'ai-art-studio:cart-updated', success: false, error: err.message });
          });
        return;
      }

      // ===== POST-ATC IMAGE SWAP =====
      if (data.type === 'AI_ART_STUDIO_REPLACE_CART_IMAGES') {
        console.log(B, 'Post-ATC image swap requested');
        if (data.mockupUrl && data.variantId) {
          window.__aiArtRecentMockup = { variantId: String(data.variantId), url: data.mockupUrl, designId: '' };
        }
        // Immediate attempt
        if (typeof window.aiArtFastReplace === 'function') window.aiArtFastReplace();
        // Retry after DOM settles (section re-render may still be in progress)
        setTimeout(function() {
          if (typeof window.__applyCartMockups === 'function') window.__applyCartMockups();
          else if (typeof window.aiArtFastReplace === 'function') window.aiArtFastReplace();
        }, 800);
        setTimeout(function() {
          if (typeof window.__applyCartMockups === 'function') window.__applyCartMockups();
        }, 2000);
        return;
      }

      // ===== RESIZE =====
      if (data.type === 'ai-art-studio:resize') {
        if (mobileNativeScroll) return;
        var newH = Math.max(data.height || 0, 400);
        studioContainer.style.height = newH + 'px';
        return;
      }
      // ===== SCROLL TO PREVIEW (hard refresh landing) =====
      if (data.type === 'ai-art-studio:scroll-to-preview') {
        var embedRoot = document.getElementById('ai-art-studio-auto-embed')
          || document.querySelector('.ai-art-studio-block')
          || (studioContainer && studioContainer.closest('.ai-art-studio-embed'))
          || studioContainer;
        if (embedRoot) {
          try {
            // This message exists to rescue hard-refresh landings where the
            // browser restored scroll near the footer. On a fresh navigation
            // the preview is already at/near the top — scrolling then only
            // trims the top margin, and on themes whose header is NOT sticky
            // (Ritual: static header inside the .page-wrapper scroller) it
            // pushes the nav menu off-screen, which looks like the menu was
            // removed. Skip unless the preview is genuinely out of view.
            var _pre = embedRoot.getBoundingClientRect();
            var _vh = window.innerHeight || document.documentElement.clientHeight || 800;
            if (_pre.top >= 0 && _pre.top < _vh * 0.5) return;
          } catch(e) {}
          try {
            embedRoot.scrollIntoView({ block: 'start', behavior: 'auto' });
          } catch(e) {}
          try {
            var _landEl = document.scrollingElement || document.documentElement;
            var _rect = embedRoot.getBoundingClientRect();
            _landEl.scrollTop = Math.max(0, _landEl.scrollTop + _rect.top - 16);
          } catch(e) {}
        }
        return;
      }
      // ===== WHEEL FORWARDING =====
      // The iframe forwards wheel events so the parent page can scroll when
      // the mouse is over the iframe but not inside an open dropdown.
      if (data.type === 'ai-art-studio:wheel') {
        appaiScrollParentPage(data.deltaX, data.deltaY, data.deltaMode);
        return;
      }
      // ===== TOUCH SCROLL FORWARDING + FLING (mobile) =====
      // iOS Safari does not propagate iframe touch events to the parent for scroll.
      // touchscroll: immediate scroll per touchmove frame.
      // touchfling:  momentum animation after finger lifts (inertia).
      // touchcancel: cancel any in-flight fling (new touch started).
      //
      // IMPORTANT: writes go through appaiInstantScrollBy — themes that set
      // CSS scroll-behavior:smooth on the scroller (Savor/Horizon/Ritual)
      // otherwise turn every write into a restarted 300ms animation, which
      // looks completely frozen under rapid per-frame calls. The scroller is
      // resolved per event: some themes scroll an inner wrapper (Savor's
      // .page-wrapper), not <html>.
      var _resolveTouchScroller = function (dy) {
        var pageEl = appaiGetPageScrollElement();
        if (appaiCanScroll(pageEl, dy, 0)) return pageEl;
        var wrapper = appaiScrollRootForEmbedIframe();
        if (wrapper && appaiCanScroll(wrapper, dy, 0)) return wrapper;
        return pageEl;
      };
      if (data.type === 'ai-art-studio:touchscroll') {
        stopFling();
        var _tsDy = data.deltaY || 0;
        appaiInstantScrollBy(_resolveTouchScroller(_tsDy), _tsDy, 0);
        return;
      }
      if (data.type === 'ai-art-studio:touchcancel') {
        stopFling();
        return;
      }
      if (data.type === 'ai-art-studio:touchfling') {
        stopFling();
        var flingV = data.velocityY || 0;
        var alive = true;
        stopFling = function() { alive = false; };
        (function step() {
          if (!alive || Math.abs(flingV) < 0.5) return;
          appaiInstantScrollBy(_resolveTouchScroller(flingV), flingV, 0);
          flingV *= 0.95; // friction: decays to ~0 in ~55 rAF frames (~0.9 s)
          requestAnimationFrame(step);
        })();
        return;
      }

      // ===== PRODUCT CONTEXT (in-app cross-product switch) =====
      if (data.type === 'AI_ART_STUDIO_PRODUCT_CONTEXT') {
        if (data.productTypeId) config.productTypeId = String(data.productTypeId);
        if (data.productId) config.productId = String(data.productId);
        if (data.productHandle) config.productHandle = String(data.productHandle);
        if (data.selectedVariant) config.selectedVariant = String(data.selectedVariant);
        if (Array.isArray(data.variants)) config.shopifyVariants = data.variants;
        console.log(B, 'Updated parent product context after in-app switch — productTypeId:', config.productTypeId, 'productId:', config.productId);
        if (Array.isArray(data.variants) && data.variants.length > 0) {
          try {
            iframe.contentWindow.postMessage({
              type: 'AI_ART_STUDIO_SHOPIFY_VARIANTS',
              variants: data.variants,
              baseVariantId: data.selectedVariant || config.selectedVariant || null,
              productTypeId: config.productTypeId || null,
            }, iframeOrigin || '*');
            console.log(B, 'Re-sent SHOPIFY_VARIANTS after product switch:', data.variants.length, 'variants');
          } catch(e) {
            console.warn(B, 'Failed to re-send SHOPIFY_VARIANTS after product switch:', e.message);
          }
        }
        return;
      }

      // ===== CART STATE (parent button sync) =====
      if (data.type === 'AI_ART_STUDIO_CART_STATE') {
        var atcBtnEl = document.getElementById('ai-art-atc-btn');
        var atcWrapperEl = document.getElementById('ai-art-atc-wrapper');
        if (atcBtnEl && atcWrapperEl) {
          atcWrapperEl.style.display = 'block';
          // Don't overwrite button text while it shows "Adding…" or "Added ✓"
          var currentText = atcBtnEl.textContent || '';
          var isBusy = currentText.indexOf('Adding') !== -1 || currentText.indexOf('Added') !== -1;
          if (!isBusy) {
            atcBtnEl.textContent = data.label || 'Add to Cart';
            atcBtnEl.style.background = '';
          }
          atcBtnEl.disabled = !!data.disabled;
          atcBtnEl.style.opacity = data.disabled ? '0.5' : '1';
          atcBtnEl.style.cursor = data.disabled ? 'not-allowed' : 'pointer';
          if (data.payload) {
            atcBtnEl.dataset.payload = JSON.stringify(data.payload);
          }
        }

        // Sync Cart Guard with latest mockup from every generation cycle
        try {
          var csProps = data.payload && data.payload.properties;
          if (csProps && csProps['_mockup_url'] && window.AppAI && window.AppAI.setLatestDesign) {
            window.AppAI.setLatestDesign({
              _design_id: csProps['_design_id'] || '',
              _mockup_url: csProps['_mockup_url'],
              _artwork_url: csProps['_artwork_url'] || '',
              _shop: config.shopDomain || '',
              _product_id: config.productId || '',
              _app_url: config.appUrl || ''
            });
          }
        } catch(_) {}

        return;
      }

      // ===== MOCKUP LOADING STATE =====
      if (data.type === 'AI_ART_STUDIO_MOCKUP_LOADING') {
        var genOverlay = document.getElementById('ai-art-gen-overlay');
        if (genOverlay) {
          genOverlay.style.display = data.loading ? 'flex' : 'none';
        }
        return;
      }

      // ===== MOCKUPS =====
      if (data.type === 'AI_ART_STUDIO_MOCKUPS') {
        var mockupUrls = data.mockupUrls;
        if (!mockupUrls || mockupUrls.length === 0) return;
        console.log(B, 'Bridge MOCKUPS received:', mockupUrls.length, 'urls — handled by global listener gallery');
      }
    });

    console.log(B, 'Bridge installed successfully.');

    // --- Parent-side Add to Cart button ---
    var atcBtn = container.querySelector('#ai-art-atc-btn');
    if (atcBtn) {
      atcBtn.addEventListener('click', function() {
        var payloadJson = atcBtn.dataset.payload || '{}';
        var payload;
        try { payload = JSON.parse(payloadJson); } catch(e) { payload = {}; }
        if (!payload.variantId) return;

        atcBtn.textContent = 'Adding to Cart\u2026';
        atcBtn.disabled = true;
        atcBtn.style.opacity = '0.7';

        // Store mockup for instant cart drawer replacement
        var mockupUrl = payload.properties && (payload.properties['_mockup_url'] || payload.properties['mockup_url']);
        if (mockupUrl) {
          window.__aiArtRecentMockup = { variantId: String(payload.variantId), url: mockupUrl, designId: (payload.properties && payload.properties['_design_id']) || '' };
          try {
            if (window.AppAI && window.AppAI.setLatestDesign) {
              window.AppAI.setLatestDesign({
                _design_id: (payload.properties && payload.properties['_design_id']) || '',
                _mockup_url: mockupUrl,
                _artwork_url: (payload.properties && payload.properties['_artwork_url']) || '',
                _shop: config.shopDomain || '',
                _product_id: config.productId || '',
                _app_url: config.appUrl || ''
              });
            }
          } catch(_) {}
        }

        var btnDesignId = (payload.properties && payload.properties['_design_id']) || '';
        resolveDesignSku(payload.variantId, btnDesignId, mockupUrl || '')
          .then(function(sku) {
            return addToCart(sku.variantId, payload.quantity || 1, payload.properties || {});
          })
          .then(function(cart) {
            // Notify iframe of success so it can show its success state
            try {
              iframe.contentWindow.postMessage({
                type: 'AI_ART_STUDIO_ADD_TO_CART_RESULT',
                correlationId: payload.correlationId || '',
                ok: true, success: true,
                cart: cart, result: cart,
                _bridgeVersion: BRIDGE_VERSION
              }, '*');
            } catch(e) {}

            atcBtn.textContent = 'Added to Cart \u2713';
            atcBtn.style.background = '#2d7a2d';
            atcBtn.disabled = false;
            atcBtn.style.opacity = '1';
            refreshCartUI();
          })
          .catch(function(err) {
            try {
              iframe.contentWindow.postMessage({
                type: 'AI_ART_STUDIO_ADD_TO_CART_RESULT',
                correlationId: payload.correlationId || '',
                ok: false, success: false,
                error: err.message,
                _bridgeVersion: BRIDGE_VERSION
              }, '*');
            } catch(e) {}
            atcBtn.textContent = 'Error \u2014 Try Again';
            atcBtn.style.background = '#c0392b';
            atcBtn.disabled = false;
            atcBtn.style.opacity = '1';
            // Reset button appearance after 3 seconds
            setTimeout(function() {
              atcBtn.style.background = '';
              atcBtn.textContent = 'Add to Cart';
            }, 3000);
          });
      });
    }

    // Return null if we mounted into an existing block (it's already in the DOM).
    // Callers must check for null and skip DOM insertion.
    return existingBlock ? null : container;
  }

  /**
   * Belt-and-suspenders cleanup: if old cached code (design-studio.liquid's
   * inline script that we gutted) still runs from Shopify CDN and creates a
   * second iframe, remove it so only one generator is ever visible.
   * Called after every mount, regardless of path.
   */
  function cleanupDuplicateGenerators() {
    var autoEmbed  = document.getElementById('ai-art-studio-auto-embed');
    var blockIframe = document.querySelector('.ai-art-studio-block iframe[title="AI Art Design Studio"]');

    if (autoEmbed && blockIframe) {
      // Block placement wins — remove the auto-embed duplicate
      autoEmbed.remove();
      console.log('[AI Art Embed] cleanupDuplicateGenerators: removed duplicate auto-embed');
    }

    // Remove extra iframes inside any block container (old cached code may add one)
    document.querySelectorAll('[id^="ai-art-studio-container-"]').forEach(function(c) {
      var iframes = c.querySelectorAll('iframe');
      for (var i = 1; i < iframes.length; i++) {
        iframes[i].remove();
        console.log('[AI Art Embed] cleanupDuplicateGenerators: removed extra iframe from block container');
      }
      if (iframes[0]) appaiAttachIframeWheelForward(iframes[0], false);
    });
    document.querySelectorAll('iframe[title="AI Art Design Studio"]').forEach(function(f) {
      appaiAttachIframeWheelForward(f, false);
    });
  }

  var aiArtNativeGallery = null; // reference kept so we can restore it if needed

  function createPlaceholderGallery() {
    if (document.getElementById('ai-art-placeholder')) return; // already created

    var nativeGallerySelectors = [
      '.product__media-wrapper',
      '.product__media-gallery',
      '.product-single__photos',
      '.product__images',
      '.product-gallery',
      '.product__photo-container',
      '.product-images',
      '.product-media',
      '[data-product-media-container]',
      '[data-product-images]',
      '[data-media-gallery]',
      '.product__media-list',
      '.product__media',
      '.product-single__media-wrapper',
      '.product-featured-media'
    ];

    var native = null;
    for (var gi = 0; gi < nativeGallerySelectors.length; gi++) {
      native = document.querySelector(nativeGallerySelectors[gi]);
      if (native) {
        console.log('[AI Art Embed] Found native gallery with:', nativeGallerySelectors[gi]);
        break;
      }
    }

    // Fallback: find the first container with product images near the product info
    if (!native) {
      var productContainer = document.querySelector('.product, [data-product], .product-template, main');
      if (productContainer) {
        var imgs = productContainer.querySelectorAll('img');
        for (var ii = 0; ii < imgs.length; ii++) {
          var parentEl = imgs[ii].closest('[class*="media"], [class*="gallery"], [class*="image"], [class*="photo"]');
          if (parentEl && !parentEl.closest('.ai-art-studio-embed')) {
            native = parentEl;
            console.log('[AI Art Embed] Found native gallery via image fallback:', native.className);
            break;
          }
        }
      }
    }

    if (!native) {
      console.log('[AI Art Embed] Could not find native gallery - skipping placeholder');
      return;
    }

    // Hide the native gallery — replaced by our placeholder / custom gallery
    native.style.display = 'none';
    native.dataset.aiHidden = 'true';
    aiArtNativeGallery = native;

    var ph = document.createElement('div');
    ph.id = 'ai-art-placeholder';
    // max-width matches the custom gallery so the page layout doesn't shift
    ph.style.cssText = 'width:100%;max-width:600px;aspect-ratio:1/1;background:#f0f0f0;border-radius:8px;overflow:hidden;margin-bottom:20px;position:relative;';

    // Prefer the Liquid-rendered original product image (immune to variant image mutations
    // that happen when a user adds a custom design to cart). Fall back to DOM scraping.
    var liquidImgSrc = '';
    var scriptDataEl = document.querySelector('[data-ai-art-studio]');
    if (scriptDataEl) {
      try {
        var scriptData = JSON.parse(scriptDataEl.textContent);
        if (scriptData.featuredImageUrl) {
          liquidImgSrc = scriptData.featuredImageUrl;
        }
      } catch(e) {}
    }

    var imgSrc = liquidImgSrc;
    var imgSrcset = '';

    if (!imgSrc) {
      // Fallback: scrape first image from native gallery
      var firstProductImg = native.querySelector('img[src]:not([src=""]), img[data-src]:not([data-src=""])');
      if (firstProductImg) {
        imgSrc = firstProductImg.src || firstProductImg.dataset.src || '';
        imgSrcset = firstProductImg.srcset || firstProductImg.dataset.srcset || '';
      }
    }

    if (imgSrc) {
      var placeholderProductImg = document.createElement('img');
      placeholderProductImg.src = imgSrc;
      if (imgSrcset) placeholderProductImg.srcset = imgSrcset;
      placeholderProductImg.alt = 'Product image';
      placeholderProductImg.style.cssText = 'width:100%;height:100%;object-fit:contain;display:block;';
      ph.appendChild(placeholderProductImg);
    }

    // Overlay shown while mockups are generating (hidden initially)
    var overlay = document.createElement('div');
    overlay.id = 'ai-art-gen-overlay';
    overlay.style.cssText = 'display:none;position:absolute;inset:0;background:rgba(255,255,255,0.88);flex-direction:column;align-items:center;justify-content:center;gap:14px;z-index:10;';
    overlay.innerHTML = '<div class="ai-art-spinner"></div><span style="font-size:14px;color:#555;font-weight:500;letter-spacing:0.01em;">Artwork Generating\u2026</span>';
    ph.appendChild(overlay);

    native.parentNode.insertBefore(ph, native);
    console.log('[AI Art Embed] Created placeholder gallery. liquidImg:', !!liquidImgSrc, 'fallbackImg:', !liquidImgSrc && !!imgSrc);
  }

  function insertStudioAfterProductInfo(studioElement) {
    const insertionPoints = [
      '.product__info-wrapper',
      '.product-single__meta',
      '.product__content',
      '.product-info',
      '[data-product-info]',
      '.product__description',
      '.product-description'
    ];
    
    for (const selector of insertionPoints) {
      const target = document.querySelector(selector);
      if (target) {
        target.parentNode.insertBefore(studioElement, target.nextSibling);
        return true;
      }
    }
    
    const productContainer = document.querySelector('.product, [data-product], .product-template, main');
    if (productContainer) {
      productContainer.appendChild(studioElement);
      return true;
    }
    
    return false;
  }
  
  function init() {
    var isProductPage = window.location.pathname.includes('/products/') || 
                        window.location.pathname.includes('/products_preview');
    if (!isProductPage) {
      return;
    }
    
    if (document.getElementById('ai-art-studio-auto-embed') ||
        document.querySelector('[data-embed-handled="true"]')) {
      return;
    }
    
    const productMeta = document.querySelector('[data-product-json]');
    let productData = null;
    
    if (productMeta) {
      try {
        productData = JSON.parse(productMeta.textContent);
      } catch (e) {}
    }
    
    if (!productData && window.ShopifyAnalytics && window.ShopifyAnalytics.meta) {
      productData = window.ShopifyAnalytics.meta.product;
    }
    
    checkMetafieldsAndInit();
  }
  
  function checkMetafieldsAndInit() {
    const metaTags = document.querySelectorAll('meta[property^="product:"]');
    
    let appUrl = null;
    let productTypeId = null;
    let displayName = null;
    let description = null;
    let hideAddToCart = false;
    let enabled = false;
    
    const metaAppUrl = document.querySelector('meta[name="ai_art_studio:app_url"]');
    const metaProductTypeId = document.querySelector('meta[name="ai_art_studio:product_type_id"]');
    const metaEnabled = document.querySelector('meta[name="ai_art_studio:enable"]');
    const metaHideCart = document.querySelector('meta[name="ai_art_studio:hide_add_to_cart"]');
    const metaDisplayName = document.querySelector('meta[name="ai_art_studio:display_name"]');
    const metaDescription = document.querySelector('meta[name="ai_art_studio:description"]');
    
    if (metaAppUrl) appUrl = metaAppUrl.content;
    if (metaProductTypeId) productTypeId = metaProductTypeId.content;
    if (metaEnabled) enabled = metaEnabled.content === 'true';
    if (metaHideCart) hideAddToCart = metaHideCart.content === 'true';
    if (metaDisplayName) displayName = metaDisplayName.content;
    if (metaDescription) description = metaDescription.content;
    
    if (!appUrl || !productTypeId) {
      const scriptData = document.querySelector('[data-ai-art-studio]');
      console.log('[AI Art Embed] Looking for script data, found:', !!scriptData);
      if (scriptData) {
        try {
          const data = JSON.parse(scriptData.textContent);
          console.log('[AI Art Embed] Parsed metafield data:', JSON.stringify(data));
          appUrl = data.appUrl;
          productTypeId = data.productTypeId;
          displayName = data.displayName;
          description = data.description;
          hideAddToCart = data.hideAddToCart === true || data.hideAddToCart === 'true';
          enabled = data.enabled === true || data.enabled === 'true';
        } catch (e) {
          console.error('[AI Art Embed] Failed to parse script data:', e);
        }
      }
    }

    // productTypeId is now optional - backend will auto-resolve using productHandle/displayName
    if (!productTypeId) {
      productTypeId = '0';
      console.log('[AI Art Embed] No productTypeId set - will use backend auto-resolution');
    }

    console.log('[AI Art Embed] Final values - appUrl:', appUrl, 'productTypeId:', productTypeId, 'enabled:', enabled);

    // Inject preconnect hints as early as possible so the browser can start the
    // TCP handshake to Railway before the iframe src is set. This reduces perceived
    // cold-start latency without making an HTTP request that can visibly fail.
    if (appUrl) {
      try {
        var appOriginHint = new URL(appUrl).origin;
        if (!document.querySelector('link[rel="preconnect"][href="' + appOriginHint + '"]')) {
          var pcLink = document.createElement('link');
          pcLink.rel = 'preconnect';
          pcLink.href = appOriginHint;
          pcLink.crossOrigin = 'anonymous';
          document.head.appendChild(pcLink);
          var dnsPrefetch = document.createElement('link');
          dnsPrefetch.rel = 'dns-prefetch';
          dnsPrefetch.href = appOriginHint;
          document.head.appendChild(dnsPrefetch);
        }
      } catch(e) {}
    }

    if (!appUrl) {
      console.log('[AI Art Embed] Missing appUrl, stopping');
      return;
    }

    // Only proceed if the product is enabled for AI Art Studio
    if (!enabled) {
      return;
    }
    
    if (hideAddToCart) {
      hideNativeAddToCart();
      
      const observer = new MutationObserver(() => {
        hideNativeAddToCart();
      });
      if (document.body) {
        observer.observe(document.body, { childList: true, subtree: true });
      } else {
        document.addEventListener('DOMContentLoaded', () => {
          if (document.body) observer.observe(document.body, { childList: true, subtree: true });
        });
      }
    }
    
    const productHandle = window.location.pathname.split('/products/')[1]?.split('?')[0]?.split('#')[0] || '';
    const productTitle = document.querySelector('h1')?.textContent?.trim() || 'Product';
    let productId = window.ShopifyAnalytics?.meta?.product?.id || '';
    
    // Get the currently selected variant from Shopify using multiple detection methods
    let selectedVariant = window.ShopifyAnalytics?.meta?.selectedVariantId || 
                          document.querySelector('[name="id"]')?.value ||
                          document.querySelector('select[name="id"] option:checked')?.value ||
                          document.querySelector('input[name="id"]')?.value ||
                          '';
    
    // Always extract variant prices from product JSON
    let productVariants = [];
    const productJson = document.querySelector('[data-product-json]');
    if (productJson) {
      try {
        const product = JSON.parse(productJson.textContent);
        // Fallback: use product.id from the JSON blob if ShopifyAnalytics didn't provide it
        if (!productId && product.id) {
          productId = String(product.id);
        }
        if (product.variants && product.variants.length > 0) {
          if (!selectedVariant) {
            selectedVariant = product.variants[0].id?.toString() || '';
          }
          // Extract variants with prices for the iframe
          productVariants = product.variants.map(v => ({
            id: v.id?.toString() || '',
            title: v.title || '',
            price: v.price ? (parseFloat(v.price) / 100).toFixed(2) : '0.00',
            option1: v.option1 || undefined,
            option2: v.option2 || undefined,
          }));
          console.log('[AI Art Embed] Extracted', productVariants.length, 'variants with prices');
        }
      } catch (e) {
        console.log('[AI Art Embed] Failed to parse product JSON:', e);
      }
    }
    
    // Last resort: fetch product JSON from API
    const initWithVariant = (variantId) => {
      const config = {
        appUrl: appUrl,
        productTypeId: productTypeId,
        productId: productId,
        productHandle: productHandle,
        productTitle: productTitle,
        displayName: displayName || productTitle.replace('Custom ', ''),
        description: description,
        shopDomain: (function () {
          var el = document.getElementById('appai-root');
          var ds = el && el.getAttribute('data-shop');
          var raw = (ds && String(ds).trim()) || (window.Shopify && window.Shopify.shop) || window.location.hostname || '';
          var s = String(raw).trim().toLowerCase();
          if (s.indexOf('.myshopify.com') !== -1) return s;
          if (/^[a-z0-9][a-z0-9-]*$/.test(s)) return s + '.myshopify.com';
          return s;
        })(),
        selectedVariant: variantId,
        shopifyVariants: productVariants
      };
      
      console.log('[AI Art Embed] Creating studio with variant:', variantId);
      const studioElement = createDesignStudio(config);

      // null means the iframe was mounted into an existing theme app block — no insertion needed.
      if (studioElement) {
        const doInsert = () => {
          createPlaceholderGallery();
          insertStudioAfterProductInfo(studioElement);
          cleanupDuplicateGenerators();
        };

        if (document.readyState === 'loading') {
          document.addEventListener('DOMContentLoaded', doInsert);
        } else {
          doInsert();
        }
      } else {
        // Mounted into block — still run cleanup in case old cached code fires later
        setTimeout(cleanupDuplicateGenerators, 500);
      }
    };
    
    if (selectedVariant) {
      initWithVariant(selectedVariant);
    } else if (productHandle) {
      // Fetch product JSON as last resort
      fetch('/products/' + productHandle + '.json')
        .then(r => r.json())
        .then(data => {
          const variantId = data.product?.variants?.[0]?.id?.toString() || '';
          console.log('[AI Art Embed] Got variant from API:', variantId);
          initWithVariant(variantId);
        })
        .catch(e => {
          console.log('[AI Art Embed] Failed to fetch product JSON:', e);
          initWithVariant('');
        });
    } else {
      initWithVariant('');
    }
  }
  
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  /**
   * initCustomizerPage — called when the embed detects /pages/:handle.
   * Fetches the admin-configured page record via App Proxy, then renders
   * the same /embed/design iframe used on product pages (unified renderer).
   *
   * The __APPAI_CUSTOMIZER_HANDLED flag is set SYNCHRONOUSLY before this
   * function is called, so appai-customizer-embed.js can never race with us.
   * If the config fetch fails (404 = not a customizer page), we release the flag.
   */
  /**
   * State machine for customizer pages:
   *   BOOT → CONFIG_LOADING → CONFIG_LOADED → MOUNTED
   *                        → ERROR (404 or network failure)
   *
   * Only one customizer instance can ever mount — the global guards
   * (__APPAI_CUSTOMIZER_INIT__ + __APPAI_CUSTOMIZER_HANDLED) ensure this.
   */
  function appaiMountCustomizerConfig(handle, config, opts) {
    opts = opts || {};
    var replaceExisting = !!opts.replaceExisting;
    console.log('[AI Art Embed] STATE=CONFIG_LOADED handle=' + handle +
      ' productTypeId=' + config.productTypeId +
      ' hasDesignerConfig=' + !!config.designerConfig);

    var mount = document.querySelector('#MainContent') ||
                document.querySelector('main[role="main"]') ||
                document.querySelector('main') ||
                document.body;

    if (replaceExisting) {
      document.querySelectorAll('#ai-art-studio-auto-embed, .ai-art-studio-embed').forEach(function(el) {
        if (el && el.parentNode) el.parentNode.removeChild(el);
      });
      Array.prototype.slice.call(mount.children || []).forEach(function(el) {
        if (el.id === 'appai-boot' || el.id === 'appai-nav-transition') return;
        if (el.classList && el.classList.contains('ai-art-studio-embed')) return;
        el.style.display = 'none';
      });
    }

    var hideThemeElement = function(el) {
      if (!el || el.querySelector('#appai-boot') || el.closest('#appai-boot')) return;
      el.style.display = 'none';
    };

    // Hide theme's generic page text (title, body copy)
    ['#MainContent > .page-width', 'main .page', '.page__content',
     '.shopify-section--rich-text', 'h1.page-title', 'h1.title'].forEach(function(sel) {
      document.querySelectorAll(sel).forEach(hideThemeElement);
    });

    // Hide the page's body_html rendered by the theme (e.g. stale "Loading customizer..." text
    // that was set as the page body before we switched to empty body_html).
    document.querySelectorAll('.page-content, .rte, article .rte, .page__body').forEach(function(el) {
      if (el.closest('.ai-art-studio-embed') || el.closest('.ai-art-studio-block')) return;
      hideThemeElement(el);
    });
    var shopDomain = (function () {
      var el = document.getElementById('appai-root');
      var ds = el && el.getAttribute('data-shop');
      var raw = (ds && String(ds).trim()) || ((window.Shopify && window.Shopify.shop) || '');
      var s = String(raw).trim().toLowerCase();
      if (s.indexOf('.myshopify.com') !== -1) return s;
      if (/^[a-z0-9][a-z0-9-]*$/.test(s)) return s + '.myshopify.com';
      return s;
    })();
    var studioEl = createDesignStudio({
      appUrl:               config.appUrl,
      shopDomain:           shopDomain,
      productTypeId:        config.productTypeId ? String(config.productTypeId) : '0',
      productId:            config.baseProductId || '',
      productHandle:        config.baseProductHandle || handle,
      productTitle:         config.baseProductTitle || config.title,
      displayName:          config.title,
      description:          '',
      selectedVariant:      config.baseVariantId,
      hideAddToCart:        false,
      enabled:              true,
      inlineDesignerConfig: config.designerConfig || null,
      // Shopify variants with prices and style presets — pushed into the
      // iframe via postMessage in the BRIDGE_ACK handler so the generator
      // can render them internally (no external dropdown needed).
      shopifyVariants:      config.variants || [],
      stylePresets:         config.stylePresets || [],
      styleConfig:          config.styleConfig || null,
    });

    // null means the iframe was mounted into an existing theme app block.
    if (studioEl) {
      mount.insertBefore(studioEl, mount.firstChild);
    }
    console.log('[AI Art Embed] STATE=MOUNTED handle=' + handle);

    // Remove any duplicate generators that old cached block scripts may have created
    cleanupDuplicateGenerators();
    // Run again after a short delay to catch iframes that load asynchronously
    setTimeout(cleanupDuplicateGenerators, 1500);
  }

  /**
   * Fetch with a hard timeout + one retry. The backend occasionally has
   * cold-start-style latency spikes (observed: some requests hang 15-20s+ or
   * 502, then subsequent requests are fast) — without a timeout, a single
   * slow request leaves the customer stuck on the loading screen forever with
   * no error and no retry. Aborting after 10s and retrying once turns that
   * into a ~20s worst case that still surfaces the existing error/retry UI.
   */
  function appaiFetchWithTimeout(url, options, timeoutMs) {
    var controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    var timer = controller ? setTimeout(function() { controller.abort(); }, timeoutMs) : null;
    return fetch(url, Object.assign({}, options, controller ? { signal: controller.signal } : {}))
      .finally(function() { if (timer) clearTimeout(timer); });
  }
  function appaiFetchCustomizerConfig(handle, attempt) {
    return appaiFetchWithTimeout(
      '/apps/appai/customizer-page?handle=' + encodeURIComponent(handle),
      { credentials: 'same-origin' },
      10000
    ).catch(function(e) {
      if (attempt >= 1) throw e;
      console.warn('[AI Art Embed] customizer-page fetch attempt', attempt, 'failed, retrying:', e && e.message);
      return appaiFetchCustomizerConfig(handle, attempt + 1);
    });
  }

  function initCustomizerPage(handle, opts) {
    opts = opts || {};
    console.log('[AI Art Embed] STATE=CONFIG_LOADING handle=' + handle);

    appaiFetchCustomizerConfig(handle, 0)
      .then(function(r) { return r.ok ? r.json() : null; })
      .then(function(config) {
        if (!config) {
          var staleBoot = document.getElementById('appai-boot');
          // Only pages the app itself created/hosts carry these markers: the
          // self-bootstrap cover (#appai-boot) or a theme app block container.
          // Ordinary merchant pages (Contact, About, FAQ...) also live under
          // /pages/ and reach this 404 branch — they must be left untouched.
          var isAppaiPage = !!staleBoot || !!document.querySelector(
            '.ai-art-studio-block, [data-block-handle="ai-art-studio"]'
          );
          if (staleBoot && staleBoot.parentNode) staleBoot.parentNode.removeChild(staleBoot);
          if (opts.fallbackUrl) {
            window.location.href = opts.fallbackUrl;
            return;
          }
          if (!isAppaiPage) {
            // Regular theme page that merely matched the /pages/ URL pattern —
            // do nothing. Injecting the "not configured" notice here put an
            // error message on every merchant Contact/About page.
            console.log('[AI Art Embed] /pages/' + handle + ' is not a customizer page; leaving it alone.');
            return;
          }
          // STATE=ERROR — an app-hosted page whose config is missing/paused.
          // Show a clear message instead of a blank page.
          console.log('[AI Art Embed] STATE=ERROR /pages/' + handle + ' is not a customizer page (404).');
          var mount = document.querySelector('#MainContent') ||
                      document.querySelector('main[role="main"]') ||
                      document.querySelector('main') ||
                      document.body;
          var notice = document.createElement('div');
          notice.style.cssText = 'max-width:640px;margin:40px auto;padding:24px;text-align:center;' +
            'font-family:system-ui,sans-serif;color:#6b7280;';
          notice.innerHTML = '<p style="font-size:16px;margin:0;">This customizer page is not configured yet.</p>' +
            '<p style="font-size:13px;margin:8px 0 0;">Please check the admin panel to activate it.</p>';
          mount.insertBefore(notice, mount.firstChild);
          return;
        }

        appaiMountCustomizerConfig(handle, config, opts);

        // Variant selector and style presets are now rendered INSIDE the
        // generator iframe (via AI_ART_STUDIO_SHOPIFY_VARIANTS and
        // AI_ART_STUDIO_STYLE_PRESETS postMessages sent in the BRIDGE_ACK
        // handler).  No external DOM is needed here.
      })
      .catch(function(e) {
        var failedBoot = document.getElementById('appai-boot');
        if (failedBoot && failedBoot.parentNode) failedBoot.parentNode.removeChild(failedBoot);
        if (opts.fallbackUrl) {
          window.location.href = opts.fallbackUrl;
          return;
        }
        // STATE=ERROR — network or parse failure.  Show error instead of blank page.
        console.error('[AI Art Embed] STATE=ERROR initCustomizerPage failed:', e);
        var mount = document.querySelector('#MainContent') ||
                    document.querySelector('main') ||
                    document.body;
        var notice = document.createElement('div');
        notice.style.cssText = 'max-width:640px;margin:40px auto;padding:24px;text-align:center;' +
          'font-family:system-ui,sans-serif;color:#991b1b;background:#fee2e2;border-radius:8px;';
        notice.innerHTML = '<p style="font-size:15px;margin:0;">Failed to load customizer. Please refresh the page.</p>';
        mount.insertBefore(notice, mount.firstChild);
      });
  }
})();
