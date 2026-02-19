(function() {
  'use strict';

  var CL = '[AI Art Studio]';
  var cartData = null;
  var isUpdating = false;
  var replaceDebounce = null;

  async function fetchCartData() {
    try {
      const response = await fetch('/cart.js', {
        headers: { 'Accept': 'application/json' }
      });
      if (!response.ok) throw new Error('Failed to fetch cart');
      cartData = await response.json();
      return cartData;
    } catch (error) {
      console.error(CL, 'Error fetching cart:', error);
      return null;
    }
  }

  function getMockupUrl(lineItem) {
    if (!lineItem || !lineItem.properties) return null;
    return lineItem.properties['_mockup_url'] || lineItem.properties['mockup_url'] || null;
  }

  function findCartItemElements() {
    const selectors = [
      '[data-cart-item]', '.cart-item', '.cart__item', '[class*="cart-item"]',
      '[class*="CartItem"]', 'tr[data-variant-id]', 'tr.cart__row',
      '.line-item', '[data-line-item]', '.cart-drawer__item', '.mini-cart__item',
      'cart-drawer-items [id^="CartDrawer-Item"]'
    ];

    const allItems = [];
    selectors.forEach(selector => {
      try {
        document.querySelectorAll(selector).forEach(el => {
          if (!allItems.includes(el)) allItems.push(el);
        });
      } catch (e) {}
    });

    if (allItems.length === 0) {
      const drawerSels = ['cart-drawer', '[data-cart-drawer]', '.cart-drawer', '#CartDrawer',
        '.mini-cart', '.side-cart', 'cart-notification', '[data-section-type="cart-drawer"]'];
      let drawer = null;
      for (let d = 0; d < drawerSels.length; d++) {
        drawer = document.querySelector(drawerSels[d]);
        if (drawer) break;
      }
      if (!drawer) {
        drawer = document.querySelector('[class*="cart"][class*="drawer"]') ||
                 document.querySelector('[id*="cart"][id*="drawer"]');
      }
      if (!drawer && window.location.pathname.includes('/cart')) {
        drawer = document.querySelector('form[action="/cart"]') ||
                 document.querySelector('[data-cart-form]') ||
                 document.querySelector('.cart') ||
                 document.querySelector('main');
      }
      if (drawer) {
        const wrappers = drawer.querySelectorAll('li, [role="row"], [class*="item"]');
        wrappers.forEach(w => {
          if (w.querySelector('img') && !allItems.includes(w)) allItems.push(w);
        });
      }
    }

    return allItems;
  }

  function extractVariantId(element) {
    const vid = element.getAttribute('data-variant-id') ||
                element.getAttribute('data-id') ||
                element.getAttribute('data-line-item-id');
    if (vid) return String(vid);
    const input = element.querySelector('input[name*="variant"], input[data-variant-id]');
    if (input) return String(input.getAttribute('data-variant-id') || input.value);
    const key = element.getAttribute('data-line-item-key') ||
                element.getAttribute('data-key') ||
                element.getAttribute('data-cart-item-key');
    if (key && cartData?.items) {
      const match = cartData.items.find(i => i.key === key);
      if (match) return String(match.variant_id);
    }
    return null;
  }

  function replaceImage(element, mockupUrl) {
    const imgs = element.querySelectorAll('img');
    let replaced = false;

    imgs.forEach(img => {
      if (img.dataset.aiMockupApplied === 'true' && img.src === mockupUrl) return;
      if (!img.dataset.originalSrc) img.dataset.originalSrc = img.src;

      img.src = mockupUrl;
      img.srcset = '';
      img.dataset.aiMockupApplied = 'true';
      replaced = true;

      if (!img.dataset.aiOnerror) {
        img.dataset.aiOnerror = 'true';
        img.addEventListener('error', function() {
          if (img.dataset.aiRetried) return;
          img.dataset.aiRetried = 'true';
          console.warn(CL, 'Mockup image failed, retrying once');
          setTimeout(function() { img.src = mockupUrl; }, 1000);
        });
      }
    });

    return replaced;
  }

  function doReplace() {
    if (!cartData?.items?.length) return 0;

    const hasAnyMockups = cartData.items.some(item => getMockupUrl(item));
    if (!hasAnyMockups) return 0;

    const elements = findCartItemElements();
    if (elements.length === 0) return -1;

    let replacedCount = 0;

    // Pass 1: match by variant ID / line key
    elements.forEach(el => {
      const vid = extractVariantId(el);
      if (vid) {
        const matches = cartData.items.filter(item =>
          String(item.variant_id) === vid && getMockupUrl(item)
        );
        if (matches.length > 0 && replaceImage(el, getMockupUrl(matches[0]))) {
          replacedCount++;
        }
      }
    });

    // Pass 2: fallback to position matching
    if (replacedCount === 0) {
      cartData.items.forEach((item, index) => {
        const mockupUrl = getMockupUrl(item);
        if (mockupUrl && elements[index]) {
          if (replaceImage(elements[index], mockupUrl)) replacedCount++;
        }
      });
    }

    return replacedCount;
  }

  async function replaceCartImages(retriesLeft) {
    if (isUpdating) return;
    isUpdating = true;
    const maxRetries = (typeof retriesLeft === 'number') ? retriesLeft : 5;

    try {
      await fetchCartData();
      const result = doReplace();

      if (result === -1 && maxRetries > 0) {
        isUpdating = false;
        const delays = [300, 600, 1200, 2000, 3000];
        const delay = delays[5 - maxRetries] || 1000;
        setTimeout(() => replaceCartImages(maxRetries - 1), delay);
        return;
      }
    } catch (error) {
      console.error(CL, 'Error replacing cart images:', error);
    } finally {
      isUpdating = false;
    }
  }

  function scheduleReplace() {
    clearTimeout(replaceDebounce);
    replaceDebounce = setTimeout(() => replaceCartImages(5), 250);
  }

  function init() {
    // Run on ALL pages -- cart drawers can appear anywhere
    setTimeout(() => replaceCartImages(5), 500);

    const observer = new MutationObserver(function(mutations) {
      let shouldUpdate = false;
      for (const mutation of mutations) {
        if (mutation.addedNodes.length > 0) {
          for (const node of mutation.addedNodes) {
            if (node.nodeType === 1) {
              const isCart = node.matches && (
                node.matches('cart-drawer, [data-cart-drawer], .cart-drawer, [class*="cart"], [id*="cart"]') ||
                node.querySelector('cart-drawer, [data-cart-drawer], .cart-drawer, [data-cart-item], .cart-item')
              );
              if (isCart) { shouldUpdate = true; break; }
            }
          }
        }
        if (shouldUpdate) break;
      }
      if (shouldUpdate) scheduleReplace();
    });

    observer.observe(document.body, { childList: true, subtree: true });

    document.addEventListener('cart:updated', scheduleReplace);
    document.addEventListener('cart:refresh', () => setTimeout(() => replaceCartImages(5), 400));

    window.addEventListener('pageshow', (event) => {
      if (event.persisted) setTimeout(() => replaceCartImages(5), 500);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
