/**
 * AppAI Saved Designs Nav
 * ─────────────────────────────────────────────────────────────────────────
 * Runs on every storefront page. If the customer is logged in to their
 * AppAI customiser account (storefrontCustomerId in localStorage) and has
 * at least one saved design, injects a "Saved Designs" link as the first
 * item in the Customizer nav dropdown and wires up a slide-out drawer.
 *
 * The drawer shows design thumbnails; clicking one navigates to the correct
 * customiser page with loadDesignId set so the design loads ready to add to cart.
 *
 * Detection strategy: the server always creates the nav parent with the
 * exact title "Customizer". We find the <a> whose trimmed text === "Customizer",
 * then locate its sibling/child dropdown container and prepend our item.
 */
;(function () {
  'use strict';

  if (window.__APPAI_SAVED_DESIGNS_NAV__) return;
  window.__APPAI_SAVED_DESIGNS_NAV__ = true;

  var PROXY = '/apps/appai';
  var LS_KEY_CUSTOMER_ID = 'appai_customer_id';
  var LS_KEY_SHOP = 'appai_storefront_shop'; // not used — shop comes from window.Shopify.shop
  var DRAWER_ID = 'appai-saved-designs-drawer';
  var NAV_ITEM_ID = 'appai-saved-designs-nav-item';
  var CUSTOMIZER_LABEL = 'Customizer'; // exact title used by server nav creation

  // ─── Helpers ────────────────────────────────────────────────────────────

  function getStoredCustomerId() {
    try { return localStorage.getItem(LS_KEY_CUSTOMER_ID) || null; } catch (_) { return null; }
  }

  function getStoredShop() {
    return (window.Shopify && window.Shopify.shop) || window.location.hostname;
  }

  function fetchDesigns(customerId, shop) {
    return fetch(PROXY + '/api/storefront/customizer/my-designs', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customerId: customerId, shop: shop })
    }).then(function (r) { return r.ok ? r.json() : null; });
  }

  // ─── Nav item injection ──────────────────────────────────────────────────

  /**
   * Find the dropdown container that belongs to the "Customizer" nav item.
   *
   * Shopify themes render nav dropdowns in various ways:
   *   - Dawn / Refresh: <li class="header__menu-item"> containing <ul class="header__submenu">
   *   - Debut / Brooklyn: <li class="site-nav__item--has-dropdown"> with <ul class="site-nav__dropdown">
   *   - Impulse / Pipeline: <li> with <ul class="navmenu-depth-2"> or <div class="dropdown-menu">
   *
   * Strategy: find the <a> whose visible text is exactly "Customizer", then
   * walk up to its <li> and look for a <ul> or dropdown <div> sibling/descendant.
   */
  function findCustomizerDropdown() {
    var allLinks = document.querySelectorAll('a');
    var customizerLink = null;

    for (var i = 0; i < allLinks.length; i++) {
      var link = allLinks[i];
      // Use innerText to get visible text only (excludes hidden spans used for accessibility)
      var text = (link.innerText || link.textContent || '').trim();
      if (text === CUSTOMIZER_LABEL) {
        customizerLink = link;
        break;
      }
    }

    if (!customizerLink) return null;

    // Walk up to the parent <li> (or equivalent container)
    var li = customizerLink.parentElement;
    while (li && li.tagName.toLowerCase() !== 'li' && li !== document.body) {
      li = li.parentElement;
    }
    if (!li) return null;

    // Look for a dropdown list within the <li>
    // Try common selectors in order of specificity
    var dropdown =
      li.querySelector('ul[class*="submenu"]') ||
      li.querySelector('ul[class*="dropdown"]') ||
      li.querySelector('ul[class*="child"]') ||
      li.querySelector('ul[class*="sub-nav"]') ||
      li.querySelector('ul[class*="depth-2"]') ||
      li.querySelector('ul[class*="navmenu"]') ||
      li.querySelector('div[class*="dropdown"]') ||
      li.querySelector('div[class*="submenu"]') ||
      li.querySelector('ul:not([class*="header__menu-items"]):not([class*="site-nav--mobile"])') ||
      null;

    // If no specific match, take the first <ul> child that isn't the top-level nav
    if (!dropdown) {
      var uls = li.querySelectorAll('ul');
      if (uls.length > 0) dropdown = uls[0];
    }

    return dropdown;
  }

  function injectNavItem(dropdown, designs) {
    if (document.getElementById(NAV_ITEM_ID)) return; // already injected

    // Mirror the tag of existing items (li or div)
    var firstItem = dropdown.querySelector('li');
    var tag = firstItem ? 'li' : 'div';

    var li = document.createElement(tag);
    li.id = NAV_ITEM_ID;
    // Copy classes from the first existing item so it inherits theme styling
    if (firstItem) li.className = firstItem.className;

    var a = document.createElement('a');
    a.href = '#';
    a.setAttribute('role', 'button');
    a.style.cssText = 'display:flex;align-items:center;gap:6px;cursor:pointer;';

    // Copy link class from first existing link for consistent theme styling
    var firstLink = dropdown.querySelector('a');
    if (firstLink) a.className = firstLink.className;

    // Bookmark icon + label + count badge
    a.innerHTML =
      '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" ' +
      'fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" ' +
      'style="flex-shrink:0;opacity:0.8;" aria-hidden="true">' +
      '<path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>' +
      '</svg>' +
      '<span>Saved Designs</span>' +
      '<span id="appai-saved-count" style="' +
        'display:inline-flex;align-items:center;justify-content:center;' +
        'background:currentColor;color:var(--color-background,#fff);' +
        'border-radius:999px;font-size:10px;font-weight:700;line-height:1;' +
        'padding:2px 6px;min-width:18px;opacity:0.7;margin-left:2px;' +
      '">' + designs.length + '</span>';

    a.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      openDrawer(designs);
    });

    li.appendChild(a);

    // Insert as the very first item in the dropdown
    dropdown.insertBefore(li, dropdown.firstChild);
  }

  // ─── Slide-out drawer ────────────────────────────────────────────────────

  function ensureStyles() {
    if (document.getElementById('appai-saved-designs-styles')) return;
    var style = document.createElement('style');
    style.id = 'appai-saved-designs-styles';
    style.textContent = [
      /* Overlay */
      '#appai-saved-designs-overlay{',
        'position:fixed;inset:0;background:rgba(0,0,0,0.45);z-index:2147483646;',
        'opacity:0;transition:opacity 250ms ease;pointer-events:none;',
      '}',
      '#appai-saved-designs-overlay.appai-open{opacity:1;pointer-events:auto;}',

      /* Drawer panel */
      '#' + DRAWER_ID + '{',
        'position:fixed;top:0;right:0;height:100%;width:min(440px,100vw);',
        'background:#fff;z-index:2147483647;',
        'transform:translateX(100%);transition:transform 320ms cubic-bezier(0.4,0,0.2,1);',
        'display:flex;flex-direction:column;',
        'box-shadow:-6px 0 32px rgba(0,0,0,0.18);',
        'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;',
        'color:#111827;',
      '}',
      '#' + DRAWER_ID + '.appai-open{transform:translateX(0);}',

      /* Header */
      '#appai-drawer-header{',
        'display:flex;align-items:center;justify-content:space-between;',
        'padding:20px 24px 18px;border-bottom:1px solid #f3f4f6;flex-shrink:0;',
      '}',
      '#appai-drawer-title{',
        'margin:0;font-size:17px;font-weight:700;color:#111827;letter-spacing:-0.01em;',
      '}',
      '#appai-drawer-close{',
        'background:none;border:none;cursor:pointer;padding:6px;color:#6b7280;',
        'display:flex;align-items:center;justify-content:center;border-radius:8px;',
        'transition:background 150ms,color 150ms;flex-shrink:0;',
      '}',
      '#appai-drawer-close:hover{background:#f3f4f6;color:#111827;}',

      /* Scrollable grid */
      '#appai-drawer-grid{',
        'flex:1;overflow-y:auto;padding:20px 20px 24px;',
        'display:grid;grid-template-columns:repeat(2,1fr);gap:14px;',
        'align-content:start;overscroll-behavior:contain;',
      '}',
      '@media(min-width:400px){#appai-drawer-grid{grid-template-columns:repeat(3,1fr);}}',

      /* Design cards */
      '.appai-design-card{',
        'border-radius:12px;overflow:hidden;border:1.5px solid #e5e7eb;',
        'cursor:pointer;transition:border-color 180ms,box-shadow 180ms,transform 180ms;',
        'background:#f9fafb;',
      '}',
      '.appai-design-card:hover{',
        'border-color:#6366f1;box-shadow:0 4px 16px rgba(99,102,241,0.18);',
        'transform:translateY(-1px);',
      '}',
      '.appai-design-card:active{transform:translateY(0);}',
      '.appai-design-card-img{aspect-ratio:1;overflow:hidden;background:#f3f4f6;}',
      '.appai-design-card-img img{width:100%;height:100%;object-fit:cover;display:block;}',
      '.appai-design-card-img-placeholder{',
        'width:100%;height:100%;display:flex;align-items:center;justify-content:center;color:#d1d5db;',
      '}',
      '.appai-design-card-label{padding:8px 10px 10px;}',
      '.appai-design-card-name{',
        'display:block;font-size:11.5px;font-weight:600;color:#111827;',
        'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-bottom:2px;',
      '}',
      '.appai-design-card-prompt{',
        'display:block;font-size:10.5px;color:#6b7280;',
        'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;',
      '}',

      /* Empty state */
      '#appai-drawer-empty{',
        'flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;',
        'padding:48px 24px;text-align:center;color:#6b7280;',
      '}',
    ].join('');
    document.head.appendChild(style);
  }

  function buildDrawer() {
    if (document.getElementById(DRAWER_ID)) return document.getElementById(DRAWER_ID);

    ensureStyles();

    // Overlay (click to close)
    var overlay = document.createElement('div');
    overlay.id = 'appai-saved-designs-overlay';
    overlay.addEventListener('click', closeDrawer);
    document.body.appendChild(overlay);

    // Drawer shell
    var drawer = document.createElement('div');
    drawer.id = DRAWER_ID;
    drawer.setAttribute('role', 'dialog');
    drawer.setAttribute('aria-modal', 'true');
    drawer.setAttribute('aria-label', 'Saved Designs');

    // Header
    var header = document.createElement('div');
    header.id = 'appai-drawer-header';

    var title = document.createElement('h2');
    title.id = 'appai-drawer-title';
    title.textContent = 'Saved Designs';

    var closeBtn = document.createElement('button');
    closeBtn.id = 'appai-drawer-close';
    closeBtn.setAttribute('aria-label', 'Close saved designs');
    closeBtn.innerHTML =
      '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" ' +
      'fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">' +
      '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>' +
      '</svg>';
    closeBtn.addEventListener('click', closeDrawer);

    header.appendChild(title);
    header.appendChild(closeBtn);
    drawer.appendChild(header);

    // Grid (populated in openDrawer)
    var grid = document.createElement('div');
    grid.id = 'appai-drawer-grid';
    drawer.appendChild(grid);

    document.body.appendChild(drawer);
    return drawer;
  }

  function openDrawer(designs) {
    buildDrawer();
    var grid = document.getElementById('appai-drawer-grid');
    grid.innerHTML = '';

    if (!designs || designs.length === 0) {
      var empty = document.createElement('div');
      empty.id = 'appai-drawer-empty';
      empty.innerHTML =
        '<svg xmlns="http://www.w3.org/2000/svg" width="52" height="52" viewBox="0 0 24 24" ' +
        'fill="none" stroke="#d1d5db" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" ' +
        'style="margin-bottom:16px;">' +
        '<path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>' +
        '</svg>' +
        '<p style="font-size:15px;font-weight:600;color:#374151;margin:0 0 8px 0;">No saved designs yet</p>' +
        '<p style="font-size:13px;margin:0;line-height:1.5;">Visit a customiser page to create and save your first design.</p>';
      grid.appendChild(empty);
    } else {
      designs.forEach(function (design) {
        var card = document.createElement('div');
        card.className = 'appai-design-card';
        card.setAttribute('role', 'button');
        card.setAttribute('tabindex', '0');
        card.setAttribute('aria-label', (design.baseTitle || 'Custom Design') + ' — open in customiser');

        // Prefer first mockup URL, fall back to artwork URL
        var imgUrl = (design.mockupUrls && design.mockupUrls.length > 0)
          ? design.mockupUrls[0]
          : design.artworkUrl;

        // Convert relative proxy URLs to absolute
        if (imgUrl && imgUrl.charAt(0) === '/') {
          imgUrl = window.location.origin + imgUrl;
        }

        var label = design.baseTitle || 'Custom Design';
        var prompt = design.prompt || '';
        var promptShort = prompt.length > 38 ? prompt.slice(0, 38) + '\u2026' : prompt;

        var imgHtml = imgUrl
          ? '<img src="' + imgUrl + '" alt="" loading="lazy" />'
          : '<div class="appai-design-card-img-placeholder">' +
              '<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" ' +
              'fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' +
              '<rect x="3" y="3" width="18" height="18" rx="2"/>' +
              '<circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>' +
              '</svg>' +
            '</div>';

        card.innerHTML =
          '<div class="appai-design-card-img">' + imgHtml + '</div>' +
          '<div class="appai-design-card-label">' +
            '<span class="appai-design-card-name">' + label + '</span>' +
            (promptShort ? '<span class="appai-design-card-prompt">' + promptShort + '</span>' : '') +
          '</div>';

        var onClick = function () { navigateToDesign(design); };
        card.addEventListener('click', onClick);
        card.addEventListener('keydown', function (e) {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); }
        });

        grid.appendChild(card);
      });
    }

    // Animate open
    var overlay = document.getElementById('appai-saved-designs-overlay');
    var drawer = document.getElementById(DRAWER_ID);
    overlay.classList.add('appai-open');
    drawer.classList.add('appai-open');
    document.body.style.overflow = 'hidden';

    // Focus the close button for keyboard accessibility
    setTimeout(function () {
      var closeBtn = document.getElementById('appai-drawer-close');
      if (closeBtn) closeBtn.focus();
    }, 330);
  }

  function closeDrawer() {
    var drawer = document.getElementById(DRAWER_ID);
    var overlay = document.getElementById('appai-saved-designs-overlay');
    if (drawer) drawer.classList.remove('appai-open');
    if (overlay) overlay.classList.remove('appai-open');
    document.body.style.overflow = '';
  }

  // Close on Escape key
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      var drawer = document.getElementById(DRAWER_ID);
      if (drawer && drawer.classList.contains('appai-open')) closeDrawer();
    }
  });

  function navigateToDesign(design) {
    closeDrawer();
    var handle = design.pageHandle;
    if (!handle) {
      console.warn('[AppAI Nav] No pageHandle for design', design.id, '— cannot navigate');
      return;
    }
    window.location.href = '/pages/' + handle + '?loadDesignId=' + encodeURIComponent(design.id);
  }

  // ─── Main init ───────────────────────────────────────────────────────────

  function init() {
    var customerId = getStoredCustomerId();
    if (!customerId) return; // not logged in — nothing to do

    var shop = getStoredShop();

    fetchDesigns(customerId, shop).then(function (data) {
      if (!data || !data.designs || data.designs.length === 0) return;

      var designs = data.designs;

      // Attempt to inject the nav item. Retry a few times to handle themes
      // that render the nav asynchronously or via JavaScript.
      var attempts = 0;
      function tryInject() {
        if (document.getElementById(NAV_ITEM_ID)) return; // already done
        var dropdown = findCustomizerDropdown();
        if (dropdown) {
          injectNavItem(dropdown, designs);
          return;
        }
        attempts++;
        if (attempts < 6) {
          setTimeout(tryInject, attempts * 600); // 600ms, 1200ms, 1800ms, 2400ms, 3000ms
        }
      }

      tryInject();

      // Expose globally so the customiser iframe can trigger a drawer refresh
      window.__APPAI_SAVED_DESIGNS__ = designs;
      window.__APPAI_OPEN_SAVED_DESIGNS_DRAWER__ = function () { openDrawer(designs); };

    }).catch(function (e) {
      console.warn('[AppAI Nav] Failed to fetch saved designs:', e);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
