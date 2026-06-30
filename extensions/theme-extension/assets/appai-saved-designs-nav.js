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

  // Module-scoped session context so openDrawer() can re-fetch the latest
  // designs (e.g. after a customer edits an already-saved design in the
  // customizer iframe) without relying on a stale closure from init().
  var _customerId = null;
  var _shop = null;

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
   * Find ALL Customizer nav entries across themes — fully generic.
   *
   * For every visible text node "Customizer" not in a footer, walks up to find:
   *   - trigger: the clickable element holding the label (a, button, summary, .menu-list__link)
   *   - root:    the smallest dropdown wrapper around trigger (li, details, header-menu li, custom-element)
   *   - submenu: the nearest container (ul/div/nav) inside root that holds /pages/ links
   *
   * No theme-specific class names required. Returns one entry per distinct root.
   */
  function findCustomizerMenuRoots() {
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

    var entries = [];
    var seen = [];
    var triggerSel = 'a, button, summary, [role="button"], .menu-list__link';

    function nearestTrigger(start) {
      var el = start;
      var depth = 0;
      while (el && el !== document.body && depth < 6) {
        if (el.matches && el.matches(triggerSel)) return el;
        el = el.parentElement;
        depth++;
      }
      return start;
    }

    function findSubmenuInside(root, trigger) {
      var pageLinks = root.querySelectorAll('a[href*="/pages/"]');
      if (!pageLinks.length) return null;
      var first = pageLinks[0];
      var p = first.parentElement;
      var hops = 0;
      while (p && p !== root && hops < 6) {
        if (trigger && (p === trigger || p.contains(trigger))) {
          p = p.parentElement;
          hops++;
          continue;
        }
        var t = p.tagName ? p.tagName.toLowerCase() : '';
        if (t === 'ul' || t === 'nav' || t === 'div' || t === 'section') return p;
        p = p.parentElement;
        hops++;
      }
      var candidates = root.querySelectorAll('ul, nav, div, section');
      for (var i = 0; i < candidates.length; i++) {
        var c = candidates[i];
        if (trigger && (c.contains(trigger) || trigger.contains(c))) continue;
        if (c.querySelector('a[href*="/pages/"]')) return c;
      }
      return null;
    }

    function isVisible(el) {
      if (!el || !el.isConnected) return false;
      var node = el;
      while (node && node !== document.documentElement) {
        var cs = window.getComputedStyle(node);
        if (cs.display === 'none' || cs.visibility === 'hidden') return false;
        node = node.parentElement;
      }
      var r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    }

    for (var i = 0; i < customizerNodes.length; i++) {
      var candidate = customizerNodes[i];
      if (!candidate || isInFooter(candidate)) continue;

      var trigger = nearestTrigger(candidate);

      // Skip mobile drawer duplicates: trigger inside a hidden container has
      // zero/garbage geometry that breaks hot-zone math.
      if (!isVisible(trigger)) continue;

      // Walk up from trigger to find the smallest ancestor that ALSO contains
      // a /pages/ link not inside the trigger itself — that ancestor is the
      // dropdown wrapper (works for parent-child AND sibling-based layouts).
      var ancestor = trigger.parentElement;
      var depth = 0;
      var chosenRoot = null;
      var chosenSubmenu = null;
      while (ancestor && ancestor !== document.body && depth < 14) {
        var sub = findSubmenuInside(ancestor, trigger);
        if (sub && !trigger.contains(sub) && sub !== trigger) {
          chosenRoot = ancestor;
          chosenSubmenu = sub;
          break;
        }
        ancestor = ancestor.parentElement;
        depth++;
      }
      if (!chosenRoot) continue;
      if (seen.indexOf(chosenRoot) !== -1) continue;
      seen.push(chosenRoot);

      var rootTag = chosenRoot.tagName.toLowerCase();
      var kind = rootTag === 'details' ? 'details' : 'generic';

      entries.push({
        root: chosenRoot,
        kind: kind,
        link: trigger,
        submenu: chosenSubmenu,
      });
    }

    return entries;
  }

  // ─── Our own dropdown panel (universal, theme-independent) ──────────────
  //
  // RATIONALE
  // ─────────
  // Trying to make the theme's native dropdown behave reliably across every
  // Shopify theme is unwinnable — themes vary in DOM, CSS, JS, hide
  // mechanisms (display, visibility, transform, clip-path, max-height, etc.),
  // animation timing, and event handling. We previously tried force-show CSS
  // + hot-zone math + native event dispatch and it still failed on some
  // themes because each theme has its own quirks.
  //
  // The new approach: stop fighting the theme. We render OUR OWN panel,
  // fixed-position, anchored to the theme's Customizer trigger. We parse the
  // same items the theme would show from its submenu and render them in our
  // panel with our own styling. Because we control the panel DOM, CSS, and
  // event handlers end-to-end, it works on every theme.
  //
  // We also intercept the trigger's click (capture-phase, preventDefault) so
  // themes whose "Customizer" links to a non-existent /pages/customizer page
  // never navigate to a blank page — clicking the trigger toggles our panel.

  var __appaiOwnPanel = null;
  var __appaiOwnPanelTrigger = null;
  var __appaiOwnPanelSubmenu = null;
  var __appaiOwnPanelOpen = false;
  var __appaiOwnPanelCloseTimer = null;

  function ensureOwnPanelStyles() {
    if (document.getElementById('appai-own-panel-styles')) return;
    var style = document.createElement('style');
    style.id = 'appai-own-panel-styles';
    style.textContent = [
      '#appai-own-panel{',
        'position:fixed;display:none;',
        'background:#ffffff;color:#111827;',
        'border-radius:10px;',
        'box-shadow:0 10px 32px rgba(0,0,0,0.18),0 2px 6px rgba(0,0,0,0.06);',
        'border:1px solid rgba(0,0,0,0.06);',
        'min-width:220px;max-width:340px;padding:6px 0;margin:0;',
        'z-index:2147483645;',
        'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;',
        'font-size:14px;line-height:1.4;',
        'list-style:none;',
      '}',
      '#appai-own-panel.appai-open{display:block;}',
      '#appai-own-panel a.appai-own-item{',
        'display:flex;align-items:center;gap:10px;',
        'padding:10px 16px;color:#111827;text-decoration:none;',
        'background:transparent;border:none;width:100%;text-align:left;',
        'cursor:pointer;font-weight:500;font-size:14px;line-height:1.4;',
        'transition:background 120ms ease;box-sizing:border-box;',
      '}',
      '#appai-own-panel a.appai-own-item:hover,',
      '#appai-own-panel a.appai-own-item:focus{',
        'background:#f3f4f6;color:#111827;text-decoration:none;outline:none;',
      '}',
      '#appai-own-panel .appai-own-icon{flex-shrink:0;opacity:0.7;}',
      '#appai-own-panel .appai-own-badge{',
        'margin-left:auto;background:#e5e7eb;color:#111827;',
        'border-radius:999px;padding:2px 8px;font-size:11px;font-weight:700;',
        'line-height:1;',
      '}',
      // Invisible bridge below the trigger so the cursor doesn't lose hover
      // while travelling from trigger to panel (panel sits 6px below trigger).
      '[data-appai-own-trigger]{position:relative;}',
      '[data-appai-own-trigger]::after{',
        'content:"";position:absolute;left:-12px;right:-12px;',
        'top:100%;height:14px;pointer-events:auto;',
      '}',
    ].join('');
    document.head.appendChild(style);
  }

  function ensureOwnPanel() {
    if (__appaiOwnPanel && __appaiOwnPanel.isConnected) return __appaiOwnPanel;
    ensureOwnPanelStyles();
    var panel = document.createElement('div');
    panel.id = 'appai-own-panel';
    panel.setAttribute('role', 'menu');
    panel.setAttribute('aria-label', 'Customizer menu');
    panel.addEventListener('mouseenter', cancelOwnPanelClose);
    panel.addEventListener('mouseleave', scheduleOwnPanelClose);
    document.body.appendChild(panel);
    __appaiOwnPanel = panel;
    return panel;
  }

  function buildOwnPanelItems(submenu) {
    var items = [];
    var seen = {};

    if (submenu) {
      var anchors = submenu.querySelectorAll('a[href]');
      for (var i = 0; i < anchors.length; i++) {
        var a = anchors[i];
        var href = a.getAttribute('href') || '';
        if (!href || href === '#') {
          // Allow the injected Saved Designs item (href=#) — detected below.
        }
        var label = ((a.innerText !== undefined ? a.innerText : a.textContent) || '').trim();
        // Strip injected badge count (e.g. "Saved Designs 15" → "Saved Designs")
        label = label.replace(/\s+\d+$/, '').trim();
        if (!label) continue;
        var savedAncestor = null;
        try { savedAncestor = a.closest('[id^="appai-saved-designs-nav-item"]'); } catch (_) {}
        var isSavedDesigns = !!savedAncestor;
        var key = (isSavedDesigns ? 'saved' : href) + '|' + label.toLowerCase();
        if (seen[key]) continue;
        seen[key] = true;
        items.push({ href: href, label: label, isSavedDesigns: isSavedDesigns });
      }
    }

    // Always ensure Saved Designs sits at the top when the customer has any.
    var designs = window.__APPAI_SAVED_DESIGNS__ || [];
    if (designs.length > 0) {
      var existingIdx = -1;
      for (var j = 0; j < items.length; j++) {
        if (items[j].isSavedDesigns) { existingIdx = j; break; }
      }
      if (existingIdx === -1) {
        items.unshift({ href: '#saved-designs', label: 'Saved Designs', isSavedDesigns: true });
      } else if (existingIdx !== 0) {
        var moved = items.splice(existingIdx, 1)[0];
        items.unshift(moved);
      }
    }

    return items;
  }

  function renderOwnPanel(items) {
    var panel = ensureOwnPanel();
    panel.innerHTML = '';
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      var a = document.createElement('a');
      a.className = 'appai-own-item';
      a.setAttribute('role', 'menuitem');

      if (item.isSavedDesigns) {
        a.href = '#';
        var designs = window.__APPAI_SAVED_DESIGNS__ || [];
        a.innerHTML =
          '<svg class="appai-own-icon" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" ' +
            'fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
            '<path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>' +
          '<span>Saved Designs</span>' +
          (designs.length ? '<span class="appai-own-badge">' + designs.length + '</span>' : '');
        a.addEventListener('click', function (e) {
          e.preventDefault();
          e.stopPropagation();
          closeOwnPanel();
          try { openDrawer(); } catch (_) {}
        });
      } else {
        a.href = item.href;
        a.textContent = item.label;
        a.addEventListener('click', function () {
          // Let the browser navigate normally; just hide the panel first so
          // it doesn't flash during the page transition.
          closeOwnPanel();
        });
      }

      panel.appendChild(a);
    }
  }

  function positionOwnPanel(trigger) {
    if (!__appaiOwnPanel || !trigger) return;
    var rect = trigger.getBoundingClientRect();
    var panel = __appaiOwnPanel;

    // Measure with display:block but invisible (avoids flicker).
    var wasOpen = panel.classList.contains('appai-open');
    panel.style.visibility = 'hidden';
    panel.style.display = 'block';
    var pw = panel.offsetWidth;
    var ph = panel.offsetHeight;
    if (!wasOpen) panel.style.display = '';
    panel.style.visibility = '';

    var vw = window.innerWidth;
    var vh = window.innerHeight;

    var top = rect.bottom + 6;
    // If panel would overflow bottom, flip above the trigger.
    if (top + ph > vh - 8 && rect.top - 6 - ph >= 8) {
      top = rect.top - 6 - ph;
    }

    var left = rect.left;
    if (left + pw > vw - 8) left = vw - pw - 8;
    if (left < 8) left = 8;

    panel.style.top = Math.max(8, top) + 'px';
    panel.style.left = left + 'px';
    if (rect.width > 220) {
      panel.style.minWidth = Math.min(rect.width + 40, 340) + 'px';
    } else {
      panel.style.minWidth = '220px';
    }
  }

  function openOwnPanel(trigger, submenu) {
    if (!trigger) return;
    cancelOwnPanelClose();
    var items = buildOwnPanelItems(submenu);
    if (!items.length) return;
    __appaiOwnPanelTrigger = trigger;
    __appaiOwnPanelSubmenu = submenu;
    renderOwnPanel(items);
    var panel = ensureOwnPanel();
    panel.classList.add('appai-open');
    positionOwnPanel(trigger);
    __appaiOwnPanelOpen = true;
    try { trigger.setAttribute('aria-expanded', 'true'); } catch (_) {}
  }

  function closeOwnPanel() {
    if (!__appaiOwnPanel) return;
    __appaiOwnPanel.classList.remove('appai-open');
    __appaiOwnPanelOpen = false;
    if (__appaiOwnPanelTrigger) {
      try { __appaiOwnPanelTrigger.removeAttribute('aria-expanded'); } catch (_) {}
    }
  }

  function scheduleOwnPanelClose() {
    cancelOwnPanelClose();
    __appaiOwnPanelCloseTimer = setTimeout(closeOwnPanel, 260);
  }

  function cancelOwnPanelClose() {
    if (__appaiOwnPanelCloseTimer) {
      clearTimeout(__appaiOwnPanelCloseTimer);
      __appaiOwnPanelCloseTimer = null;
    }
  }

  function bindOwnTrigger(entry) {
    var trigger = entry.link;
    var submenu = entry.submenu;
    if (!trigger || trigger.getAttribute('data-appai-own-trigger') === '1') return;
    trigger.setAttribute('data-appai-own-trigger', '1');

    // Capture-phase click — intercepts before theme handlers / native nav.
    // Always opens our panel; never lets the theme navigate to a possibly
    // blank /pages/customizer page.
    trigger.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      if (__appaiOwnPanelOpen && __appaiOwnPanelTrigger === trigger) {
        closeOwnPanel();
      } else {
        openOwnPanel(trigger, submenu);
      }
    }, true);

    // Hover-to-open on the trigger. The invisible bridge below the trigger
    // (CSS pseudo-element) prevents losing hover while travelling to panel.
    trigger.addEventListener('mouseenter', function () {
      openOwnPanel(trigger, submenu);
    });
    trigger.addEventListener('mouseleave', scheduleOwnPanelClose);

    // Stop the theme's native dropdown from showing when we own the
    // interaction — themes that use <details><summary> will still toggle by
    // default unless we kill the click. Our preventDefault above handles it,
    // but for keyboard activation on <summary> we also override toggle.
    if (entry.kind === 'details') {
      entry.root.addEventListener('toggle', function () {
        // If theme expanded the details, our panel handles display.
        // Force it back closed so we don't show two menus.
        try { if (entry.root.open && !__appaiOwnPanelOpen) entry.root.open = false; } catch (_) {}
      });
    }
  }

  function ensureOwnPanelGlobalHandlers() {
    if (window.__appaiOwnPanelGlobals) return;
    window.__appaiOwnPanelGlobals = true;

    // Click outside the panel + trigger closes.
    document.addEventListener('click', function (e) {
      if (!__appaiOwnPanelOpen) return;
      var t = e.target;
      if (__appaiOwnPanel && __appaiOwnPanel.contains(t)) return;
      if (__appaiOwnPanelTrigger && __appaiOwnPanelTrigger.contains && __appaiOwnPanelTrigger.contains(t)) return;
      closeOwnPanel();
    }, true);

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && __appaiOwnPanelOpen) closeOwnPanel();
    });

    // Reposition while open if layout shifts.
    var reposition = function () {
      if (__appaiOwnPanelOpen && __appaiOwnPanelTrigger) {
        positionOwnPanel(__appaiOwnPanelTrigger);
      }
    };
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
  }

  /**
   * Bind our own panel to every Customizer trigger we can find.
   * Safe to call repeatedly — each trigger is bound only once.
   */
  function enhanceCustomizerNavHover() {
    ensureOwnPanelStyles();
    ensureOwnPanelGlobalHandlers();

    var menus = findCustomizerMenuRoots();
    for (var i = 0; i < menus.length; i++) {
      bindOwnTrigger(menus[i]);
    }
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
      // Open with the latest list (openDrawer reads the live cache and
      // kicks a background refresh) rather than this stale closure.
      openDrawer();
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

  // Compact signature of the design list so we can tell whether a refresh
  // actually changed anything (avoids needless re-render + refetch loops).
  function designsSignature(designs) {
    if (!designs || !designs.length) return '0';
    return designs
      .map(function (d) {
        var m = (d.mockupUrls && d.mockupUrls.length) ? d.mockupUrls[0] : (d.artworkUrl || '');
        return d.id + ':' + m;
      })
      .join('|');
  }

  // Re-fetch designs and, if the list changed while the drawer is open,
  // re-render it in place. Called when the drawer is opened so an edit
  // made in the customizer iframe shows up without a full page reload.
  function refreshDrawerIfChanged() {
    if (!_customerId) return;
    var before = designsSignature(window.__APPAI_SAVED_DESIGNS__ || []);
    fetchDesigns(_customerId, _shop).then(function (data) {
      if (!data || !data.designs) return;
      window.__APPAI_SAVED_DESIGNS__ = data.designs;
      var badge = document.getElementById('appai-saved-count');
      if (badge) badge.textContent = data.designs.length;
      var drawer = document.getElementById(DRAWER_ID);
      var isOpen = drawer && drawer.classList.contains('appai-open');
      if (isOpen && designsSignature(data.designs) !== before) {
        renderDrawer(data.designs);
      }
    }).catch(function () { /* ignore */ });
  }

  // Open the drawer using the freshest list we have, then kick a background
  // refresh so any just-saved edit appears immediately.
  function openDrawer(designsArg) {
    var designs = designsArg || window.__APPAI_SAVED_DESIGNS__ || [];
    renderDrawer(designs);
    var overlay = document.getElementById('appai-saved-designs-overlay');
    var drawer = document.getElementById(DRAWER_ID);
    overlay.classList.add('appai-open');
    drawer.classList.add('appai-open');
    document.body.style.overflow = 'hidden';
    setTimeout(function () {
      var closeBtn = document.getElementById('appai-drawer-close');
      if (closeBtn) closeBtn.focus();
    }, 330);
    refreshDrawerIfChanged();
  }

  // Render (or re-render) the drawer grid from a designs array. Does NOT
  // touch open/close state, so it's safe to call to refresh in place.
  function renderDrawer(designs) {
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

  // Paint an opaque full-viewport overlay showing the chosen design's mockup,
  // then navigate. During a full page reload the browser keeps the *current*
  // (old) page painted until the new one is ready — so covering it now means
  // the customer only ever sees the correct design, never a flash of the
  // previously-open product page. The destination page repaints the same
  // mockup (via ?loadMockup=) so the hand-off is seamless.
  function showNavOverlay(mockupUrl, productName) {
    if (!document.getElementById('appai-transition-styles')) {
      var style = document.createElement('style');
      style.id = 'appai-transition-styles';
      style.textContent = [
        '@keyframes appai-transition-title-shimmer{0%{background-position:200% center}100%{background-position:-200% center}}',
        '@media(max-width:640px){.appai-transition-title{font-size:28px!important;}}',
      ].join('');
      document.head.appendChild(style);
    }
    document.documentElement.style.background = '#f4f4f5';
    document.documentElement.style.overflowY = 'scroll';
    document.documentElement.style.scrollbarGutter = 'stable both-edges';
    if (document.body) {
      document.body.style.background = '#f4f4f5';
      document.body.style.overflowY = 'scroll';
      document.body.style.scrollbarGutter = 'stable both-edges';
    }
    var overlay = document.getElementById('appai-nav-transition');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'appai-nav-transition';
      overlay.setAttribute('aria-hidden', 'true');
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
      overlay.appendChild(inner);
      var root = document.documentElement || document.body;
      if (document.body && root === document.documentElement && document.body.parentNode === root) {
        root.insertBefore(overlay, document.body);
      } else {
        root.appendChild(overlay);
      }
    }
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
    // Flush layout so the loader is painted before navigation starts.
    void overlay.offsetHeight;
  }

  function navigateAfterOverlay(url) {
    var go = function () { window.location.href = url; };
    if (window.requestAnimationFrame) {
      window.requestAnimationFrame(function () {
        window.requestAnimationFrame(go);
      });
    } else {
      window.setTimeout(go, 32);
    }
  }

  function navigateToDesign(design) {
    closeDrawer();
    if (!design.pageHandle) {
      console.warn('[AppAI Nav] No pageHandle for design', design.id);
      return;
    }
    var url = '/pages/' + design.pageHandle + '?loadDesignId=' + encodeURIComponent(design.id);
    // Pass the design's mockup so the customizer can paint it instantly while
    // the full design data loads (avoids the grey loading scan on open).
    var mockup = (design.mockupUrls && design.mockupUrls[0]) || '';
    if (mockup) url += '&loadMockup=' + encodeURIComponent(mockup);
    var productName = design.baseTitle || 'saved design';
    if (productName) url += '&loadProductName=' + encodeURIComponent(productName);
    try {
      var activeIframe = document.querySelector('.ai-art-studio-embed iframe[title="AI Art Design Studio"], iframe[title="AI Art Design Studio"]');
      if (activeIframe && activeIframe.contentWindow) {
        activeIframe.contentWindow.postMessage({
          type: 'AI_ART_STUDIO_SWITCH_SAVED_DESIGN',
          design: {
            id: design.id,
            pageHandle: design.pageHandle,
            mockupUrls: mockup ? [mockup] : [],
            baseTitle: productName,
            productTypeId: design.productTypeId || null
          }
        }, '*');
        return;
      }
    } catch (e) {
      console.warn('[AppAI Nav] Iframe saved design switch failed, using full page navigation:', e);
    }
    showNavOverlay(mockup, productName);
    navigateAfterOverlay(url);
  }

  // ─── Main init ───────────────────────────────────────────────────────────

  /**
   * Bind our own dropdown panel to every Customizer trigger on the page.
   * Runs on every storefront page (not gated on customer login) so themes
   * with a non-existent /pages/customizer link never produce blank pages,
   * even for logged-out visitors.
   *
   * Retried for ~6s to cover themes that render the nav asynchronously
   * (SPA-style sections, mobile menu fade-in, etc.). Each trigger is
   * marked with data-appai-own-trigger so we never double-bind.
   *
   * SPA re-renders (e.g. after add-to-cart's history.replaceState) are
   * picked up by the MutationObserver in init() for logged-in customers,
   * and by the retry loop here for all visitors.
   */
  function initCustomizerNavHover() {
    function run() {
      try { enhanceCustomizerNavHover(); } catch (e) {
        console.warn('[AppAI Nav] enhanceCustomizerNavHover failed:', e);
      }
    }
    run();
    var attempts = 0;
    var retry = setInterval(function () {
      run();
      attempts++;
      if (attempts >= 12) clearInterval(retry);
    }, 500);
    // Also re-bind when the DOM is mutated (covers themes that lazily
    // render the header nav after first paint or rewire it on route change).
    if (window.MutationObserver) {
      var debounce = null;
      var mo = new MutationObserver(function () {
        if (debounce) return;
        debounce = setTimeout(function () { debounce = null; run(); }, 250);
      });
      try { mo.observe(document.body, { childList: true, subtree: true }); } catch (_) {}
    }
  }

  function init() {
    var customerId = getStoredCustomerId();
    if (!customerId) return;

    var shop = getShop();
    // Expose to module scope so openDrawer()/refreshDrawerIfChanged() can
    // re-fetch without a stale closure.
    _customerId = customerId;
    _shop = shop;

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
          enhanceCustomizerNavHover();
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
      // Always open with the latest cached list (openDrawer reads
      // window.__APPAI_SAVED_DESIGNS__) and let it kick a background
      // refresh — never close over this initial `designs` snapshot.
      window.__APPAI_OPEN_SAVED_DESIGNS_DRAWER__ = function () { openDrawer(); };

      // ── MutationObserver: re-inject if the nav item is removed from the DOM ──
      // Some Shopify themes re-render the nav when the URL changes via
      // history.replaceState (e.g. after add-to-cart resets the page URL),
      // which removes the injected nav item. Watch for this and re-inject.
      var reinjecting = false;
      var reinjectTimer = null;
      var observer = new MutationObserver(function () {
        var primaryItem = document.getElementById(NAV_ITEM_ID);
        if (primaryItem || reinjecting) return;
        if (reinjectTimer) clearTimeout(reinjectTimer);
        reinjectTimer = setTimeout(function () {
          reinjectTimer = null;
          if (document.getElementById(NAV_ITEM_ID)) return;
          reinjecting = true;
          console.log('[AppAI Nav] Nav item removed from DOM — re-injecting...');
          tryInject();
          reinjecting = false;
        }, 200);
      });

      observer.observe(document.body, { childList: true, subtree: true });

      // ── Listen for refresh messages from the customizer iframe ──────────────
      window.addEventListener('message', function (event) {
        if (event.data && event.data.type === 'APPAI_REFRESH_GALLERY') {
          console.log('[AppAI Nav] Refreshing gallery data...');
          fetchDesigns(customerId, shop).then(function (newData) {
            if (newData && newData.designs) {
              window.__APPAI_SAVED_DESIGNS__ = newData.designs;
              // Update the count badge if it exists
              var badge = document.getElementById('appai-saved-count');
              if (badge) badge.textContent = newData.designs.length;
              // If the drawer is currently open, re-render its content in
              // place (renderDrawer doesn't touch open/close state).
              var drawer = document.getElementById(DRAWER_ID);
              if (drawer && drawer.classList.contains('appai-open')) {
                renderDrawer(newData.designs);
              }
            }
          });
        }
      });

    }).catch(function (e) {
      console.warn('[AppAI Nav] Failed to fetch saved designs:', e);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      initCustomizerNavHover();
      init();
    });
  } else {
    initCustomizerNavHover();
    init();
  }

})();
