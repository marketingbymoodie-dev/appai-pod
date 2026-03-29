/* AppAI Cart Image Replacer
 * Replaces Shopify cart thumbnail images with the customer's generated mockup.
 * Source of truth: /cart.js (reads _mockup_url from line item properties).
 * Injected on every page via the ai-art-embed.liquid body block.
 *
 * Strategy (in order):
 *   1. input[name^="updates[KEY]"] → find container → swap first qualifying img
 *   2a. [id*="CartItem-N"] — Dawn/OS2 themes with numbered cart item IDs
 *   2b. data-variant-id matching — themes that embed variant ID on cart item nodes
 *   2c. Positional matching — nth cart item DOM node = nth item in /cart.js
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

  // ─── Build lookup maps from cart data ────────────────────────────────────────
  // Returns:
  //   keyToMockup   — Map: "variantId:lineIndex" → mockupUrl
  //   variantToMockup — Map: variantId (string) → mockupUrl (last wins — fallback)
  //   indexedItems  — Array: [{index (1-based), variantId, mockupUrl, key}]
  function buildMaps(cart) {
    var keyToMockup = new Map();
    var variantToMockup = new Map();
    var indexedItems = [];
    var items = cart.items || [];
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      var url = item && item.properties && item.properties._mockup_url;
      if (!url) continue;
      keyToMockup.set(item.key, url);
      variantToMockup.set(String(item.variant_id), url);
      indexedItems.push({ index: i + 1, variantId: String(item.variant_id), mockupUrl: url, key: item.key });
    }
    return { keyToMockup: keyToMockup, variantToMockup: variantToMockup, indexedItems: indexedItems };
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

  // ─── Extract 1-based line item index from a cart item element ─────────────────
  // Dawn/OS2 uses id="CartItem-1", "CartItem-2", etc.
  function extractLineIndexFromElement(el) {
    var id = el.id || '';
    var m = /CartItem-(\d+)/i.exec(id);
    if (m) return parseInt(m[1], 10);
    // Also check data attributes
    var lineAttr = el.getAttribute('data-line') ||
                   el.getAttribute('data-line-index') ||
                   el.getAttribute('data-index');
    if (lineAttr) {
      var n = parseInt(lineAttr, 10);
      if (!isNaN(n)) return n;
    }
    return null;
  }

  // ─── Core replace ─────────────────────────────────────────────────────────────
  async function applyMockups() {
    try {
      var cart = await getCart();
      var maps = buildMaps(cart);
      var keyToMockup = maps.keyToMockup;
      var variantToMockup = maps.variantToMockup;
      var indexedItems = maps.indexedItems;

      if (keyToMockup.size === 0) {
        console.log('[AppAI Cart Image] No _mockup_url in cart — removing loading class.');
        document.documentElement.classList.remove('appai-cart-loading');
        return;
      }

      var replaced = 0;

      // ── Strategy 1: inputs named updates[KEY] — most reliable ─────────────────
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

      // ── Strategy 2: cart-item containers (drawer/page themes) ─────────────────
      // Supports multiple AppAI items via 3 sub-strategies:
      //   2a. CartItem-N id (Dawn/OS2)
      //   2b. data-variant-id attribute
      //   2c. Positional (nth DOM node = nth cart item)
      if (replaced === 0 && indexedItems.length > 0) {
        var selectors = [
          '.cart-item',
          "[class*='cart-item']",
          "[id*='CartItem']",
          'cart-items > *',
          "form[action*='/cart'] li",
        ];

        for (var s = 0; s < selectors.length; s++) {
          var nodes = Array.prototype.slice.call(document.querySelectorAll(selectors[s]));
          if (nodes.length === 0) continue;

          var selectorReplaced = 0;

          for (var n = 0; n < nodes.length; n++) {
            var node = nodes[n];
            var img = Array.prototype.slice.call(node.querySelectorAll('img')).find(isLikelyProductImg);
            if (!img) continue;

            var mockupForNode = null;

            // 2a. Match by CartItem-N id (Dawn/OS2)
            var lineIdx = extractLineIndexFromElement(node);
            if (lineIdx !== null) {
              for (var k = 0; k < indexedItems.length; k++) {
                if (indexedItems[k].index === lineIdx) {
                  mockupForNode = indexedItems[k].mockupUrl;
                  break;
                }
              }
            }

            // 2b. Match by data-variant-id attribute
            if (!mockupForNode) {
              var variantAttr = node.getAttribute('data-variant-id') ||
                                node.getAttribute('data-variant');
              if (!variantAttr) {
                var variantEl = node.querySelector('[data-variant-id]');
                if (variantEl) variantAttr = variantEl.getAttribute('data-variant-id');
              }
              if (variantAttr) {
                mockupForNode = variantToMockup.get(String(variantAttr)) || null;
              }
            }

            // 2c. Positional fallback: nth node with an image = nth AppAI item
            if (!mockupForNode) {
              // Count how many image-bearing nodes we have seen so far (including this one)
              var imgNodeCount = 0;
              for (var p = 0; p <= n; p++) {
                var pImg = Array.prototype.slice.call(nodes[p].querySelectorAll('img')).find(function(im) {
                  return !im.hasAttribute('data-appai-mockup') &&
                         (im.getAttribute('src') || '') !== '' &&
                         im.closest("form[action^='/cart']");
                });
                if (pImg) imgNodeCount++;
              }
              // imgNodeCount is the 1-based position among nodes with images
              if (imgNodeCount > 0 && imgNodeCount <= indexedItems.length) {
                mockupForNode = indexedItems[imgNodeCount - 1].mockupUrl;
              }
            }

            if (mockupForNode) {
              setImgToMockup(img, mockupForNode);
              selectorReplaced++;
            }
          }

          if (selectorReplaced > 0) {
            replaced += selectorReplaced;
            break; // Found the right selector, stop trying others
          }
        }
      }

      // ── Strategy 3: single-item fallback on cart form ──────────────────────────
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
