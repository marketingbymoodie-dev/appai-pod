/**
 * AppAI Saved Designs Nav
 * ─────────────────────────────────────────────────────────────────────────
 * Runs on every storefront page. If the customer is logged in to their
 * AppAI customiser account (appai_customer_id in localStorage) and has at
 * least one saved design, injects a "Saved Designs" link as the first item
 * in the Customizer nav dropdown and wires up a slide-out drawer.
 *
 * CROSS-THEME DETECTION STRATEGY
 * ────────────────────────────────
 * Shopify themes render nav dropdowns in many different ways:
 *
 *   Dawn / Sense / Craft (most popular free themes):
 *     <details>
 *       <summary><span>Customizer</span></summary>
 *       <ul>  ← inject here
 *         <li><a href="/pages/slim-phone-cases">Slim Phone Cases</a></li>
 *       </ul>
 *     </details>
 *
 *   Debut / Brooklyn / Narrative (older free themes):
 *     <li class="site-nav__item--has-dropdown">
 *       <a>Customizer</a>
 *       <ul class="site-nav__dropdown">  ← inject here
 *         <li><a href="/pages/...">...</a></li>
 *       </ul>
 *     </li>
 *
 *   Impulse / Pipeline / Prestige (paid themes):
 *     <li class="...">
 *       <a>Customizer</a>
 *       <ul class="navmenu-depth-2">  ← inject here
 *         ...
 *       </ul>
 *     </li>
 *
 * The algorithm:
 *   1. Find ALL elements whose visible text is exactly "Customizer"
 *   2. For each, walk up the DOM to find the nearest ancestor that
 *      contains at least one <a href="/pages/..."> child
 *   3. Inside that ancestor, find the <ul> or <div> that holds those links
 *   4. Skip any match that is inside the footer
 *   5. Inject the "Saved Designs" item as the first child of that container
 *
 * RE-INJECTION ON DOM CHANGES
 * ────────────────────────────
 * Some Shopify themes re-render the nav when the URL changes via
 * history.replaceState (e.g. after add-to-cart resets the page URL),
 * which removes the injected nav item from the DOM. A MutationObserver
 * watches the document body and re-injects whenever the nav item disappears.
 */
;(function () {
  'use strict';

  if (window.__APPAI_SAVED_DESIGNS_NAV__) return;
  window.__APPAI_SAVED_DESIGNS_NAV__ = true;

  var PROXY = '/apps/appai';
  var LS_KEY_CUSTOMER_ID = 'appai_customer_id';
  var DRAWER_ID = 'appai-saved-designs-drawer';
  var NAV_ITEM_ID = 'appai-saved-designs-nav-item';
  var CUSTOMIZER_LABEL = 'Customizer';

  // ─── Helpers ────────────────────────────────────────────────────────────

  function getStoredCustomerId() {
    try { return localStorage.getItem(LS_KEY_CUSTOMER_ID) || null; } catch (_) { return null; }
  }

  function getShop() {
    return (window.Shopify && window.Shopify.shop) || window.location.hostname;
  }

  function isInFooter(el) {
    var node = el;
    while (node && node !== document.body) {
      var tag = node.tagName ? node.tagName.toLowerCase() : '';
      var cls = (node.className || '').toLowerCase();
      if (tag === 'footer' || cls.indexOf('footer') !== -1) return true;
      node = node.parentElement;
    }
    return false;
  }

  function getVisibleText(el) {
    // Use innerText (respects CSS visibility) when available, fall back to textContent
    return ((el.innerText !== undefined ? el.innerText : el.textContent) || '').trim();
  }

  function fetchDesigns(customerId, shop) {
    return fetch(PROXY + '/api/storefront/customizer/my-designs', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customerId: customerId, shop: shop })
    }).then(function (r) { return r.ok ? r.json() : null; });
  }

  // ─── Cross-theme dropdown detection ─────────────────────────────────────

  /**
   * Find ALL container elements that hold Customizer dropdown items.
   * Returns an array of containers (ul/div/nav) to inject into — covers
   * both the desktop header dropdown and the mobile drawer.
   */
  function findCustomizerDropdownContainers() {
    // Step 1: collect all DOM nodes whose direct visible text is "Customizer"
    var customizerNodes = [];
    try {
      var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
      var node;
      while ((node = walker.nextNode())) {
        if (node.nodeValue && node.nodeValue.trim() === CUSTOMIZER_LABEL) {
          customizerNodes.push(node.parentElement);
        }
      }
    } catch (_) {}

    var containers = [];
    var seen = [];

    // Step 2: for each candidate, walk up to find a container with /pages/ links
    for (var i = 0; i < customizerNodes.length; i++) {
      var candidate = customizerNodes[i];

      // Skip footer instances
      if (isInFooter(candidate)) continue;

      // Walk up at most 8 levels to find an ancestor that contains /pages/ links
      var el = candidate;
      var depth = 0;
      while (el && el !== document.body && depth < 8) {
        var pageLinks = el.querySelectorAll('a[href*="/pages/"]');
        if (pageLinks.length > 0) {
          var container = findBestContainer(el, pageLinks);
          if (container && seen.indexOf(container) === -1) {
            seen.push(container);
            containers.push(container);
          }
          break;
        }
        el = el.parentElement;
        depth++;
      }
    }

    return containers;
  }

  /**
   * Given an ancestor element that contains /pages/ links, find the most
   * specific container (<ul> or <div>) that directly wraps those links.
   */
  function findBestContainer(ancestor, pageLinks) {
    // Find the common parent of the page links
    // The first link's parent (or grandparent if it's an <li>) is our target
    var firstLink = pageLinks[0];
    var linkParent = firstLink.parentElement;

    // If the link is directly in a <ul> or <div>, that's our container
    var tag = linkParent ? linkParent.tagName.toLowerCase() : '';
    if (tag === 'ul' || tag === 'div' || tag === 'nav') {
      return linkParent;
    }

    // If the link is in an <li>, the <li>'s parent is the container
    if (tag === 'li') {
      var liParent = linkParent.parentElement;
      if (liParent) {
        var liParentTag = liParent.tagName.toLowerCase();
        if (liParentTag === 'ul' || liParentTag === 'div' || liParentTag === 'nav') {
          return liParent;
        }
      }
    }

    // Fall back: find the first <ul> inside the ancestor that contains a /pages/ link
    var uls = ancestor.querySelectorAll('ul');
    for (var i = 0; i < uls.length; i++) {
      if (uls[i].querySelector('a[href*="/pages/"]')) return uls[i];
    }

    // Last resort: return the ancestor itself
    return ancestor;
  }

  // ─── Nav item injection ──────────────────────────────────────────────────

  function injectNavItem(container, designs, suffix) {
    var itemId = NAV_ITEM_ID + (suffix || '');
    if (document.getElementById(itemId)) return;

    // Determine what tag to use for the wrapper (mirror existing items)
    var firstChild = container.querySelector('li');
    var wrapperTag = firstChild ? 'li' : 'div';

    var wrapper = document.createElement(wrapperTag);
    wrapper.id = itemId;
    // Copy classes from the first existing item for theme-consistent styling
    if (firstChild) wrapper.className = firstChild.className;

    var a = document.createElement('a');
    a.href = '#';
    a.setAttribute('role', 'button');
    a.style.cssText = 'display:flex;align-items:center;gap:6px;cursor:pointer;';

    // Copy link class from first existing link for consistent theme styling
    var firstLink = container.querySelector('a');
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
        'background:#e5e7eb;color:#111827;' +
        'border-radius:999px;font-size:10px;font-weight:700;line-height:1;' +
        'padding:2px 6px;min-width:18px;margin-left:4px;flex-shrink:0;' +
      '">' + designs.length + '</span>';

    a.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      openDrawer(designs);
    });

    wrapper.appendChild(a);
    container.insertBefore(wrapper, container.firstChild);

    console.log('[AppAI Nav] Injected Saved Designs nav item into container', suffix || 0, '| Designs:', designs.length);
  }

  // ─── Slide-out drawer ────────────────────────────────────────────────────

  function ensureStyles() {
    if (document.getElementById('appai-saved-designs-styles')) return;
    var style = document.createElement('style');
    style.id = 'appai-saved-designs-styles';
    style.textContent = [
      '#appai-saved-designs-overlay{',
        'position:fixed;inset:0;background:rgba(0,0,0,0.45);z-index:2147483646;',
        'opacity:0;transition:opacity 250ms ease;pointer-events:none;',
      '}',
      '#appai-saved-designs-overlay.appai-open{opacity:1;pointer-events:auto;}',
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
      '#appai-drawer-header{',
        'display:flex;align-items:center;justify-content:space-between;',
        'padding:20px 24px 18px;border-bottom:1px solid #f3f4f6;flex-shrink:0;',
      '}',
      '#appai-drawer-title{margin:0;font-size:17px;font-weight:700;color:#111827;letter-spacing:-0.01em;}',
      '#appai-drawer-close{',
        'background:none;border:none;cursor:pointer;padding:6px;color:#6b7280;',
        'display:flex;align-items:center;justify-content:center;border-radius:8px;',
        'transition:background 150ms,color 150ms;flex-shrink:0;',
      '}',
      '#appai-drawer-close:hover{background:#f3f4f6;color:#111827;}',
      '#appai-drawer-grid{',
        'flex:1;min-height:0;overflow-y:auto;padding:20px 20px 24px;',
        'display:grid;grid-template-columns:repeat(2,1fr);gap:14px;',
        'align-content:start;grid-auto-rows:max-content;overscroll-behavior:contain;',
      '}',
      '@media(min-width:400px){#appai-drawer-grid{grid-template-columns:repeat(3,1fr);}}',
      '.appai-design-card{',
        'border-radius:10px;overflow:hidden;border:1.5px solid #e5e7eb;',
        'cursor:pointer;transition:border-color 150ms,box-shadow 150ms,transform 150ms;',
        'background:#f9fafb;',
      '}',
      '.appai-design-card:hover{border-color:#6366f1;box-shadow:0 4px 16px rgba(99,102,241,0.18);transform:translateY(-1px);}',
      '.appai-design-card:active{transform:translateY(0);}',
      '.appai-design-card-img{aspect-ratio:1;overflow:hidden;background:#f3f4f6;}',
      '.appai-design-card-img img{width:100%;height:100%;object-fit:cover;display:block;}',
      '.appai-design-card-img-placeholder{width:100%;height:100%;display:flex;align-items:center;justify-content:center;color:#d1d5db;}',
      '.appai-design-card-label{padding:8px 10px 10px;}',
      '.appai-design-card-name{display:block;font-size:11.5px;font-weight:600;color:#111827;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-bottom:2px;}',
      '.appai-design-card-prompt{display:block;font-size:10.5px;color:#6b7280;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '#appai-drawer-empty{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:48px 24px;text-align:center;color:#6b7280;}',
    ].join('');
    document.head.appendChild(style);
  }

  function buildDrawer() {
    if (document.getElementById(DRAWER_ID)) return document.getElementById(DRAWER_ID);
    ensureStyles();

    var overlay = document.createElement('div');
    overlay.id = 'appai-saved-designs-overlay';
    overlay.addEventListener('click', closeDrawer);
    document.body.appendChild(overlay);

    var drawer = document.createElement('div');
    drawer.id = DRAWER_ID;
    drawer.setAttribute('role', 'dialog');
    drawer.setAttribute('aria-modal', 'true');
    drawer.setAttribute('aria-label', 'Saved Designs');

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
      '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
    closeBtn.addEventListener('click', closeDrawer);
    header.appendChild(title);
    header.appendChild(closeBtn);
    drawer.appendChild(header);

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
        '<path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>' +
        '<p style="font-size:15px;font-weight:600;color:#374151;margin:0 0 8px 0;">No saved designs yet</p>' +
        '<p style="font-size:13px;margin:0;line-height:1.5;">Visit a customiser page to create and save your first design.</p>';
      grid.appendChild(empty);
    } else {
      designs.forEach(function (design) {
        var card = document.createElement('div');
        card.className = 'appai-design-card';
        card.setAttribute('role', 'button');
        card.setAttribute('tabindex', '0');
        card.setAttribute('aria-label', (design.baseTitle || 'Custom Design') + ' \u2014 open in customiser');

        var imgUrl = (design.mockupUrls && design.mockupUrls.length > 0)
          ? design.mockupUrls[0] : design.artworkUrl;
        if (imgUrl && imgUrl.charAt(0) === '/') imgUrl = window.location.origin + imgUrl;

        var label = design.baseTitle || 'Custom Design';
        var prompt = design.prompt || '';
        var promptShort = prompt.length > 38 ? prompt.slice(0, 38) + '\u2026' : prompt;

        var imgHtml = imgUrl
          ? '<img src="' + imgUrl + '" alt="" loading="lazy" />'
          : '<div class="appai-design-card-img-placeholder">' +
              '<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" ' +
              'fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' +
              '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/>' +
              '<polyline points="21 15 16 10 5 21"/></svg></div>';

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

    var overlay = document.getElementById('appai-saved-designs-overlay');
    var drawer = document.getElementById(DRAWER_ID);
    overlay.classList.add('appai-open');
    drawer.classList.add('appai-open');
    document.body.style.overflow = 'hidden';
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

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      var drawer = document.getElementById(DRAWER_ID);
      if (drawer && drawer.classList.contains('appai-open')) closeDrawer();
    }
  });

  function navigateToDesign(design) {
    closeDrawer();
    if (!design.pageHandle) {
      console.warn('[AppAI Nav] No pageHandle for design', design.id);
      return;
    }
    window.location.href = '/pages/' + design.pageHandle + '?loadDesignId=' + encodeURIComponent(design.id);
  }

  // ─── Main init ───────────────────────────────────────────────────────────

  function init() {
    var customerId = getStoredCustomerId();
    if (!customerId) return;

    var shop = getShop();

    fetchDesigns(customerId, shop).then(function (data) {
      if (!data || !data.designs || data.designs.length === 0) {
        console.log('[AppAI Nav] No saved designs for this customer.');
        return;
      }

      var designs = data.designs;
      console.log('[AppAI Nav] Customer has', designs.length, 'saved designs. Attempting nav injection...');

      // Inject into all matching containers
      function tryInject() {
        var containers = findCustomizerDropdownContainers();
        if (containers.length > 0) {
          containers.forEach(function(container, idx) {
            injectNavItem(container, designs, idx === 0 ? '' : '-' + idx);
          });
          return true;
        }
        return false;
      }

      // Initial injection with retry backoff
      var attempts = 0;
      function retryInject() {
        if (tryInject()) return;
        attempts++;
        if (attempts < 8) {
          setTimeout(retryInject, attempts * 500);
        } else {
          console.warn('[AppAI Nav] Could not find Customizer dropdown after', attempts, 'attempts.');
        }
      }
      retryInject();

      window.__APPAI_SAVED_DESIGNS__ = designs;
      window.__APPAI_OPEN_SAVED_DESIGNS_DRAWER__ = function () { openDrawer(designs); };

      // ── MutationObserver: re-inject if the nav item is removed from the DOM ──
      // Some Shopify themes re-render the nav when the URL changes via
      // history.replaceState (e.g. after add-to-cart resets the page URL),
      // which removes the injected nav item. Watch for this and re-inject.
      var reinjecting = false;
      var observer = new MutationObserver(function () {
        // Check if any of our nav items have been removed
        var primaryItem = document.getElementById(NAV_ITEM_ID);
        if (!primaryItem && !reinjecting) {
          reinjecting = true;
          // Small debounce to let the theme finish its DOM update
          setTimeout(function () {
            console.log('[AppAI Nav] Nav item removed from DOM — re-injecting...');
            tryInject();
            reinjecting = false;
          }, 150);
        }
      });

      observer.observe(document.body, { childList: true, subtree: true });

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
