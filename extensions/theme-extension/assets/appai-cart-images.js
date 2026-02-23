/* AppAI Cart Image Replacer
 * Replaces Shopify cart thumbnail images with the customer's generated mockup.
 * Source of truth: /cart.js (reads _mockup_url from line item properties).
 * Injected on every page via the ai-art-embed.liquid body block.
 *
 * Strategy (in order):
 *   1. input[name^="updates[KEY]"] → find container → swap first qualifying img
 *   2. Common cart-item containers (.cart-item, [id*=CartItem], tr, li, …)
 *   3. Last resort: single-item cart → first qualifying img in the cart form
 *
 * No-flash: on /cart pages, hides all cart images until the first replace
 * succeeds or a 1.2s safety timeout fires.
 *
 * Retry window: runs immediately on cart pages, then re-runs on DOM changes,
 * cart events, section reloads, and after appai:cart-updated.
 */
;(function () {
  'use strict';

  if (window.__APPAI_CART_IMG_REPLACER__) return;
  window.__APPAI_CART_IMG_REPLACER__ = true;

  // ─── Critical CSS: hide cart images until we swap them (no-flash) ─────────────
  function ensureCartNoFlashStyle() {
    if (window.location.pathname.indexOf('/cart') === -1) return;

    document.documentElement.classList.add('appai-cart-loading');

    if (!document.getElementById('appai-cart-noflash-style')) {
      var s = document.createElement('style');
      s.id = 'appai-cart-noflash-style';
      s.textContent =
        // Only hide images inside cart forms that haven't been swapped yet
        '.appai-cart-loading form[action^="/cart"] img:not([data-appai-mockup]) { opacity: 0 !important; }' +
        'form[action^="/cart"] img { transition: opacity 120ms ease; }';
      document.head.appendChild(s);
    }

    // Safety: never hide longer than 1.2 s
    setTimeout(function () {
      document.documentElement.classList.remove('appai-cart-loading');
    }, 1200);
  }

  ensureCartNoFlashStyle();

  // ─── /cart.js fetch ───────────────────────────────────────────────────────────
  async function getCart() {
    var res = await fetch('/cart.js', { credentials: 'same-origin' });
    if (!res.ok) throw new Error('Failed to fetch /cart.js: ' + res.status);
    return await res.json();
  }

  // ─── Build key → mockup map ───────────────────────────────────────────────────
  function buildKeyToMockup(cart) {
    var map = new Map();
    var items = cart.items || [];
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      var url = item && item.properties && item.properties._mockup_url;
      if (url) map.set(item.key, url);
    }
    return map;
  }

  // ─── Image qualification ──────────────────────────────────────────────────────
  function isLikelyProductImg(img) {
    var src = img.getAttribute('src') || '';
    if (!src) return false;
    // Skip tiny icons
    var w = Number(img.getAttribute('width') || img.naturalWidth || 0);
    var h = Number(img.getAttribute('height') || img.naturalHeight || 0);
    if ((w && w <= 40) || (h && h <= 40)) return false;
    // Skip already-swapped images
    if (img.hasAttribute('data-appai-mockup')) return false;
    // Must be inside the cart form
    if (!img.closest("form[action^='/cart']")) return false;
    return true;
  }

  function setImgToMockup(img, mockupUrl) {
    img.src = mockupUrl;
    img.removeAttribute('srcset');
    img.setAttribute('data-appai-mockup', 'true');
  }

  // ─── Container resolution ─────────────────────────────────────────────────────
  function findCartItemContainerFromUpdatesInput(inputEl) {
    return (
      inputEl.closest('[data-cart-item]') ||
      inputEl.closest("[id*='CartItem']") ||
      inputEl.closest('tr') ||
      inputEl.closest('li') ||
      inputEl.closest('.cart-item') ||
      inputEl.closest("[class*='cart']") ||
      inputEl.closest('form') ||
      document
    );
  }

  function extractKeyFromUpdatesInputName(name) {
    var m = /^updates\[(.+)\]$/.exec(name || '');
    return m ? m[1] : null;
  }

  // ─── Core replace ─────────────────────────────────────────────────────────────
  async function applyMockups() {
    try {
      var cart = await getCart();
      var keyToMockup = buildKeyToMockup(cart);

      if (keyToMockup.size === 0) {
        console.log('[AppAI Cart Image] No _mockup_url in cart — removing loading class.');
        document.documentElement.classList.remove('appai-cart-loading');
        return;
      }

      var replaced = 0;

      // Strategy 1: inputs named updates[KEY] — most reliable
      var updateInputs = Array.prototype.slice.call(document.querySelectorAll("input[name^='updates[']"));
      for (var i = 0; i < updateInputs.length; i++) {
        var input = updateInputs[i];
        var key = extractKeyFromUpdatesInputName(input.getAttribute('name'));
        if (!key) continue;

        var mockupUrl = keyToMockup.get(key);
        if (!mockupUrl) continue;

        var container = findCartItemContainerFromUpdatesInput(input);
        var imgs = Array.prototype.slice.call(container.querySelectorAll('img')).filter(isLikelyProductImg);
        if (imgs.length) {
          setImgToMockup(imgs[0], mockupUrl);
          replaced++;
        }
      }

      // Strategy 2: common cart-item class selectors (drawer themes)
      if (replaced === 0) {
        var selectors = [
          '.cart-item',
          "[class*='cart-item']",
          "[id*='CartItem']",
          'cart-items > *',
          "form[action*='/cart'] li",
        ];

        var done = false;
        for (var s = 0; s < selectors.length && !done; s++) {
          var nodes = Array.prototype.slice.call(document.querySelectorAll(selectors[s]));
          for (var n = 0; n < nodes.length && !done; n++) {
            var node = nodes[n];
            var img = Array.prototype.slice.call(node.querySelectorAll('img')).find(isLikelyProductImg);
            if (!img) continue;

            // For carts with only one AppAI item, use the single entry
            var mockupValues = Array.from ? Array.from(keyToMockup.values()) : [];
            if (!mockupValues.length) {
              keyToMockup.forEach(function (v) { mockupValues.push(v); });
            }
            if (mockupValues.length === 1) {
              setImgToMockup(img, mockupValues[0]);
              replaced++;
              done = true;
            }
          }
        }
      }

      // Strategy 3: single-item fallback on cart form
      if (replaced === 0) {
        var cartForm = document.querySelector("form[action^='/cart']");
        if (cartForm && cart.items && cart.items.length === 1) {
          var onlyUrl = cart.items[0].properties && cart.items[0].properties._mockup_url;
          var fallbackImg = Array.prototype.slice.call(cartForm.querySelectorAll('img')).find(isLikelyProductImg);
          if (fallbackImg && onlyUrl) {
            setImgToMockup(fallbackImg, onlyUrl);
            replaced++;
          }
        }
      }

      if (replaced > 0) {
        document.documentElement.classList.remove('appai-cart-loading');
      }

      console.log('[AppAI Cart Image] Applied mockups. Replaced:', replaced, '| Cart lines with mockup:', keyToMockup.size);
    } catch (e) {
      document.documentElement.classList.remove('appai-cart-loading');
      console.warn('[AppAI Cart Image] applyMockups failed:', e);
    }
  }

  // ─── Debounced scheduler ─────────────────────────────────────────────────────
  var scheduleTimer = null;
  function schedule() {
    clearTimeout(scheduleTimer);
    scheduleTimer = setTimeout(applyMockups, 150);
  }

  // Expose globally for backward compatibility
  window.aiArtFastReplace = applyMockups;
  window.__applyCartMockups = applyMockups;

  // ─── Triggers ─────────────────────────────────────────────────────────────────
  // Immediate first-paint on cart pages (attempt now + after 150ms)
  if (window.location.pathname.indexOf('/cart') !== -1) {
    applyMockups();
    schedule();
  }

  // DOM mutations (cart drawer re-renders, ajax section loads)
  try {
    var obs = new MutationObserver(function () { schedule(); });
    obs.observe(document.documentElement, { childList: true, subtree: true });
  } catch (_) {}

  // Cart event bus
  window.addEventListener('appai:cart-updated', schedule);
  document.addEventListener('cart:updated', schedule);
  document.addEventListener('cart:refresh', schedule);
  document.addEventListener('shopify:section:load', schedule);
  document.addEventListener('shopify:section:unload', schedule);
  document.addEventListener('shopify:section:select', schedule);
  window.addEventListener('pageshow', schedule);

  console.log('[AppAI Cart Image] Installed.');
})();
